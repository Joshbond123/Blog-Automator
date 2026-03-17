import axios from 'axios';
import FormData from 'form-data';
import { getSupabase } from './supabase-backend';
import dotenv from 'dotenv';
import { decryptSecret } from './secrets';

dotenv.config();

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
    headers: form.getHeaders()
  });
  return res.data;
}

async function generateText(prompt: string, niche: string) {
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
  const currentSettings = await getSettings();
  const textModel = currentSettings.cloudflare_text_model || DEFAULT_CF_TEXT_MODEL;

  try {
    const res = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${selected.accountId}/ai/run/${textModel}`,
      {
        messages: [
          { role: 'system', content: `You are a professional content creator for the ${niche} niche. Generate engaging, high-quality content.` },
          { role: 'user', content: prompt }
        ]
      },
      { headers: { Authorization: `Bearer ${selected.key}` } }
    );

    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
    return res.data.result.response;
  } catch (err) {
    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, false);
    throw err;
  }
}

async function generateImage(prompt: string) {
  const selected = await pickRotatingKey('cloudflare_configs', 'cloudflare_rotation_index');
  const currentSettings = await getSettings();
  const imageModel = currentSettings.cloudflare_image_model || DEFAULT_CF_IMAGE_MODEL;

  try {
    const res = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${selected.accountId}/ai/run/${imageModel}`,
      { prompt },
      { headers: { Authorization: `Bearer ${selected.key}` }, responseType: 'arraybuffer' }
    );

    await trackKeyUsage('cloudflare_configs', 'cloudflare_rotation_index', selected.key, true);
    return Buffer.from(res.data);
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

async function publishToBlogger(blogId: string, title: string, content: string) {
  const settings = await getSettings();
  const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: decryptSecret(settings.blogger_client_id),
    client_secret: decryptSecret(settings.blogger_client_secret),
    refresh_token: decryptSecret(settings.blogger_refresh_token),
    grant_type: 'refresh_token'
  });
  const accessToken = tokenRes.data.access_token;

  const res = await axios.post(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`,
    { kind: 'blogger#post', title, content },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.data;
}

async function publishToFacebook(pageId: string, accessToken: string, message: string, link?: string) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message, link, access_token: accessToken }
  );
  return res.data;
}

export async function runBlogAutomation(scheduleId: string) {
  const supabase = getSupabase();
  const { data: schedule } = await supabase.from('schedules').select('*, blogger_accounts(*)').eq('id', scheduleId).single();
  if (!schedule) return;

  const account = schedule.blogger_accounts;
  const niche = account.niche;

  try {
    const discoveredTopic = await pickUniqueTrendingTopic(supabase, niche);
    const topic = await rewriteToViralTitle(discoveredTopic, niche);
    const content = await generateText(
      `Write a high-quality, engaging, professional blog article about: "${topic}" for niche "${niche}". Keep it topic-specific and non-generic. Return clean HTML.`,
      niche,
    );

    const imageBuffer = await generateImage(
      `Create a realistic, high-impact image about: ${topic}. No text, no letters, no words, no logos, no watermark, no captions in the image.`,
    );

    const imageUrl = await uploadToCatbox(imageBuffer, `blog-image-${Date.now()}.png`);
    const bloggerPost = await publishToBlogger(account.blogger_id, topic, `<img src="${imageUrl}" style="width:100%" /><br/>${content}`);

    await supabase.from('topics').insert({ niche, title: topic, used: true, created_at: new Date().toISOString() });

    if (account.facebook_page_id) {
      const { data: fbPage } = await supabase.from('facebook_pages').select('*').eq('id', account.facebook_page_id).single();
      if (fbPage) {
        const teaserMessage = buildFacebookTeaser(content, niche, bloggerPost.url);
        const fbPost = await publishToFacebook(fbPage.page_id, fbPage.access_token, teaserMessage, imageUrl);

        await axios.post(
          `https://graph.facebook.com/v19.0/${fbPost.id}/comments`,
          {
            message: `Full article is live here: ${bloggerPost.url}

If this helped you, share your thoughts and read the full post now 🚀`,
            access_token: fbPage.access_token,
          },
        );
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

    await supabase.from('schedules').update({ last_execution_status: 'success', last_executed_at: new Date().toISOString() }).eq('id', scheduleId);
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
    await supabase.from('schedules').update({ last_execution_status: `failed: ${error?.message || 'unknown'}`, last_executed_at: new Date().toISOString() }).eq('id', scheduleId);
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
