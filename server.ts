import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cron from "node-cron";
import { createVerifiedSupabaseClient, getSupabase, updateSupabaseConfig, getPublicConfig, getCurrentSupabaseConfig, verifyCurrentSupabaseConnection } from "./supabase-backend";
import { runBlogAutomation, runVideoAutomation } from "./automation";
import { decryptSecret, encryptSecret } from "./secrets";
import axios from "axios";
import { fetch as undiciFetch, ProxyAgent } from "undici";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log("Starting server initialization...");
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  const SECRET_SETTING_FIELDS = ["blogger_client_id", "blogger_client_secret", "blogger_refresh_token"] as const;

  const outboundProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const outboundProxyAgent = outboundProxyUrl ? new ProxyAgent(outboundProxyUrl) : null;

  const proxyFetch = (url: string, init: any = {}) => {
    if (outboundProxyAgent) {
      return undiciFetch(url, { ...init, dispatcher: outboundProxyAgent } as any);
    }
    return undiciFetch(url, init as any);
  };

  const graphGet = async (path: string, params: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    const response = await proxyFetch(`https://graph.facebook.com/v20.0/${path}?${query}`);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || payload?.error) {
      const err: any = new Error(payload?.error?.message || `Facebook Graph request failed (${response.status})`);
      err.facebookError = payload?.error;
      throw err;
    }
    return payload;
  };

  const ARRAY_SETTING_FIELDS = new Set(["cloudflare_configs", "elevenlabs_keys", "lightning_keys"]);
  const SETTINGS_FIELDS = new Set([
    "supabase_url", "supabase_service_role_key", "supabase_access_token", "github_pat",
    "cloudflare_configs", "blogger_client_id", "blogger_client_secret", "blogger_refresh_token",
    "elevenlabs_keys", "lightning_keys", "catbox_hash", "ads_html", "ads_scripts", "ads_placement", "cloudflare_text_model", "cloudflare_image_model", "github_repo"
  ]);

  const ensureArray = (value: any) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };


  const isLikelyCloudflareAccountId = (value: any) => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim());
  const isLikelyCloudflareApiToken = (value: any) => typeof value === 'string' && value.trim().length > 24 && /[-_]/.test(value);

  const normalizeCloudflareConfig = (entry: any = {}) => {
    const accountId = entry?.account_id;
    const apiKey = entry?.api_key || entry?.key;

    if (isLikelyCloudflareAccountId(apiKey) && isLikelyCloudflareApiToken(accountId)) {
      return { ...entry, account_id: apiKey, api_key: accountId };
    }

    return { ...entry, account_id: accountId, api_key: apiKey };
  };

  const classifyFacebookTokenError = (error: any) => {
    const code = Number(error?.code || 0);
    if (code === 190) return 'expired';
    if (code === 10 || code === 200 || code === 2500) return 'invalid';
    return 'error';
  };

  const verifyFacebookPageToken = async (pageId: string, token: string) => {
    try {
      const payload = await graphGet(encodeURIComponent(pageId), { fields: 'id,name', access_token: token });
      return { status: 'valid', page_id: payload.id || pageId, name: payload.name || null, token_error: null };
    } catch (error: any) {
      const fbError = error?.facebookError;
      const status = classifyFacebookTokenError(fbError);
      return {
        status,
        page_id: pageId,
        name: null,
        token_error: fbError?.message || error?.message || 'Failed to verify token',
      };
    }
  };

  const normalizeSettings = (settings: any = {}) => {
    const normalized = { ...settings };
    normalized.cloudflare_configs = ensureArray(normalized.cloudflare_configs).map(normalizeCloudflareConfig);
    normalized.elevenlabs_keys = ensureArray(normalized.elevenlabs_keys);
    normalized.lightning_keys = ensureArray(normalized.lightning_keys);
    normalized.ads_placement = normalized.ads_placement || 'after';
    normalized.cloudflare_text_model = normalized.cloudflare_text_model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    normalized.cloudflare_image_model = normalized.cloudflare_image_model || '@cf/black-forest-labs/flux-1-schnell';

    if (normalized.cloudflare_configs.length === 0 && normalized.cloudflare_api_keys && normalized.cloudflare_account_id) {
      const oldKeys = String(normalized.cloudflare_api_keys).split(',').map((v: string) => v.trim()).filter(Boolean);
      normalized.cloudflare_configs = oldKeys.map((key: string) => ({ account_id: normalized.cloudflare_account_id, api_key: key }));
    }

    for (const field of SECRET_SETTING_FIELDS) {
      normalized[field] = decryptSecret(normalized[field]);
    }
    return normalized;
  };

  const protectSettings = (settings: any = {}) => {
    const protectedSettings = { ...settings };
    for (const field of SECRET_SETTING_FIELDS) {
      if (field in protectedSettings) {
        protectedSettings[field] = encryptSecret(protectedSettings[field]);
      }
    }
    return protectedSettings;
  };

  const parseStoredValue = (key: string, value: any) => {
    if (value == null) return null;
    if (ARRAY_SETTING_FIELDS.has(key)) return ensureArray(value);
    return value;
  };

  const serializeStoredValue = (key: string, value: any) => {
    if (value === undefined) return null;
    if (value === null) return null;
    if (ARRAY_SETTING_FIELDS.has(key)) return JSON.stringify(ensureArray(value));
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const isKeyValueSettingsSchema = async (supabase: any) => {
    const { error } = await supabase.from("settings").select("setting_key,setting_value").limit(1);
    return !error;
  };

  const readSettings = async (supabase: any) => {
    const keyValueMode = await isKeyValueSettingsSchema(supabase);
    if (keyValueMode) {
      const { data, error } = await supabase.from("settings").select("setting_key,setting_value");
      if (error) throw error;
      const mapped: any = {};
      for (const row of data || []) {
        const key = row.setting_key;
        if (!SETTINGS_FIELDS.has(key)) continue;
        mapped[key] = parseStoredValue(key, row.setting_value);
      }
      return normalizeSettings(mapped);
    }

    const { data, error } = await supabase.from("settings").select("*").limit(1);
    if (error) throw error;
    return normalizeSettings((data && data[0]) || {});
  };

  const writeSettings = async (supabase: any, payload: any) => {
    const keyValueMode = await isKeyValueSettingsSchema(supabase);
    const safePayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => SETTINGS_FIELDS.has(k)));

    if (keyValueMode) {
      const rows = Object.entries(safePayload).map(([setting_key, rawValue]) => ({
        setting_key,
        setting_value: serializeStoredValue(setting_key, rawValue),
      }));
      if (rows.length > 0) {
        const { error } = await supabase.from("settings").upsert(rows, { onConflict: "setting_key" });
        if (error) throw error;
      }
      return readSettings(supabase);
    }

    const { data: existingRows } = await supabase.from("settings").select("*").limit(1);
    const row = existingRows?.[0];
    if (row?.id) {
      const { error } = await supabase.from("settings").update(safePayload).eq("id", row.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("settings").insert({ id: 1, ...safePayload });
      if (error) throw error;
    }
    return readSettings(supabase);
  };

  const deleteSettingFieldInStorage = async (supabase: any, field: string) => {
    const keyValueMode = await isKeyValueSettingsSchema(supabase);
    if (keyValueMode) {
      if (field === "ads_placement") {
        const { error } = await supabase.from("settings").upsert({ setting_key: field, setting_value: "after" }, { onConflict: "setting_key" });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("settings").delete().eq("setting_key", field);
        if (error) throw error;
      }
      return readSettings(supabase);
    }

    const resetValue = field === "ads_placement" ? "after" : null;
    return writeSettings(supabase, { [field]: resetValue });
  };


  const isLegacyScheduleSchema = async (supabase: any) => {
    const { error } = await supabase.from("schedules").select("type,posting_time,active").limit(1);
    return !error;
  };

  const normalizeSchedule = (row: any, legacy: boolean) => {
    if (legacy) {
      return {
        ...row,
        type: row.type || 'blog',
        posting_time: row.posting_time,
        active: row.active ?? true,
      };
    }

    const metadata = row.metadata || {};
    const rawTime = String(row.schedule_time || '').slice(0, 5);
    return {
      ...row,
      type: row.channel === 'video' ? 'video' : 'blog',
      posting_time: rawTime,
      active: row.is_enabled ?? true,
      last_execution_status: metadata.last_execution_status || null,
      last_executed_at: metadata.last_executed_at || null,
    };
  };

  const scheduleTypeOf = (row: any) => (row?.type === 'video' || row?.channel === 'video' ? 'video' : 'blog');

  app.use(express.json());
  console.log("Express middleware configured.");

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/config", (req, res) => {
    res.json(getPublicConfig());
  });

  app.get("/api/supabase/status", async (req, res) => {
    const status = await verifyCurrentSupabaseConnection();
    const cfg = getCurrentSupabaseConfig();
    res.json({
      ...status,
      url: cfg.url,
      has_access_token: Boolean(cfg.anonKey),
      has_service_role_key: Boolean(cfg.serviceRoleKey),
    });
  });

  // Settings Management
  // Settings
  app.get("/api/settings", async (req, res) => {
    try {
      const supabase = getSupabase();
      const normalized = await readSettings(supabase);
      const cfg = getCurrentSupabaseConfig();
      if (!normalized.supabase_url && cfg.url) normalized.supabase_url = cfg.url;
      if (!normalized.supabase_access_token && cfg.anonKey) normalized.supabase_access_token = cfg.anonKey;
      normalized.supabase_service_role_key = normalized.supabase_service_role_key || "";
      res.json(normalized);
    } catch (err: any) {
      // If not configured, return empty settings so user can configure
      const cfg = getCurrentSupabaseConfig();
      res.json({
        cloudflare_configs: [],
        elevenlabs_keys: [],
        lightning_keys: [],
        supabase_url: cfg.url || "",
        supabase_service_role_key: "",
        supabase_access_token: cfg.anonKey || ""
      });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const section = req.body?._section;
      const requestPayload = { ...(req.body || {}) };
      delete requestPayload._section;

      // Only update runtime Supabase config when user is explicitly saving Supabase settings
      if (section === 'supabase' && requestPayload.supabase_url && requestPayload.supabase_service_role_key) {
        updateSupabaseConfig({
          url: requestPayload.supabase_url,
          serviceRoleKey: requestPayload.supabase_service_role_key,
          anonKey: requestPayload.supabase_access_token
        });
      }

      const supabase = getSupabase();
      const protectedBody = protectSettings(requestPayload);
      const saved = await writeSettings(supabase, protectedBody);
      res.json(saved);
    } catch (err: any) {
      console.error("Settings save error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/settings/field/:field", async (req, res) => {
    const allowedFields = new Set([
      "supabase_url", "supabase_access_token", "supabase_service_role_key",
      "github_pat", "catbox_hash", "ads_html", "ads_scripts", "ads_placement",
      "blogger_client_id", "blogger_client_secret", "blogger_refresh_token",
      "cloudflare_configs", "elevenlabs_keys", "lightning_keys"
    ]);
    const field = req.params.field;
    if (!allowedFields.has(field)) return res.status(400).json({ error: "Field not allowed" });

    try {
      const supabase = getSupabase();
      const updated = await deleteSettingFieldInStorage(supabase, field);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/settings/verify-supabase", async (req, res) => {
    const { url, service_role_key } = req.body || {};
    try {
      if (url && service_role_key) {
        const tempClient = createVerifiedSupabaseClient(url, service_role_key);
        const { error } = await tempClient.from("settings").select("*").limit(1);
        if (error) throw error;
        return res.json({ status: "connected" });
      }

      const status = await verifyCurrentSupabaseConnection();
      if (!status.connected) {
        return res.status(400).json({ error: "Supabase is not connected" });
      }
      res.json({ status: "connected" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/facebook/verify-token", async (req, res) => {
    const { token, page_id } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
      if (page_id) {
        const verified = await verifyFacebookPageToken(page_id, token);
        return res.json(verified);
      }

      try {
        const data: any = await graphGet('me', { fields: 'id,name', access_token: token });
        return res.json({ status: 'valid', id: data.id, name: data.name });
      } catch (error: any) {
        const fbError = error?.facebookError;
        return res.status(400).json({
          status: classifyFacebookTokenError(fbError),
          error: fbError?.message || 'Invalid Facebook token',
        });
      }
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  app.post("/api/facebook/pages-from-token", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
      const data: any = await graphGet('me/accounts', { access_token: token });

      const pages = (data.data || []).map((page: any) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        access_token: page.access_token,
      }));

      return res.json({ pages });
    } catch (err: any) {
      const fbError = err?.facebookError;
      const nonExistingAccountsField = fbError?.code === 100 && /accounts/i.test(String(fbError?.message || ""));
      if (nonExistingAccountsField) {
        try {
          const meData: any = await graphGet('me', { fields: 'id,name,category', access_token: token });
          return res.json({ pages: [{ id: meData.id, name: meData.name || 'Facebook Page', category: meData.category, access_token: token }] });
        } catch (innerErr: any) {
          return res.status(400).json({ error: innerErr?.facebookError?.message || fbError?.message || 'Failed to fetch Facebook pages' });
        }
      }

      return res.status(400).json({ error: fbError?.message || err?.message || 'Failed to fetch Facebook pages' });
    }
  });

  app.get("/api/blogger/available-accounts", async (req, res) => {
    try {
      const supabase = getSupabase();

      const settings = await readSettings(supabase);


      if (!settings.blogger_client_id || !settings.blogger_client_secret || !settings.blogger_refresh_token) {
        return res.status(400).json({ error: "Blogger OAuth credentials are not configured" });
      }

      const tokenForm = new URLSearchParams({
        client_id: settings.blogger_client_id,
        client_secret: settings.blogger_client_secret,
        refresh_token: settings.blogger_refresh_token,
        grant_type: "refresh_token",
      });

      const tokenResponse = await proxyFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm.toString(),
      });
      const tokenPayload: any = await tokenResponse.json();
      if (!tokenResponse.ok || tokenPayload?.error) {
        throw new Error(tokenPayload?.error_description || tokenPayload?.error || `Blogger OAuth failed (${tokenResponse.status})`);
      }

      const blogsResponse = await proxyFetch("https://www.googleapis.com/blogger/v3/users/self/blogs", {
        headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
      });
      const blogsPayload: any = await blogsResponse.json();
      if (!blogsResponse.ok || blogsPayload?.error) {
        throw new Error(blogsPayload?.error?.message || blogsPayload?.error || `Failed to fetch Blogger accounts (${blogsResponse.status})`);
      }

      const blogs = (blogsPayload.items || []).map((item: any) => ({
        blogger_id: item.id,
        name: item.name,
        url: item.url,
      }));

      res.json(blogs);
    } catch (err: any) {
      res.status(500).json({ error: err.response?.data?.error_description || err.response?.data?.error?.message || err.message });
    }
  });

  // Blogger Accounts
  app.get("/api/blogger-accounts", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("blogger_accounts").select("*");
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/blogger-accounts", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("blogger_accounts").insert(req.body).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Facebook Pages
  app.get("/api/facebook-pages", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("facebook_pages").select("*");
      if (error) return res.status(500).json({ error: error.message });

      const refreshStatus = String(req.query.refresh || "1") !== "0";
      if (!refreshStatus || !(data || []).length) {
        return res.json(data || []);
      }

      const verified = await Promise.all((data || []).map(async (page: any) => {
        const result = await verifyFacebookPageToken(page.page_id, page.access_token);
        return { ...page, status: result.status, name: result.name || page.name };
      }));

      await Promise.all(verified.map((page: any) =>
        supabase.from("facebook_pages").update({ status: page.status, name: page.name }).eq("id", page.id)
      ));

      res.json(verified);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/facebook-pages", async (req, res) => {
    try {
      const supabase = getSupabase();
      const verified = await verifyFacebookPageToken(req.body.page_id, req.body.access_token);
      const payload = {
        ...req.body,
        status: verified.status,
        name: verified.name || req.body.name,
      };
      const { data, error } = await supabase.from("facebook_pages").insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/facebook-pages/:id", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from("facebook_pages").delete().eq("id", req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.sendStatus(204);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/blogger-accounts/:id", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("blogger_accounts").update(req.body).eq("id", req.params.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/blogger-accounts/:id", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from("blogger_accounts").delete().eq("id", req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.sendStatus(204);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Schedules
  app.get("/api/schedules", async (req, res) => {
    try {
      const supabase = getSupabase();
      const legacy = await isLegacyScheduleSchema(supabase);
      const { data, error } = await supabase.from("schedules").select("*");
      if (error) return res.status(500).json({ error: error.message });
      res.json((data || []).map((row: any) => normalizeSchedule(row, legacy)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/schedules", async (req, res) => {
    try {
      const supabase = getSupabase();
      const legacy = await isLegacyScheduleSchema(supabase);
      const body = req.body || {};
      const type = body.type === 'video' ? 'video' : 'blog';

      const payload = legacy
        ? {
            type,
            target_id: body.target_id,
            posting_time: body.posting_time,
            active: body.active ?? true,
          }
        : {
            channel: type === 'video' ? 'video' : 'blog',
            target_id: String(body.target_id || ''),
            schedule_time: body.posting_time ? `${body.posting_time}:00` : null,
            timezone: body.timezone || 'UTC',
            is_enabled: body.active ?? true,
            metadata: body.metadata || {},
          };

      const { data, error } = await supabase.from("schedules").insert(payload).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(normalizeSchedule(data, legacy));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.patch("/api/schedules/:id", async (req, res) => {
    try {
      const supabase = getSupabase();
      const legacy = await isLegacyScheduleSchema(supabase);
      const body = req.body || {};

      const payload = legacy
        ? {
            posting_time: body.posting_time,
            target_id: body.target_id,
            active: body.active,
            type: body.type,
          }
        : {
            schedule_time: body.posting_time ? `${body.posting_time}:00` : undefined,
            target_id: body.target_id ? String(body.target_id) : undefined,
            is_enabled: body.active,
            channel: body.type ? (body.type === 'video' ? 'video' : 'blog') : undefined,
          };
      Object.keys(payload).forEach((k) => (payload as any)[k] === undefined && delete (payload as any)[k]);

      const { data, error } = await supabase.from("schedules").update(payload).eq("id", req.params.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(normalizeSchedule(data, legacy));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/schedules/:id", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from("schedules").delete().eq("id", req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      res.sendStatus(204);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Automation Trigger (Manual or Cron)
  app.post("/api/automation/run/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const supabase = getSupabase();
      const { data: schedule } = await supabase.from("schedules").select("*").eq("id", id).single();
      
      if (!schedule) return res.status(404).json({ error: "Schedule not found" });

      if (scheduleTypeOf(schedule) === "blog") {
        runBlogAutomation(id).catch(console.error);
      } else {
        runVideoAutomation(id).catch(console.error);
      }

      res.json({ message: "Automation triggered" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard Stats
  app.get("/api/stats", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { count: totalPosts } = await supabase.from("posts").select("*", { count: "exact", head: true });
      const today = new Date().toISOString().split("T")[0];
      const { count: publishedToday } = await supabase.from("posts").select("*", { count: "exact", head: true }).gte("published_at", today);
      const legacyScheduleSchema = await isLegacyScheduleSchema(supabase);
      const activeSchedulesQuery = legacyScheduleSchema
        ? supabase.from("schedules").select("*", { count: "exact", head: true }).eq("active", true)
        : supabase.from("schedules").select("*", { count: "exact", head: true }).eq("is_enabled", true);
      const { count: activeSchedules } = await activeSchedulesQuery;

      res.json({
        totalPosts: totalPosts || 0,
        publishedToday: publishedToday || 0,
        activeSchedules: activeSchedules || 0
      });
    } catch (err: any) {
      res.json({ totalPosts: 0, publishedToday: 0, activeSchedules: 0 });
    }
  });

  app.get("/api/recent-posts", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("posts").select("*").order("published_at", { ascending: false }).limit(8);
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.json([]);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    console.log("Initializing Vite dev server...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite middleware attached.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Cron Job (runs every minute to check schedules)
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      
      const supabase = getSupabase();
      const legacy = await isLegacyScheduleSchema(supabase);
      const schedulesQuery = legacy
        ? supabase.from("schedules").select("*").eq("active", true).eq("posting_time", currentTime)
        : supabase.from("schedules").select("*").eq("is_enabled", true).eq("schedule_time", `${currentTime}:00`);
      const { data: schedules } = await schedulesQuery;

      if (schedules) {
        for (const schedule of schedules) {
          console.log(`Triggering schedule ${schedule.id} at ${currentTime}`);
          if (scheduleTypeOf(schedule) === "blog") {
            runBlogAutomation(schedule.id).catch(console.error);
          } else {
            runVideoAutomation(schedule.id).catch(console.error);
          }
        }
      }
    } catch (err) {
      console.error("Cron job failed:", err);
    }
  });

  console.log(`Attempting to listen on port ${PORT}...`);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'Defined' : 'Missing'}`);
  });
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
