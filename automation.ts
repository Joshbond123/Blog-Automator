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

// Confirmed valid English VoiceId values for api.v8.unrealspeech.com/speech (verified from API)
const UNREALSPEECH_VOICES = [
  'Charlotte', 'Emily', 'Amelia', 'Ivy', 'Lauren', 'Willow', 'Kaitlyn', 'Hannah', 'Autumn', 'Eleanor', 'Sierra', 'Melody',
  'Oliver', 'Caleb', 'Benjamin', 'Noah', 'Zane', 'Ethan', 'Arthur', 'Rowan', 'Daniel', 'Jasper',
] as const;
function pickRandomVoice(): string {
  return UNREALSPEECH_VOICES[Math.floor(Math.random() * UNREALSPEECH_VOICES.length)];
}
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

const ARRAY_SETTING_FIELDS = new Set(['cloudflare_configs', 'unrealspeech_keys', 'cerebras_keys', 'lightning_keys']);
const KEY_VALUE_SETTING_FIELDS = new Set([
  'supabase_url', 'supabase_service_role_key', 'supabase_access_token', 'github_pat',
  'github_repo',
  'cloudflare_configs', 'blogger_client_id', 'blogger_client_secret', 'blogger_refresh_token',
  'unrealspeech_keys', 'cerebras_keys', 'imgbb_api_key', 'ads_html', 'ads_scripts', 'ads_placement',
  'cloudflare_rotation_index', 'unrealspeech_rotation_index', 'cerebras_rotation_index', 'lightning_keys', 'lightning_rotation_index',
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
  if (!Array.isArray(settings.unrealspeech_keys)) settings.unrealspeech_keys = [];
  if (!Array.isArray(settings.cerebras_keys)) settings.cerebras_keys = [];
  if (!Array.isArray(settings.lightning_keys)) settings.lightning_keys = [];

  settings.cloudflare_rotation_index = Number(settings.cloudflare_rotation_index || 0);
  settings.unrealspeech_rotation_index = Number(settings.unrealspeech_rotation_index || 0);
  settings.cerebras_rotation_index = Number(settings.cerebras_rotation_index || 0);
  settings.lightning_rotation_index = Number(settings.lightning_rotation_index || 0);

  settings.cloudflare_configs = settings.cloudflare_configs
    .map((c: any) => normalizeCloudflareConfig(c))
    .filter((c: any) => c.account_id && c.api_key);
  settings.unrealspeech_keys = settings.unrealspeech_keys.map((k: any) => normalizeUsageEntry(k));
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
  listName: 'cloudflare_configs' | 'unrealspeech_keys' | 'cerebras_keys',
  indexName: 'cloudflare_rotation_index' | 'unrealspeech_rotation_index' | 'cerebras_rotation_index',
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
  listName: 'cloudflare_configs' | 'unrealspeech_keys' | 'cerebras_keys',
  indexName: 'cloudflare_rotation_index' | 'unrealspeech_rotation_index' | 'cerebras_rotation_index',
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
  const selected = await pickRotatingKey('unrealspeech_keys', 'unrealspeech_rotation_index');
  const voiceId = pickRandomVoice();

  try {
    console.log(`[voice] Using UnrealSpeech voice: ${voiceId}`);
    const res = await axios.post(
      'https://api.v8.unrealspeech.com/speech',
      { Text: text, VoiceId: voiceId, Bitrate: '192k', Speed: '0', Pitch: '1', TimestampType: 'word' },
      outboundConfig({ headers: { Authorization: `Bearer ${selected.key}`, 'Content-Type': 'application/json' }, timeout: 120000 }),
    );
    const outputUri = String(res.data?.OutputUri || '').trim();
    if (!outputUri) throw new Error('UnrealSpeech returned no OutputUri');
    const audioRes = await axios.get(outputUri, outboundConfig({ responseType: 'arraybuffer', timeout: 120000 }));
    await trackKeyUsage('unrealspeech_keys', 'unrealspeech_rotation_index', selected.key, true);
    return Buffer.from(audioRes.data);
  } catch (err) {
    await trackKeyUsage('unrealspeech_keys', 'unrealspeech_rotation_index', selected.key, false);
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

// ─────────────────────────────────────────────────────────────────────────────
// TopicShield-100
// Production-grade anti-duplicate topic engine.
// Caps history at 100 entries. Blocks exact dupes, near-dupes, reworded
// versions, same-event rewrites, and thematically identical topics.
// Operates in two passes: (1) signal-based hard/soft block, (2) AI semantic.
// ─────────────────────────────────────────────────────────────────────────────

const TOPICSHIELD_HISTORY_CAP = 800;

const TOPICSHIELD_STOPWORDS = new Set([
  'a','about','after','again','all','also','an','and','any','are','as','at','be','because',
  'been','before','being','between','both','breaking','but','by','can','could','day','days',
  'do','does','during','each','even','every','find','first','for','from','get','got','had',
  'has','have','he','her','here','him','his','how','i','if','in','into','is','it','its',
  'just','know','latest','like','look','make','many','may','me','might','more','most','much',
  'my','new','news','no','not','now','of','off','on','one','only','or','other','our','out',
  'over','own','part','people','per','put','report','reports','reveal','reveals','said','same',
  'see','she','should','show','shows','since','some','still','studies','study','such','take',
  'than','that','the','their','them','then','there','these','they','this','those','through',
  'time','to','too','trending','two','under','up','us','use','was','we','were','what','when',
  'where','which','while','who','why','will','with','would','year','years','you','your',
]);

/** Normalize: lowercase, strip punctuation, collapse whitespace */
function topicShield_normalize(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract meaningful keywords (≥3 chars, no stopwords) */
function topicShield_keywords(text: string): string[] {
  return topicShield_normalize(text)
    .split(' ')
    .filter(w => w.length >= 3 && !TOPICSHIELD_STOPWORDS.has(w));
}

/** Extract named entities and year patterns from original casing */
function topicShield_entities(text: string): string[] {
  const matches = String(text || '').match(/\b(?:[A-Z][a-z]+|[A-Z]{2,}|\d{4})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|\d{4})){0,3}\b/g) || [];
  return [...new Set(matches.map(m => m.trim().toLowerCase()))].slice(0, 10);
}

/** Bigrams from normalized text */
function topicShield_bigrams(text: string): string[] {
  const tokens = topicShield_normalize(text).split(' ').filter(Boolean);
  const grams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

/** Trigrams from normalized text */
function topicShield_trigrams(text: string): string[] {
  const tokens = topicShield_normalize(text).split(' ').filter(Boolean);
  const grams: string[] = [];
  for (let i = 0; i < tokens.length - 2; i++) grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return grams;
}

/** Overlap ratio: |intersection| / min(|A|, |B|) */
function topicShield_overlapRatio(a: string[], b: string[]): number {
  const sa = new Set(a.filter(Boolean));
  const sb = new Set(b.filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  const intersection = [...sa].filter(x => sb.has(x)).length;
  return intersection / Math.min(sa.size, sb.size);
}

/** Jaccard similarity: |intersection| / |union| */
function topicShield_jaccard(a: string, b: string): number {
  const sa = new Set(topicShield_normalize(a).split(' ').filter(Boolean));
  const sb = new Set(topicShield_normalize(b).split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  const intersection = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union ? intersection / union : 0;
}

/** Sorted deduplicated keyword set as a fingerprint string */
function topicShield_themeFingerprint(text: string): string {
  return [...new Set(topicShield_keywords(text))].sort().slice(0, 6).join('|');
}

/** All similarity dimensions between candidate and one historical topic */
function topicShield_signals(candidate: string, previous: string) {
  const normC = topicShield_normalize(candidate);
  const normP = topicShield_normalize(previous);
  return {
    exactMatch:     normC === normP,
    jaccard:        topicShield_jaccard(normC, normP),
    keywordOverlap: topicShield_overlapRatio(topicShield_keywords(candidate), topicShield_keywords(previous)),
    entityOverlap:  topicShield_overlapRatio(topicShield_entities(candidate), topicShield_entities(previous)),
    bigramOverlap:  topicShield_overlapRatio(topicShield_bigrams(candidate),  topicShield_bigrams(previous)),
    trigramOverlap: topicShield_overlapRatio(topicShield_trigrams(candidate), topicShield_trigrams(previous)),
    sameTheme:      topicShield_themeFingerprint(candidate) === topicShield_themeFingerprint(previous),
  };
}

/**
 * Hard block: deterministic signals strong enough to block without AI.
 * Thresholds are intentionally LOW because historical titles and new
 * candidates are often worded differently even when covering the same topic.
 */
function topicShield_isHardBlocked(candidate: string, previous: string): boolean {
  const s = topicShield_signals(candidate, previous);
  if (s.exactMatch) return true;
  if (s.jaccard >= 0.32) return true;
  if (s.keywordOverlap >= 0.48) return true;
  if (s.entityOverlap >= 0.55 && s.keywordOverlap >= 0.28) return true;
  if (s.bigramOverlap >= 0.40) return true;
  if (s.trigramOverlap >= 0.28) return true;
  if (s.sameTheme && s.keywordOverlap >= 0.30) return true;
  if (s.keywordOverlap >= 0.35 && s.bigramOverlap >= 0.25) return true;
  return false;
}

/**
 * Soft flag: moderate overlap that warrants an AI semantic check.
 * Set much lower than hard-block so the AI sees anything suspicious.
 */
function topicShield_isSoftFlagged(candidate: string, previous: string): boolean {
  const s = topicShield_signals(candidate, previous);
  if (s.jaccard >= 0.16) return true;
  if (s.keywordOverlap >= 0.26) return true;
  if (s.entityOverlap >= 0.30) return true;
  if (s.bigramOverlap >= 0.20) return true;
  if (s.trigramOverlap >= 0.12) return true;
  return false;
}

/**
 * AI semantic check. Feeds all soft-flagged historical topics to the AI.
 * The AI returns the matching historical topic text if duplicate, or NONE.
 */
async function topicShield_semanticCheck(candidate: string, softFlagged: string[], niche: string): Promise<boolean> {
  if (!softFlagged.length) return false;
  try {
    const prompt = [
      `New candidate topic: "${candidate}"`,
      '',
      'Previously published topics:',
      ...softFlagged.map((t, i) => `${i + 1}. ${t}`),
      '',
      'TASK: Determine whether the candidate covers the same event, discovery, person, or core concept as ANY listed topic — even if phrased completely differently.',
      'A topic IS a duplicate if:',
      '  - It is about the same news story or event, just reworded',
      '  - It covers the same subject with a different angle or framing',
      '  - The headline would produce a very similar article',
      'A topic is NOT a duplicate if it is about a clearly different subject matter.',
      '',
      'Reply with exactly one of:',
      '  DUPLICATE - if it matches any listed topic',
      '  UNIQUE - if it is genuinely different from all listed topics',
    ].join('\n');

    const response = await generateText(prompt, niche);
    const answer = String(response || '').trim().toUpperCase();
    return answer.startsWith('DUPLICATE');
  } catch {
    return false;
  }
}

/**
 * TopicShield-100 core uniqueness check.
 * Returns true if the candidate is safe to use, false if it should be blocked.
 */
async function topicShield_isUnique(candidate: string, history: string[], niche: string): Promise<boolean> {
  if (!candidate.trim()) return false;

  const softFlagged: string[] = [];

  for (const previous of history) {
    if (!previous.trim()) continue;
    if (topicShield_isHardBlocked(candidate, previous)) {
      return false;
    }
    if (topicShield_isSoftFlagged(candidate, previous)) {
      softFlagged.push(previous);
    }
  }

  if (softFlagged.length > 0) {
    const isDuplicate = await topicShield_semanticCheck(candidate, softFlagged.slice(0, 15), niche);
    if (isDuplicate) return false;
  }

  return true;
}

/**
 * Load the most recent historical titles for the TopicShield memory.
 *
 * IMPORTANT: We intentionally do NOT filter by niche here.
 *   - Niche labels can drift (renames, new accounts, slight spelling differences).
 *   - The same trending news/topic is the same regardless of which niche label
 *     it was filed under, and we never want to re-publish it.
 *
 * We merge two sources so the shield uses the actual publish history as the
 * source of truth (the `topics` table can be missing rows whenever a topic
 * insert silently failed during a prior run):
 *   1. `topics.topic`           — explicit shield records
 *   2. `posts.title`            — every post we ever attempted/published
 *
 * Failed posts (title === "Failed to generate post") are skipped so they don't
 * pollute the corpus.
 */
async function topicShield_loadHistory(supabase: any, _niche: string): Promise<string[]> {
  const cap = TOPICSHIELD_HISTORY_CAP;
  const seen = new Set<string>();
  const merged: { text: string; ts: number }[] = [];

  const pushUnique = (text: string, ts: number) => {
    const t = String(text || '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ text: t, ts: Number.isFinite(ts) ? ts : 0 });
  };

  // 1) topics table — explicit shield memory across ALL niches
  try {
    const { data, error } = await supabase
      .from('topics')
      .select('topic, created_at')
      .order('created_at', { ascending: false })
      .limit(cap);
    if (error) {
      console.warn('[TopicShield] Failed to load topics history:', error.message);
    } else {
      for (const row of data || []) {
        pushUnique(row.topic, Date.parse(row.created_at || '') || 0);
      }
    }
  } catch (e: any) {
    console.warn('[TopicShield] topics load threw:', e?.message || e);
  }

  // 2) posts table — actual publish history (real source of truth)
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('title, published_at')
      .order('published_at', { ascending: false })
      .limit(cap);
    if (error) {
      console.warn('[TopicShield] Failed to load posts history:', error.message);
    } else {
      for (const row of data || []) {
        const title = String(row.title || '').trim();
        if (!title || title.toLowerCase() === 'failed to generate post') continue;
        pushUnique(title, Date.parse(row.published_at || '') || 0);
      }
    }
  } catch (e: any) {
    console.warn('[TopicShield] posts load threw:', e?.message || e);
  }

  // Sort newest first and cap.
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, cap).map(r => r.text);
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

/**
 * TopicShield-100: pick a unique trending topic.
 * Checks every RSS candidate against the 100-topic history in two passes:
 *   Pass 1 — deterministic signal checks (exact, Jaccard, keyword, entity, bigram, trigram, theme)
 *   Pass 2 — AI semantic check on all soft-flagged historical topics
 * Returns the first candidate that clears both passes.
 */
async function pickUniqueTrendingTopic(supabase: any, niche: string): Promise<string> {
  const candidates = await fetchTrendingTopicsForNiche(niche);
  if (candidates.length < 20) {
    console.warn(`[TopicShield] Only ${candidates.length} candidates fetched for niche="${niche}".`);
  }

  const history = await topicShield_loadHistory(supabase, niche);
  console.log(`[TopicShield] Loaded ${history.length} historical topics (cap=${TOPICSHIELD_HISTORY_CAP}) for niche="${niche}".`);

  const rejected: string[] = [];

  for (const candidate of candidates) {
    const unique = await topicShield_isUnique(candidate, history, niche);
    if (unique) {
      console.log(`[automation] Selected unique topic after reviewing ${candidates.length} candidates and ${history.length} historical topics.`);
      if (rejected.length) {
        console.log(`[TopicShield] Rejected ${rejected.length} duplicate/near-duplicate candidate(s) before selecting.`);
      }
      return candidate;
    }
    rejected.push(candidate);
  }

  throw new Error(
    `[TopicShield] No unique topic found for niche="${niche}" after checking ` +
    `${candidates.length} candidates against ${history.length} historical topics. ` +
    `All ${rejected.length} candidate(s) were blocked as duplicates.`
  );
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

// ── Hashtag system ─────────────────────────────────────────────────────────
// Goal: short, viral, topic-relevant hashtags only. Each tag is a single
// short token (≤ 12 chars after the #), never a long joined CamelCase phrase.
// Examples we WANT:  #Tech #AI #Viral #Tips #Facts #Trending #Food #Recipe
// Examples we REJECT: #StoryBehindTheIce #DiscoveryAlertWatch #DeepDiveStory

const NICHE_VIRAL_TAG_BANK: Record<string, string[]> = {
  'Scary / Mysterious / True Crime': ['#Mystery', '#Crime', '#Scary', '#True', '#Creepy', '#Cold', '#Spooky'],
  'AI Tools & Technology':           ['#AI',      '#Tech',  '#Tools', '#Apps', '#Future', '#GPT',   '#Code'],
  'Life Hacks & Tips':               ['#Hacks',   '#Tips',  '#Smart', '#DIY',  '#Pro',    '#Easy',  '#Daily'],
  'Weird Facts & Discoveries':       ['#Facts',   '#Weird', '#Wow',   '#Wild', '#True',   '#Crazy', '#Discover'],
  'Viral Entertainment':             ['#Viral',   '#Trend', '#Fun',   '#Wow',  '#Hot',    '#Buzz',  '#Watch'],
  'Health & Wellness Hacks':         ['#Health',  '#Wellness', '#Fit', '#Tips', '#Glow',  '#Care',  '#Daily'],
};
const GENERIC_VIRAL_TAGS = ['#Viral', '#Trending', '#Wow', '#Hot', '#Daily', '#Story', '#Watch'];

// Known acronyms that must keep their original ALL-CAPS form (#AI not #Ai).
const ACRONYM_TAGS = new Set(['AI', 'GPT', 'DIY', 'NFT', 'VR', 'AR', 'IT', 'UFO', 'FBI', 'CIA', 'USA', 'NYC', 'CEO', 'API', 'ML']);

// Stopwords we never want as standalone hashtags (filtered when splitting joined tags).
const HASHTAG_STOPWORDS = new Set([
  'the','and','for','with','from','about','this','that','what','when','why',
  'how','was','were','are','has','have','had','will','can','your','you',
  'they','their','them','our','off','out','too','any','all','some','more',
  'into','onto','upon','over','under','than','then','also','very','just',
  'new','old','one','two','here','there','who','its','it','to','of','in',
  'on','at','as','by','an','a','is','be','do','or','if','but','not','no',
  'so','up','my','me','we','us','i','behind','during','after','before',
]);

// Strict validator: hashtag must be a single short token, ≤12 chars after #,
// no more than one internal capital — UNLESS it's a known all-caps acronym
// (so #WeirdFacts and #AI are OK, but #StoryBehindTheIce is rejected).
function isShortViralTag(tag: string): boolean {
  if (!/^#[A-Za-z][A-Za-z0-9]{1,11}$/.test(tag)) return false; // 2-12 chars after #
  if (/^#\d+$/.test(tag)) return false;
  const body = tag.slice(1);
  if (ACRONYM_TAGS.has(body.toUpperCase()) && body === body.toUpperCase()) return true;
  const internalUpper = (body.slice(1).match(/[A-Z]/g) || []).length;
  return internalUpper <= 1;
}

// Take a free-form word and turn it into a clean short hashtag, or null.
// Preserves known acronyms (#AI, #GPT) and existing valid 2-word CamelCase (#WeirdFacts).
function toShortTag(word: string): string | null {
  const cleaned = String(word || '')
    .replace(/^#+/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .trim();
  if (!cleaned) return null;

  // 1) Known acronym → force ALL CAPS form
  if (ACRONYM_TAGS.has(cleaned.toUpperCase())) {
    const tag = `#${cleaned.toUpperCase()}`;
    return isShortViralTag(tag) ? tag : null;
  }

  // 2) Already-valid TitleCase / CamelCase tag (e.g. WeirdFacts, Facts) → preserve case
  //    BUT only if the first letter is already uppercase. Lowercase input falls through.
  if (/^[A-Z]/.test(cleaned)) {
    const asIs = `#${cleaned}`;
    if (isShortViralTag(asIs)) {
      if (HASHTAG_STOPWORDS.has(cleaned.toLowerCase())) return null;
      return asIs;
    }
  }

  // 3) Otherwise normalize to TitleCase single word: #Facts (not #FACTS, not #facts)
  const cap = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
  if (HASHTAG_STOPWORDS.has(cap.toLowerCase())) return null;
  const tag = `#${cap}`;
  return isShortViralTag(tag) ? tag : null;
}

function nicheTagBank(niche: string): string[] {
  return NICHE_VIRAL_TAG_BANK[niche] || GENERIC_VIRAL_TAGS;
}

// Single source of truth. Always returns exactly `count` short, unique,
// viral, topic/niche-relevant hashtags. Used for both blog and video paths.
function sanitizeHashtags(rawCandidates: string[], topic: string, niche: string, count = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (tag: string | null) => {
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };

  // 1) Anything the LLM gave us, after splitting joined CamelCase tags into pieces
  for (const raw of rawCandidates || []) {
    if (out.length >= count) break;
    const noHash = String(raw || '').replace(/^#+/, '').trim();
    if (!noHash) continue;
    // Try the whole token first
    const whole = toShortTag(noHash);
    if (whole) {
      push(whole);
      continue;
    }
    // Otherwise split on CamelCase / non-alphanumeric and take the strongest single-word pieces
    const pieces = noHash
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    for (const piece of pieces) {
      if (out.length >= count) break;
      push(toShortTag(piece));
    }
  }

  // 2) Topic keywords (each word becomes its own short tag)
  if (out.length < count) {
    for (const kw of extractTopicKeywords(topic)) {
      if (out.length >= count) break;
      push(toShortTag(kw));
    }
  }

  // 3) Niche viral bank
  if (out.length < count) {
    for (const tag of nicheTagBank(niche)) {
      if (out.length >= count) break;
      push(tag);
    }
  }

  // 4) Generic viral tags as last resort
  if (out.length < count) {
    for (const tag of GENERIC_VIRAL_TAGS) {
      if (out.length >= count) break;
      push(tag);
    }
  }

  return out.slice(0, count);
}

// Public deterministic helper kept for callers that want a no-LLM fallback.
function deterministicTopicHashtags(topic: string, niche = '') {
  return sanitizeHashtags([], topic, niche, 5);
}

async function generateViralHashtags(topic: string, niche: string, content: string) {
  const examples =
    nicheTagBank(niche).slice(0, 4).join(' ') +
    '   (other good examples: #Tech #AI #Viral #Tips • #Facts #Trending #Learn • #Food #Yummy #Recipe)';
  try {
    const response = await generateText(
      [
        `Topic: ${topic}`,
        `Niche: ${niche}`,
        `Article preview: ${stripHtml(content).slice(0, 400)}`,
        '',
        'Generate exactly 5 SHORT viral hashtags for this post.',
        'STRICT RULES (mandatory):',
        '- Each hashtag is ONE short word, max 12 letters after the #.',
        '- NEVER join multiple words into one tag (no #StoryBehindTheIce, no #DeepDiveStory, no #DiscoveryAlertWatch).',
        '- Prefer single common words people actually search.',
        '- Mix topic-specific tags with niche-relevant viral tags.',
        '- No spam, no repeats, no emojis, no numbers-only tags.',
        '- Output ONLY the 5 hashtags separated by spaces. No commentary, no numbering.',
        '',
        `Style examples for this niche: ${examples}`,
      ].join('\n'),
      niche,
    );
    const parsed = Array.from(
      new Set((String(response || '').match(/#[A-Za-z0-9]+/g) || []).map((v) => v.trim())),
    );
    return sanitizeHashtags(parsed, topic, niche, 5);
  } catch {
    return sanitizeHashtags([], topic, niche, 5);
  }
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
  const apiUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodedPath}`;

  // Paths here are timestamped (voice-${ts}.mp3, scene-${ts}.png, etc.) so a 409
  // almost always means concurrent repo activity — not a true SHA mismatch on
  // this file. Retry on 409/422 with exponential backoff to match upsertFileToGithub.
  const MAX_ATTEMPTS = 5;
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await axios.put(
        apiUrl,
        { message, content: buffer.toString('base64') },
        outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
      );
      const url = String(res.data?.content?.download_url || '').trim();
      if (!/^https?:\/\//.test(url)) throw new Error('GitHub upload did not return a public download URL.');
      if (attempt > 1) console.log(`[github] Uploaded ${path} on attempt ${attempt}`);
      return url;
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (status === 409 || status === 422) {
        const delayMs = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        console.warn(`[github] uploadBuffer ${path} conflict (status ${status}) attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`[github] uploadBufferToGithub ${path} failed after ${MAX_ATTEMPTS} attempts`);
}

// Upsert (create or update) a file in GitHub — handles SHA automatically for updates.
// Retries on 409 (Conflict) and 422 (Unprocessable Entity / SHA mismatch) which both
// happen when two concurrent runs target the same file path: between our SHA fetch
// and our PUT, another writer updated the file, so our SHA is now stale. We refetch
// and retry. This is a real production scenario when blog + video automations or
// parallel video runs both sync render-pipeline files at the same time.
async function upsertFileToGithub(repo: string, token: string, buffer: Buffer, path: string, message: string) {
  const { owner, name } = parseGithubRepo(repo);
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodedPath}`;

  const fetchSha = async (): Promise<string | undefined> => {
    try {
      const existing = await axios.get(apiUrl, outboundConfig({ headers: githubHeaders(token), timeout: 15000 }));
      const s = String(existing.data?.sha || '').trim();
      return s || undefined;
    } catch (e: any) {
      if (e?.response?.status === 404) return undefined; // file doesn't exist yet
      throw e;
    }
  };

  const MAX_ATTEMPTS = 5;
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const sha = await fetchSha();
    const body: any = { message, content: buffer.toString('base64') };
    if (sha) body.sha = sha;
    try {
      const res = await axios.put(apiUrl, body, outboundConfig({ headers: githubHeaders(token), timeout: 30000 }));
      if (attempt > 1) {
        console.log(`[github] Upserted ${path} (${(buffer.length / 1024).toFixed(0)}KB)${sha ? ' [updated]' : ' [created]'} on attempt ${attempt}`);
      } else {
        console.log(`[github] Upserted ${path} (${(buffer.length / 1024).toFixed(0)}KB)${sha ? ' [updated]' : ' [created]'}`);
      }
      return String(res.data?.content?.download_url || '').trim();
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      // 409 Conflict and 422 (often "sha didn't match") = stale SHA from a concurrent writer.
      // Refetch SHA and retry with exponential-ish backoff + jitter.
      if (status === 409 || status === 422) {
        const delayMs = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        console.warn(`[github] ${path} SHA conflict (status ${status}) on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`[github] upsert ${path} failed after ${MAX_ATTEMPTS} attempts`);
}

// Sync the local render scripts AND the entire Remotion project to the GitHub
// repo so the "Video Renderer" GitHub Action always uses the latest version.
async function syncRenderScriptToGithub(repo: string, token: string) {
  const path = await import('path');
  const fs = await import('fs');

  // Files (and whole directories) that the GitHub Action depends on.
  const FILE_TARGETS = [
    'scripts/render-video.mjs',
    '.github/workflows/render-video.yml',
  ];
  const DIR_TARGETS = ['remotion'];
  // Ignore patterns for directory walks (don't ship build output / deps).
  const IGNORED = new Set(['node_modules', 'out', 'public', 'dist', '.cache']);

  const walkDir = (root: string, base = root): string[] => {
    const out: string[] = [];
    if (!fs.existsSync(root)) return out;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        out.push(...walkDir(full, base));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  };

  const allFiles: string[] = [];
  for (const f of FILE_TARGETS) {
    if (fs.existsSync(path.join(process.cwd(), f))) allFiles.push(f);
  }
  for (const d of DIR_TARGETS) {
    const abs = path.join(process.cwd(), d);
    for (const full of walkDir(abs)) {
      const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
      allFiles.push(rel);
    }
  }

  let pushed = 0;
  for (const rel of allFiles) {
    try {
      const buf = Buffer.from(fs.readFileSync(path.join(process.cwd(), rel)));
      await upsertFileToGithub(
        repo,
        token,
        buf,
        rel,
        `chore: sync ${rel} from automation platform`,
      );
      pushed++;
    } catch (err: any) {
      console.warn(`[video] Failed to sync ${rel}:`, err?.message || err);
    }
  }
  console.log(`[video] Synced ${pushed}/${allFiles.length} render-pipeline files to GitHub ✓`);
}

// AI-generated viral CTA per video. Always includes the required phrases:
// "check link in bio" and a like/share/follow ask.
async function generateVideoCTA(topic: string, niche: string): Promise<string> {
  const fallback = 'LIKE, SHARE & FOLLOW — CHECK LINK IN BIO!';
  try {
    const raw = await generateText(
      `Write ONE viral short-form-video CTA (call to action) for a video about "${topic}" in the ${niche} niche.

REQUIREMENTS:
- ALL CAPS
- 8 to 14 words MAX (must fit on screen)
- Punchy, urgent, emotional energy
- MUST include the phrase "CHECK LINK IN BIO"
- MUST also include a like/share/follow ask (e.g. "LIKE, SHARE & FOLLOW")
- No hashtags, no quotes, no emojis
Return ONLY the CTA text, nothing else.`,
      niche,
    );
    let text = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '').toUpperCase();
    if (!/CHECK LINK IN BIO/.test(text)) text = `${text} — CHECK LINK IN BIO`;
    if (!/(LIKE|SHARE|FOLLOW)/.test(text)) text = `LIKE, SHARE & FOLLOW — ${text}`;
    // Hard cap so it always fits on screen
    if (text.length > 90) text = text.slice(0, 87) + '...';
    return text || fallback;
  } catch {
    return fallback;
  }
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

      // ── TopicShield-100: Post-rewrite check ────────────────────────────────
      // The raw candidate passed the pre-selection check, but the rewritten
      // viral title must ALSO be checked — different raw headlines can produce
      // nearly identical final titles, which is a duplicate.
      const postRewriteHistory = await topicShield_loadHistory(supabase, niche);
      const viralTitleIsUnique = await topicShield_isUnique(topic, postRewriteHistory, niche);
      if (!viralTitleIsUnique) {
        throw new Error(
          `[TopicShield] Post-rewrite duplicate detected: viral title "${topic}" is too similar to a previously published topic. Aborting run.`
        );
      }
      console.log(`[TopicShield] Post-rewrite check passed for: "${topic}"`);
      // ── end TopicShield post-rewrite check ────────────────────────────────
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
    console.log(`[blog] ✓ Viral hashtags: ${hashtags.join(' ')}`);

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

    {
      const normalized_topic = normalizeTopicText(topic) || topic.toLowerCase().trim();
      const { error: topicInsertErr } = await supabase
        .from('topics')
        .insert({
          niche,
          topic,
          normalized_topic,
          source: 'automation',
          used_for: bloggerPost.id || scheduleId,
          created_at: new Date().toISOString(),
        });
      if (topicInsertErr) {
        console.error(`[TopicShield] FAILED to save topic to history: ${topicInsertErr.message}. Future runs may produce duplicates.`);
      } else {
        console.log(`[TopicShield] Saved topic to history (niche="${niche}").`);
      }
    }

    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        try {
          const teaserMessage = buildFacebookTeaser(content, topic, niche, hashtags, bloggerPost.url);
          const fbPost = await publishToFacebook(fbPage.page_id, fbPage.access_token, teaserMessage, finalImageUrl);
          const fbPostId = fbPost.post_id || fbPost.id;

          console.log(`✓ Facebook post published: https://www.facebook.com/${fbPage.page_id}/posts/${fbPostId}`);

          // Post the link-bearing comment in its own try/catch + retry so a
          // transient LLM or Graph API failure NEVER leaves the FB post
          // without the blog link (the whole reason the comment exists).
          const linkCommentAttempts: string[] = [];
          try {
            linkCommentAttempts.push(await generateBloggerComment(topic, niche, bloggerPost.url));
          } catch {
            linkCommentAttempts.push(`Read the full article here 👉 ${bloggerPost.url}`);
          }
          // Always queue a deterministic fallback as the second attempt.
          linkCommentAttempts.push(`Read the full article here 👉 ${bloggerPost.url}`);

          let commentPosted = false;
          for (let i = 0; i < linkCommentAttempts.length && !commentPosted; i += 1) {
            const message = linkCommentAttempts[i];
            try {
              await axios.post(
                `https://graph.facebook.com/v19.0/${fbPostId}/comments`,
                { message, access_token: fbPage.access_token },
                outboundConfig({ timeout: 30000 }),
              );
              commentPosted = true;
              console.log(`✓ Facebook link comment posted on ${fbPostId} (attempt ${i + 1}, contains URL: ${message.includes(bloggerPost.url)})`);
            } catch (commentErr: any) {
              const body = commentErr?.response?.data ? JSON.stringify(commentErr.response.data) : '';
              console.warn(`[automation] FB comment attempt ${i + 1} failed: ${commentErr?.message || commentErr} ${body}`);
            }
          }
          if (!commentPosted) {
            console.error(`[automation] FB link comment FAILED for ${fbPostId} after ${linkCommentAttempts.length} attempts. Blog URL: ${bloggerPost.url}`);
          }
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

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO PIPELINE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function generateBloggerComment(topic: string, niche: string, blogUrl: string): Promise<string> {
  const fallback = `Fascinating topic! Read the full breakdown here 👉 ${blogUrl}`;
  // Hard guarantee: the returned comment ALWAYS contains the blog URL,
  // regardless of niche or what the LLM returns. This is what carries the
  // click-through from Facebook back to the published Blogger article.
  const ensureUrl = (text: string): string => {
    let out = String(text || '').trim().slice(0, 500);
    if (!out) return fallback;
    if (blogUrl && !out.includes(blogUrl)) {
      // Trim trailing punctuation/whitespace before appending so the URL renders cleanly.
      out = `${out.replace(/[\s.,;:!?-]+$/, '')} 👉 ${blogUrl}`;
    }
    return out.slice(0, 600);
  };
  try {
    const raw = await generateText(
      `You are a social media manager posting a comment on a Facebook post about "${topic}" in the ${niche} niche.

Write ONE short, highly engaging comment that:
- Mentions something curious or surprising about the topic (1 sentence)
- Teases what readers will find in the full article (1 sentence)
- Ends with a direct call-to-action to click the link
- MUST include this exact article URL verbatim: ${blogUrl}
- Sounds human, not robotic
- Maximum 3 sentences total, no hashtags

Return ONLY the comment text.`,
      niche,
    );
    return ensureUrl(String(raw || ''));
  } catch {
    return fallback;
  }
}

interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

function convertCharToWordTimestamps(alignment: any): WordTimestamp[] {
  const characters: string[] = alignment?.characters || [];
  const starts: number[] = alignment?.character_start_times_seconds || [];
  const ends: number[] = alignment?.character_end_times_seconds || [];

  const words: WordTimestamp[] = [];
  let currentWord = '';
  let wordStart: number | null = null;
  let wordEnd = 0;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const s = starts[i] ?? 0;
    const e = ends[i] ?? s + 0.05;

    if (ch === ' ' || ch === '\n' || ch === '\r') {
      if (currentWord.length > 0) {
        words.push({ word: currentWord, start: wordStart!, end: wordEnd });
        currentWord = '';
        wordStart = null;
      }
    } else {
      if (wordStart === null) wordStart = s;
      wordEnd = e;
      currentWord += ch;
    }
  }
  if (currentWord.length > 0 && wordStart !== null) {
    words.push({ word: currentWord, start: wordStart, end: wordEnd });
  }
  return words;
}

interface VideoScript {
  voiceover: string;
  scenes: Array<{ imagePrompt: string }>;
  hashtags: string[];
}

async function generateVideoScript(topic: string, niche: string): Promise<VideoScript> {
  const raw = await generateText(
    `You are a viral short-form video content creator. Create a complete ~60-second video script for this topic: "${topic}"
Niche: ${niche}

REQUIREMENTS:
- voiceover: EXACTLY 135-150 words of natural spoken narration so it lands at ~55-60 seconds when read at a normal pace. NEVER fewer than 130 words and NEVER more than 155 words.
  • Open with a 5-7 word HOOK that creates instant curiosity (no "Did you know", no "Have you ever").
  • Deliver 3-4 specific, surprising facts in conversational TikTok/Reels energy.
  • The LAST 12-18 words MUST be a spoken CTA that says (in your own natural words): like the video, share it with someone, follow the page, and visit the blog link in the bio for the full story / more posts. The CTA must sound human and energetic — not robotic.
- scenes: exactly 5 scene descriptions. Each must be a DETAILED image generation prompt. Cinematic, realistic, NO TEXT, NO WORDS, NO SIGNS, NO LETTERS in the image.
- hashtags: exactly 5 SHORT viral hashtags. EACH tag is ONE short word (max 12 letters after the #). Never join multiple words into one tag. Examples of GOOD tags: #Tech #AI #Viral #Tips #Facts #Trending #Food #Recipe. Examples of BAD tags (forbidden): #StoryBehindTheIce #DiscoveryAlertWatch #DeepDiveStory.

Return ONLY valid JSON, nothing else:
{
  "voiceover": "complete narration text here",
  "scenes": [
    {"imagePrompt": "detailed scene 1 description"},
    {"imagePrompt": "detailed scene 2 description"},
    {"imagePrompt": "detailed scene 3 description"},
    {"imagePrompt": "detailed scene 4 description"},
    {"imagePrompt": "detailed scene 5 description"}
  ],
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4", "#Tag5"]
}`,
    niche,
  );

  let parsed: any;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    throw new Error(`Video script JSON parse failed. Raw: ${raw.slice(0, 200)}`);
  }

  if (!parsed?.voiceover || !Array.isArray(parsed?.scenes) || parsed.scenes.length < 3) {
    throw new Error(`Video script missing required fields. Got: ${JSON.stringify(Object.keys(parsed || {}))}`);
  }

  const rawHashtags = Array.isArray(parsed.hashtags) ? (parsed.hashtags as any[]).map((t) => String(t || '')) : [];
  return {
    voiceover: String(parsed.voiceover).trim(),
    scenes: (parsed.scenes as any[]).slice(0, 6).map((s: any) => ({ imagePrompt: String(s?.imagePrompt || s?.prompt || '').trim() })),
    hashtags: sanitizeHashtags(rawHashtags, topic, niche, 5),
  };
}

function estimateWordTimestamps(text: string, audioDurationSeconds?: number): WordTimestamp[] {
  const words = text.split(/\s+/).filter(Boolean);
  const wordsPerSecond = 2.5;
  const totalDuration = audioDurationSeconds ?? words.length / wordsPerSecond;
  const avgDur = totalDuration / Math.max(words.length, 1);
  const timestamps: WordTimestamp[] = [];
  let cursor = 0;
  for (const word of words) {
    const start = cursor;
    const end = cursor + avgDur;
    timestamps.push({ word, start, end });
    cursor = end;
  }
  return timestamps;
}

async function generateVoiceoverWithTimestamps(text: string): Promise<{ buffer: Buffer; wordTimestamps: WordTimestamp[]; voiceId: string }> {
  const selected = await pickRotatingKey('unrealspeech_keys', 'unrealspeech_rotation_index');
  const voiceId = pickRandomVoice();

  try {
    console.log(`[video] UnrealSpeech voice selected: ${voiceId}`);
    const res = await axios.post(
      'https://api.v8.unrealspeech.com/speech',
      { Text: text, VoiceId: voiceId, Bitrate: '192k', Speed: '0', Pitch: '1', TimestampType: 'word' },
      outboundConfig({ headers: { Authorization: `Bearer ${selected.key}`, 'Content-Type': 'application/json' }, timeout: 120000 }),
    );

    const outputUri = String(res.data?.OutputUri || '').trim();
    const timestampsUri = String(res.data?.TimestampsUri || '').trim();

    if (!outputUri) throw new Error('UnrealSpeech returned no OutputUri');

    const [audioRes, tsRes] = await Promise.all([
      axios.get(outputUri, outboundConfig({ responseType: 'arraybuffer', timeout: 120000 })),
      timestampsUri
        ? axios.get(timestampsUri, outboundConfig({ timeout: 30000 })).catch(() => null)
        : Promise.resolve(null),
    ]);

    await trackKeyUsage('unrealspeech_keys', 'unrealspeech_rotation_index', selected.key, true);

    const buffer = Buffer.from(audioRes.data);

    let wordTimestamps: WordTimestamp[] = [];
    if (tsRes?.data && Array.isArray(tsRes.data)) {
      wordTimestamps = tsRes.data
        .filter((t: any) => t && typeof t.word === 'string' && typeof t.start === 'number')
        .map((t: any) => ({ word: t.word, start: t.start, end: t.end ?? t.start + 0.3 }));
    }

    if (!wordTimestamps.length) {
      const estimatedDurationSeconds = (buffer.length * 8) / (192 * 1000);
      wordTimestamps = estimateWordTimestamps(text, estimatedDurationSeconds);
      console.log(`[video] UnrealSpeech voiceover: ${(buffer.length / 1024).toFixed(0)}KB, ${wordTimestamps.length} word timestamps (estimated), voice=${voiceId}`);
    } else {
      console.log(`[video] UnrealSpeech voiceover: ${(buffer.length / 1024).toFixed(0)}KB, ${wordTimestamps.length} word timestamps (aligned), voice=${voiceId}`);
    }

    return { buffer, wordTimestamps, voiceId };
  } catch (err: any) {
    await trackKeyUsage('unrealspeech_keys', 'unrealspeech_rotation_index', selected.key, false);
    const respBody = err?.response?.data
      ? JSON.stringify(err.response.data).slice(0, 400)
      : '';
    const status = err?.response?.status ?? '';
    console.error(`[video] UnrealSpeech error ${status} voice=${voiceId}${respBody ? ' body=' + respBody : ''}`);
    throw err;
  }
}

async function dispatchVideoRenderWorkflow(
  repo: string,
  token: string,
  voiceoverPath: string,
  scenePaths: string[],
  wordTimestamps: WordTimestamp[],
  title: string,
  correlationId: string,
  cta: string,
  hookText: string,
) {
  const { owner, name } = parseGithubRepo(repo);
  await axios.post(
    `https://api.github.com/repos/${owner}/${name}/dispatches`,
    {
      event_type: 'render_video',
      client_payload: {
        voiceoverPath,
        scenePaths: JSON.stringify(scenePaths),
        wordTimestamps: JSON.stringify(wordTimestamps),
        title,
        correlationId,
        cta,
        hookText,
      },
    },
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );
  console.log(`[video] Dispatched render_video workflow: ${correlationId} (engine=remotion, cta="${cta}")`);
}

async function waitForVideoRenderArtifact(repo: string, token: string, correlationId: string): Promise<{ videoBuffer: Buffer; result: any }> {
  const { owner, name } = parseGithubRepo(repo);
  const artifactName = `video-result-${correlationId}`;
  const expectedRunName = `Video Renderer - ${correlationId}`;
  const startedAt = Date.now();
  let runId = '';

  for (let i = 0; i < 60; i++) {
    await sleep(15000);

    const runsRes = await axios.get(
      `https://api.github.com/repos/${owner}/${name}/actions/runs?event=repository_dispatch&per_page=15`,
      outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
    );
    const runs = Array.isArray(runsRes.data?.workflow_runs) ? runsRes.data.workflow_runs : [];

    if (!runId) {
      const candidate = runs.find((r: any) => {
        const created = Date.parse(r?.created_at || '');
        return created >= startedAt - 30000 && String(r?.display_title || r?.name || '').includes(correlationId);
      });
      if (candidate) {
        runId = String(candidate.id);
        console.log(`[video] Found workflow run: ${runId} (${candidate.status})`);
      }
    }

    if (runId) {
      const run = runs.find((r: any) => String(r.id) === runId);
      if (!run) continue;
      if (run.status === 'completed') {
        if (run.conclusion === 'failure') throw new Error(`Video render workflow failed (run ${runId}). Check GitHub Actions for details.`);
        if (run.conclusion !== 'success') throw new Error(`Video render workflow ended with conclusion="${run.conclusion}"`);
        console.log(`[video] Workflow completed successfully: ${runId}`);
        break;
      }
      console.log(`[video] Workflow ${runId} still running (${run.status})... (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
    }

    if (Date.now() - startedAt > 25 * 60 * 1000) {
      throw new Error(`Video render workflow timed out after 25 minutes. correlationId=${correlationId}`);
    }
  }

  const artifactsRes = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts`,
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );
  const artifacts = Array.isArray(artifactsRes.data?.artifacts) ? artifactsRes.data.artifacts : [];
  const artifact = artifacts.find((a: any) => a.name === artifactName);
  if (!artifact) throw new Error(`Artifact "${artifactName}" not found for run ${runId}`);

  const zipRes = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/artifacts/${artifact.id}/zip`,
    outboundConfig({ headers: githubHeaders(token), responseType: 'arraybuffer', timeout: 120000 }),
  );
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(Buffer.from(zipRes.data));

  const resultEntry = zip.getEntry('result.json');
  if (!resultEntry) throw new Error('result.json not found in video artifact zip');
  const resultPayload = JSON.parse(resultEntry.getData().toString('utf8'));

  const videoEntry = zip.getEntry('output.mp4');
  if (!videoEntry) throw new Error('output.mp4 not found in video artifact zip');
  const videoBuffer = videoEntry.getData();
  if (videoBuffer.length < 100 * 1024) throw new Error(`Video in artifact is too small: ${videoBuffer.length} bytes`);

  console.log(`[video] Artifact downloaded: ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB video`);
  return { videoBuffer, result: resultPayload };
}

async function publishVideoToFacebook(pageId: string, accessToken: string, videoBuffer: Buffer, description: string): Promise<string> {
  const FormData = (await import('form-data')).default;
  const formData = new FormData();
  formData.append('source', videoBuffer, { filename: 'video.mp4', contentType: 'video/mp4' });
  formData.append('description', description);
  formData.append('access_token', accessToken);

  const res = await axios.post(
    `https://graph-video.facebook.com/v19.0/${pageId}/videos`,
    formData,
    outboundConfig({
      headers: formData.getHeaders(),
      timeout: 180000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    }),
  );

  const videoId = String(res.data?.id || '').trim();
  if (!videoId) throw new Error(`Facebook video upload returned no ID: ${JSON.stringify(res.data)}`);
  console.log(`[video] Facebook video posted: ${videoId}`);
  return videoId;
}

async function generateVideoEngagementComment(topic: string, niche: string, blogUrl?: string): Promise<string> {
  const fallback = blogUrl
    ? `Loved this one? Drop a 🔥 in the replies, share it with someone who needs to see it, and read the full breakdown here → ${blogUrl}`
    : `Loved this one? Drop a 🔥 in the replies and share it with someone who needs to see it. Follow for daily stories like this!`;
  try {
    const blogLine = blogUrl
      ? `\n- The comment MUST end by sharing this exact blog link for the full story: ${blogUrl}\n- Phrase the link naturally, e.g. "full story here →" or "read the deep dive →"`
      : '';
    const raw = await generateText(
      `You are a senior social-media community manager for a viral Facebook page in the "${niche}" niche.
Write ONE pinned-comment-quality reply for a Facebook video about: "${topic}".

The comment MUST:
- Sound 100% human — warm, witty, genuinely curious, NOT corporate, NOT a press release
- Be 2-4 sentences, ~35-55 words
- Open with a hooky line that reacts to the video (no "Hey guys", no "Check this out")
- Ask ONE specific question that invites real replies (not generic "what do you think?")
- Encourage viewers to LIKE, SHARE with a friend, and FOLLOW the page for more
- Feel native to Facebook, not LinkedIn
- Use AT MOST 1 tasteful emoji (or zero)
- NO hashtags${blogLine}

Return ONLY the comment text — no quotes, no preamble.`,
      niche,
    );
    let text = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if (blogUrl && !text.includes(blogUrl)) text = `${text} ${blogUrl}`;
    return text.slice(0, 600) || fallback;
  } catch {
    return fallback;
  }
}

async function generateFacebookVideoCaption(
  topic: string,
  niche: string,
  hashtags: string[],
  _blogUrl?: string,
): Promise<string> {
  const tagLine = (hashtags || []).filter(Boolean).slice(0, 4).join(' ').trim();
  const fallback =
    `${topic} 🤯\n\nLike, share & follow for more.` +
    (tagLine ? `\n\n${tagLine}` : '');
  try {
    const raw = await generateText(
      `You are the social-media editor of a top-performing Facebook page in the "${niche}" niche.
Write ONE short, viral-style Facebook caption for a short vertical video titled: "${topic}".

STRICT CAPTION RULES:
- TOTAL length: 1 to 3 SHORT lines, max 35 words, max 220 characters.
- Line 1: a punchy, scroll-stopping hook (no "You won't believe", no clickbait).
- Optional line 2: one sentence of curiosity or value.
- Final short line: friendly CTA asking viewers to LIKE, SHARE & FOLLOW.
- Up to 1 tasteful emoji total (or zero) — never spammy.
- Do NOT include any URL, link, "link in bio", or "full story" reference.
- Do NOT include hashtags inside the body (they are appended separately).
- No quotes around the whole caption, no preamble, no markdown, no labels.

Return ONLY the caption text.`,
      niche,
    );
    let body = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    body = body.replace(/https?:\/\/\S+/gi, '').replace(/\blink in bio\b/gi, '').replace(/\bfull story\b[^\n]*/gi, '').trim();
    const words = body.split(/\s+/);
    if (words.length > 35) body = words.slice(0, 35).join(' ');
    if (body.length > 220) body = body.slice(0, 220).replace(/\s+\S*$/, '');
    if (tagLine && !body.includes(tagLine)) {
      body = `${body}\n\n${tagLine}`;
    }
    return body || fallback;
  } catch {
    return fallback;
  }
}

export async function runVideoAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
  if (!schedule) {
    console.error(`[video] Schedule ${scheduleId} not found`);
    return;
  }

  const fbPageId = String(schedule.target_id || '').trim();
  const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', fbPageId).single();
  if (!fbPage) {
    await supabase.from('schedules').update({ metadata: buildScheduleMetadataStatus(schedule.metadata, 'failed: facebook page not found') }).eq('id', scheduleId);
    console.error(`[video] Facebook page ${fbPageId} not found`);
    return;
  }

  // Auto-determine niche from the Blogger account linked to this Facebook page
  const { data: linkedBlogger } = await supabase
    .from('blogger_accounts')
    .select('niche, name')
    .eq('facebook_page_id', fbPageId)
    .limit(1)
    .single();

  const niche = String(linkedBlogger?.niche || '').trim() || 'Viral Facts';
  console.log(`[video] Niche resolved from linked Blogger account: "${niche}" (account: "${linkedBlogger?.name || 'none'}")`);

  if (!linkedBlogger) {
    console.warn(`[video] No Blogger account linked to Facebook page "${fbPage.name}" (id=${fbPageId}). Using fallback niche: "${niche}". Link a Blogger account to this Facebook page to set the niche automatically.`);
  }
  const settings = await getSettings();
  const githubRepo = String(settings.github_repo || '').trim();
  const githubPat = decryptSecret(settings.github_pat || '');

  if (!githubRepo || !githubPat) {
    await supabase.from('schedules').update({ metadata: buildScheduleMetadataStatus(schedule.metadata, 'failed: GitHub repo or PAT not configured') }).eq('id', scheduleId);
    return;
  }

  let jobId = '';
  let topic = '';

  try {
    await supabase.from('schedules').update({ metadata: buildScheduleMetadataStatus(schedule.metadata, 'running') }).eq('id', scheduleId);

    // ── 1. Insert a pending job row
    const { data: jobRow } = await supabase.from('video_jobs').insert({
      schedule_id: scheduleId,
      status: 'running',
      created_at: new Date().toISOString(),
    }).select().single();
    jobId = jobRow?.id || '';

    // ── 2. Fetch 100 trending topics from the web + TopicShield selection
    console.log(`[video] Fetching trending topics and selecting unique topic for niche="${niche}"...`);
    const rawTopic = await pickUniqueTrendingTopic(supabase, niche);
    if (!rawTopic) throw new Error(`TopicShield could not find a unique topic for niche="${niche}"`);

    // ── 4. Rewrite topic to viral headline + post-rewrite duplicate check
    //
    // CRITICAL: pickUniqueTrendingTopic only validated the RAW RSS title.
    // Different raw RSS headlines can collapse to the same viral title once
    // rewritten by the AI, producing duplicate videos. We must therefore
    // re-validate the FINAL viral title against history before using it,
    // mirroring runBlogAutomation's post-rewrite check.
    const MAX_REWRITE_ATTEMPTS = 6;
    let rewriteAttempt = 0;
    let acceptedTopic = '';
    let lastRejectedTopic = '';
    while (rewriteAttempt < MAX_REWRITE_ATTEMPTS && !acceptedTopic) {
      rewriteAttempt += 1;
      const candidateTopic = await rewriteToViralTitle(rawTopic, niche);
      const postRewriteHistory = await topicShield_loadHistory(supabase, niche);
      const isUnique = await topicShield_isUnique(candidateTopic, postRewriteHistory, niche);
      if (isUnique) {
        acceptedTopic = candidateTopic;
        break;
      }
      lastRejectedTopic = candidateTopic;
      console.warn(
        `[TopicShield] Post-rewrite duplicate on attempt ${rewriteAttempt}/${MAX_REWRITE_ATTEMPTS}: "${candidateTopic}" — retrying with a fresh trending topic.`,
      );
      // Pull a brand-new RSS candidate so the rewriter has different source material.
      const freshRaw = await pickUniqueTrendingTopic(supabase, niche).catch(() => '');
      if (freshRaw) {
        // Tail-call style: re-bind the local rawTopic for the next loop iteration
        // by reusing the variable through a retry of the rewrite step.
        // (We can't reassign the const above, but rewriteToViralTitle accepts any source.)
        const retryTopic = await rewriteToViralTitle(freshRaw, niche);
        const retryHistory = await topicShield_loadHistory(supabase, niche);
        if (await topicShield_isUnique(retryTopic, retryHistory, niche)) {
          acceptedTopic = retryTopic;
          break;
        }
        lastRejectedTopic = retryTopic;
      }
    }
    if (!acceptedTopic) {
      throw new Error(
        `[TopicShield] Could not produce a unique viral title after ${MAX_REWRITE_ATTEMPTS} rewrite attempts. ` +
          `Last rejected title: "${lastRejectedTopic}". Aborting to prevent duplicate publishing.`,
      );
    }
    topic = acceptedTopic;
    console.log(`[video] Topic selected & rewritten (unique-verified): "${topic}"`);

    // ── 5. Generate structured video script (voiceover + scenes + hashtags)
    console.log('[video] Generating video script...');
    const videoScript = await generateVideoScript(topic, niche);
    const { voiceover, scenes, hashtags } = videoScript;
    console.log(`[video] ✓ Viral hashtags: ${hashtags.join(' ')}`);
    console.log(`[video] Script: ${voiceover.split(' ').length} words, ${scenes.length} scenes`);

    // ── 6. Generate voiceover with word-level timestamps
    console.log('[video] Generating voiceover with timestamps...');
    const { buffer: voiceBuffer, wordTimestamps, voiceId: selectedVoiceId } = await generateVoiceoverWithTimestamps(voiceover);
    if (voiceBuffer.length < 5000) throw new Error('Voiceover audio buffer too small');
    console.log(`[video] Voice: ${selectedVoiceId}`);

    // ── 7. Upload voiceover to GitHub
    const ts = Date.now();
    const voicePath = `automation/voiceovers/voice-${ts}.mp3`;
    await uploadBufferToGithub(githubRepo, githubPat, voiceBuffer, voicePath, `Video voiceover: ${topic}`);
    console.log(`[video] Voiceover uploaded to GitHub: ${voicePath}`);

    // ── 8. Generate scene images with Cloudflare Workers AI
    console.log(`[video] Generating ${scenes.length} scene images...`);
    const scenePaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scenePrompt = `${scenes[i].imagePrompt}. Ultra-realistic, cinematic photography, no text, no words, no letters, no signs, no watermarks, high quality.`;
      const rawBuffer = await generateImage(scenePrompt);
      const sceneBuffer = await compressForGithub(rawBuffer);
      const scenePath = `automation/scenes/scene-${ts}-${i}.jpg`;
      await uploadBufferToGithub(githubRepo, githubPat, sceneBuffer, scenePath, `Video scene ${i + 1}: ${topic}`);
      scenePaths.push(scenePath);
      console.log(`[video] Scene ${i + 1}/${scenes.length} generated & uploaded`);
    }

    // ── 9. Sync render script to GitHub then dispatch render_video workflow
    console.log('[video] Syncing render script to GitHub...');
    await syncRenderScriptToGithub(githubRepo, githubPat);
    const correlationId = `video-${ts}-${Math.random().toString(36).slice(2, 8)}`;

    // AI-generated viral CTA + short attention-grabbing hook for the first 2s
    const ctaText = await generateVideoCTA(topic, niche);
    const hookWords = voiceover.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
    const hookText = (hookWords || topic).toUpperCase().slice(0, 60);

    await dispatchVideoRenderWorkflow(
      githubRepo,
      githubPat,
      voicePath,
      scenePaths,
      wordTimestamps,
      topic,
      correlationId,
      ctaText,
      hookText,
    );

    // ── 10. Poll until video render completes and download artifact
    console.log(`[video] Waiting for render workflow to complete (correlationId=${correlationId})...`);
    const { videoBuffer, result: renderResult } = await waitForVideoRenderArtifact(githubRepo, githubPat, correlationId);
    console.log(`[video] Render complete: ${renderResult.videoDuration?.toFixed(1)}s video, ${renderResult.videoSizeMB}MB`);

    // ── 11. Build a real, human-quality Facebook caption (with blog link + CTA)
    let blogUrl: string | undefined;
    try {
      const { data: blogAccount } = await supabase
        .from('blogger_accounts')
        .select('url')
        .eq('facebook_page_id', fbPage.id)
        .single();
      blogUrl = blogAccount?.url;
    } catch { /* no linked blog, that's ok */ }

    const fbDescription = await generateFacebookVideoCaption(topic, niche, hashtags, blogUrl);
    console.log(`[video] Generated FB caption (${fbDescription.length} chars, viral-style, no link)`);

    // ── 12. Post video to Facebook
    console.log('[video] Uploading video to Facebook...');
    const videoId = await publishVideoToFacebook(fbPage.page_id, fbPage.access_token, videoBuffer, fbDescription);
    const fbVideoUrl = `https://www.facebook.com/${fbPage.page_id}/videos/${videoId}`;
    console.log(`✓ Facebook video published: ${fbVideoUrl}`);

    // ── 14. Post AI-generated engagement comment on the video
    await sleep(8000);
    try {
      const engComment = await generateVideoEngagementComment(topic, niche, blogUrl);
      await axios.post(
        `https://graph.facebook.com/v19.0/${videoId}/comments`,
        { message: engComment, access_token: fbPage.access_token },
        outboundConfig({ timeout: 30000 }),
      );
      console.log(`✓ Engagement comment posted on video ${videoId}`);
    } catch (commentErr: any) {
      console.warn('[video] Comment post warning:', commentErr?.message);
    }

    // ── 15. Save topic to TopicShield history
    {
      const normalized_topic = normalizeTopicText(topic) || topic.toLowerCase().trim();
      const { error: topicInsertErr } = await supabase
        .from('topics')
        .insert({
          niche,
          topic,
          normalized_topic,
          source: 'automation',
          used_for: jobId || scheduleId,
          created_at: new Date().toISOString(),
        });
      if (topicInsertErr) {
        console.error(`[TopicShield] FAILED to save topic to history: ${topicInsertErr.message}. Future runs may produce duplicates.`);
      } else {
        console.log(`[TopicShield] Saved topic to history (niche="${niche}").`);
      }
    }

    // ── 16. Log to video_jobs
    if (jobId) {
      await supabase.from('video_jobs').update({
        status: 'published',
        video_url: fbVideoUrl,
      }).eq('id', jobId);
    }

    // ── 17. Update schedule metadata
    const statusMsg = `success: published video "${topic}" → ${fbVideoUrl}`;
    await supabase.from('schedules').update({ metadata: buildScheduleMetadataStatus(schedule.metadata, statusMsg) }).eq('id', scheduleId);

    console.log(`\n✓ Video automation complete for schedule ${scheduleId}`);
    console.log(`  Topic: ${topic}`);
    console.log(`  Facebook: ${fbVideoUrl}`);
  } catch (error: any) {
    const fbErr = error?.response?.data;
    const errMsg = String(error?.message || error || 'unknown error');
    const detail = fbErr ? ` | response: ${JSON.stringify(fbErr).slice(0, 600)}` : '';
    console.error(`[video] FAILED for schedule ${scheduleId}:`, errMsg + detail);
    if (jobId) {
      await supabase.from('video_jobs').update({ status: 'failed' }).eq('id', jobId);
    }
    await supabase.from('schedules').update({ metadata: buildScheduleMetadataStatus(schedule.metadata, `failed: ${errMsg.slice(0, 200)}`) }).eq('id', scheduleId);
  }
}
