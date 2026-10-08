/**
 * Connector credentials at rest: AES-256-GCM under KW_SECRET_KEY, one random nonce per
 * write. The key never enters the database; losing it means re-entering the tokens.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export function secretKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['KW_SECRET_KEY'];
  if (!raw) throw new Error('KW_SECRET_KEY is not set (see .env.example)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('KW_SECRET_KEY must be 32 bytes, base64-encoded');
  return key;
}

/** nonce (12) | tag (16) | ciphertext */
export function encryptSecrets(secrets: Record<string, unknown>, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

export function decryptSecrets(blob: Buffer | null, key: Buffer): Record<string, unknown> {
  if (!blob || blob.length === 0) return {};
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(text) as Record<string, unknown>;
}
