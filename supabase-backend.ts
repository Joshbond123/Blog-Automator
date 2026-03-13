import { createClient } from "@supabase/supabase-js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import dns from "node:dns";
import dotenv from "dotenv";

dotenv.config();
dns.setDefaultResultOrder("ipv4first");

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
  anonKey?: string;
}

const envConfig: SupabaseConfig = {
  url: process.env.SUPABASE_URL || "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ACCESS_TOKEN || "",
};

let currentConfig: SupabaseConfig = { ...envConfig };
let configSource: "environment" | "manual" = "environment";
let supabaseInstance: any = null;

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;

async function stableFetch(input: any, init?: RequestInit): Promise<any> {
  return proxyAgent
    ? undiciFetch(input, { ...(init || {}), dispatcher: proxyAgent } as any)
    : fetch(input, init);
}

export function getCurrentSupabaseConfig() {
  return { ...currentConfig, source: configSource };
}

export function isSupabaseConfigured() {
  return Boolean(currentConfig.url && currentConfig.serviceRoleKey);
}

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance;
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  supabaseInstance = createClient(currentConfig.url, currentConfig.serviceRoleKey, {
    global: {
      fetch: stableFetch as any,
    },
  });
  return supabaseInstance;
}

export function updateSupabaseConfig(config: Partial<SupabaseConfig>) {
  const next = { ...currentConfig };
  if (config.url) next.url = config.url;
  if (config.serviceRoleKey) next.serviceRoleKey = config.serviceRoleKey;
  if (typeof config.anonKey === "string") next.anonKey = config.anonKey;
  currentConfig = next;
  configSource = "manual";
  supabaseInstance = null;
  return getSupabase();
}

export async function verifyCurrentSupabaseConnection() {
  if (!isSupabaseConfigured()) {
    return { configured: false, connected: false, source: configSource };
  }

  try {
    const client = getSupabase();
    const { error } = await client.from("settings").select("id").limit(1);
    if (error) throw error;
    return { configured: true, connected: true, source: configSource };
  } catch {
    return { configured: true, connected: false, source: configSource };
  }
}

export function getPublicConfig() {
  return {
    url: currentConfig.url,
    anonKey: currentConfig.anonKey,
    source: configSource,
    configured: isSupabaseConfigured(),
  };
}
