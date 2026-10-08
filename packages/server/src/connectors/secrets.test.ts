import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecrets, encryptSecrets, secretKeyFromEnv } from './secrets.js';

describe('secrets', () => {
  const key = randomBytes(32);

  it('round-trips and never repeats a ciphertext', () => {
    const a = encryptSecrets({ token: 'abc', n: 1 }, key);
    const b = encryptSecrets({ token: 'abc', n: 1 }, key);
    expect(decryptSecrets(a, key)).toEqual({ token: 'abc', n: 1 });
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a wrong key or a tampered blob', () => {
    const blob = encryptSecrets({ token: 'abc' }, key);
    expect(() => decryptSecrets(blob, randomBytes(32))).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptSecrets(tampered, key)).toThrow();
  });

  it('treats an empty blob as no secrets', () => {
    expect(decryptSecrets(null, key)).toEqual({});
  });

  it('reads a base64 key from the environment and checks its length', () => {
    expect(secretKeyFromEnv({ KW_SECRET_KEY: key.toString('base64') }).equals(key)).toBe(true);
    expect(() => secretKeyFromEnv({ KW_SECRET_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => secretKeyFromEnv({})).toThrow(/not set/);
  });
});
