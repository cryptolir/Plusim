/**
 * AES-256-GCM encryption for the Google Drive refresh token at rest.
 *
 * The owner refresh token grants broad Drive access, so it is never stored as
 * plaintext in Postgres. Encrypted with a dedicated DRIVE_TOKEN_ENCRYPTION_KEY
 * (32-byte base64), separate from CLERK_SECRET_KEY. Ciphertext format:
 *   v1.<ivB64>.<authTagB64>.<cipherTextB64>
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("DRIVE_TOKEN_ENCRYPTION_KEY not configured");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error("DRIVE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (use: openssl rand -base64 32)");
  }
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptJson<T>(blob: string): T {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("bad ciphertext format");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
