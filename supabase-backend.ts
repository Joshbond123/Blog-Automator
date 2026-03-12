import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const CONFIG_PATH = path.join(process.cwd(), "supabase-config.json");

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  anonKey?: string;
}

let currentConfig: SupabaseConfig = {
  url: process.env.SUPABASE_URL || "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || "",
};

// Try to load from local config if environment is missing
if (!currentConfig.url && fs.existsSync(CONFIG_PATH)) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    currentConfig = { ...currentConfig, ...savedConfig };
  } catch (err) {
    console.error("Failed to load local supabase config:", err);
  }
}

let supabaseInstance: any = null;

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance;

  if (currentConfig.url && currentConfig.serviceRoleKey) {
    try {
      supabaseInstance = createClient(currentConfig.url, currentConfig.serviceRoleKey);
      return supabaseInstance;
    } catch (err) {
      console.error("Failed to initialize Supabase client:", err);
      throw new Error("Supabase initialization failed. Please check your credentials.");
    }
  }

  throw new Error("Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

export function updateSupabaseConfig(config: Partial<SupabaseConfig>) {
  currentConfig = { ...currentConfig, ...config };
  
  // Persist to local file for survival across restarts if not in env
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2));
  } catch (err) {
    console.error("Failed to save supabase config to file:", err);
  }

  // Reset instance so it's re-created on next get
  supabaseInstance = null;
  return getSupabase();
}

export function getPublicConfig() {
  return {
    url: currentConfig.url,
    anonKey: currentConfig.anonKey
  };
}
