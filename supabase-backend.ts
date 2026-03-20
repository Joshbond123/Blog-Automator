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

function normalizeTextInput(value?: string) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function normalizeCredentialInput(value?: string) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "") // zero-width chars
    .replace(/[\r\n\t ]+/g, "") // accidental whitespace/newlines from copy-paste
    .replace(/[^\x20-\x7E]/g, "") // strip non-ASCII characters introduced by bad encoding
    .trim();
}

function assertByteString(name: string, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 255) {
      throw new Error(`${name} contains unsupported characters. Please paste the original key/url without smart quotes or special symbols.`);
    }
  }
}

function sanitizeSupabaseConfig(config: Partial<SupabaseConfig>) {
  const url = normalizeTextInput(config.url);
  const serviceRoleKey = normalizeCredentialInput(config.serviceRoleKey);
  const anonKey = typeof config.anonKey === "string" ? normalizeCredentialInput(config.anonKey) : config.anonKey;

  if (url) assertByteString("SUPABASE_URL", url);
  if (serviceRoleKey) assertByteString("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
  if (anonKey) assertByteString("SUPABASE_ACCESS_TOKEN", anonKey);

  return { url, serviceRoleKey, anonKey };
}

const envConfig: SupabaseConfig = sanitizeSupabaseConfig({
  url: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  anonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ACCESS_TOKEN,
}) as SupabaseConfig;

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
  const sanitized = sanitizeSupabaseConfig(config);
  const next = { ...currentConfig };
  if (sanitized.url) next.url = sanitized.url;
  if (sanitized.serviceRoleKey) next.serviceRoleKey = sanitized.serviceRoleKey;
  if (typeof sanitized.anonKey === "string") next.anonKey = sanitized.anonKey;
  currentConfig = next;
  configSource = "manual";
  supabaseInstance = null;
  return getSupabase();
}

export function createVerifiedSupabaseClient(url: string, serviceRoleKey: string) {
  const sanitized = sanitizeSupabaseConfig({ url, serviceRoleKey });
  return createClient(sanitized.url, sanitized.serviceRoleKey, {
    global: {
      fetch: stableFetch as any,
    },
  });
}

export async function verifyCurrentSupabaseConnection() {
  if (!isSupabaseConfigured()) {
    return { configured: false, connected: false, source: configSource };
  }

  try {
    const client = getSupabase();
    const { error } = await client.from("settings").select("*").limit(1);
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
