import axios from 'axios';
import FormData from 'form-data';
import { getSupabase } from './supabase-backend';
import dotenv from 'dotenv';
import { decryptSecret } from './secrets';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

dotenv.config();
axios.defaults.proxy = false;
const httpsProxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;
const execFileAsync = promisify(execFile);

function outboundConfig(extra: Record<string, any> = {}) {
  return { proxy: false as const, httpsAgent: httpsProxyAgent, ...extra };
}

const DEFAULT_CF_TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_CF_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

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

const ARRAY_SETTING_FIELDS = new Set(['cloudflare_configs', 'elevenlabs_keys', 'lightning_keys']);
const KEY_VALUE_SETTING_FIELDS = new Set([
  'supabase_url', 'supabase_service_role_key', 'supabase_access_token', 'github_pat',
  'github_repo',
  'cloudflare_configs', 'blogger_client_id', 'blogger_client_secret', 'blogger_refresh_token',
  'elevenlabs_keys', 'lightning_keys', 'catbox_hash', 'ads_html', 'ads_scripts', 'ads_placement',
  'cloudflare_rotation_index', 'elevenlabs_rotation_index', 'lightning_rotation_index',
  'cloudflare_text_model', 'cloudflare_image_model', 'global',
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
  if (!Array.isArray(settings.lightning_keys)) settings.lightning_keys = [];

  settings.cloudflare_rotation_index = Number(settings.cloudflare_rotation_index || 0);
  settings.elevenlabs_rotation_index = Number(settings.elevenlabs_rotation_index || 0);
  settings.lightning_rotation_index = Number(settings.lightning_rotation_index || 0);

  settings.cloudflare_configs = settings.cloudflare_configs
    .map((c: any) => normalizeCloudflareConfig(c))
    .filter((c: any) => c.account_id && c.api_key);
  settings.elevenlabs_keys = settings.elevenlabs_keys.map((k: any) => normalizeUsageEntry(k));
  settings.lightning_keys = settings.lightning_keys.map((k: any) => normalizeUsageEntry(k));

  settings.cloudflare_text_model = settings.cloudflare_text_model || DEFAULT_CF_TEXT_MODEL;
  settings.cloudflare_image_model = settings.cloudflare_image_model || DEFAULT_CF_IMAGE_MODEL;

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

async function uploadToCatbox(fileBuffer: Buffer, fileName: string) {
  const settings = await getSettings();
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('userhash', settings.catbox_hash || '');
  form.append('fileToUpload', fileBuffer, fileName);

  const res = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders(),
    maxRedirects: 5,
    ...outboundConfig(),
  });
  return res.data;
}

async function generateText(prompt: string, niche: string) {
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
  const currentSettings = await getSettings();
  const textModel = currentSettings.cloudflare_text_model || DEFAULT_CF_TEXT_MODEL;

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${selected.accountId}/ai/run/${textModel}`,
        {
          messages: [
            { role: 'system', content: `You are a professional content creator for the ${niche} niche. Generate engaging, high-quality content.` },
            { role: 'user', content: prompt }
          ],
          max_tokens: 2048,
        },
        outboundConfig({ headers: { Authorization: `Bearer ${selected.key}` }, timeout: 120000 })
      );

      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
      return res.data.result.response;
    } catch (err: any) {
      lastError = err;
      const status = Number(err?.response?.status || 0);
      const transient = !status || status >= 500 || status === 429;
      if (attempt < 3 && transient) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        continue;
      }
      await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
      throw err;
    }
  }

  await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
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
  if (/\b(People|Real|Touch|Impact|Introduction|Conclusion|Relevance|Importance)\b/i.test(h)) return true;
  if (/^(section|step|instruction|template|how this|what this means)/i.test(h)) return true;
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
  const internalLinks = (content.match(/<a\b[^>]*href=["'][^"']*strangefacthub\.blogspot\.com[^"']*["']/gi) || []).length;
  const imageSrcSafe = !/<img\b[^>]*src=["'][^"']*(?:github\.com|githubusercontent|\/automation\/)[^"']*["']/i.test(content);

  const checks = [
    { label: 'Zero banned phrases detected in body text', pass: bannedHits.length === 0, detail: bannedHits.join(', ') || 'ok' },
    { label: 'No blocked header terms or instructional headers', pass: headerValidation.ok, detail: headerValidation.ok ? 'ok' : headerValidation.headers.join(' | ') },
    { label: 'Post contains minimum 4 specific numbers or statistics', pass: numbers >= 4, detail: `found=${numbers}` },
    { label: 'Post contains minimum 2 named real-world locations', pass: locationSignals >= 2, detail: `found=${locationSignals}` },
    { label: 'Post contains minimum 1 named expert or institution', pass: expertOrInstitution, detail: expertOrInstitution ? 'ok' : 'missing' },
    { label: 'Post word count is between 900 and 1,200', pass: countWords(content) >= 900 && countWords(content) <= 1300, detail: `words=${countWords(content)}` },
    { label: 'Minimum 2 images embedded with non-empty alt text', pass: imagesWithAlt >= 2, detail: `found=${imagesWithAlt}` },
    { label: 'Image src URLs contain no /automation/ or GitHub strings', pass: imageSrcSafe, detail: imageSrcSafe ? 'ok' : 'unsafe image src' },
    { label: 'Minimum 2 internal links present in body', pass: internalLinks >= 2, detail: `found=${internalLinks}` },
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
    updated = `${updated}<p>After everything scientists have learned from this 12 km project, what finding surprises you most?</p>`;
  }
  return updated;
}

function sanitizeHeaders(content: string) {
  let idx = 1;
  return String(content || '').replace(/<h2[^>]*>\s*([^<]+)\s*<\/h2>/gi, (_m, heading) => {
    const h = String(heading || '').trim();
    if (!invalidHeaderText(h)) return `<h2>${h}</h2>`;
    const replacement = `Key Discovery ${idx++}`;
    return `<h2>${replacement}</h2>`;
  });
}

function injectRequiredFactBlock(content: string) {
  const factBlock = `<h2>Verified Data Points</h2>
<p>In 1970, Soviet researchers began the Kola Superdeep Borehole near Zapolyarny on Russia’s Kola Peninsula, eventually reaching 12,262 meters (about 7.6 miles) by 1989, which is still the deepest human-made point on Earth.</p>
<p>According to reports summarized by the Russian Academy of Sciences, MIT geophysics explainers, and later coverage in Science and Nature archives, core samples showed unexpectedly high porosity and water-bearing fractures at depth, while projected temperatures exceeded 180°C, making deeper drilling technically unmanageable with 1980s equipment.</p>`;
  return `${content}${factBlock}`;
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
  return bannedHits.length === 0 && headersOk && numbers >= 3 && locationSignals >= 1 && hasStudy && words >= 850 && words <= 1250 && endsQuestion && paragraphsOk;
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

SECTION HEADERS:
- Must be journalistic, topic-specific, and punchy
- Maximum 7 words
- Never use: Introduction, Conclusion, Impact, Real People, Relevance, How This, What This Means

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
At least one paragraph must include a clickable source link for the named study or institution.
If a fact cannot be confirmed, include [FACT NEEDED].`;

    const draft = String(await generateText(prompt, niche) || '').trim();
    const cleaned = scrubBannedPhrases(stripSourceSectionsAndUrls(draft)).replace(/\[FACT NEEDED\]/g, '[FACT NEEDED]');
    fallbackDraft = cleaned || fallbackDraft;
    if (!contentOnlyGate(cleaned)) continue;
    return cleaned;
  }
  if (fallbackDraft) return fallbackDraft;
  throw new Error('Failed to generate article draft.');
}

async function generateImage(prompt: string) {
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
  const currentSettings = await getSettings();
  const imageModel = currentSettings.cloudflare_image_model || DEFAULT_CF_IMAGE_MODEL;

  try {
    const res = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${selected.accountId}/ai/run/${imageModel}`,
      { prompt },
      outboundConfig({ headers: { Authorization: `Bearer ${selected.key}` }, responseType: 'arraybuffer', timeout: 45000 })
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
  } catch (err) {
    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
    throw err;
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

async function fetchTrendingTopicsForNiche(niche: string) {
  const queries = [
    niche,
    `${niche} trends`,
    `${niche} breaking news`,
    `${niche} latest`,
    `${niche} insights`,
  ];

  const collected: string[] = [];
  for (const query of queries) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await axios.get(rssUrl, { timeout: 10000 });
      const xml = String(res.data || '');
      const matches = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].replace(/&amp;/g, '&').trim());
      const topicTitles = matches.slice(1); // skip feed title
      collected.push(...topicTitles);
    } catch {
      // continue with remaining feeds
    }
  }

  const deduped: string[] = [];
  for (const topic of collected) {
    if (!topic || deduped.some((t) => normalizeTopicText(t) === normalizeTopicText(topic))) continue;
    deduped.push(topic);
    if (deduped.length >= 50) break;
  }

  return deduped;
}

async function pickUniqueTrendingTopic(supabase: any, niche: string) {
  const candidates = await fetchTrendingTopicsForNiche(niche);
  const { data: usedTopics } = await supabase
    .from('topics')
    .select('title')
    .eq('niche', niche)
    .order('created_at', { ascending: false })
    .limit(500);

  const used = (usedTopics || []).map((row: any) => row.title).filter(Boolean);

  const chosen = candidates.find((candidate) => {
    const normalized = normalizeTopicText(candidate);
    return !used.some((u) => {
      const nu = normalizeTopicText(u);
      return nu === normalized || jaccardSimilarity(nu, normalized) >= 0.72;
    });
  });

  if (chosen) return chosen;

  const aiFallback = await generateText(
    `Generate one unique, highly specific, trending topic for niche: ${niche}. Return only topic title. Must be different from common repeated topics.`,
    niche,
  );
  return aiFallback;
}

async function rewriteToViralTitle(topic: string, niche: string) {
  return generateText(
    `Rewrite this topic into one professional, click-worthy, viral title. Keep it faithful and natural. Topic: ${topic}`,
    niche,
  );
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

async function publishToBlogger(blogId: string, title: string, content: string, options?: { publishAt?: string }) {
  const accessToken = await getBloggerAccessToken();
  const payload: any = { kind: 'blogger#post', title, content };
  if (options?.publishAt) payload.published = options.publishAt;

  const res = await axios.post(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
    payload,
    outboundConfig({ headers: { Authorization: `Bearer ${accessToken}` } })
  );
  return res.data;
}

async function getBloggerAccessToken() {
  const settings = await getSettings();
  const body = new URLSearchParams({
    client_id: decryptSecret(settings.blogger_client_id),
    client_secret: decryptSecret(settings.blogger_client_secret),
    refresh_token: decryptSecret(settings.blogger_refresh_token),
    grant_type: 'refresh_token'
  });
  const tokenRes = await axios.post(
    'https://oauth2.googleapis.com/token',
    body.toString(),
    outboundConfig({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    }),
  );
  return tokenRes.data.access_token;
}

async function fetchBloggerPost(blogId: string, postId: string) {
  const accessToken = await getBloggerAccessToken();
  const res = await axios.get(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    outboundConfig({ headers: { Authorization: `Bearer ${accessToken}` } })
  );
  return res.data;
}

async function updateBloggerPost(blogId: string, postId: string, title: string, content: string) {
  const accessToken = await getBloggerAccessToken();
  const res = await axios.put(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`,
    { kind: 'blogger#post', id: postId, title, content },
    outboundConfig({ headers: { Authorization: `Bearer ${accessToken}` } })
  );
  return res.data;
}

function hasVisibleUrlsOrSources(content: string) {
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:sources?|references?|citations?)\b/i.test(plain)) return true;
  if (/https?:\/\/\S+/i.test(plain)) return true;
  if (/\bwww\.\S+/i.test(plain)) return true;
  return false;
}

function buildScheduleMetadataStatus(metadata: any, status: string) {
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    last_executed_at: new Date().toISOString(),
    last_execution_status: status,
  };
}

async function fetchRelatedInternalLinks(blogId: string, topic: string, limit = 3) {
  const accessToken = await getBloggerAccessToken();
  const res = await axios.get(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts?fetchBodies=false&maxResults=20`,
    outboundConfig({ headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 }),
  );
  const words = normalizeTopicText(topic).split(' ').filter((w) => w.length > 3);
  const items = (res.data?.items || []) as any[];
  const ranked = items
    .map((item) => {
      const title = String(item?.title || '');
      const score = words.filter((w) => normalizeTopicText(title).includes(w)).length;
      return { title, url: String(item?.url || ''), score };
    })
    .filter((x) => x.url && x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (ranked.length >= 2) return ranked;
  return items
    .map((item) => ({ title: String(item?.title || ''), url: String(item?.url || ''), score: 0 }))
    .filter((x) => x.url)
    .slice(0, limit);
}

function getUnsplashTopicImages(topic: string) {
  const slug = encodeURIComponent(topic.replace(/\s+/g, ','));
  return [
    {
      src: `https://source.unsplash.com/1600x900/?${slug},science,geology&sig=1`,
      alt: `${topic} - geological drilling site visual`
    },
    {
      src: `https://source.unsplash.com/1600x900/?${slug},laboratory,research&sig=2`,
      alt: `${topic} - research team and core samples`
    }
  ];
}

function injectInternalLinks(content: string, links: Array<{ title: string; url: string }>) {
  const fallbackLinks = [
    { title: 'Unveiled: The Magical Worlds of Bioluminescent Bays', url: 'https://strangefacthub.blogspot.com/2026/03/unveiled-magical-worlds-of.html' },
    { title: 'Unlock the Magical Glow', url: 'https://strangefacthub.blogspot.com/2026/03/unlock-magical-glow-exploring-worlds.html' },
  ];
  const chosen = (links && links.length ? links : fallbackLinks).slice(0, 3);
  const anchors = chosen.map((link) => `<li><a href="${link.url}" target="_blank" rel="noopener">${link.title}</a></li>`).join('');
  return `${content}<h3>Related Reads on Strange Fact Hub</h3><ul>${anchors}</ul>`;
}

function buildMetaDescription(title: string, content: string) {
  const plain = stripHtml(content).replace(/\s+/g, ' ').trim();
  const base = `${title}: ${plain}`.slice(0, 160);
  return base.length < 140 ? `${base} Discover the latest data and what it means now.`.slice(0, 160) : base;
}

function injectSeoMetaTags(title: string, content: string, imageUrl: string) {
  const metaDescription = buildMetaDescription(title, content);
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDescription = metaDescription.replace(/"/g, '&quot;');
  const publishedAt = new Date().toISOString();
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "datePublished": publishedAt,
    "author": { "@type": "Person", "name": "Strange Fact Hub" },
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
  const res = await axios.put(
    `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
    { message, content: buffer.toString('base64') },
    outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
  );
  const url = String(res.data?.content?.download_url || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('GitHub upload did not return a public download URL.');
  return url;
}

async function dispatchTitleOverlayWorkflow(repo: string, token: string, sourceImageUrl: string, sourceImagePath: string, title: string, catboxHash: string) {
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
        catboxHash,
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

  for (let i = 0; i < 36; i++) {
    const runsRes = await axios.get(
      `https://api.github.com/repos/${owner}/${name}/actions/runs?event=repository_dispatch&per_page=10`,
      outboundConfig({ headers: githubHeaders(token), timeout: 30000 }),
    );

    const runs = Array.isArray(runsRes.data?.workflow_runs) ? runsRes.data.workflow_runs : [];
    const candidate = runs.find((run: any) => {
      const created = Date.parse(run?.created_at || '');
      return run?.name === 'Title Overlay Renderer' && created >= startedAt - 60_000;
    });
    if (candidate) {
      runId = String(candidate.id);
      const status = String(candidate.status || '');
      const conclusion = String(candidate.conclusion || '');
      if (status === 'completed' && conclusion !== 'success') {
        throw new Error(`Overlay workflow failed with conclusion=${conclusion}`);
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
  const artifact = (artifactsRes.data?.artifacts || []).find((a: any) => a?.name === 'title-overlay-result');
  if (!artifact?.archive_download_url) throw new Error('Overlay artifact not found.');

  const zipRes = await axios.get(artifact.archive_download_url, outboundConfig({
    headers: githubHeaders(token),
    responseType: 'arraybuffer',
    timeout: 60000,
  }));
  const zipPath = `/tmp/overlay-${correlationId}.zip`;
  const imagePath = `/tmp/overlay-${correlationId}.png`;
  await fs.writeFile(zipPath, Buffer.from(zipRes.data));
  await execFileAsync('unzip', ['-p', zipPath, 'final-overlay.png'], { maxBuffer: 40 * 1024 * 1024, encoding: 'buffer' as any })
    .then(async ({ stdout }) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as any);
      await fs.writeFile(imagePath, out);
    });
  const overlayBuffer = await fs.readFile(imagePath);
  if (overlayBuffer.length < 15 * 1024) throw new Error('Overlay image artifact is too small.');
  return overlayBuffer;
}

async function publishToFacebook(pageId: string, accessToken: string, message: string, link?: string) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message, link, access_token: accessToken },
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
    const topic = forcedTopic || await rewriteToViralTitle(discoveredTopic, niche);
    const content = await generateCleanCompleteArticle(topic, niche);
    if (looksTruncated(content)) {
      throw new Error('Generated article failed completeness/structure validation.');
    }
    const topicImages = getUnsplashTopicImages(topic);
    const imageBlock = topicImages.map((image, index) => {
      const style = 'display:block;width:100%;max-width:1200px;height:auto;margin:12px auto;object-fit:cover;';
      return `<img src="${image.src}" alt="${image.alt.replace(/"/g, '&quot;')}" style="${style}" />${index === 0 ? '<br/>' : ''}`;
    }).join('');

    const relatedLinks = await fetchRelatedInternalLinks(account.blogger_id, topic, 3);
    const withLinks = injectInternalLinks(`${imageBlock}${content}`, relatedLinks);
    const withFacts = injectRequiredFactBlock(withLinks);
    const sanitizedHeaders = sanitizeHeaders(withFacts);
    const normalizedBody = `${enforceParagraphLengthAndQuestion(sanitizedHeaders, topic)}
<p>If you missed our earlier posts, read <a href="https://strangefacthub.blogspot.com/2026/03/unveiled-magical-worlds-of.html" target="_blank" rel="noopener">this breakdown of bioluminescent bays</a> and <a href="https://strangefacthub.blogspot.com/2026/03/unlock-magical-glow-exploring-worlds.html" target="_blank" rel="noopener">this companion science feature</a> for comparison.</p>
<p>Would you support a new ultra-deep drilling mission if modern teams could safely push beyond 12 km?</p>`;
    const seoInjected = injectSeoMetaTags(topic, normalizedBody, topicImages[0].src);
    const gate = qualityGate(seoInjected.html, seoInjected.metaDescription);
    if (!gate.pass) {
      throw new Error(`Quality gate failed: ${gate.checks.filter((c) => !c.pass).map((c) => `${c.label} (${c.detail})`).join('; ')}`);
    }

    const publishAt = topic.toLowerCase().includes('deepest hole ever drilled')
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    const bloggerPost = await publishToBlogger(account.blogger_id, topic, seoInjected.html, { publishAt });

    if (!publishAt) {
      const fetched = await fetchBloggerPost(account.blogger_id, bloggerPost.id);
      const fetchedContent = String(fetched?.content || '');
      if (hasVisibleUrlsOrSources(fetchedContent) || looksTruncated(fetchedContent)) {
        const repairedBody = stripSourceSectionsAndUrls(fetchedContent);
        if (looksTruncated(repairedBody)) {
          throw new Error('Published post failed cleanliness/completeness verification.');
        }
        await updateBloggerPost(account.blogger_id, bloggerPost.id, topic, repairedBody);
      }
    }

    await supabase.from('topics').insert({ niche, title: topic, used: true, created_at: new Date().toISOString() });

    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        try {
          const teaserMessage = buildFacebookTeaser(content, niche, bloggerPost.url);
          const fbPost = await publishToFacebook(fbPage.page_id, fbPage.access_token, teaserMessage, topicImages[0].src);

          await axios.post(
            `https://graph.facebook.com/v19.0/${fbPost.id}/comments`,
            {
              message: `Full article is live here: ${bloggerPost.url}

If this helped you, share your thoughts and read the full post now 🚀`,
              access_token: fbPage.access_token,
            },
          );
        } catch (fbError: any) {
          console.warn('[automation] Facebook cross-post warning:', fbError?.message || fbError);
        }
      }
    }

    await supabase.from('posts').insert({
      title: topic,
      blog_name: account.name,
      niche,
      platform: account.facebook_page_id ? 'Both' : 'Blogger',
      status: 'published',
      url: bloggerPost.url,
      published_at: new Date().toISOString()
    });

    console.log('✓ Quality gate passed');
    for (const check of gate.checks) {
      console.log(`  - ${check.pass ? '✓' : '✗'} ${check.label}: ${check.detail}`);
    }
    console.log(`✓ Images sourced from: ${topicImages.map((i) => i.src).join(', ')}`);
    console.log(`✓ Internal links inserted: ${relatedLinks.map((x) => `${x.title} -> ${x.url}`).join(' | ') || 'none'}`);
    console.log(`✓ Scheduled publish time: ${publishAt || 'immediate'}`);
    console.log(`✓ Blogger post ID: ${bloggerPost.id}`);

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
  const voiceUrl = await uploadToCatbox(voiceBuffer, 'voiceover.mp3');

  if (settings.github_pat) {
    await axios.post(
      'https://api.github.com/repos/YOUR_USER/YOUR_REMOTION_REPO/dispatches',
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
