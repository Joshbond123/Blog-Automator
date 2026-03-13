import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";
import { getSupabase, updateSupabaseConfig, getPublicConfig, getCurrentSupabaseConfig, verifyCurrentSupabaseConnection } from "./supabase-backend";
import { runBlogAutomation, runVideoAutomation } from "./automation";
import { decryptSecret, encryptSecret } from "./secrets";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log("Starting server initialization...");
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  const SECRET_SETTING_FIELDS = ["blogger_client_id", "blogger_client_secret", "blogger_refresh_token"] as const;

  const normalizeSettings = (settings: any = {}) => {
    const normalized = { ...settings };
    if (!normalized.cloudflare_configs) normalized.cloudflare_configs = [];
    if (!normalized.elevenlabs_keys) normalized.elevenlabs_keys = [];
    if (!normalized.lightning_keys) normalized.lightning_keys = [];
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

  const upsertSettingsWithFallback = async (supabase: any, payload: any) => {
    const currentPayload = { ...payload };

    while (true) {
      const { data, error } = await supabase.from("settings").upsert({ id: 1, ...currentPayload }).select().single();
      if (!error) return { data, skippedFields: [] as string[] };

      const missingColumn = error.message?.match(/Could not find the '([^']+)' column/)?.[1];
      if (!missingColumn || !(missingColumn in currentPayload)) {
        return { data: null, error, skippedFields: [] as string[] } as any;
      }

      delete currentPayload[missingColumn];
    }
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
      const { data, error } = await supabase.from("settings").select("*").single();
      if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
      
      const normalized = normalizeSettings(data || {});
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
      // If updating Supabase config, update the local instance first
      // This ensures that the upsert below uses the NEW credentials to save to the NEW database
      if (req.body.supabase_url && req.body.supabase_service_role_key) {
        updateSupabaseConfig({
          url: req.body.supabase_url,
          serviceRoleKey: req.body.supabase_service_role_key,
          anonKey: req.body.supabase_access_token
        });
      }

      const supabase = getSupabase();
      
      // Filter out fields that might cause issues if the user hasn't updated their schema yet
      // but we want to allow them to save what they can.
      // However, upserting with missing columns is what causes the user's error.
      const protectedBody = protectSettings(req.body);
      const { data, error } = await upsertSettingsWithFallback(supabase, protectedBody);
      
      if (error) {
        console.error("Supabase settings upsert error:", error);
        return res.status(500).json({ error: error.message });
      }
      res.json(normalizeSettings(data));
    } catch (err: any) {
      console.error("Settings save error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/settings/verify-supabase", async (req, res) => {
    const { url, service_role_key } = req.body || {};
    try {
      if (url && service_role_key) {
        const tempClient = createClient(url, service_role_key);
        const { error } = await tempClient.from("settings").select("id").limit(1);
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

      if (!response.ok || data.error) {
        return res.status(400).json({ error: data.error?.message || "Failed to fetch Facebook pages" });
      }

      const pages = (data.data || []).map((page: any) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        access_token: page.access_token,
      }));

      res.json({ pages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
