import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import cron from "node-cron";
import { getSupabase, updateSupabaseConfig, getPublicConfig } from "./supabase-backend";
import { runBlogAutomation, runVideoAutomation } from "./automation";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log("Starting server initialization...");
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  console.log("Express middleware configured.");

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/config", (req, res) => {
    res.json(getPublicConfig());
  });

  // Settings Management
  // Settings
  app.get("/api/settings", async (req, res) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("settings").select("*").single();
      if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
      
      // Ensure arrays exist for multi-key settings
      const settings = data || {};
      if (!settings.cloudflare_configs) settings.cloudflare_configs = [];
      if (!settings.elevenlabs_keys) settings.elevenlabs_keys = [];
      if (!settings.lightning_keys) settings.lightning_keys = [];
      
      res.json(settings);
    } catch (err: any) {
      // If not configured, return empty settings so user can configure
      res.json({
        cloudflare_configs: [],
        elevenlabs_keys: [],
        lightning_keys: [],
        supabase_url: process.env.SUPABASE_URL || "",
        supabase_service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        supabase_access_token: process.env.VITE_SUPABASE_ANON_KEY || ""
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
      const { data, error } = await supabase.from("settings").upsert({ id: 1, ...req.body }).select().single();
      
      if (error) {
        console.error("Supabase settings upsert error:", error);
        return res.status(500).json({ error: error.message });
      }
      res.json(data);
    } catch (err: any) {
      console.error("Settings save error:", err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/settings/verify-supabase", async (req, res) => {
    const { url, service_role_key } = req.body;
    try {
      const tempClient = createClient(url, service_role_key);
      const { error } = await tempClient.from("settings").select("id").limit(1);
      if (error) throw error;
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
