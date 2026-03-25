import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";

function getEncryptionKey() {
  const source = process.env.APP_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!source) {
    throw new Error("Missing APP_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY for secret encryption.");
  }
  return crypto.createHash("sha256").update(source).digest();
}

function normalizeKeyMaterial(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\r\n\t ]+/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function getEncryptionKeyCandidates() {
  const rawCandidates = [
    process.env.APP_ENCRYPTION_KEY || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  ].filter(Boolean);
  const normalizedCandidates = rawCandidates.map((v) => normalizeKeyMaterial(v)).filter(Boolean);
  const unique = Array.from(new Set([...rawCandidates, ...normalizedCandidates]));
  if (!unique.length) {
    throw new Error("Missing APP_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY for secret encryption.");
  }
  return unique.map((source) => crypto.createHash("sha256").update(source).digest());
}

export function encryptSecret(value?: string | null) {
  if (!value) return value || "";
  if (value.startsWith(PREFIX)) return value;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

export function decryptSecret(value?: string | null) {
  if (!value) return value || "";
  if (!value.startsWith(PREFIX)) return value;

  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const payload = raw.subarray(28);
  const keys = getEncryptionKeyCandidates();
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      // try next key candidate
    }
  }
  throw new Error("Failed to decrypt secret with available key material.");
}
