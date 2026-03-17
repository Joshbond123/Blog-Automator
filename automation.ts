import axios from 'axios';
import FormData from 'form-data';
import { getSupabase } from './supabase-backend';
import dotenv from 'dotenv';
import dns from 'node:dns';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { decryptSecret } from './secrets';

dotenv.config();
dns.setDefaultResultOrder('ipv4first');

const outboundProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
const outboundProxyAgent = outboundProxyUrl ? new ProxyAgent(outboundProxyUrl) : null;
const execFileAsync = promisify(execFile);

const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-dev';
const BLOG_COVER_WIDTH = 1280;
const BLOG_COVER_HEIGHT = 720;
const SUPABASE_OP_TIMEOUT_MS = 20000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function proxyFetch(input: string, init: any = {}) {
  const timeoutMs = Number(process.env.AUTOMATION_FETCH_TIMEOUT_MS || 45000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (outboundProxyAgent) {
    try {
      return await undiciFetch(input, {
        ...init,
        signal: init?.signal || controller.signal,
        dispatcher: outboundProxyAgent,
      } as any);
    } finally {
      clearTimeout(timeout);
    }
  }
  try {
    return await undiciFetch(input, {
      ...init,
      signal: init?.signal || controller.signal,
    } as any);
  } finally {
    clearTimeout(timeout);
  }
}

type KeyUsage = {
  key: string;
  success_calls?: number;
  failed_calls?: number;
  total_calls?: number;
  monthly_calls?: number;
  monthly_period?: string;
};

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeUsageEntry(entry: any): KeyUsage {
  const period = currentPeriod();
  const entryPeriod = entry?.monthly_period || period;
  const resetMonthly = entryPeriod !== period;
  return {
    ...entry,
    success_calls: entry?.success_calls || 0,
    failed_calls: entry?.failed_calls || 0,
    total_calls: entry?.total_calls || 0,
    monthly_calls: resetMonthly ? 0 : (entry?.monthly_calls || 0),
    monthly_period: period,
  };
}


function isLikelyCloudflareAccountId(value: any) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim());
}

function isLikelyCloudflareApiToken(value: any) {
  return typeof value === 'string' && value.trim().length > 24 && /[-_]/.test(value);
}

function normalizeCloudflareConfig(entry: any) {
  const normalized: any = normalizeUsageEntry(entry || {});
  const accountId = normalized?.account_id || normalized?.accountId || normalized?.accountID || normalized?.account || normalized?.cf_account_id;
  const apiKey = normalized?.api_key || normalized?.apiKey || normalized?.apiToken || normalized?.api_token || normalized?.token || normalized?.key;

  if (isLikelyCloudflareAccountId(apiKey) && isLikelyCloudflareApiToken(accountId)) {
    return { ...normalized, account_id: apiKey, api_key: accountId };
  }

  return { ...normalized, account_id: accountId, api_key: apiKey };
}

const ARRAY_SETTING_FIELDS = new Set(['cloudflare_configs', 'elevenlabs_keys', 'lightning_keys']);
const KEY_VALUE_SETTING_FIELDS = new Set([
  'supabase_url', 'supabase_service_role_key', 'supabase_access_token', 'github_pat',
  'cloudflare_configs', 'blogger_client_id', 'blogger_client_secret', 'blogger_refresh_token',
  'elevenlabs_keys', 'lightning_keys', 'catbox_hash', 'ads_html', 'ads_scripts', 'ads_placement',
  'cloudflare_rotation_index', 'elevenlabs_rotation_index', 'lightning_rotation_index',
  'cloudflare_text_model', 'cloudflare_image_model', 'github_repo',
  'cloudflare_account_id', 'cloudflare_api_token', 'cloudflare_api_keys'
]);

const KEY_ALIASES: Record<string, string> = {
  github_repository: 'github_repo',
  githubrepo: 'github_repo',
  github_repo_name: 'github_repo',
  catbox_user_hash: 'catbox_hash',
  cloudflare_accountid: 'cloudflare_account_id',
  cloudflare_account_id: 'cloudflare_account_id',
  cloudflare_api_key: 'cloudflare_api_token',
  cloudflare_api_token: 'cloudflare_api_token',
  cloudflare_apitoken: 'cloudflare_api_token',
  cloudflare_token: 'cloudflare_api_token',
  cloudflare_keys: 'cloudflare_api_keys',
};

function canonicalSettingKey(rawKey: any) {
  const normalized = String(rawKey || '').trim().toLowerCase();
  return KEY_ALIASES[normalized] || normalized;
}

function looksMaskedSecret(value: any) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^\*{4,}$/.test(trimmed) || /^(hidden|masked)$/i.test(trimmed);
}

function parsePossiblyJsonObject(value: any) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !text.startsWith('{')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function extractCloudflareConfigsFromGlobalPayload(payload: any): any[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const rootConfigs = Array.isArray((payload as any).cloudflare_configs) ? (payload as any).cloudflare_configs : [];
  const cloudflareNode = (payload as any).cloudflare;
  const nestedConfigs = Array.isArray(cloudflareNode?.configs) ? cloudflareNode.configs : [];
  const singleConfig = cloudflareNode && typeof cloudflareNode === 'object'
    ? [{
        account_id: cloudflareNode.account_id || cloudflareNode.accountId || cloudflareNode.account,
        api_key: cloudflareNode.api_key || cloudflareNode.apiKey || cloudflareNode.apiToken || cloudflareNode.api_token || cloudflareNode.token,
      }]
    : [];
  return [...rootConfigs, ...nestedConfigs, ...singleConfig].filter((cfg) => cfg && typeof cfg === 'object');
}

async function hydrateOverlaySettingsFromLegacyRow(supabase: any, settings: any) {
  try {
    const { data, error } = await supabase.from('settings').select('*').limit(1);
    if (error || !data?.[0]) return;
    const row = data[0] as any;
    for (const key of ['github_pat', 'github_repo', 'catbox_hash']) {
      const value = row?.[key];
      if ((!settings[key] || looksMaskedSecret(settings[key])) && value && !looksMaskedSecret(value)) {
        settings[key] = value;
      }
    }
  } catch {
    // no-op
  }
}

async function isKeyValueSettingsSchema(supabase: any) {
  const { error } = await supabase.from('settings').select('setting_key,setting_value').limit(1);
  return !error;
}

function parseStoredValue(key: string, value: any) {
  if (value == null) return null;
  if (ARRAY_SETTING_FIELDS.has(key)) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).configs)) return (parsed as any).configs;
        return [];
      } catch { return []; }
    }
    if (value && typeof value === 'object' && Array.isArray((value as any).configs)) return (value as any).configs;
    return [];
  }

  if (key.endsWith('_rotation_index')) return Number(value || 0);
  return value;
}

function serializeStoredValue(key: string, value: any) {
  if (value === undefined || value === null) return null;
  if (ARRAY_SETTING_FIELDS.has(key)) return JSON.stringify(Array.isArray(value) ? value : []);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function getSettings() {
  const supabase = getSupabase();
  const keyValueMode = await isKeyValueSettingsSchema(supabase);
  const settings: any = {};

  if (keyValueMode) {
    const { data } = await supabase.from('settings').select('setting_key,setting_value');
    for (const row of data || []) {
      const key = canonicalSettingKey(row.setting_key);
      const parsedValue = parseStoredValue(key, row.setting_value);

      if (key === 'global') {
        const globalPayload = parsePossiblyJsonObject(parsedValue);
        if (globalPayload && typeof globalPayload === 'object' && !Array.isArray(globalPayload)) {
          for (const [globalKey, globalValue] of Object.entries(globalPayload)) {
            const canonicalGlobalKey = canonicalSettingKey(globalKey);
            if (KEY_VALUE_SETTING_FIELDS.has(canonicalGlobalKey) && (settings[canonicalGlobalKey] == null || looksMaskedSecret(settings[canonicalGlobalKey]))) {
              settings[canonicalGlobalKey] = parseStoredValue(canonicalGlobalKey, globalValue);
            }
          }
          if (!Array.isArray(settings.cloudflare_configs) || settings.cloudflare_configs.length === 0) {
            const extracted = extractCloudflareConfigsFromGlobalPayload(globalPayload);
            if (extracted.length) {
              settings.cloudflare_configs = extracted;
            }
          }
        }
        continue;
      }

      if (!KEY_VALUE_SETTING_FIELDS.has(key)) continue;
      settings[key] = parsedValue;
    }

    await hydrateOverlaySettingsFromLegacyRow(supabase, settings);

    if ((!settings.cloudflare_configs || settings.cloudflare_configs.length === 0)) {
      try {
        const { data: apiKeyRows, error: apiKeyErr } = await supabase
          .from('api_keys')
          .select('key_type, encrypted_key, metadata')
          .ilike('key_type', '%cloudflare%');
        if (!apiKeyErr && Array.isArray(apiKeyRows) && apiKeyRows.length > 0) {
          const mapped = apiKeyRows.flatMap((row: any) => {
            const metadataConfigs = Array.isArray(row?.metadata?.configs) ? row.metadata.configs : [];
            const encrypted = decryptSecret(row?.encrypted_key);
            const single = {
              account_id: row?.metadata?.account_id || row?.metadata?.accountId || row?.metadata?.account,
              api_key: encrypted,
              active: row?.metadata?.active !== false,
            };
            return [...metadataConfigs, single];
          }).map((entry: any) => normalizeCloudflareConfig(entry)).filter((cfg: any) => cfg.account_id && cfg.api_key);
          if (mapped.length > 0) {
            settings.cloudflare_configs = mapped;
          }
        }
      } catch {
        // ignore api_keys fallback errors
      }
    }
  } else {
    const { data } = await supabase.from('settings').select('*').limit(1);
    Object.assign(settings, (data && data[0]) || {});
  }

  for (const required of ['github_pat', 'github_repo', 'catbox_hash']) {
    if (looksMaskedSecret(settings[required])) {
      settings[required] = '';
    }
  }

  if ((!settings.cloudflare_configs || settings.cloudflare_configs.length === 0) && settings.cloudflare_api_keys && settings.cloudflare_account_id) {
    settings.cloudflare_configs = String(settings.cloudflare_api_keys)
      .split(',')
      .map((key: string) => key.trim())
      .filter(Boolean)
      .map((key: string) => ({ account_id: settings.cloudflare_account_id, key }));
  }

  if ((!settings.cloudflare_configs || settings.cloudflare_configs.length === 0) && settings.cloudflare_api_token && settings.cloudflare_account_id) {
    settings.cloudflare_configs = [{ account_id: settings.cloudflare_account_id, api_key: settings.cloudflare_api_token }];
  }

  if (!Array.isArray(settings.cloudflare_configs)) settings.cloudflare_configs = [];
  if (!Array.isArray(settings.elevenlabs_keys)) settings.elevenlabs_keys = [];
  if (!Array.isArray(settings.lightning_keys)) settings.lightning_keys = [];

  settings.cloudflare_rotation_index = Number(settings.cloudflare_rotation_index || 0);
  settings.elevenlabs_rotation_index = Number(settings.elevenlabs_rotation_index || 0);
  settings.lightning_rotation_index = Number(settings.lightning_rotation_index || 0);

  settings.cloudflare_configs = settings.cloudflare_configs.map((c: any) => normalizeCloudflareConfig(c));
  settings.elevenlabs_keys = settings.elevenlabs_keys.map((k: any) => normalizeUsageEntry(k));
  settings.lightning_keys = settings.lightning_keys.map((k: any) => normalizeUsageEntry(k));

  return settings;
}

async function saveSettingsPatch(patch: Record<string, any>) {
  const supabase = getSupabase();
  const keyValueMode = await isKeyValueSettingsSchema(supabase);

  if (keyValueMode) {
    const rows = Object.entries(patch)
      .filter(([key]) => KEY_VALUE_SETTING_FIELDS.has(key))
      .map(([setting_key, value]) => ({ setting_key, setting_value: serializeStoredValue(setting_key, value) }));
    if (rows.length > 0) {
      await supabase.from('settings').upsert(rows, { onConflict: 'setting_key' });
    }
    return;
  }

  const { data: rows } = await supabase.from('settings').select('id').limit(1);
  const row = rows?.[0];
  if (row?.id) {
    await supabase.from('settings').update(patch).eq('id', row.id);
    return;
  }

  await supabase.from('settings').insert({ id: 1, ...patch });
}

function getEntryKey(entry: any) {
  return entry?.key || entry?.api_key || entry?.apiKey || entry?.apiToken || entry?.api_token || entry?.token;
}

async function pickRotatingKey(
  listName: 'cloudflare_configs' | 'elevenlabs_keys' | 'lightning_keys',
  indexName: 'cloudflare_rotation_index' | 'elevenlabs_rotation_index' | 'lightning_rotation_index',
) {
  const settings = await getSettings();
  const list = (settings[listName] || []).filter((item: any) => getEntryKey(item));
  if (listName === 'cloudflare_configs') {
    console.log(`[automation] Loaded Cloudflare configs: total=${(settings[listName] || []).length}, usable=${list.length}`);
  }
  if (!list.length) throw new Error(`No keys configured for ${listName}`);

  const rawIndex = Number(settings[indexName] || 0);
  const index = ((rawIndex % list.length) + list.length) % list.length;
  const selected = list[index];
  const nextIndex = (index + 1) % list.length;

  await saveSettingsPatch({ [indexName]: nextIndex });

  return {
    settings,
    list,
    selected,
    key: getEntryKey(selected),
    index,
    accountId: selected.account_id || list[0]?.account_id,
  };
}

async function trackKeyUsage(
  listName: 'cloudflare_configs' | 'elevenlabs_keys' | 'lightning_keys',
  indexName: 'cloudflare_rotation_index' | 'elevenlabs_rotation_index' | 'lightning_rotation_index',
  usedKey: string,
  ok: boolean,
) {
  const settings = await getSettings();
  const list = (settings[listName] || []).map((entry: any) => {
    const normalized = normalizeUsageEntry(entry);
    const key = getEntryKey(normalized);
    if (key !== usedKey) return normalized;

    return {
      ...normalized,
      total_calls: (normalized.total_calls || 0) + 1,
      monthly_calls: (normalized.monthly_calls || 0) + 1,
      success_calls: (normalized.success_calls || 0) + (ok ? 1 : 0),
      failed_calls: (normalized.failed_calls || 0) + (ok ? 0 : 1),
    };
  });

  await saveSettingsPatch({ [listName]: list, [indexName]: Number(settings[indexName] || 0) });
}

function isValidImageBuffer(buffer: Buffer) {
  if (!buffer || buffer.length < 100) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return jpeg || png || webp;
}

async function generateCloudflareFluxImage(accountId: string, apiToken: string, prompt: string) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;
  const { stdout } = await execFileAsync('curl', [
    '-sS',
    '-X',
    'POST',
    endpoint,
    '-H',
    `Authorization: Bearer ${apiToken}`,
    '-F',
    `prompt=${prompt}`,
    '-F',
    `width=${BLOG_COVER_WIDTH}`,
    '-F',
    `height=${BLOG_COVER_HEIGHT}`,
  ], { maxBuffer: 20 * 1024 * 1024 });

  const parsed = JSON.parse(String(stdout || '{}'));
  if (!parsed?.success || !parsed?.result?.image) {
    throw new Error(`Cloudflare image generation failed: ${parsed?.errors?.[0]?.message || 'Cloudflare did not return an image payload'}`);
  }

  const imageBuffer = Buffer.from(parsed.result.image, 'base64');
  if (!isValidImageBuffer(imageBuffer)) {
    throw new Error('Cloudflare returned invalid image data');
  }

  return imageBuffer;
}

async function uploadToCatbox(fileBuffer: Buffer, fileName: string) {
  const settings = await getSettings();
  const tempPath = path.join(os.tmpdir(), `catbox-${Date.now()}-${Math.random().toString(36).slice(2)}-${fileName}`);

  await fs.writeFile(tempPath, fileBuffer);
  try {
    const { stdout } = await execFileAsync('curl', [
      '-sS',
      '-F',
      'reqtype=fileupload',
      '-F',
      `userhash=${settings.catbox_hash || ''}`,
      '-F',
      `fileToUpload=@${tempPath}`,
      'https://catbox.moe/user/api.php',
    ], { maxBuffer: 20 * 1024 * 1024 });

    const url = String(stdout || '').trim();
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`Catbox upload failed: ${url || 'unknown response'}`);
    }
    return url;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

const OVERLAY_WORKFLOW_WAIT_MS = 90 * 1000;
const IMAGE_PIPELINE_MAX_MS = 5 * 60 * 1000;

async function waitForWorkflowRun(owner: string, repo: string, githubPat: string, sinceIso: string) {
  const started = Date.now();
  while (Date.now() - started < OVERLAY_WORKFLOW_WAIT_MS) {
    const runsResponse = await proxyFetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/title-overlay.yml/runs?event=repository_dispatch&per_page=20`, {
      headers: {
        Authorization: `token ${githubPat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Blog-Automator',
      },
    });
    const runsPayload: any = await runsResponse.json();
    if (!runsResponse.ok) {
      throw new Error(runsPayload?.message || `Failed to load GitHub workflow runs (${runsResponse.status})`);
    }

    const runs = Array.isArray(runsPayload?.workflow_runs) ? runsPayload.workflow_runs : [];
    const run = runs.find((r: any) => new Date(String(r.created_at || 0)).getTime() >= new Date(sinceIso).getTime() - 5000 && String(r?.name || '').toLowerCase().includes('title overlay'));
    if (run) {
      if (run.status === 'completed') return run;
      await new Promise((resolve) => setTimeout(resolve, 8000));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for title-overlay workflow run to appear after ${Math.round(OVERLAY_WORKFLOW_WAIT_MS / 1000)}s`);
}

async function runGitHubTitleOverlay(sourceImageUrl: string, title: string) {
  const settings = await getSettings();
  const githubPat = settings.github_pat;
  const githubRepo = settings.github_repo;
  const catboxHash = settings.catbox_hash;

  if (!githubPat || !githubRepo || !catboxHash) {
    throw new Error(`GitHub overlay requires github_pat, github_repo, and catbox_hash in Settings (loaded: github_pat=${Boolean(githubPat)}, github_repo=${Boolean(githubRepo)}, catbox_hash=${Boolean(catboxHash)})`);
  }

  const [owner, repo] = String(githubRepo).split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid github_repo format: ${githubRepo}. Expected owner/repo`);
  }

  const startedAt = new Date().toISOString();
  const dispatchResponse = await proxyFetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubPat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Blog-Automator',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'title_overlay',
      client_payload: {
        sourceImageUrl,
        title,
        catboxHash,
      },
    }),
  });

  if (!dispatchResponse.ok) {
    const dispatchBody = await dispatchResponse.text();
    throw new Error(`Failed to dispatch GitHub overlay workflow (${dispatchResponse.status}): ${dispatchBody}`);
  }

  const run = await waitForWorkflowRun(owner, repo, githubPat, startedAt);
  if (run.conclusion !== 'success') {
    throw new Error(`Title overlay workflow failed with conclusion: ${run.conclusion || 'unknown'}`);
  }

  const artifactsResponse = await proxyFetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`, {
    headers: {
      Authorization: `token ${githubPat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Blog-Automator',
    },
  });
  const artifactsPayload: any = await artifactsResponse.json();
  if (!artifactsResponse.ok) {
    throw new Error(artifactsPayload?.message || `Failed to fetch GitHub artifacts (${artifactsResponse.status})`);
  }

  const artifacts = Array.isArray(artifactsPayload?.artifacts) ? artifactsPayload.artifacts : [];
  const resultArtifact = artifacts.find((a: any) => a.name === 'title-overlay-result');
  if (!resultArtifact?.archive_download_url) {
    throw new Error('Title overlay workflow completed but no result artifact was found');
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-result-'));
  const zipPath = path.join(tmpDir, 'result.zip');
  const outDir = path.join(tmpDir, 'unzipped');
  await fs.mkdir(outDir, { recursive: true });

  try {
    const zipResponse = await proxyFetch(resultArtifact.archive_download_url, {
      headers: {
        Authorization: `token ${githubPat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Blog-Automator',
      },
    });
    if (!zipResponse.ok) {
      const body = await zipResponse.text();
      throw new Error(`Failed to download overlay artifact (${zipResponse.status}): ${body}`);
    }

    const zipArray = await zipResponse.arrayBuffer();
    await fs.writeFile(zipPath, Buffer.from(zipArray));
    await execFileAsync('unzip', ['-o', zipPath, '-d', outDir], { maxBuffer: 10 * 1024 * 1024 });
    const resultRaw = await fs.readFile(path.join(outDir, 'result.json'), 'utf8');
    const result = JSON.parse(resultRaw || '{}');
    const finalImageUrl = String(result?.finalImageUrl || '').trim();
    if (!/^https?:\/\//.test(finalImageUrl)) {
      throw new Error('Title overlay workflow returned invalid final image URL');
    }
    return finalImageUrl;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCloudflareRequest(accountId: string, apiToken: string, model: string, payload: any, expectBinary = false) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const response = await proxyFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Cloudflare AI request failed (${response.status}): ${details}`);
  }

  if (expectBinary) {
    return Buffer.from(await response.arrayBuffer());
  }

  return response.json();
}

async function postFacebookGraph(path: string, payload: Record<string, string>) {
  const response = await proxyFetch(`https://graph.facebook.com/v20.0/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  });

  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok || parsed?.error) {
    throw new Error(parsed?.error?.message || `Facebook Graph request failed (${response.status})`);
  }
  return parsed;
}

async function generateText(prompt: string, niche: string) {
  const settings = await getSettings();
  const textModel = settings.cloudflare_text_model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');

  try {
    const res: any = await runCloudflareRequest(
      selected.accountId,
      selected.key,
      textModel,
      {
        messages: [
          { role: 'system', content: `You are a professional content creator for the ${niche} niche. Generate engaging, high-quality content.` },
          { role: 'user', content: prompt }
        ]
      }
    );

    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
    return res?.result?.response || '';
  } catch (err) {
    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
    throw err;
  }
}

async function detectTextInImage(buffer: Buffer) {
  const runOcr = async (engine = '2') => {
    const body = new URLSearchParams();
    body.append('apikey', 'helloworld');
    body.append('language', 'eng');
    body.append('isOverlayRequired', 'false');
    body.append('OCREngine', engine);
    body.append('scale', 'true');
    body.append('base64Image', `data:image/png;base64,${buffer.toString('base64')}`);

    const response = await proxyFetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const payload: any = await response.json().catch(() => ({}));
    if (payload?.IsErroredOnProcessing) {
      throw new Error(`OCR processing error: ${String(payload?.ErrorMessage || 'unknown')}`);
    }

    const parsedResults = payload?.ParsedResults;
    const extracted = Array.isArray(parsedResults)
      ? parsedResults.map((r: any) => String(r?.ParsedText || '')).join(' ').trim()
      : '';
    const normalized = extracted.replace(/[^A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = normalized.split(' ').filter((t) => t.length >= 2);
    return {
      normalized,
      tokenCount: tokens.length,
      hasText: normalized.length >= 14 && tokens.length >= 3,
    };
  };

  try {
    const primary = await runOcr('2');
    if (primary.hasText) return true;
    const secondary = await runOcr('1');
    return secondary.hasText;
  } catch (err) {
    console.warn('OCR validation failed for generated image; treating as text-detected:', err);
    return true;
  }
}

function buildCloudflareScenePrompt(topic: string) {
  const cleanedTopic = String(topic || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanedTopic) {
    throw new Error('Cannot generate image prompt from an empty topic');
  }

  return [
    `Create a realistic, visually striking hero scene about: ${cleanedTopic}.`,
    'Output must be image-only with no visible text of any kind.',
    'Do not include letters, words, numbers, captions, labels, logos, watermarks, UI text, or typography.',
    'Focus on cinematic composition, depth, clear subject framing, and social-media-ready visual impact.',
  ].join(' ');
}

async function generateImage(topic: string) {
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
  const basePrompt = buildCloudflareScenePrompt(topic);
  const attempts = [
    `${basePrompt} Use natural color grading and clean cinematic composition with realistic details.`,
    `${basePrompt} Use dramatic but realistic lighting, premium editorial framing, and zero textual artifacts.`,
    `${basePrompt} Prioritize visual storytelling with balanced contrast and a clean subject-forward scene.`,
    `${basePrompt} if any text-like artifact appears, regenerate as a pure text-free visual scene.`,
  ];

  let lastError: any = null;
  for (const attemptPrompt of attempts) {
    try {
      const buffer = await generateCloudflareFluxImage(selected.accountId, selected.key, attemptPrompt);
      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
      return buffer;
    } catch (err) {
      lastError = err;
      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
    }
  }

  throw lastError || new Error('Image generation failed');
}


async function detectTextInImageUrl(imageUrl: string) {
  const runOcr = async (engine = '2') => {
    const body = new URLSearchParams();
    body.append('apikey', 'helloworld');
    body.append('language', 'eng');
    body.append('isOverlayRequired', 'false');
    body.append('OCREngine', engine);
    body.append('scale', 'true');
    body.append('url', imageUrl);

    const response = await proxyFetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const payload: any = await response.json().catch(() => ({}));
    const parsedResults = payload?.ParsedResults;
    const extracted = Array.isArray(parsedResults)
      ? parsedResults.map((r: any) => String(r?.ParsedText || '')).join(' ').trim()
      : '';
    const normalized = extracted.replace(/[^A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = normalized.split(' ').filter((t) => t.length >= 2);
    return normalized.length >= 8 && tokens.length >= 2;
  };

  try {
    const primary = await runOcr('2');
    if (primary) return true;
    return runOcr('1');
  } catch (err) {
    console.warn('OCR validation failed for uploaded raw image URL; treating as text-detected:', err);
    return true;
  }
}

async function generateVoiceover(text: string) {
  const selected = await pickRotatingKey('elevenlabs_keys', 'elevenlabs_rotation_index');

  try {
    const res = await axios.post(
      'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
      { text, model_id: 'eleven_monolingual_v1' },
      { headers: { 'xi-api-key': selected.key }, responseType: 'arraybuffer' }
    );

    await trackKeyUsage('elevenlabs_keys', 'elevenlabs_rotation_index', selected.key, true);
    return Buffer.from(res.data);
  } catch (err) {
    await trackKeyUsage('elevenlabs_keys', 'elevenlabs_rotation_index', selected.key, false);
    throw err;
  }
}


function normalizeTopicText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a: string, b: string) {
  const aa = new Set(normalizeTopicText(a).split(' ').filter(Boolean));
  const bb = new Set(normalizeTopicText(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter((x) => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size;
  return union ? intersection / union : 0;
}

function isGenericTopicLike(value: string) {
  const text = String(value || '').trim();
  if (!text) return true;
  const banned = /(astonishing secrets|surprising revelations|hidden truths?|mind[-\s]?blowing|mysteries revealed|fascinating secrets|weird facts that will shock you|uncover\s+the\s+most|discover\s+\d+\s+mind[-\s]?blowing\s+facts|weird unknown|jaw[-\s]?dropping facts|you won'?t believe|blow your mind)/i;
  if (banned.test(text)) return true;
  const normalized = normalizeTopicText(text);
  const tokens = normalized.split(' ').filter(Boolean);
  const genericTokens = new Set(['secrets', 'discoveries', 'revelations', 'mysteries', 'truths', 'facts', 'astonishing', 'surprising', 'hidden', 'uncover']);
  const concreteSignal = /(scientists?|researchers?|nasa|astronomers?|archaeologists?|species|fossil|earthquake|volcano|storm|hurricane|wildfire|flood|lobster|bacteria|signals?|city|road|roman|antarctic|amazon|maine|london)/i;
  const genericCount = tokens.filter((t) => genericTokens.has(t)).length;
  if (!concreteSignal.test(text) && genericCount >= 2) return true;
  return false;
}

function isTemplateSectionHeading(value: string) {
  const text = String(value || '').trim();
  if (!text) return true;
  return /(what\s+this\s+means|important\s+facts\s+and\s+insights|what\s+to\s+watch\s+next|how\s+this\s+situation\s+developed|what\s+this\s+topic\s+is\s+really\s+about|key\s+insight|core\s+story)/i.test(text);
}

async function buildDynamicFallbackSections(topic: string, niche: string, researchBrief = '') {
  const prompt =
    `Generate exactly 5 section plans for a blog article.\n` +
    `Topic: ${topic}\n` +
    `Niche: ${niche}\n` +
    `Research notes:\n${researchBrief || '- Use topic context only.'}\n` +
    `Return JSON array only: [{"heading":"...","angle":"..."}, ...].\n` +
    `Rules: headings must be specific to this topic, curiosity-driven, human-written, and NOT template phrases.`;

  const raw = await generateText(prompt, niche);
  try {
    const parsed = JSON.parse(stripMarkdownFences(raw).replace(/^json\s*/i, '').trim());
    if (Array.isArray(parsed)) {
      return parsed.map((r: any) => ({
        heading: String(r?.heading || '').trim(),
        angle: String(r?.angle || '').trim(),
      }));
    }
  } catch {
    // fall through
  }
  return [] as Array<{ heading: string; angle: string }>;
}

function buildDeterministicTopicHeadings(topic: string) {
  const core = String(topic || '').replace(/[:—-].*$/, '').trim() || String(topic || '').trim();
  return [
    `How ${core} First Caught Attention`,
    `What Experts Actually Found`,
    `The Evidence Behind ${core}`,
    `Why ${core} Matters Right Now`,
    `What Researchers Are Looking At Next`,
  ];
}

async function fetchTrendingTopicsForNiche(niche: string) {
  const queryVariants = [
    niche,
    `${niche} trend`,
    `${niche} trending now`,
    `${niche} latest news`,
    `${niche} viral story`,
    `${niche} breakthrough`,
    `${niche} facts`,
    `${niche} discoveries`,
    `${niche} update`,
    `${niche} what happened`,
  ];

  const feedUrls = queryVariants.flatMap((query) => [
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`,
  ]);

  const feedResults = await Promise.all(feedUrls.map(async (feedUrl) => {
    try {
      const res = await axios.get(feedUrl, { timeout: 6000 });
      const xml = String(res.data || '');
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
      const parsed: Array<{ title: string; link: string; source: string }> = [];
      for (const item of items) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
        const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
        const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
        const title = String(titleMatch?.[1] || '').replace(/&amp;/g, '&').trim();
        const link = String(linkMatch?.[1] || '').trim();
        const source = String(sourceMatch?.[1] || '').trim();
        if (title && link) parsed.push({ title, link, source });
      }
      return parsed;
    } catch {
      return [] as Array<{ title: string; link: string; source: string }>;
    }
  }));

  const collected = feedResults.flat();

  const bannedVagueTopic = /(astonishing secrets|surprising revelations|mind[-\s]?blowing|mysteries revealed|fascinating secrets|amazing weird facts|unbelievable mysteries|blow your mind|you won'?t believe|jaw[-\s]?dropping facts|weird unknown|change your perspective forever)/i;
  const realEventSignal = /(discover|discovered|uncovers?|uncov(?:ered|ers)|detects?|detected|finds?|found|researchers?|scientists?|study|studies|nasa|archaeolog|volcanic|earthquake|volcano|species|fossil|signal|probe|mission|trial|breakthrough|outbreak|announces?|launches?|court|policy|election|storm|hurricane|wildfire|flood)/i;

  const deduped: Array<{ title: string; link: string; source: string }> = [];
  for (const item of collected) {
    const title = String(item.title || '').trim();
    const normalized = normalizeTopicText(title);
    if (!normalized || bannedVagueTopic.test(title) || !realEventSignal.test(title) || isGenericTopicLike(title)) continue;
    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 6 || words.length > 24) continue;
    if (deduped.some((t) => {
      const existing = normalizeTopicText(t.title);
      return existing === normalized || jaccardSimilarity(existing, normalized) >= 0.68;
    })) {
      continue;
    }
    deduped.push({ title, link: item.link, source: item.source });
    if (deduped.length >= 100) break;
  }

  return deduped;
}

async function pickUniqueTrendingTopic(supabase: any, niche: string) {
  const candidates = await fetchTrendingTopicsForNiche(niche);
  const { data: usedTopics } = await supabase
    .from('topics')
    .select('title, topic, normalized_topic')
    .eq('niche', niche)
    .order('created_at', { ascending: false })
    .limit(1500);

  const used = (usedTopics || [])
    .flatMap((row: any) => [row?.title, row?.topic, row?.normalized_topic])
    .filter(Boolean)
    .map((x: string) => normalizeTopicText(x));

  const valid = candidates.filter((candidate) => {
    const normalized = normalizeTopicText(candidate.title);
    if (!normalized) return false;
    return !used.some((u) => u === normalized || jaccardSimilarity(u, normalized) >= 0.58);
  });

  if (valid.length > 0) {
    const index = Math.floor(Math.random() * valid.length);
    const selected = valid[index];

    const related = valid
      .filter((c) => jaccardSimilarity(c.title, selected.title) >= 0.2)
      .slice(0, 8);

    const facts: string[] = [];
    for (const sourceItem of related.slice(0, 4)) {
      try {
        const page = await axios.get(sourceItem.link, { timeout: 12000, maxRedirects: 5 });
        const html = String(page.data || '');
        const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
        const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
        const pageTitle = String(titleMatch?.[1] || sourceItem.title).replace(/\s+/g, ' ').trim();
        const description = String(meta?.[1] || '').replace(/\s+/g, ' ').trim();
        const snippet = description || pageTitle;
        if (snippet) facts.push(`- ${snippet.slice(0, 220)}`);
      } catch {
        const fallback = [sourceItem.title, sourceItem.source].filter(Boolean).join(' — ');
        if (fallback) facts.push(`- ${fallback}`);
      }
    }

    return {
      topic: selected.title,
      researchBrief: facts.join('\n'),
    };
  }

  for (let i = 0; i < 4; i += 1) {
    const fallback = (await generateText(
      `Generate one unique, specific, real-world topic for niche: ${niche}.
` +
      `Rules: one line only, no quotes, must reference a real event/discovery/phenomenon with concrete nouns (who/where/what), no vague wording, and avoid topics similar to previously used ideas.`,
      niche,
    )).trim();
    const normalized = normalizeTopicText(fallback);
    const tooVague = /(astonishing secrets|surprising revelations|mind[-\s]?blowing|mysteries revealed|fascinating secrets)/i.test(fallback);
    if (fallback && normalized && !tooVague && !isGenericTopicLike(fallback) && !used.some((u) => u === normalized || jaccardSimilarity(u, normalized) >= 0.58)) {
      return { topic: fallback, researchBrief: '' };
    }
  }

  throw new Error(`No valid unique trending topic found for niche: ${niche}`);
}

async function rewriteToViralTitle(topic: string, niche: string) {
  const rewritten = await generateText(
    `Rewrite this topic into one professional, curiosity-driven viral title in simple English.
` +
    `Topic: ${topic}
` +
    `Rules: one line only, no quotes, emotionally engaging, clear, and faithful to the topic.
Avoid generic/clickbait wording such as "astonishing secrets", "surprising revelations", "mind-blowing facts", "hidden truths".`,
    niche,
  );

  const clean = String(rewritten || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean || isGenericTopicLike(clean)) return topic;
  return clean;
}

function stripMarkdownFences(text: string) {
  return text
    .replace(/```html/gi, '')
    .replace(/```/g, '')
    .trim();
}

function plainTextLengthFromHtml(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function normalizeGeneratedHtml(text: string) {
  const cleaned = stripMarkdownFences(text);
  if (!cleaned) return '';
  if (/<(p|h2|h3|ul|ol|blockquote|section|article|div)\b/i.test(cleaned)) {
    return cleaned;
  }

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p>${chunk.replace(/\n+/g, ' ')}</p>`);

  return paragraphs.join('\n');
}


function stripInnerHeadings(html: string) {
  return String(html || '').replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/gi, '').trim();
}

function extractParagraphsFromHtml(html: string) {
  const matches = [...String(html || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => String(m[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (matches.length > 0) return matches;

  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const chunks = text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (chunks.length <= 2) return chunks;
  const mid = Math.ceil(chunks.length / 2);
  return [chunks.slice(0, mid).join(' '), chunks.slice(mid).join(' ')].filter(Boolean);
}

function ensureSentenceEnding(text: string) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/[.!?]$/.test(t)) return t;
  return `${t}.`;
}

function htmlParagraph(text: string) {
  return `<p>${ensureSentenceEnding(text)}</p>`;
}

async function generateFullBlogArticle(titleTopic: string, niche: string, researchBrief = '', sourceTopic = '') {
  const factualTopic = String(sourceTopic || titleTopic).trim();
  const outlineRaw = await generateText(
    `Create a professional blog outline for topic "${factualTopic}" in niche "${niche}".\n` +
      `Return JSON only with this shape: {"sections":[{"heading":"...","angle":"..."},...]} with exactly 5 sections.\n` +
      `Rules: simple English, no placeholders, no repeated ideas, each heading must be specific to the topic and based on real details.\n` +
      `Research notes:\n${researchBrief || '- Use verified topic context from current reports.'}`,
    niche,
  );

  let sourceSections: Array<{ heading: string; angle: string }> = [];
  try {
    const parsed = JSON.parse(stripMarkdownFences(outlineRaw).replace(/^json\s*/i, '').trim());
    if (Array.isArray(parsed?.sections)) {
      sourceSections = parsed.sections.map((r: any) => ({
        heading: String(r?.heading || '').trim(),
        angle: String(r?.angle || '').trim(),
      }));
    }
  } catch {
    sourceSections = [];
  }

  if (sourceSections.length < 5) {
      const fallbackRaw = await generateText(
      `Create 5 unique, topic-specific section plans for this blog topic: "${factualTopic}".\n` +
        `Return JSON array only: [{"heading":"...","angle":"..."}, ...].\n` +
        `Rules: no placeholders, no generic labels, each section covers a different part of the topic.`,
      niche,
    );
    try {
      const parsed = JSON.parse(stripMarkdownFences(fallbackRaw).replace(/^json\s*/i, '').trim());
      if (Array.isArray(parsed)) {
        sourceSections = parsed.map((r: any) => ({
          heading: String(r?.heading || '').trim(),
          angle: String(r?.angle || '').trim(),
        }));
      }
    } catch {
      sourceSections = [];
    }
  }

  if (sourceSections.length < 5) {
    sourceSections = await buildDynamicFallbackSections(factualTopic, niche, researchBrief);
  }

  const uniqueSections: Array<{ heading: string; angle: string }> = [];
  const seenHeadingNorm = new Set<string>();
  for (const rawSection of sourceSections) {
    if (uniqueSections.length >= 5) break;
    const heading = String(rawSection?.heading || '').trim();
    const angle = String(rawSection?.angle || '').trim();
    const normalizedHeading = normalizeTopicText(heading);
    if (!normalizedHeading || !angle || isTemplateSectionHeading(heading)) continue;
    const tooSimilar = [...seenHeadingNorm].some((h) => h === normalizedHeading || jaccardSimilarity(h, normalizedHeading) >= 0.57);
    if (tooSimilar) continue;
    seenHeadingNorm.add(normalizedHeading);
    uniqueSections.push({ heading, angle });
  }

  if (uniqueSections.length < 5) {
    const rescue = await buildDynamicFallbackSections(factualTopic, niche, researchBrief);
    for (const r of rescue) {
      if (uniqueSections.length >= 5) break;
      const heading = String(r?.heading || '').trim();
      const angle = String(r?.angle || '').trim();
      const normalizedHeading = normalizeTopicText(heading);
      if (!normalizedHeading || !angle || isTemplateSectionHeading(heading)) continue;
      const tooSimilar = [...seenHeadingNorm].some((h) => h === normalizedHeading || jaccardSimilarity(h, normalizedHeading) >= 0.57);
      if (tooSimilar) continue;
      seenHeadingNorm.add(normalizedHeading);
      uniqueSections.push({ heading, angle });
    }
  }

  if (uniqueSections.length < 5) {
    const fallbackHeadings = buildDeterministicTopicHeadings(factualTopic);
    for (const heading of fallbackHeadings) {
      if (uniqueSections.length >= 5) break;
      const normalizedHeading = normalizeTopicText(heading);
      const tooSimilar = [...seenHeadingNorm].some((h) => h === normalizedHeading || jaccardSimilarity(h, normalizedHeading) >= 0.57);
      if (tooSimilar || isTemplateSectionHeading(heading)) continue;
      seenHeadingNorm.add(normalizedHeading);
      uniqueSections.push({
        heading,
        angle: `Explain one concrete, topic-specific detail tied to: ${factualTopic}. Keep it factual and clear.`,
      });
    }
  }

  const sections = uniqueSections.slice(0, 5);

  const introRaw = await generateText(
    `Write a hook introduction for a blog post about "${titleTopic}" in niche "${niche}".\n` +
      `The factual topic is: "${factualTopic}".\n` +
      `Rules: simple English, natural human tone, one paragraph only, no hype overload, no placeholder text.\n` +
      `Use this research context if relevant:\n${researchBrief || '- No extra notes available.'}\n` +
      `Return HTML paragraph only.`,
    niche,
  );
  const introParagraphs = extractParagraphsFromHtml(normalizeGeneratedHtml(introRaw));
  const introHtml = htmlParagraph(introParagraphs[0] || `This topic has been getting attention for important reasons, and understanding it clearly can help readers make better decisions.`);

  const sectionHtmlParts: string[] = [];
  const priorSectionSummaries: string[] = [];

  for (const section of sections) {
    const heading = String(section?.heading || 'Key insight').trim();
    const angle = String(section?.angle || 'Explain this topic clearly with useful details.').trim();
    let chosenParagraphs: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const distinctnessContext = priorSectionSummaries.length
        ? `Avoid repeating these previous section themes: ${priorSectionSummaries.join(' | ')}`
        : 'No previous sections yet.';

      const sectionBody = await generateText(
        `Write one complete blog section for factual topic "${factualTopic}".\n` +
          `Use this blog headline context: "${titleTopic}".\n` +
          `Section heading: "${heading}".\n` +
          `Section angle: ${angle}.\n` +
          `Base the writing on these researched facts when useful:\n${researchBrief || '- Keep facts grounded in real reporting context.'}\n` +
          `${distinctnessContext}.\n` +
          `Rules: exactly two complete paragraphs, simple English, professional human tone, no repeated hooks, no filler, and smooth transition.\n` +
          `Return HTML paragraphs only.`,
        niche,
      );

      const normalized = stripInnerHeadings(normalizeGeneratedHtml(sectionBody));
      const paras = extractParagraphsFromHtml(normalized)
        .map((x) => x.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 2);

      const enough = paras.length === 2 && paras.every((p) => p.length >= 220);
      const notCut = paras.every((p) => /[.!?]$/.test(p.trim()));
      const plain = paras.join(' ');
      const isDuplicateLike = priorSectionSummaries.some((prev) => jaccardSimilarity(prev, plain) >= 0.62);

      if ((enough && notCut && !isDuplicateLike) || attempt === 2) {
        chosenParagraphs = paras;
        priorSectionSummaries.push(plain.slice(0, 700));
        break;
      }
    }

    if (chosenParagraphs.length < 2) {
      const fallback = await generateText(
        `Write exactly two complete paragraphs for section "${heading}" about topic "${factualTopic}".\n` +
          `Simple English, natural style, fully finished sentences, no placeholders, and include at least one concrete real-world detail. Return HTML paragraphs only.`,
        niche,
      );
      chosenParagraphs = extractParagraphsFromHtml(normalizeGeneratedHtml(fallback)).slice(0, 2);
    }

    const p1 = htmlParagraph(chosenParagraphs[0] || `This part explains what happened and gives the core context in straightforward language, so the reader can follow the story without confusion.`);
    const p2 = htmlParagraph(chosenParagraphs[1] || `It then adds practical meaning by connecting the detail to why this development matters now and what readers should pay attention to next.`);

    sectionHtmlParts.push(`<h2>${heading}</h2>\n${p1}\n${p2}`);
  }

  const conclusionRaw = await generateText(
    `Write one conclusion paragraph for blog topic "${factualTopic}" in niche "${niche}".\n` +
      `Rules: one paragraph only, summarize key ideas, end with a natural call-to-action inviting readers to comment and share their thoughts.\n` +
      `Avoid phrases like "In conclusion" and keep it human and specific to this topic.\n` +
      `Return HTML paragraph only.`,
    niche,
  );

  const conclusionParas = extractParagraphsFromHtml(normalizeGeneratedHtml(conclusionRaw));
  const conclusionHtml = htmlParagraph(conclusionParas[0] || `This story shows how fast new findings can change what we think we know. What part stood out to you most, and do you think this discovery will change how people see the topic? Share your view in the comments.`);

  const article = [
    introHtml,
    ...sectionHtmlParts,
    `<h2>Conclusion</h2>`,
    conclusionHtml,
  ].join('\n\n');

  return article
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<p>\s*<\/p>/g, '')
    .trim();
}

async function generateFacebookComment(topic: string, niche: string, blogUrl: string) {
  const generated = await generateText(
    `Write one engaging Facebook comment (2-4 sentences) for topic "${topic}" in niche "${niche}".
` +
      `The tone must be natural, professional, and viral-style. Include a strong call-to-action to read the full article.
` +
      `Include this exact link once: ${blogUrl}
` +
      `Return plain text only, no quotes, no markdown.`,
    niche,
  );

  const comment = stripMarkdownFences(generated).replace(/\s+/g, ' ').trim();
  if (!comment || !comment.includes(blogUrl)) {
    return `Want the full breakdown on ${topic}? Read the full article here: ${blogUrl} — then drop your take below.`;
  }

  return comment;
}

function buildFacebookTeaser(fullContent: string, niche: string, blogUrl: string) {
  const plain = fullContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const teaser = plain.slice(0, 280);
  const hashtagBase = niche
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => `#${w}`)
    .join(' ');

  return `${teaser}...

Read the full article in the comments 👇
${hashtagBase}`;
}

async function publishToBlogger(blogId: string, title: string, content: string) {
  const settings = await getSettings();
  const tokenForm = new URLSearchParams({
    client_id: decryptSecret(settings.blogger_client_id),
    client_secret: decryptSecret(settings.blogger_client_secret),
    refresh_token: decryptSecret(settings.blogger_refresh_token),
    grant_type: 'refresh_token'
  });

  const tokenResponse = await proxyFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm.toString(),
  });
  const tokenPayload: any = await tokenResponse.json();
  if (!tokenResponse.ok || tokenPayload?.error) {
    throw new Error(tokenPayload?.error_description || tokenPayload?.error || `Blogger OAuth failed (${tokenResponse.status})`);
  }

  const publishResponse = await proxyFetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenPayload.access_token}`,
    },
    body: JSON.stringify({ kind: 'blogger#post', title, content }),
  });
  const publishPayload: any = await publishResponse.json();
  if (!publishResponse.ok || publishPayload?.error) {
    const message = publishPayload?.error?.message || publishPayload?.error || `Blogger publish failed (${publishResponse.status})`;
    throw new Error(message);
  }

  const expectedLength = plainTextLengthFromHtml(content);
  if (publishPayload?.id) {
    const verifyResponse = await proxyFetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${publishPayload.id}`, {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    });
    const verifyPayload: any = await verifyResponse.json();
    const actualLength = plainTextLengthFromHtml(String(verifyPayload?.content || ''));

    if (!verifyResponse.ok || verifyPayload?.error || actualLength < Math.floor(expectedLength * 0.85)) {
      const patchResponse = await proxyFetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${publishPayload.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenPayload.access_token}`,
        },
        body: JSON.stringify({ content }),
      });
      const patchPayload: any = await patchResponse.json();
      if (!patchResponse.ok || patchPayload?.error) {
        throw new Error(patchPayload?.error?.message || patchPayload?.error || `Blogger post update failed (${patchResponse.status})`);
      }
      return patchPayload;
    }
  }

  return publishPayload;
}

async function publishToFacebook(pageId: string, accessToken: string, message: string, imageUrl?: string) {
  if (imageUrl) {
    return postFacebookGraph(`${pageId}/photos`, { url: imageUrl, caption: message, access_token: accessToken });
  }

  return postFacebookGraph(`${pageId}/feed`, { message, access_token: accessToken });
}

async function recordTopicUsage(supabase: any, niche: string, topic: string, scheduleId: string) {
  const now = new Date().toISOString();
  const legacyInsert = await supabase.from('topics').insert({ niche, title: topic, used: true, created_at: now });
  if (!legacyInsert.error) return;

  await supabase.from('topics').insert({
    niche,
    topic,
    normalized_topic: normalizeTopicText(topic),
    source: 'automation',
    used_for: scheduleId,
    created_at: now,
  });
}

async function updateScheduleExecutionStatus(supabase: any, scheduleId: string, status: string) {
  const timestamp = new Date().toISOString();
  const legacy = await supabase
    .from('schedules')
    .update({ last_execution_status: status, last_executed_at: timestamp })
    .eq('id', scheduleId);

  if (!legacy.error) return;

  const { data: schedule } = await supabase.from('schedules').select('metadata').eq('id', scheduleId).single();
  if (!schedule) return;

  const metadata = {
    ...(schedule.metadata || {}),
    last_execution_status: status,
    last_executed_at: timestamp,
  };

  await supabase.from('schedules').update({ metadata }).eq('id', scheduleId);
}

export async function runBlogAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule, error: scheduleError } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
  if (scheduleError || !schedule) {
    throw new Error(`Schedule ${scheduleId} not found`);
  }

  const { data: account, error: accountError } = await supabase
    .from('blogger_accounts')
    .select('*')
    .eq('id', schedule.target_id)
    .single();

  if (accountError || !account) {
    await updateScheduleExecutionStatus(
      supabase,
      scheduleId,
      `failed: blogger account not found for target_id ${schedule.target_id}`,
    );
    throw new Error(`Blogger account not found for target_id ${schedule.target_id}`);
  }
  const niche = account.niche;

  try {
    const discovered = await pickUniqueTrendingTopic(supabase, niche);
    const discoveredTopic = discovered.topic;
    const topic = await rewriteToViralTitle(discoveredTopic, niche);
    const content = await generateFullBlogArticle(topic, niche, discovered.researchBrief || '', discoveredTopic);

    let imageUrl = '';
    let overlayError: any = null;
    const imagePipelineStartedAt = Date.now();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (Date.now() - imagePipelineStartedAt > IMAGE_PIPELINE_MAX_MS) {
        throw new Error(`Image/overlay pipeline exceeded ${Math.round(IMAGE_PIPELINE_MAX_MS / 1000)}s total runtime`);
      }
      try {
        const imageBuffer = await generateImage(discoveredTopic);
        const rawImageUrl = await uploadToCatbox(imageBuffer, `blog-image-raw-${Date.now()}-${attempt}.png`);
        console.log(`[blog-automation] workers-ai raw image url: ${rawImageUrl}`);
        const rawContainsText = await detectTextInImageUrl(rawImageUrl);
        if (rawContainsText) {
          throw new Error('Raw generated image contains text-like artifacts; regenerating before overlay');
        }
        imageUrl = await runGitHubTitleOverlay(rawImageUrl, topic);
        overlayError = null;
        break;
      } catch (err) {
        overlayError = err;
        console.error(`Image/overlay attempt ${attempt} failed:`, err);
      }
    }

    if (!imageUrl) {
      throw overlayError || new Error('Image overlay pipeline failed after retries');
    }

    const heroImageHtml = `<figure style="margin:0 0 1.25rem 0;"><img src="${imageUrl}" alt="${topic.replace(/"/g, '&quot;')}" style="display:block;width:100%;height:auto;border-radius:12px;" loading="eager" /></figure>`;
    const bloggerPost = await publishToBlogger(account.blogger_id, topic, `${heroImageHtml}${content}`);

    await withTimeout(recordTopicUsage(supabase, niche, topic, scheduleId), SUPABASE_OP_TIMEOUT_MS, 'recordTopicUsage');

    let publishedPlatform: 'Blogger' | 'Both' = 'Blogger';
    let facebookWarning = '';

    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        try {
          const teaserMessage = buildFacebookTeaser(content, niche, bloggerPost.url);
          const fbPost = await publishToFacebook(fbPage.page_id, fbPage.access_token, teaserMessage, imageUrl);

          const dynamicComment = await generateFacebookComment(topic, niche, bloggerPost.url);
          await postFacebookGraph(`${fbPost.id}/comments`, {
            message: dynamicComment,
            access_token: fbPage.access_token,
          });
          publishedPlatform = 'Both';
        } catch (fbError: any) {
          facebookWarning = fbError?.message || 'Facebook publish failed';
          console.error('Facebook publish failed:', fbError);
        }
      }
    }

    await withTimeout(supabase.from('posts').insert({
      title: topic,
      blog_name: account.name,
      niche,
      platform: publishedPlatform,
      status: 'published',
      url: bloggerPost.url,
      published_at: new Date().toISOString()
    }), SUPABASE_OP_TIMEOUT_MS, 'posts.insert.published');

    await withTimeout(updateScheduleExecutionStatus(
      supabase,
      scheduleId,
      facebookWarning ? `success_with_facebook_warning: ${facebookWarning}` : 'success',
    ), SUPABASE_OP_TIMEOUT_MS, 'updateScheduleExecutionStatus.success');
    return {
      ok: true,
      scheduleId,
      discoveredTopic,
      title: topic,
      bloggerUrl: bloggerPost.url,
      imageUrl,
      platform: publishedPlatform,
      facebookWarning,
    };
  } catch (error: any) {
    console.error('Blog automation failed:', error);
    await withTimeout(supabase.from('posts').insert({
      title: 'Failed to generate post',
      blog_name: account.name,
      niche,
      platform: account.facebook_page_id ? 'Both' : 'Blogger',
      status: 'failed',
      published_at: new Date().toISOString()
    }), SUPABASE_OP_TIMEOUT_MS, 'posts.insert.failed').catch((insertErr) => {
      console.error('Failed to persist failed post row:', insertErr);
    });
    await withTimeout(updateScheduleExecutionStatus(supabase, scheduleId, `failed: ${error?.message || 'unknown'}`), SUPABASE_OP_TIMEOUT_MS, 'updateScheduleExecutionStatus.failed').catch((updateErr) => {
      console.error('Failed to update schedule failure status:', updateErr);
    });
    throw error;
  }
}

export async function runVideoAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule, error: scheduleError } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
  if (scheduleError || !schedule) {
    throw new Error(`Schedule ${scheduleId} not found`);
  }

  const { data: fbPage, error: fbError } = await supabase
    .from('facebook_pages')
    .select('*')
    .eq('id', schedule.target_id)
    .single();

  if (fbError || !fbPage) {
    throw new Error(`Facebook page not found for target_id ${schedule.target_id}`);
  }
  const settings = await getSettings();

  const niche = 'Viral Entertainment';
  const topic = await generateText(`Generate a viral video topic for the ${niche} niche.`, niche);
  const script = await generateText(`Write a 30-second video script for the topic: "${topic}".`, niche);
  const voiceBuffer = await generateVoiceover(script);
  const voiceUrl = await uploadToCatbox(voiceBuffer, 'voiceover.mp3');

  if (settings.github_pat) {
    await axios.post(
      `https://api.github.com/repos/${settings.github_repo || 'YOUR_USER/YOUR_REMOTION_REPO'}/dispatches`,
      {
        event_type: 'render_video',
        client_payload: {
          topic,
          script,
          voiceUrl,
          catboxHash: settings.catbox_hash,
          fbPageId: fbPage.page_id,
          fbAccessToken: fbPage.access_token
        }
      },
      {
        headers: {
          Authorization: `token ${settings.github_pat}`,
          Accept: 'application/vnd.github.v3+json'
        }
      }
    );
  }

  await supabase.from('video_jobs').insert({
    schedule_id: scheduleId,
    status: 'rendering',
    created_at: new Date().toISOString()
  });
}
