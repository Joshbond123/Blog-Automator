import axios from 'axios';
import FormData from 'form-data';
import { getSupabase } from './supabase-backend';
import dotenv from 'dotenv';
import { decryptSecret } from './secrets';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import AdmZip from 'adm-zip';

dotenv.config();
axios.defaults.proxy = false;
const httpsProxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cloudflareRateLimitUntil = new Map<string, number>();
const cerebrasRateLimitUntil = new Map<string, number>();

function computeRetryDelayMs(error: any, attempt: number, baseMs = 2500, maxMs = 90000) {
  const retryAfterRaw = error?.response?.headers?.['retry-after'];
  const retryAfterSec = Number(retryAfterRaw);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, maxMs);
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), maxMs);
}

function isCloudflareDailyQuotaExhausted(error: any) {
  const status = Number(error?.response?.status || 0);
  const payload = error?.response?.data;
  const code = Number(payload?.errors?.[0]?.code || 0);
  const message = String(payload?.errors?.[0]?.message || '').toLowerCase();
  return status === 429 && (code === 4006 || message.includes('daily free allocation'));
}

function outboundConfig(extra: Record<string, any> = {}) {
  return { proxy: false as const, httpsAgent: httpsProxyAgent, ...extra };
}

const DEFAULT_CF_IMAGE_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
const LEGACY_IMAGE_MODELS = new Set([
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/black-forest-labs/flux-2-dev',
  '@cf/leonardo/phoenix-1.0',
]);
const CEREBRAS_TEXT_MODEL = 'qwen-3-235b-a22b-instruct-2507';

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

function normalizeCloudflareConfig(entry: any) {
  const normalized = normalizeUsageEntry(entry || {}) as any;
  return {
    ...normalized,
    account_id: normalized.account_id || normalized.accountId || normalized.accountID || normalized.account || normalized.cf_account_id || '',
    api_key: normalized.api_key || normalized.apiKey || normalized.apiToken || normalized.api_token || normalized.token || normalized.key || '',
  };
}

function extractCloudflareConfigsFromUnknownRow(rawValue: any): any[] {
  const value = typeof rawValue === 'string' ? (() => {
    try { return JSON.parse(rawValue); } catch { return rawValue; }
  })() : rawValue;

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeCloudflareConfig(entry))
      .filter((entry: any) => entry.account_id && entry.api_key);
  }

  if (value && typeof value === 'object') {
    const direct = normalizeCloudflareConfig(value);
    const nested = [
      ...(Array.isArray((value as any).configs) ? (value as any).configs : []),
      ...(Array.isArray((value as any).cloudflare_configs) ? (value as any).cloudflare_configs : []),
      ...(Array.isArray((value as any).cloudflare?.configs) ? (value as any).cloudflare.configs : []),
    ].map((entry: any) => normalizeCloudflareConfig(entry)).filter((entry: any) => entry.account_id && entry.api_key);

    if (direct.account_id && direct.api_key) return [direct, ...nested];
    return nested;
  }

  return [];
}

const ARRAY_SETTING_FIELDS = new Set(['cloudflare_configs', 'elevenlabs_keys', 'cerebras_keys', 'lightning_keys']);
const KEY_VALUE_SETTING_FIELDS = new Set([
  'supabase_url', 'supabase_service_role_key', 'supabase_access_token', 'github_pat',
  'github_repo',
  'cloudflare_configs', 'blogger_client_id', 'blogger_client_secret', 'blogger_refresh_token',
  'elevenlabs_keys', 'cerebras_keys', 'imgbb_api_key', 'ads_html', 'ads_scripts', 'ads_placement',
  'cloudflare_rotation_index', 'elevenlabs_rotation_index', 'cerebras_rotation_index', 'lightning_keys', 'lightning_rotation_index',
  'cloudflare_image_model', 'global',
  'cloudflare_account_id', 'cloudflare_api_token', 'cloudflare_api_keys'
]);

async function isKeyValueSettingsSchema(supabase: any) {
  const { error } = await supabase.from('settings').select('setting_key,setting_value').limit(1);
  return !error;
}

function parseStoredValue(key: string, value: any) {
  if (value == null) return null;
  if (ARRAY_SETTING_FIELDS.has(key)) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
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
      if (!KEY_VALUE_SETTING_FIELDS.has(row.setting_key)) continue;
      settings[row.setting_key] = parseStoredValue(row.setting_key, row.setting_value);
    }

    if ((!settings.cloudflare_configs || settings.cloudflare_configs.length === 0) && settings.global && typeof settings.global === 'object') {
      const globalNode = settings.global as any;
      if (Array.isArray(globalNode.cloudflare_configs)) settings.cloudflare_configs = globalNode.cloudflare_configs;
      else if (globalNode.cloudflare && Array.isArray(globalNode.cloudflare.configs)) settings.cloudflare_configs = globalNode.cloudflare.configs;
    }

    if ((!settings.cloudflare_configs || settings.cloudflare_configs.length === 0) && Array.isArray(data)) {
      const discovered = data.flatMap((row: any) => {
        const key = String(row.setting_key || '').toLowerCase();
        const parsed = extractCloudflareConfigsFromUnknownRow(row.setting_value);
        if (parsed.length > 0 && (key.includes('cloudflare') || key === 'global' || key === 'integrations')) {
          return parsed;
        }
        return [];
      });
      if (discovered.length > 0) {
        settings.cloudflare_configs = discovered;
      }
    }
  } else {
    const { data } = await supabase.from('settings').select('*').limit(1);
    Object.assign(settings, (data && data[0]) || {});
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
  if (!Array.isArray(settings.cerebras_keys)) settings.cerebras_keys = [];
  if (!Array.isArray(settings.lightning_keys)) settings.lightning_keys = [];

  settings.cloudflare_rotation_index = Number(settings.cloudflare_rotation_index || 0);
  settings.elevenlabs_rotation_index = Number(settings.elevenlabs_rotation_index || 0);
  settings.cerebras_rotation_index = Number(settings.cerebras_rotation_index || 0);
  settings.lightning_rotation_index = Number(settings.lightning_rotation_index || 0);

  settings.cloudflare_configs = settings.cloudflare_configs
    .map((c: any) => normalizeCloudflareConfig(c))
    .filter((c: any) => c.account_id && c.api_key);
  settings.elevenlabs_keys = settings.elevenlabs_keys.map((k: any) => normalizeUsageEntry(k));
  if (settings.cerebras_keys.length === 0 && settings.lightning_keys.length > 0) {
    settings.cerebras_keys = settings.lightning_keys.map((k: any) => normalizeUsageEntry(k));
    settings.cerebras_rotation_index = Number(settings.lightning_rotation_index || 0);
    await saveSettingsPatch({
      cerebras_keys: settings.cerebras_keys,
      cerebras_rotation_index: settings.cerebras_rotation_index,
    });
  }
  settings.cerebras_keys = settings.cerebras_keys.map((k: any) => normalizeUsageEntry(k));

  const configuredImageModel = String(settings.cloudflare_image_model || '').trim();
  settings.cloudflare_image_model = configuredImageModel || DEFAULT_CF_IMAGE_MODEL;
  if (LEGACY_IMAGE_MODELS.has(settings.cloudflare_image_model)) {
    settings.cloudflare_image_model = DEFAULT_CF_IMAGE_MODEL;
    await saveSettingsPatch({ cloudflare_image_model: DEFAULT_CF_IMAGE_MODEL });
    console.log(`[automation] Migrated deprecated Cloudflare image model to ${DEFAULT_CF_IMAGE_MODEL}.`);
  }

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

function keyFingerprint(key: string) {
  const k = String(key || '');
  return k.length <= 8 ? k : `${k.slice(0, 4)}...${k.slice(-4)}`;
}

function markCloudflareRateLimited(key: string, retryMs: number) {
  const now = Date.now();
  const until = now + Math.max(5_000, retryMs);
  cloudflareRateLimitUntil.set(key, until);
  console.warn(`[automation] Cloudflare key ${keyFingerprint(key)} rate-limited; cooling down for ${Math.round((until - now) / 1000)}s`);
}

function markCerebrasRateLimited(key: string, retryMs: number) {
  const now = Date.now();
  const until = now + Math.max(5_000, retryMs);
  cerebrasRateLimitUntil.set(key, until);
  console.warn(`[automation] Cerebras key ${keyFingerprint(key)} rate-limited; cooling down for ${Math.round((until - now) / 1000)}s`);
}

async function waitForCerebrasKeyAvailability(keys: string[]) {
  const now = Date.now();
  const activeUntil = keys.map((key) => Number(cerebrasRateLimitUntil.get(key) || 0)).filter(Boolean);
  if (!activeUntil.length) return;
  const soonest = Math.min(...activeUntil);
  if (soonest > now) {
    const waitMs = Math.min(soonest - now, 90_000);
    await sleep(waitMs);
  }
}

async function waitForCloudflareKeyAvailability(keys: string[]) {
  const now = Date.now();
  const activeUntil = keys.map((key) => Number(cloudflareRateLimitUntil.get(key) || 0)).filter(Boolean);
  if (!activeUntil.length) return;
  const soonest = Math.min(...activeUntil);
  if (soonest > now) {
    const waitMs = Math.min(soonest - now, 90_000);
    await sleep(waitMs);
  }
}

async function pickRotatingKey(
  listName: 'cloudflare_configs' | 'elevenlabs_keys' | 'cerebras_keys',
  indexName: 'cloudflare_rotation_index' | 'elevenlabs_rotation_index' | 'cerebras_rotation_index',
) {
  const settings = await getSettings();
  const list = (settings[listName] || []).filter((item: any) => getEntryKey(item));
  if (listName === 'cloudflare_configs') {
    console.log(`[automation] Loaded Cloudflare configs total=${(settings[listName] || []).length}, usable=${list.length}`);
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
  listName: 'cloudflare_configs' | 'elevenlabs_keys' | 'cerebras_keys',
  indexName: 'cloudflare_rotation_index' | 'elevenlabs_rotation_index' | 'cerebras_rotation_index',
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

async function uploadToImgBB(fileBuffer: Buffer, fileName: string): Promise<string> {
  const settings = await getSettings();
  const apiKey = decryptSecret(settings.imgbb_api_key || '');
  if (!apiKey) throw new Error('No ImgBB API key configured. Add one at Settings → ImgBB.');
  const base64Image = fileBuffer.toString('base64');
  const form = new FormData();
  form.append('key', apiKey);
  form.append('image', base64Image);
  form.append('name', fileName.replace(/\.[^.]+$/, ''));
  const res = await axios.post('https://api.imgbb.com/1/upload', form, {
    headers: form.getHeaders(),
    timeout: 60000,
    ...outboundConfig(),
  });
  const url = String(res.data?.data?.url || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error(`ImgBB upload failed: ${JSON.stringify(res.data)}`);
  return url;
}

async function generateText(prompt: string, niche: string) {
  const initialSettings = await getSettings();
  const knownKeys = (initialSettings.cerebras_keys || []).map((entry: any) => getEntryKey(entry)).filter(Boolean);
  if (!knownKeys.length) throw new Error('No Cerebras API keys configured for text generation.');

  let lastError: any = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const selected = await pickRotatingKey('cerebras_keys', 'cerebras_rotation_index');
    const cooldownUntil = Number(cerebrasRateLimitUntil.get(selected.key) || 0);
    if (cooldownUntil > Date.now()) {
      await waitForCerebrasKeyAvailability(knownKeys.length ? knownKeys : [selected.key]);
    }
    try {
      const res = await axios.post(
        'https://api.cerebras.ai/v1/chat/completions',
        {
          model: CEREBRAS_TEXT_MODEL,
          temperature: 0.7,
          max_completion_tokens: 2048,
          messages: [
            { role: 'system', content: `You are a professional content creator for the ${niche} niche. Generate engaging, high-quality content.` },
            { role: 'user', content: prompt }
          ]
        },
        outboundConfig({ headers: { Authorization: `Bearer ${selected.key}`, 'Content-Type': 'application/json' }, timeout: 120000 })
      );

      await trackKeyUsage('cerebras_keys', 'cerebras_rotation_index', selected.key, true);
      const content = String(res.data?.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error('Cerebras text response was empty.');
      console.log(`[automation] Cerebras text key used: ${keyFingerprint(selected.key)} model=${CEREBRAS_TEXT_MODEL}`);
      return content;
    } catch (err: any) {
      lastError = err;
      await trackKeyUsage('cerebras_keys', 'cerebras_rotation_index', selected.key, false);
      const status = Number(err?.response?.status || 0);
      if (status === 429 || status === 503) {
        const retryMs = computeRetryDelayMs(err, attempt, 8_000, 180_000);
        markCerebrasRateLimited(selected.key, retryMs);
      }
      const transient = !status || status >= 500 || status === 429 || status === 503;
      if (attempt < 10 && transient) {
        await sleep(computeRetryDelayMs(err, attempt, 4_000, 180_000));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Text generation failed');
}

function stripSourceSectionsAndUrls(content: string) {
  if (!content) return '';

  let cleaned = content;

  // Remove markdown-like source/reference sections.
  cleaned = cleaned.replace(
    /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:sources?|references?|citations?)\s*:?\s*\n[\s\S]*$/i,
    '\n',
  );

  // Remove HTML heading sections titled Sources/References/Citations with their following list blocks.
  cleaned = cleaned.replace(
    /<h[1-6][^>]*>\s*(?:sources?|references?|citations?)\s*<\/h[1-6]>\s*(?:<(?:ul|ol)[^>]*>[\s\S]*?<\/(?:ul|ol)>|<p[^>]*>[\s\S]*?<\/p>)?/gi,
    '',
  );

  // Remove "Sources:" paragraph lines that contain links.
  cleaned = cleaned.replace(
    /<p[^>]*>\s*(?:sources?|references?|citations?)\s*:?\s*[\s\S]*?<\/p>/gi,
    '',
  );

  // Convert markdown style links [text](url) into HTML anchors.
  cleaned = cleaned.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Remove citation-only lines like [1], [2], etc.
  cleaned = cleaned.replace(/(?:^|\n)\s*\[\d+\]\s*$/gm, '');

  // Collapse empty list items/paragraphs created by cleaning.
  cleaned = cleaned.replace(/<li>\s*<\/li>/gi, '');
  cleaned = cleaned.replace(/<p>\s*<\/p>/gi, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

function canonicalizeParagraph(text: string) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, 'YEAR')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'NUM')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeExternalReferencesAndDuplicateParagraphs(content: string) {
  let cleaned = String(content || '');
  cleaned = cleaned.replace(/<a\b[^>]*href=["']https?:\/\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');
  cleaned = cleaned.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  cleaned = cleaned.replace(/<h[23][^>]*>\s*Related Reads[\s\S]*?<\/h[23]>\s*(?:<(?:ul|ol)[^>]*>[\s\S]*?<\/(?:ul|ol)>|<p[^>]*>[\s\S]*?<\/p>)?/gi, '');
  cleaned = cleaned.replace(/<(?:ul|ol)[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, (block) => /related reads|read more|companion|earlier posts/i.test(stripHtml(block)) ? '' : block);
  cleaned = cleaned.replace(/<p[^>]*>[\s\S]*?(?:for (?:a )?reference|read more|another useful|source:|sources:|references?:|citations?:|related reads|if you missed our earlier posts|visit\s+[^.]+website)[\s\S]*?<\/p>/gi, '');

  const seenExact = new Set<string>();
  const seenCanonical = new Set<string>();
  cleaned = cleaned.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (match, inner) => {
    const exact = stripHtml(inner).toLowerCase().replace(/\s+/g, ' ').trim();
    const canonical = canonicalizeParagraph(inner);
    if (!exact) return '';
    if (seenExact.has(exact) || seenCanonical.has(canonical)) return '';
    seenExact.add(exact);
    seenCanonical.add(canonical);
    return `<p>${stripHtml(inner)}</p>`;
  });

  cleaned = cleaned.replace(/<h2[^>]*>\s*([^<]+)\s*<\/h2>\s*(?=<h2|$)/gi, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function looksTruncated(content: string) {
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return true;
  if (plain.length < 1200) return true;

  const ending = plain.slice(-250);
  if (!/[.!?]"?$/.test(ending.trim())) return true;

  const unfinishedTail = /\b(?:and|or|to|with|of|for|in|on|by|that|which|is|are|was|were|has|have|had)\s*$/i;
  return unfinishedTail.test(plain);
}

const BANNED_PHRASES = [
  'enchanting', 'mesmerizing', 'awe-inspiring', 'testament to', 'nothing short of',
  'future generations', 'delve into', 'it is worth noting', 'tapestry', 'spellbound',
  'symphony of', 'ethereal', 'in conclusion', 'beckons us', 'odyssey', 'captivate'
];

function stripHtml(text: string) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function countWords(text: string) {
  return stripHtml(text).split(/\s+/).filter(Boolean).length;
}

function findBannedPhraseHits(content: string) {
  const lower = stripHtml(content).toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
}

function scrubBannedPhrases(content: string) {
  let output = String(content || '');
  for (const phrase of BANNED_PHRASES) {
    const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    output = output.replace(pattern, '');
  }
  return output;
}

function invalidHeaderText(header: string) {
  const h = header.trim();
  if (!h) return true;
  if (h.split(/\s+/).length > 8) return true;
  // Generic template/AI-sounding headers
  if (/\b(People|Real|Touch|Impact|Introduction|Conclusion|Relevance|Importance|Overview|Summary)\b/i.test(h)) return true;
  if (/^(section|step|instruction|template|how this|what this means|key discovery|main story|deeper insight|human impact|quick context|hook title|hook introduction)/i.test(h)) return true;
  // Common AI-generated filler headers that are not topic-specific
  if (/^(Why It Matters|What'?s Next|The Big Picture|Breaking It Down|What We Know|What This Means|Key Takeaway|Final Thoughts|In Summary|The Bottom Line|Going Forward|Looking Ahead|The Impact|The Basics|The Details|The Facts|The Story|The Science|The Research|The Evidence|The Context|The Background|The History|The Future|The Problem|The Solution|The Answer|The Question|The Truth|The Reality|The Result|The Findings|The Implications|The Significance)$/i.test(h)) return true;
  // Very short generic headers that are not topic-specific (less than 2 words that are too vague)
  if (h.split(/\s+/).length <= 2 && /^(Alert|Overview|Update|Analysis|Report|Story|Facts|News|Info|Details|Basics|Context|Background|History|Future|Problem|Solution|Answer|Question|Truth|Reality|Result|Findings|Impact|Significance|Conclusion|Summary|Introduction)$/i.test(h)) return true;
  return false;
}

function validateHeaders(content: string) {
  const headers = [...String(content || '').matchAll(/<h2[^>]*>\s*([^<]+)\s*<\/h2>/gi)].map((m) => String(m[1] || '').trim());
  return { ok: headers.length >= 6 && headers.every((h) => !invalidHeaderText(h)), headers };
}

function qualityGate(content: string, metaDescription: string) {
  const plain = stripHtml(content);
  const bannedHits = findBannedPhraseHits(content);
  const headerValidation = validateHeaders(content);
  const numbers = (plain.match(/\b\d+(?:\.\d+)?\s?(?:%|km|m|cm|mm|years?|million|billion)?\b/gi) || []).length;
  const locationSignals = (plain.match(/\b(?:in|at|near|off)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g) || []).length;
  const expertOrInstitution = /\b(?:University|Institute|NASA|NOAA|USGS|WHO|CDC|Harvard|MIT|Oxford)\b/.test(plain);
  const paragraphWordCap = [...String(content || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]).split(/\s+/).filter(Boolean).length)
    .every((c) => c <= 120);
  const imagesWithAlt = (content.match(/<img\b(?=[^>]*\bsrc=["'][^"']+["'])(?=[^>]*\balt=["'][^"']+["'])[^>]*>/gi) || []).length;
  const externalLinks = (content.match(/<a\b[^>]*href=["']https?:\/\/[^"']+["']/gi) || []).length;
  const anchorCount = (content.match(/<a\b[^>]*href=/gi) || []).length;
  const imageSrcSafe = !/<img\b[^>]*src=["'][^"']*(?:github\.com|githubusercontent|\/automation\/)[^"']*["']/i.test(content);

  const checks = [
    { label: 'Zero banned phrases detected in body text', pass: bannedHits.length === 0, detail: bannedHits.join(', ') || 'ok' },
    { label: 'No blocked header terms or instructional headers', pass: headerValidation.ok, detail: headerValidation.ok ? 'ok' : headerValidation.headers.join(' | ') },
    { label: 'Post contains minimum 4 specific numbers or statistics', pass: numbers >= 4, detail: `found=${numbers}` },
    { label: 'Post contains minimum 2 named real-world locations', pass: locationSignals >= 2, detail: `found=${locationSignals}` },
    { label: 'Post contains minimum 1 named expert or institution', pass: expertOrInstitution, detail: expertOrInstitution ? 'ok' : 'missing' },
    { label: 'Post word count is between 600 and 1,300', pass: countWords(content) >= 600 && countWords(content) <= 1300, detail: `words=${countWords(content)}` },
    { label: 'At least 1 real image embedded with non-empty alt text', pass: imagesWithAlt >= 1, detail: `found=${imagesWithAlt}` },
    { label: 'Image src URLs contain no /automation/ or GitHub strings', pass: imageSrcSafe, detail: imageSrcSafe ? 'ok' : 'unsafe image src' },
    { label: 'No external source links exposed in body', pass: externalLinks === 0, detail: `found=${externalLinks}` },
    { label: 'No article links injected into body', pass: anchorCount === 0, detail: `found=${anchorCount}` },
    { label: 'Meta description is present and 140-160 chars', pass: metaDescription.length >= 140 && metaDescription.length <= 160, detail: `len=${metaDescription.length}` },
    { label: 'Post closes with a question', pass: /\?$/.test(plain), detail: /\?$/.test(plain) ? 'ok' : 'missing ?' },
    { label: 'No paragraph exceeds 120 words', pass: paragraphWordCap, detail: paragraphWordCap ? 'ok' : 'paragraph over 120 words' },
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

function enforceParagraphLengthAndQuestion(content: string, topic: string) {
  let updated = String(content || '');
  updated = updated.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, inner) => {
    const text = stripHtml(inner);
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 120) return `<p>${inner}</p>`;
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 100) {
      chunks.push(words.slice(i, i + 100).join(' '));
    }
    return chunks.map((c) => `<p>${c}</p>`).join('');
  });
  const plain = stripHtml(updated);
  if (!/\?$/.test(plain)) {
    updated = `${updated}<p>What part of this story feels most likely to shape real-world decisions next, and why?</p>`;
  }
  return updated;
}

function buildEditorialFallbackHeadings(topic: string) {
  // Extract meaningful keywords from the topic for topic-specific headers
  const words = topic
    .replace(/[:\-–—]/g, ' ')
    .replace(/\b(the|a|an|and|or|in|on|of|to|is|are|was|were|that|this|it|with|for|by|at)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const key = words.slice(0, 3).join(' ') || topic.split(/\s+/).slice(0, 3).join(' ');
  const first = words[0] || 'It';
  return [
    `How ${key} Actually Works`,
    `The Data Behind ${first}`,
    `Where ${first} Is Changing Fast`,
    `What ${key} Gets Wrong`,
    `${first} in ${new Date().getFullYear()}: The Numbers`,
    `The Question ${first} Can't Answer Yet`,
  ];
}

function sanitizeHeaders(content: string, topic: string) {
  const replacements = buildEditorialFallbackHeadings(topic);
  let idx = 0;
  return String(content || '').replace(/<h2[^>]*>\s*([^<]+)\s*<\/h2>/gi, (_m, heading) => {
    const h = String(heading || '').trim();
    if (!invalidHeaderText(h)) return `<h2>${h}</h2>`;
    const replacement = replacements[Math.min(idx, replacements.length - 1)];
    idx += 1;
    return `<h2>${replacement}</h2>`;
  });
}

function contentOnlyGate(content: string) {
  const plain = stripHtml(content);
  const bannedHits = findBannedPhraseHits(content);
  const headersOk = validateHeaders(content).ok;
  const numbers = (plain.match(/\b\d+(?:\.\d+)?\s?(?:%|km|m|cm|mm|years?|million|billion)?\b/gi) || []).length;
  const locationSignals = (plain.match(/\b(?:in|at|near|off)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g) || []).length;
  const expertOrInstitution = /\b(?:University|Institute|NASA|NOAA|USGS|WHO|CDC|Harvard|MIT|Oxford)\b/.test(plain);
  const hasStudy = /\b(study|report|dataset|paper)\b/i.test(plain) && /\b(19|20)\d{2}\b/.test(plain);
  const words = countWords(content);
  const endsQuestion = /\?$/.test(plain);
  const paragraphsOk = [...String(content || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]).split(/\s+/).filter(Boolean).length)
    .every((c) => c <= 120);
  return bannedHits.length === 0 && headersOk && numbers >= 3 && locationSignals >= 1 && hasStudy && words >= 600 && words <= 1300 && endsQuestion && paragraphsOk;
}

const EXACT_JOURNAL_PROMPT = `
You are a professional journalist and science writer for a curious general audience. Write a compelling, human blog post about: [TOPIC]

MANDATORY RULES — follow every single one:

TONE & VOICE:
- Write like a knowledgeable friend explaining something fascinating, not a textbook or press release
- Use contractions naturally (it's, don't, you'll, they've)
- Vary sentence length — short punchy sentences mixed with longer ones
- Include at least one moment of genuine surprise or a subverted assumption
- Never use: enchanting, mesmerizing, awe-inspiring, testament to, nothing short of, future generations, delve into, tapestry, spellbound, odyssey, ethereal, beckons

STRUCTURE (follow this exact blueprint):
1. HOOK (1 paragraph): Open with ONE surprising specific fact or scenario. No scene-setting fluff. Make the reader stop scrolling.
2. THE SCIENCE / HOW IT WORKS (2 paragraphs): Clear explanation with real terminology. Assume the reader is smart but not an expert.
3. WHERE IN THE WORLD (1-2 paragraphs): Name specific real locations, events, or cases. Include at least 2 named places or examples.
4. THE SURPRISING PART (1-2 paragraphs): The angle most people don't know. A controversy, a counterintuitive finding, or an emerging challenge.
5. WHY IT MATTERS RIGHT NOW (1 paragraph): A concrete, specific reason this is relevant today — not vague "importance to humanity."
6. CLOSE WITH A QUESTION (1 paragraph): End with ONE direct, specific question that invites the reader to share an opinion or experience related to this exact topic.

FACTS REQUIRED:
- At least 4 specific facts with numbers, dates, or measurements
- At least 2 named real locations
- At least 1 named researcher, scientist, or institution
- At least 1 reference to a study or report (include year)

SECTION HEADERS — CRITICAL RULES:
- MUST reference the specific topic, place, discovery, or person in the article — generic headers are forbidden
- Maximum 7 words per header
- ABSOLUTELY FORBIDDEN headers (do not use these or anything similar):
  "Why It Matters", "What's Next", "The Big Picture", "Breaking It Down", "What We Know",
  "Introduction", "Conclusion", "Impact", "Overview", "Summary", "Analysis", "The Details",
  "The Facts", "The Story", "The Science", "Key Takeaway", "Final Thoughts", "Going Forward",
  "The Bottom Line", "The Truth", "Looking Ahead", "The Basics", "News Alert", "News Engine",
  "Global Reach", "Hidden Secrets", "The Research", "The Findings"
- GOOD header examples for a topic about "Antarctic Ice":
  "Thwaites Glacier's Hidden Drainage System", "When More Meltwater Slows The Ice",
  "Scientists Track The Ross Ice Shelf", "What 72 Hours Under Ice Revealed"
- Every header must feel like it belongs only to THIS article — not reusable for any other topic

LENGTH: 950–1,150 words exactly. No more.
`;

async function generateCleanCompleteArticle(topic: string, niche: string) {
  let fallbackDraft = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    const prompt = `${EXACT_JOURNAL_PROMPT.replace('[TOPIC]', topic)}
Return only valid HTML using this skeleton:
<h2>...</h2><p>...</p>
<h2>...</h2><p>...</p><p>...</p>
<h2>...</h2><p>...</p><p>...</p>
<h2>...</h2><p>...</p><p>...</p>
<h2>...</h2><p>...</p>
<h2>...</h2><p>...</p>
Use niche context: ${niche}.
Do not include source URLs, "read another website" instructions, or citation sections in the final article body.
If a fact cannot be confirmed, rewrite to a defensible general statement instead of adding placeholders.`;

    const draft = String(await generateText(prompt, niche) || '').trim();
    const cleaned = removeExternalReferencesAndDuplicateParagraphs(scrubBannedPhrases(stripSourceSectionsAndUrls(draft))).replace(/\[FACT NEEDED\]/g, '[FACT NEEDED]');
    fallbackDraft = cleaned || fallbackDraft;
    if (!contentOnlyGate(cleaned)) continue;
    return cleaned;
  }
  if (fallbackDraft) return fallbackDraft;
  throw new Error('Failed to generate article draft.');
}

function buildFallbackArticle(topic: string, _niche: string) {
  const root = topic.split(':')[0].trim();
  return `
<h2>${root} Starts Beneath The Surface</h2>
<p>Antarctica can look motionless from a satellite image, but some of its most important movement begins in total darkness. Beneath major glaciers, pressurized meltwater can change the friction between ice and bedrock, altering how quickly huge sections of ice move toward the coast.</p>
<p>That buried water is not a minor detail. In some parts of the ice sheet, drainage routes can connect inland basins to coastal outlets across distances greater than 100 kilometers, which means a shift deep below the surface can influence how stress moves through an entire glacier system.</p>
<h2>Why The Ice Base Keeps Changing</h2>
<p>Subglacial water forms when geothermal heat, pressure, and the friction of moving ice melt the glacier from below. Radar surveys, satellite altimetry, and GPS stations have shown that some Antarctic drainage systems fill and drain in pulses rather than staying stable from one season to the next.</p>
<p>During active drainage events, researchers have measured water moving at roughly 200 meters per hour, and some glacier speed changes have appeared within about 72 hours of a major pulse. That is fast enough to matter for short-term ice modeling, not just long-range climate projections.</p>
<p>Studies published in 2020 and 2023 helped push this issue into the spotlight by showing that changes at the glacier base can echo upward through hundreds of meters of ice. What happens out of sight can still leave a signal that satellites detect from orbit.</p>
<h2>Where Scientists See The Shift</h2>
<p>Much of the attention stays on Thwaites Glacier in West Antarctica, Pine Island Glacier near Pine Island Bay, and the ice streams feeding the Ross Ice Shelf. East Antarctica adds another piece of the puzzle through observations near Dome C and Lake Vostok, where deeper basal systems reveal how pressure behaves under very different terrain.</p>
<p>Taken together, those locations show the same basic truth: the underside of the ice sheet is not passive. It behaves more like a changing plumbing network that can redirect pressure, reorganize flow, and complicate otherwise neat predictions about glacier behavior.</p>
<p>Researchers working with NASA data and British Antarctic Survey field campaigns have reinforced that this is not a one-off curiosity. Similar patterns appearing in multiple Antarctic sectors suggest that hidden drainage is a structural part of the story, not background noise.</p>
<h2>When More Water Does Less</h2>
<p>The most surprising part is that more meltwater does not always mean faster ice loss. In some settings, a more organized drainage channel can move water efficiently enough to reduce lubrication and briefly slow local motion. In others, unstable routing allows pressure to build and pushes the ice forward faster.</p>
<p>That is why the old year-by-year shorthand often falls apart. The real question is not whether water exists under the ice, but how that water is routed, how pressure builds, and when the system reorganizes.</p>
<h2>Why This Matters Beyond Antarctica</h2>
<p>Sea-level planning depends on how confidently scientists can estimate near-term change as well as long-term risk. If hidden drainage systems can widen the uncertainty around ice movement, that uncertainty can ripple into coastal engineering, insurance models, port upgrades, and public infrastructure budgets expected to last for decades.</p>
<p>In practical terms, better polar monitoring can affect when a city raises a seawall, how an insurer prices flood exposure, or whether a planner assumes a narrow risk range or a much wider one. The rivers under Antarctic ice are far away, but the consequences of misunderstanding them may not stay there.</p>
<h2>What Should Be Watched Next?</h2>
<p>If these hidden rivers can either stabilize or destabilize glacier flow depending on how they reorganize, what deserves the closest watch next: faster field measurements, sharper public forecasts, or stronger coastal planning buffers, and is this a story more people should be talking about?</p>
`;
}

async function generateImage(prompt: string) {
  const initialSettings = await getSettings();
  const imageModel = initialSettings.cloudflare_image_model || DEFAULT_CF_IMAGE_MODEL;
  const knownKeys = (initialSettings.cloudflare_configs || []).map((entry: any) => getEntryKey(entry)).filter(Boolean);
  let lastError: any = null;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
    const cooldownUntil = Number(cloudflareRateLimitUntil.get(selected.key) || 0);
    if (cooldownUntil > Date.now()) {
      await waitForCloudflareKeyAvailability(knownKeys.length ? knownKeys : [selected.key]);
    }
    try {
      const res = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${selected.accountId}/ai/run/${imageModel}`,
        { prompt },
        outboundConfig({ headers: { Authorization: `Bearer ${selected.key}` }, responseType: 'arraybuffer', timeout: 120000 })
      );

      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
      const raw = Buffer.from(res.data);
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const payload = JSON.parse(raw.toString('utf8'));
        const b64 = String(payload?.result?.image || payload?.image || '').trim();
        if (!b64) throw new Error('Cloudflare image payload missing base64 image.');
        return Buffer.from(b64, 'base64');
      }
      return raw;
    } catch (err: any) {
      lastError = err;
      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
      if (isCloudflareDailyQuotaExhausted(err)) {
        throw new Error('Cloudflare Workers AI daily free allocation is exhausted for this account. Add a paid Workers AI account/key and retry.');
      }
      const status = Number(err?.response?.status || 0);
      if (status === 429) {
        const retryMs = computeRetryDelayMs(err, attempt, 8_000, 180_000);
        markCloudflareRateLimited(selected.key, retryMs);
      }
      const transient = !status || status >= 500 || status === 429;
      if (attempt < 10 && transient) {
        await sleep(computeRetryDelayMs(err, attempt, 4_000, 180_000));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Image generation failed');
}

function detectImageMime(buffer: Buffer) {
  if (!buffer || buffer.length < 8) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return '';
}

function assertRealGeneratedImage(buffer: Buffer, label: string) {
  if (!buffer || buffer.length < 20 * 1024) throw new Error(`${label} is invalid: image buffer is missing or too small.`);
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error(`${label} is invalid: unsupported or unknown image format.`);
  return mime;
}

function buildWorkersAiImagePrompt(topic: string, niche: string) {
  return [
    `Create a stunning, photorealistic blog cover photograph about: ${topic}.`,
    `Niche: ${niche}.`,
    'Style: cinematic documentary photography, dramatic natural lighting, rich depth of field, high-detail macro or wide-angle composition.',
    'The image must be completely free of ANY text, letters, numbers, words, captions, watermarks, logos, UI elements, labels, or signs.',
    'IMPORTANT: Do NOT render any written characters or text of any kind anywhere in the image.',
    'The scene should be visually compelling on its own — no overlay text needed.',
    'Leave the upper third and lower third of the image slightly less busy to allow for a title text overlay.',
    'Think National Geographic cover quality: real-world environments, genuine-looking subjects, vivid but natural colors.',
  ].join(' ');
}

async function generateWorkersAiImageWithRetry(topic: string, niche: string, maxAttempts = 6) {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const imageBuffer = await generateImage(buildWorkersAiImagePrompt(topic, niche));
      assertRealGeneratedImage(imageBuffer, `Workers AI image attempt ${attempt}`);
      return imageBuffer;
    } catch (error: any) {
      lastError = error;
      await sleep(computeRetryDelayMs(error, attempt, 3000, 120000));
    }
  }
  throw new Error(`Workers AI image generation failed after ${maxAttempts} attempts: ${String(lastError?.message || lastError)}`);
}

/**
 * Compresses a buffer so it is under GITHUB_MAX_BYTES (900 KB) for the GitHub Contents API.
 * Returns the original buffer if it is already small enough.
 */
async function compressForGithub(buf: Buffer): Promise<Buffer> {
  const GITHUB_MAX_BYTES = 900 * 1024;
  if (buf.length <= GITHUB_MAX_BYTES) return buf;
  let compressed = await sharp(buf)
    .resize({ width: 1280, height: 720, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, quality: 80 })
    .toBuffer();
  if (compressed.length <= GITHUB_MAX_BYTES) {
    console.log(`[automation] Compressed for GitHub: ${buf.length} → ${compressed.length} bytes`);
    return compressed;
  }
  compressed = await sharp(buf)
    .resize({ width: 1024, height: 576, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  console.log(`[automation] Compressed (JPEG fallback) for GitHub: ${buf.length} → ${compressed.length} bytes`);
  return compressed;
}

async function createFinalBlogImageOrThrow(topic: string, niche: string, settings: any) {
  const githubPat = decryptSecret(settings.github_pat || '');
  const githubRepo = String(settings.github_repo || '').trim();
  const imgbbApiKey = decryptSecret(settings.imgbb_api_key || '');
  if (!githubPat) throw new Error('Missing github_pat setting for title overlay workflow.');
  if (!githubRepo) throw new Error('Missing github_repo setting for title overlay workflow.');
  if (!imgbbApiKey) console.warn('[automation] imgbb_api_key is not set — image will be uploaded to GitHub as fallback.');

  // ── 1. Generate image ──────────────────────────────────────────────────────
  const workersImage = await generateWorkersAiImageWithRetry(topic, niche, 6);
  assertRealGeneratedImage(workersImage, 'Workers AI image');

  // ── 2. Upload compressed source to GitHub (Contents API limit: ~1 MB) ──────
  const ts = Date.now();
  const sourceImagePath = `automation/incoming/workers-ai-${ts}.png`;
  const githubSourceImage = await compressForGithub(workersImage);
  const githubDownloadUrl = await uploadBufferToGithub(githubRepo, githubPat, githubSourceImage, sourceImagePath, `Upload Workers AI source image: ${topic}`);

  // ── 3. Build sourceImageUrl — try ImgBB first, fall back to GitHub URL ────
  const { owner: ghOwner, name: ghName } = parseGithubRepo(githubRepo);
  const githubRawFallback = `https://raw.githubusercontent.com/${ghOwner}/${ghName}/main/${sourceImagePath}`;
  let sourceImageUrl = '';
  if (imgbbApiKey) {
    try {
      sourceImageUrl = await uploadToImgBB(workersImage, `workers-ai-${ts}.png`);
      console.log(`[automation] Source image uploaded to ImgBB: ${sourceImageUrl}`);
    } catch (imgbbErr: any) {
      console.warn(`[automation] ImgBB source upload failed (${imgbbErr?.message}); using GitHub URL as fallback.`);
      sourceImageUrl = githubDownloadUrl || githubRawFallback;
    }
  } else {
    console.warn('[automation] No ImgBB API key — using GitHub URL for source image.');
    sourceImageUrl = githubDownloadUrl || githubRawFallback;
  }
  if (!/^https?:\/\/.+/i.test(sourceImageUrl)) throw new Error('Could not obtain a valid source image URL (ImgBB and GitHub both failed).');

  // ── 4. Dispatch GitHub Actions overlay workflow ───────────────────────────
  const correlationId = await dispatchTitleOverlayWorkflow(githubRepo, githubPat, sourceImageUrl, sourceImagePath, topic, imgbbApiKey);

  // ── 5. Download the overlay artifact ─────────────────────────────────────
  const overlayResult = await waitForOverlayArtifact(githubRepo, githubPat, correlationId);
  if (overlayResult.overlayBuffer.length > 0) {
    assertRealGeneratedImage(overlayResult.overlayBuffer, 'Overlay output image');
  }

  // ── 6. Resolve finalImageUrl — prefer what the workflow returned (ImgBB),
  //       but fall back: try uploading from Replit to ImgBB, then GitHub. ────
  let finalImageUrl = overlayResult.finalImageUrl;
  const overlayAvailable = overlayResult.overlayBuffer.length > 0;
  if (!/^https?:\/\/.+/i.test(finalImageUrl)) {
    if (overlayAvailable) {
      console.warn('[automation] finalImageUrl from overlay workflow is empty/invalid — uploading overlay from Replit.');
    } else {
      console.warn('[automation] Overlay workflow produced no artifact — using source image as final image.');
      finalImageUrl = sourceImageUrl;
    }
    if (overlayAvailable && imgbbApiKey) {
      try {
        finalImageUrl = await uploadToImgBB(overlayResult.overlayBuffer, `overlay-${correlationId}.png`);
        console.log(`[automation] Overlay uploaded to ImgBB from Replit: ${finalImageUrl}`);
      } catch (imgbbErr: any) {
        console.warn(`[automation] ImgBB overlay upload failed (${imgbbErr?.message}); falling back to GitHub.`);
      }
    }
    if (overlayAvailable && !/^https?:\/\/.+/i.test(finalImageUrl)) {
      const overlayPath = `automation/results/overlay-${correlationId}.png`;
      const githubOverlayImage = await compressForGithub(overlayResult.overlayBuffer);
      finalImageUrl = await uploadBufferToGithub(githubRepo, githubPat, githubOverlayImage, overlayPath, `Upload overlay result: ${topic}`);
      console.log(`[automation] Overlay uploaded to GitHub: ${finalImageUrl}`);
    }
  }
  if (!/^https?:\/\/.+/i.test(finalImageUrl)) throw new Error('Could not obtain a valid final image URL (ImgBB and GitHub both failed).');

  return { sourceImageUrl, finalImageUrl };
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


const TOPIC_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'into', 'is', 'it',
  'its', 'new', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'what', 'when', 'where',
  'why', 'with', 'after', 'before', 'latest', 'breaking', 'trending', 'report', 'reports', 'study',
  'studies', 'reveals', 'reveal', 'shows', 'show', 'could', 'may', 'might', 'over', 'under',
]);

function normalizeTopicText(text: string) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicTokens(text: string) {
  return normalizeTopicText(text).split(' ').filter(Boolean);
}

function extractTopicKeywords(text: string) {
  return topicTokens(text)
    .filter((token) => token.length >= 3 && !TOPIC_STOPWORDS.has(token))
    .slice(0, 12);
}

function extractTopicEntities(text: string) {
  const matches = String(text || '').match(/\b(?:[A-Z][a-z]+|[A-Z]{2,}|\d{4})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|\d{4})){0,3}\b/g) || [];
  return matches
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === entry.toLowerCase()) === index)
    .slice(0, 8);
}

function buildTopicThemeSignature(text: string) {
  const keywords = extractTopicKeywords(text);
  return Array.from(new Set(keywords)).sort().slice(0, 6);
}

function overlapRatio(a: Iterable<string>, b: Iterable<string>) {
  const aa = new Set(Array.from(a).filter(Boolean));
  const bb = new Set(Array.from(b).filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter((value) => bb.has(value)).length;
  return intersection / Math.min(aa.size, bb.size);
}

function jaccardSimilarity(a: string, b: string) {
  const aa = new Set(topicTokens(a));
  const bb = new Set(topicTokens(b));
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter((x) => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size;
  return union ? intersection / union : 0;
}

function bigramSimilarity(a: string, b: string) {
  const toBigrams = (value: string) => {
    const tokens = topicTokens(value);
    const grams = [];
    for (let i = 0; i < tokens.length - 1; i += 1) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
    return grams;
  };
  return overlapRatio(toBigrams(a), toBigrams(b));
}

function topicSimilaritySignals(candidate: string, previous: string) {
  const normalizedCandidate = normalizeTopicText(candidate);
  const normalizedPrevious = normalizeTopicText(previous);
  const keywordOverlap = overlapRatio(extractTopicKeywords(candidate), extractTopicKeywords(previous));
  const entityOverlap = overlapRatio(
    extractTopicEntities(candidate).map((value) => value.toLowerCase()),
    extractTopicEntities(previous).map((value) => value.toLowerCase()),
  );
  const themeOverlap = overlapRatio(buildTopicThemeSignature(candidate), buildTopicThemeSignature(previous));
  const lexicalSimilarity = jaccardSimilarity(normalizedCandidate, normalizedPrevious);
  const phraseSimilarity = bigramSimilarity(candidate, previous);
  const sameLeadingTheme = buildTopicThemeSignature(candidate).join('|') === buildTopicThemeSignature(previous).join('|');
  return {
    normalizedCandidate,
    normalizedPrevious,
    keywordOverlap,
    entityOverlap,
    themeOverlap,
    lexicalSimilarity,
    phraseSimilarity,
    sameLeadingTheme,
  };
}

async function semanticDuplicateCheck(candidate: string, previousTopics: string[], niche: string) {
  if (!previousTopics.length) return '';
  try {
    const response = await generateText(
      [
        `Candidate topic: ${candidate}`,
        'Existing topics:',
        ...previousTopics.map((topic, index) => `${index + 1}. ${topic}`),
        '',
        'If the candidate is the same event, same core subject, or a near-duplicate of any existing topic, return only the exact matching existing topic.',
        'If none are near-duplicates, return only NONE.',
      ].join('\n'),
      niche,
    );
    const normalized = String(response || '').trim();
    if (!normalized || /^none$/i.test(normalized)) return '';
    return previousTopics.find((topic) => normalizeTopicText(topic) === normalizeTopicText(normalized)) || '';
  } catch {
    return '';
  }
}

function buildTrendingQueriesForNiche(niche: string) {
  const generic = [
    niche,
    `${niche} latest news`,
    `${niche} trending story`,
    `${niche} breaking discovery`,
    `${niche} research update`,
    `${niche} surprising discovery`,
    `${niche} expert analysis`,
    `${niche} science news`,
    `${niche} investigation`,
    `${niche} viral topic`,
  ];

  const nicheSpecific: Record<string, string[]> = {
    'Weird Facts & Discoveries': [
      'strange discovery',
      'bizarre science discovery',
      'ancient mystery discovery',
      'space mystery discovery',
      'ocean mystery discovery',
      'archaeology surprise find',
      'antarctica discovery',
      'fossil discovery',
      'unexpected research finding',
      'rare natural phenomenon',
      'hidden underground discovery',
      'unusual wildlife discovery',
    ],
    'Scary / Mysterious / True Crime': [
      'true crime case update',
      'cold case breakthrough',
      'mystery investigation',
      'forensic discovery',
      'criminal case timeline',
      'unexplained case report',
      'mysterious disappearance update',
      'court filing crime case',
      'evidence breakthrough',
      'detective investigation news',
    ],
    'AI Tools & Technology': [
      'AI product launch',
      'LLM release',
      'AI startup funding',
      'developer tool update',
      'open source AI release',
      'robotics breakthrough',
      'tech platform launch',
      'software release notes',
      'cloud AI feature',
      'automation platform update',
    ],
    'Life Hacks & Tips': [
      'productivity study',
      'consumer tip trend',
      'home organization idea',
      'money saving technique',
      'travel hack',
      'kitchen hack',
      'phone setting tip',
      'work routine improvement',
      'shopping trick',
      'time saving method',
    ],
    'Viral Entertainment': [
      'celebrity trend',
      'streaming hit',
      'movie surprise',
      'music viral moment',
      'social media trend',
      'entertainment rumor clarified',
      'fan theory trend',
      'festival headline',
      'tv finale reaction',
      'internet culture trend',
    ],
    'Health & Wellness Hacks': [
      'wellness study',
      'nutrition trend',
      'sleep research',
      'fitness science',
      'mental health strategy',
      'longevity research',
      'healthy habit study',
      'exercise finding',
      'diet research update',
      'stress management study',
    ],
  };

  return Array.from(new Set([...(nicheSpecific[niche] || []), ...generic])).slice(0, 24);
}

async function fetchTrendingTopicsForNiche(niche: string) {
  const extractTitles = (xml: string) => {
    return [...String(xml || '').matchAll(/<title(?:\s[^>]*)?>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/gi)]
      .map((m) => String(m[1] || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim())
      .filter(Boolean);
  };
  const fetchRssTitles = async (url: string) => {
    const res = await axios.get(url, outboundConfig({
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlogAutomator/1.0; +https://github.com/Joshbond123/Blog-Automator)' },
    }));
    return extractTitles(String(res.data || ''));
  };

  const queries = buildTrendingQueriesForNiche(niche);
  const collected: string[] = [];
  const webFeeds = [
    'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
    'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml',
    'https://www.sciencedaily.com/rss/top/science.xml',
    'https://www.livescience.com/feeds/all',
    'https://www.sciencealert.com/feed',
  ];

  for (const query of queries) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const matches = await fetchRssTitles(rssUrl);
      const topicTitles = matches.slice(1, 16);
      collected.push(...topicTitles);
    } catch {
      // continue with remaining feeds
    }
  }

  for (const feedUrl of webFeeds) {
    try {
      const matches = await fetchRssTitles(feedUrl);
      collected.push(...matches.slice(1, 30));
    } catch {
      // continue with other web feeds
    }
  }

  const deduped: string[] = [];
  for (const topic of collected) {
    const normalized = normalizeTopicText(topic);
    if (!normalized) continue;
    if (deduped.some((existing) => normalizeTopicText(existing) === normalized)) continue;
    deduped.push(topic);
    if (deduped.length >= 120) break;
  }
  return deduped.slice(0, 100);
}

async function loadHistoricalTopicsForNiche(supabase: any, niche: string) {
  const [topicsRes, postsRes] = await Promise.all([
    supabase.from('topics').select('title,created_at').eq('niche', niche).order('created_at', { ascending: false }).limit(800),
    supabase.from('posts').select('title,published_at').eq('niche', niche).order('published_at', { ascending: false }).limit(800),
  ]);

  const combined = [
    ...((topicsRes.data || []).map((row: any) => row.title)),
    ...((postsRes.data || []).map((row: any) => row.title)),
  ].filter(Boolean);

  return Array.from(new Set(combined.map((title: string) => title.trim()).filter(Boolean)));
}

async function findDuplicateTopicMatch(candidate: string, historicalTopics: string[], niche: string) {
  const borderline: string[] = [];

  for (const previous of historicalTopics) {
    const signals = topicSimilaritySignals(candidate, previous);
    if (!signals.normalizedCandidate || !signals.normalizedPrevious) continue;

    if (signals.normalizedCandidate === signals.normalizedPrevious) return previous;
    if (signals.keywordOverlap >= 0.85 && signals.entityOverlap >= 0.6) return previous;
    if (signals.entityOverlap >= 0.75 && signals.themeOverlap >= 0.65) return previous;
    if (signals.lexicalSimilarity >= 0.8 || signals.phraseSimilarity >= 0.7) return previous;
    if (signals.sameLeadingTheme && (signals.keywordOverlap >= 0.72 || signals.themeOverlap >= 0.8)) return previous;

    const moderateMatch = signals.keywordOverlap >= 0.55 || signals.entityOverlap >= 0.45 || signals.themeOverlap >= 0.65 || signals.lexicalSimilarity >= 0.6;
    if (moderateMatch) borderline.push(previous);
  }

  if (borderline.length) {
    const semanticMatch = await semanticDuplicateCheck(candidate, borderline.slice(0, 8), niche);
    if (semanticMatch) return semanticMatch;
  }

  return '';
}

async function pickUniqueTrendingTopic(supabase: any, niche: string) {
  const candidates = await fetchTrendingTopicsForNiche(niche);
  if (candidates.length < 100) {
    console.warn(`[automation] Trending topic fetch returned ${candidates.length} unique candidates for niche="${niche}".`);
  }

  const historicalTopics = await loadHistoricalTopicsForNiche(supabase, niche);
  const rejected: Array<{ candidate: string; matched: string }> = [];

  for (const candidate of candidates) {
    const match = await findDuplicateTopicMatch(candidate, historicalTopics, niche);
    if (match) {
      rejected.push({ candidate, matched: match });
      continue;
    }
    console.log(`[automation] Selected unique topic after reviewing ${candidates.length} candidates and ${historicalTopics.length} historical topics.`);
    if (rejected.length) {
      console.log(`[automation] Rejected ${rejected.length} duplicate or near-duplicate candidates before selecting topic.`);
    }
    return candidate;
  }

  throw new Error(`Unable to find a unique topic for niche="${niche}" after checking ${candidates.length} trending candidates against ${historicalTopics.length} historical topics.`);
}

async function rewriteToViralTitle(topic: string, niche: string) {
  const bannedLeadPattern = /^(Breaking News|Breaking:|Alert:|Exclusive:|BREAKING|Revealed:|Discover:|Uncover:|Hidden Secrets:?|The Ultimate)/i;
  const raw = await generateText(
    `You are a headline editor at a major digital publication. Rewrite the topic below into ONE punchy, human-sounding blog headline.

STRICT RULES:
- Maximum 12 words
- Must sound like a real journalist wrote it — natural, specific, conversational
- NEVER start with: "Breaking News", "Alert", "Exclusive", "Revealed", "Discover", "Uncover", "Hidden", "Secrets", "Ultimate", "The Truth About", "You Won't Believe", "Top [number]", "Shocking"
- NEVER use colons followed by generic phrases like "What You Need to Know" or "Here's Why"
- NO question marks in the title
- NO ALL CAPS words
- NO hashtags or emojis
- Be direct and specific about the actual subject matter
- Sound like something The Atlantic or BBC News would publish
- Return ONLY the headline. No quotes. No explanation.

Topic: ${topic}`,
    niche,
  );
  // Strip any remaining AI-generated prefixes or formatting
  let title = String(raw || topic).trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^(Breaking News[\s:]*|Alert[\s:]*|Exclusive[\s:]*|BREAKING[\s:]*)/i, '')
    .replace(/^(Shocking[\s:]*|Revealed[\s:]*|Uncover[\s:]*|Discover[\s:]*)/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // If the result looks bad (too long, empty, or still has AI junk), build a safer fallback from the raw topic.
  if (!title || title.split(/\s+/).length > 16 || bannedLeadPattern.test(title)) {
    title = String(topic)
      .replace(bannedLeadPattern, '')
      .replace(/\s*-\s*The Ultimate Source of Real-Time Information!?/gi, '')
      .replace(/\s*[:\-–—]\s*(What You Need to Know|Here's Why)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  if (!title || title.split(/\s+/).length < 4 || title.split(/\s+/).length > 16 || bannedLeadPattern.test(title)) {
    throw new Error(`Generated title failed humanization checks. topic="${topic}" generated="${raw}"`);
  }
  return title;
}

function deterministicTopicHashtags(topic: string) {
  const entities = extractTopicEntities(topic)
    .map((entry) => `#${entry.replace(/[^A-Za-z0-9]+/g, '')}`)
    .filter((entry) => entry.length > 3);
  const keywords = extractTopicKeywords(topic)
    .map((entry) => `#${entry.split(/[^a-z0-9]+/i).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`)
    .filter((entry) => entry.length > 3);
  const viralized = [
    ...entities,
    ...keywords,
    ...keywords.map((entry) => `${entry}Alert`),
    ...keywords.map((entry) => `${entry}Watch`),
    ...entities.map((entry) => `${entry}Mystery`),
  ];

  const unique = Array.from(new Set(viralized.map((value) => value.replace(/#+/g, '#').replace(/[^#A-Za-z0-9]/g, ''))))
    .filter((value) => /^#[A-Za-z0-9]{4,32}$/.test(value));

  return unique.slice(0, 5);
}

async function generateViralHashtags(topic: string, niche: string, content: string) {
  const deterministic = deterministicTopicHashtags(topic);
  try {
    const response = await generateText(
      [
        `Topic: ${topic}`,
        `Niche context: ${niche}`,
        `Article preview: ${stripHtml(content).slice(0, 500)}`,
        'Generate exactly 5 viral-style hashtags for this blog post.',
        'Rules: output only hashtags, no numbering, no commentary, no generic tags like #Viral or #Trending unless they are topic-specific.',
      ].join('\n'),
      niche,
    );
    const parsed = Array.from(new Set((String(response || '').match(/#[A-Za-z0-9]+/g) || []).map((value) => value.trim())));
    if (parsed.length === 5) return parsed;
  } catch {
    // fall back to deterministic hashtags
  }

  if (deterministic.length >= 5) return deterministic.slice(0, 5);
  const filler = ['#DeepDiveStory', '#ScienceWatch', '#StoryBehindTheIce', '#DiscoveryAlert', '#GlobalSignals'];
  return Array.from(new Set([...deterministic, ...filler])).slice(0, 5);
}

function injectHashtagBlock(content: string, hashtags: string[]) {
  const block = `<p><strong>${hashtags.join(' ')}</strong></p>`;
  const paragraphs = [...String(content || '').matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)];
  if (!paragraphs.length) return `${content}${block}`;
  const last = paragraphs[paragraphs.length - 1];
  const start = last.index || 0;
  return `${content.slice(0, start)}${block}${content.slice(start)}`;
}

function buildFacebookTeaser(fullContent: string, topic: string, niche: string, hashtags: string[], blogUrl: string) {
  const plain = fullContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const teaser = plain.slice(0, 280);
  const hashtagBase = hashtags.slice(0, 5).join(' ') || deterministicTopicHashtags(topic).slice(0, 5).join(' ');

  return `${teaser}...

Read the full article in the comments 👇
${hashtagBase}`;
}

type BloggerAuthBundle = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshedAt: string;
};

async function loadBloggerOAuthCredentials() {
  const settings = await getSettings();
  const clientId = decryptSecret(settings.blogger_client_id);
  const clientSecret = decryptSecret(settings.blogger_client_secret);
  const refreshToken = decryptSecret(settings.blogger_refresh_token);

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Blogger OAuth credentials are missing in Supabase settings.');
  }

  return { clientId, clientSecret, refreshToken };
}

async function refreshBloggerAccessToken() {
  const credentials = await loadBloggerOAuthCredentials();
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  });

  const tokenRes = await axios.post(
    'https://oauth2.googleapis.com/token',
    body.toString(),
    outboundConfig({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    }),
  );

  const accessToken = String(tokenRes.data?.access_token || '').trim();
  if (!accessToken) {
    throw new Error('Google OAuth did not return an access token for Blogger.');
  }

  return {
    accessToken,
    tokenType: String(tokenRes.data?.token_type || 'Bearer'),
    expiresIn: Number(tokenRes.data?.expires_in || 0),
    refreshedAt: new Date().toISOString(),
  } satisfies BloggerAuthBundle;
}

function bloggerAuthHeaders(bundle: BloggerAuthBundle) {
  return { Authorization: `${bundle.tokenType || 'Bearer'} ${bundle.accessToken}` };
}

async function createVerifiedBloggerClient(blogId: string) {
  const auth = await refreshBloggerAccessToken();
  const verifyRes = await axios.get(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}`,
    outboundConfig({ headers: bloggerAuthHeaders(auth), timeout: 30000 }),
  );

  return {
    auth,
    blog: verifyRes.data,
    headers: bloggerAuthHeaders(auth),
  };
}

async function publishToBlogger(blogId: string, title: string, content: string, auth: BloggerAuthBundle, options?: { publishAt?: string; labels?: string[] }) {
  const payload: any = { kind: 'blogger#post', title, content };
  if (options?.publishAt) payload.published = options.publishAt;
  if (options?.labels && options.labels.length > 0) {
    // Strip '#' prefix for Blogger labels (tags)
    payload.labels = options.labels.map((l) => l.replace(/^#/, '').trim()).filter(Boolean);
  }

  const res = await axios.post(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
    payload,
    outboundConfig({ headers: bloggerAuthHeaders(auth) })
  );
  return res.data;
}

async function fetchBloggerPost(blogId: string, postId: string, auth: BloggerAuthBundle) {
  const res = await axios.get(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    outboundConfig({ headers: bloggerAuthHeaders(auth) })
  );
  return res.data;
}

async function updateBloggerPost(blogId: string, postId: string, title: string, content: string, auth: BloggerAuthBundle) {
  const res = await axios.put(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    { kind: 'blogger#post', id: postId, title, content },
    outboundConfig({ headers: bloggerAuthHeaders(auth) })
  );
  return res.data;
}

function hasVisibleUrlsOrSources(content: string) {
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:sources?|references?|citations?)\b/i.test(plain)) return true;
  if (/https?:\/\/\S+/i.test(plain)) return true;
  if (/\bwww\.\S+/i.test(plain)) return true;
  if (/Related Reads|read another website|for a current reference|another useful scientific index|if you missed our earlier posts/i.test(plain)) return true;
  if (/<a\b[^>]*href=/i.test(content)) return true;
  return false;
}

function buildScheduleMetadataStatus(metadata: any, status: string) {
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    last_executed_at: new Date().toISOString(),
    last_execution_status: status,
  };
}

async function fetchRelatedInternalLinks(_blogId: string, _topic: string, _limit = 3) {
  return [];
}

function injectInternalLinks(content: string, _links: Array<{ title: string; url: string }>) {
  return content;
}

function buildMetaDescription(title: string, content: string) {
  const plain = stripHtml(content).replace(/\s+/g, ' ').trim();
  const base = `${title}: ${plain}`.slice(0, 160);
  return base.length < 140 ? `${base} Discover the latest data and what it means now.`.slice(0, 160) : base;
}

function injectSeoMetaTags(title: string, content: string, imageUrl: string, blogName: string) {
  const metaDescription = buildMetaDescription(title, content);
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDescription = metaDescription.replace(/"/g, '&quot;');
  const publishedAt = new Date().toISOString();
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "datePublished": publishedAt,
    "author": { "@type": "Organization", "name": blogName },
  };
  const block = `
<meta name="description" content="${safeDescription}" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" />
<meta property="og:image" content="${imageUrl}" />
<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return { html: `${block}${content}`, metaDescription };
}

function parseGithubRepo(value: string) {
  const repo = String(value || '').trim();
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('Invalid github_repo setting. Expected "owner/repo".');
  return { owner, name, repo };
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function uploadBufferToGithub(repo: string, token: string, buffer: Buffer, path: string, message: string) {
  const { owner, name } = parseGithubRepo(repo);
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const res = await axios.put(
    `https://api.github.com/repos/${owner}/${name}/contents/${encodedPath}`,
    { message, content: buffer.toString('base64') },
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );
  const url = String(res.data?.content?.download_url || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('GitHub upload did not return a public download URL.');
  return url;
}

async function dispatchTitleOverlayWorkflow(repo: string, token: string, sourceImageUrl: string, sourceImagePath: string, title: string, imgbbApiKey: string) {
  const { owner, name } = parseGithubRepo(repo);
  const correlationId = `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await axios.post(
    `https://api.github.com/repos/${owner}/${name}/dispatches`,
    {
      event_type: 'title_overlay',
      client_payload: {
        sourceImageUrl,
        sourceImagePath,
        title,
        imgbbApiKey,
        correlationId,
      },
    },
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );

  return correlationId;
}

async function waitForOverlayArtifact(repo: string, token: string, correlationId: string) {
  const { owner, name } = parseGithubRepo(repo);
  const startedAt = Date.now();
  let runId = '';
  const expectedRunName = `Title Overlay Renderer - ${correlationId}`;

  for (let i = 0; i < 36; i++) {
    const runsRes = await axios.get(
      `https://api.github.com/repos/${owner}/${name}/actions/runs?event=repository_dispatch&per_page=10`,
      outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
    );

    const runs = Array.isArray(runsRes.data?.workflow_runs) ? runsRes.data.workflow_runs : [];
    const candidate = runs.find((run: any) => {
      const created = Date.parse(run?.created_at || '');
      const title = String(run?.display_title || run?.name || '').trim();
      return title === expectedRunName && created >= startedAt - 60_000;
    });
    if (candidate) {
      runId = String(candidate.id);
      const status = String(candidate.status || '');
      const conclusion = String(candidate.conclusion || '');
      if (status === 'completed' && conclusion !== 'success') {
        console.warn(`[automation] Overlay workflow concluded=${conclusion}; falling back to Replit overlay upload.`);
        return { overlayBuffer: Buffer.alloc(0), finalImageUrl: '' };
      }
      if (status === 'completed' && conclusion === 'success') break;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!runId) throw new Error('Overlay workflow run was not found.');

  const artifactsRes = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts`,
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );
  const artifact = (artifactsRes.data?.artifacts || []).find((a: any) => a?.name === `title-overlay-result-${correlationId}`);
  if (!artifact?.archive_download_url) throw new Error('Overlay artifact not found.');

  const zipRes = await axios.get(artifact.archive_download_url, outboundConfig({
    headers: githubHeaders(token),
    responseType: 'arraybuffer',
    timeout: 60000,
  }));
  const zipBuf = Buffer.from(zipRes.data);
  const zip = new AdmZip(zipBuf);
  const resultEntry = zip.getEntry('result.json');
  if (!resultEntry) throw new Error('result.json not found in overlay artifact zip.');
  const pngEntry = zip.getEntry('final-overlay.png');
  if (!pngEntry) throw new Error('final-overlay.png not found in overlay artifact zip.');
  const resultPayload = JSON.parse(resultEntry.getData().toString('utf8'));
  if (String(resultPayload?.correlationId || '') !== correlationId) {
    throw new Error('Overlay artifact correlation mismatch.');
  }
  const overlayBuffer = pngEntry.getData();
  if (overlayBuffer.length < 15 * 1024) throw new Error('Overlay image artifact is too small.');
  return { overlayBuffer, finalImageUrl: String(resultPayload?.finalImageUrl || '').trim() };
}

async function publishToFacebook(pageId: string, accessToken: string, message: string, imageUrl?: string) {
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/photos`,
      { caption: message, url: imageUrl, access_token: accessToken },
      outboundConfig(),
    );
    return res.data;
  }
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message, access_token: accessToken },
    outboundConfig(),
  );
  return res.data;
}

export async function runBlogAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
  if (!schedule) return;

  const { data: account } = await supabase.from('blogger_accounts').select('*').eq('id', schedule.target_id).single();
  if (!account) {
    await supabase
      .from('schedules')
      .update({ metadata: buildScheduleMetadataStatus(schedule.metadata, 'failed: missing blogger account') })
      .eq('id', scheduleId);
    return;
  }

  const niche = account.niche;
  const settings = await getSettings();

  try {
    const forcedTopic = String((schedule?.metadata as any)?.forced_topic || '').trim() || process.env.FORCED_TOPIC || '';
    const discoveredTopic = forcedTopic || await pickUniqueTrendingTopic(supabase, niche);
    let topic = discoveredTopic;
    if (!forcedTopic) {
      try {
        topic = await rewriteToViralTitle(discoveredTopic, niche);
      } catch (titleError: any) {
        const status = Number(titleError?.response?.status || 0);
        if (status === 429) {
          console.warn('[automation] Cloudflare text generation rate-limited during title rewrite; using discovered topic as title fallback.');
          topic = discoveredTopic;
        } else {
          throw titleError;
        }
      }
    }
    let content = '';
    try {
      content = await generateCleanCompleteArticle(topic, niche);
    } catch (contentError: any) {
      const status = Number(contentError?.response?.status || 0);
      if (status === 429) {
        console.warn('[automation] Cloudflare text generation rate-limited; using deterministic fallback article for this run.');
        content = buildFallbackArticle(topic, niche);
      } else {
        throw contentError;
      }
    }
    if (looksTruncated(content)) {
      throw new Error('Generated article failed completeness/structure validation.');
    }
    const cleanedArticle = removeExternalReferencesAndDuplicateParagraphs(content);

    // Generate hashtags — these go ONLY to Blogger labels, NEVER into the article body
    const hashtags = await generateViralHashtags(topic, niche, cleanedArticle);

    // Strict pre-publish content validation
    const articlePlain = stripHtml(cleanedArticle);
    if (/#[A-Za-z0-9]+/.test(articlePlain)) {
      throw new Error('Pre-publish validation failed: article body contains hashtags. Hashtags must only appear as Blogger labels.');
    }
    if (/^(Breaking News|Breaking:|Alert:|Exclusive:|BREAKING|Revealed:|Discover:|Uncover:|Hidden Secrets:?|The Ultimate)/i.test(topic.trim())) {
      throw new Error(`Pre-publish validation failed: title "${topic}" uses forbidden AI-generated prefix.`);
    }
    if (topic.split(/\s+/).length > 18) {
      throw new Error(`Pre-publish validation failed: title too long (${topic.split(/\s+/).length} words). Max 18.`);
    }
    if (topic.split(/\s+/).length < 4) {
      throw new Error(`Pre-publish validation failed: title "${topic}" is too short to be a natural headline.`);
    }
    if (/(?:hidden secrets|ultimate source|you won't believe|what you need to know|here'?s why)/i.test(topic)) {
      throw new Error(`Pre-publish validation failed: title "${topic}" contains AI-style clickbait phrasing.`);
    }
    const repeatedPhraseMatch = articlePlain.match(/\b(\w+(?:\s+\w+){0,3})\b(?:[\s,.;:!?-]+\1\b){2,}/i);
    if (repeatedPhraseMatch) {
      throw new Error(`Pre-publish validation failed: AI-style repetition detected ("${repeatedPhraseMatch[1]}").`);
    }

    const { sourceImageUrl, finalImageUrl } = await createFinalBlogImageOrThrow(topic, niche, settings);
    if (!sourceImageUrl || !finalImageUrl) {
      throw new Error('Pre-publish validation failed: image pipeline returned empty URL(s).');
    }
    const imageAlt = `${topic} - cover image`;
    const imageBlock = `<img src="${finalImageUrl}" alt="${imageAlt.replace(/"/g, '&quot;')}" style="display:block;width:100%;max-width:1200px;height:auto;margin:12px auto;object-fit:cover;" /><br/>`;

    // Build final article WITHOUT hashtags in body — they go only to Blogger labels
    const sanitizedHeaders = sanitizeHeaders(`${imageBlock}${cleanedArticle}`, topic);
    const normalizedBody = enforceParagraphLengthAndQuestion(sanitizedHeaders, topic);
    const seoInjected = injectSeoMetaTags(topic, normalizedBody, finalImageUrl, account.name);
    const gate = qualityGate(seoInjected.html, seoInjected.metaDescription);
    if (!gate.pass) {
      throw new Error(`Quality gate failed: ${gate.checks.filter((c) => !c.pass).map((c) => `${c.label} (${c.detail})`).join('; ')}`);
    }

    // Final check: confirm no hashtags leaked into the publishable body
    const publishablePlain = stripHtml(seoInjected.html);
    if (/#[A-Za-z0-9]+/.test(publishablePlain)) {
      throw new Error('Final validation failed: hashtags found in publishable body. Aborting to prevent content pollution.');
    }

    const publishAt = topic.toLowerCase().includes('deepest hole ever drilled')
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    const bloggerClient = await createVerifiedBloggerClient(account.blogger_id);
    console.log(`[automation] Refreshed Blogger access token for blog ${account.blogger_id}; expires_in=${bloggerClient.auth.expiresIn}s; verified_blog=${bloggerClient.blog?.name || account.name}`);
    // Publish with hashtags as Blogger labels/tags (NOT in the body)
    const bloggerPost = await publishToBlogger(account.blogger_id, topic, seoInjected.html, bloggerClient.auth, { publishAt, labels: hashtags });

    if (!publishAt) {
      const fetched = await fetchBloggerPost(account.blogger_id, bloggerPost.id, bloggerClient.auth);
      const fetchedContent = String(fetched?.content || '');
      if (hasVisibleUrlsOrSources(fetchedContent) || looksTruncated(fetchedContent)) {
        const repairedBody = enforceParagraphLengthAndQuestion(sanitizeHeaders(removeExternalReferencesAndDuplicateParagraphs(stripSourceSectionsAndUrls(fetchedContent)), topic), topic);
        if (looksTruncated(repairedBody)) {
          throw new Error('Published post failed cleanliness/completeness verification.');
        }
        await updateBloggerPost(account.blogger_id, bloggerPost.id, topic, repairedBody, bloggerClient.auth);
      }
    }

    await supabase.from('topics').insert({ niche, title: topic, used: true, created_at: new Date().toISOString() });

    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        try {
          const teaserMessage = buildFacebookTeaser(content, topic, niche, hashtags, bloggerPost.url);
          const fbPost = await publishToFacebook(fbPage.page_id, fbPage.access_token, teaserMessage, finalImageUrl);
          const fbPostId = fbPost.post_id || fbPost.id;

          console.log(`✓ Facebook post published: https://www.facebook.com/${fbPage.page_id}/posts/${fbPostId}`);

          await axios.post(
            `https://graph.facebook.com/v19.0/${fbPostId}/comments`,
            {
              message: `Full article is live here: ${bloggerPost.url}

If this helped you, share your thoughts and read the full post now 🚀`,
              access_token: fbPage.access_token,
            },
          );
          console.log(`✓ Facebook comment (article link) posted on ${fbPostId}`);
        } catch (fbError: any) {
          const errBody = fbError?.response?.data ? JSON.stringify(fbError.response.data) : '';
          console.warn('[automation] Facebook cross-post warning:', fbError?.message || fbError, errBody);
        }
      }
    }

    const { error: postInsertError } = await supabase.from('posts').insert({
      title: topic,
      blog_name: account.name,
      niche,
      platform: account.facebook_page_id ? 'Both' : 'Blogger',
      status: 'published',
      url: bloggerPost.url,
      published_at: new Date().toISOString(),
    });
    if (postInsertError) console.warn('[automation] posts insert warning:', postInsertError.message);

    console.log('✓ Quality gate passed');
    for (const check of gate.checks) {
      console.log(`  - ${check.pass ? '✓' : '✗'} ${check.label}: ${check.detail}`);
    }
    console.log(`✓ Workers AI source image: ${sourceImageUrl}`);
    console.log(`✓ Final overlaid image: ${finalImageUrl}`);
    console.log(`✓ Viral hashtags: ${hashtags.join(' ')}`);
    console.log('✓ Internal related-link injection: disabled for focused article quality');
    console.log(`✓ Scheduled publish time: ${publishAt || 'immediate'}`);
    console.log(`✓ Blogger post ID: ${bloggerPost.id}`);
    console.log(`✓ Blogger post URL: ${bloggerPost.url}`);

    await supabase
      .from('schedules')
      .update({ metadata: buildScheduleMetadataStatus(schedule.metadata, 'success') })
      .eq('id', scheduleId);
  } catch (error: any) {
    console.error('Blog automation failed:', error);
    await supabase.from('posts').insert({
      title: 'Failed to generate post',
      blog_name: account.name,
      niche,
      platform: account.facebook_page_id ? 'Both' : 'Blogger',
      status: 'failed',
      published_at: new Date().toISOString()
    });
    await supabase
      .from('schedules')
      .update({ metadata: buildScheduleMetadataStatus(schedule.metadata, `failed: ${error?.message || 'unknown'}`) })
      .eq('id', scheduleId);
  }
}

export async function runVideoAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*, facebook_pages(*)').eq('id', scheduleId).single();
  if (!schedule) return;

  const fbPage = schedule.facebook_pages;
  const settings = await getSettings();

  const niche = 'Viral Entertainment';
  const topic = await generateText(`Generate a viral video topic for the ${niche} niche.`, niche);
  const script = await generateText(`Write a 30-second video script for the topic: "${topic}".`, niche);
  const voiceBuffer = await generateVoiceover(script);
  const githubRepo = String(settings.github_repo || '').trim();
  const githubPat = decryptSecret(settings.github_pat || '');
  const voicePath = `automation/voiceovers/voice-${Date.now()}.mp3`;
  const voiceUrl = (githubRepo && githubPat)
    ? await uploadBufferToGithub(githubRepo, githubPat, voiceBuffer, voicePath, `Upload voiceover: ${topic}`)
    : '';

  if (settings.github_pat) {
    await axios.post(
      'https://api.github.com/repos/YOUR_USER/YOUR_REMOTION_REPO/dispatches',
      {
        event_type: 'render_video',
        client_payload: {
          topic,
          script,
          voiceUrl,
          imgbbApiKey: decryptSecret(settings.imgbb_api_key || ''),
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
