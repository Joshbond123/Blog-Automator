import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  anonKey?: string;
}

let currentConfig: SupabaseConfig = {
  url: process.env.SUPABASE_URL || "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ACCESS_TOKEN || "",
};

let supabaseInstance: any = null;

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance;
  if (!currentConfig.url || !currentConfig.serviceRoleKey) {
    throw new Error("Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  supabaseInstance = createClient(currentConfig.url, currentConfig.serviceRoleKey);
  return supabaseInstance;
}

export function updateSupabaseConfig(config: Partial<SupabaseConfig>) {
  currentConfig = { ...currentConfig, ...config };
  supabaseInstance = null;
  return getSupabase();
}

export function getPublicConfig() {
  return {
    url: currentConfig.url,
    anonKey: currentConfig.anonKey,
  };
}
