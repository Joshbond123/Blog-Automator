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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log("Starting server initialization...");
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  const SECRET_SETTING_FIELDS = ["blogger_client_id", "blogger_client_secret", "blogger_refresh_token"] as const;
  const ARRAY_SETTING_FIELDS = new Set(["cloudflare_configs", "elevenlabs_keys", "lightning_keys"]);
  const SETTINGS_FIELDS = new Set([
    "supabase_url", "supabase_service_role_key", "supabase_access_token", "github_pat",
    "cloudflare_configs", "blogger_client_id", "blogger_client_secret", "blogger_refresh_token",
    "elevenlabs_keys", "lightning_keys", "catbox_hash", "ads_html", "ads_scripts", "ads_placement"
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

  const normalizeSettings = (settings: any = {}) => {
    const normalized = { ...settings };
    normalized.cloudflare_configs = ensureArray(normalized.cloudflare_configs);
    normalized.elevenlabs_keys = ensureArray(normalized.elevenlabs_keys);
    normalized.lightning_keys = ensureArray(normalized.lightning_keys);
    normalized.ads_placement = normalized.ads_placement || 'after';

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
    const { token } = req.body;
    try {
      // In a real app, call FB Graph API
      // For demo, we'll just return success if token is not empty
      if (!token) throw new Error("Token is required");
      res.json({ status: "valid" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/facebook/pages-from-token", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    try {
      const response = await fetch(`https://graph.facebook.com/v20.0/me/accounts?access_token=${encodeURIComponent(token)}`);
      const data = await response.json();

      if (response.ok && !data.error) {
        const pages = (data.data || []).map((page: any) => ({
          id: page.id,
          name: page.name,
          category: page.category,
          access_token: page.access_token,
        }));

        return res.json({ pages });
      }

      // Fallback for page tokens / tokens that don't expose /me/accounts
      const nonExistingAccountsField = data?.error?.code === 100 && /accounts/i.test(String(data?.error?.message || ""));
      if (nonExistingAccountsField) {
        const meResponse = await fetch(`https://graph.facebook.com/v20.0/me?fields=id,name,category&access_token=${encodeURIComponent(token)}`);
        const meData = await meResponse.json();
        if (!meResponse.ok || meData.error) {
          return res.status(400).json({ error: meData.error?.message || data.error?.message || "Failed to fetch Facebook pages" });
        }

        const pageLike = [{
          id: meData.id,
          name: meData.name || "Facebook Page",
          category: meData.category,
          access_token: token,
        }];

        return res.json({ pages: pageLike });
      }

      return res.status(400).json({ error: data.error?.message || "Failed to fetch Facebook pages" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/blogger/available-accounts", async (req, res) => {
    try {
      const supabase = getSupabase();

      const settings = await readSettings(supabase);


      if (!settings.blogger_client_id || !settings.blogger_client_secret || !settings.blogger_refresh_token) {
        return res.status(400).json({ error: "Blogger OAuth credentials are not configured" });
      }

      const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
        client_id: settings.blogger_client_id,
        client_secret: settings.blogger_client_secret,
        refresh_token: settings.blogger_refresh_token,
        grant_type: "refresh_token",
      });

      const accessToken = tokenRes.data.access_token;
      const blogsRes = await axios.get("https://www.googleapis.com/blogger/v3/users/self/blogs", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const blogs = (blogsRes.data.items || []).map((item: any) => ({
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
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/facebook-pages", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("facebook_pages").insert(req.body).select().single();
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
      const { data, error } = await supabase.from("schedules").select("*");
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/schedules", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("schedules").insert(req.body).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json(data);
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

      if (schedule.type === "blog") {
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
      const { count: activeSchedules } = await supabase.from("schedules").select("*", { count: "exact", head: true }).eq("active", true);

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
      const { data: schedules } = await supabase
        .from("schedules")
        .select("*")
        .eq("active", true)
        .eq("posting_time", currentTime);

      if (schedules) {
        for (const schedule of schedules) {
          console.log(`Triggering schedule ${schedule.id} at ${currentTime}`);
          if (schedule.type === "blog") {
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
