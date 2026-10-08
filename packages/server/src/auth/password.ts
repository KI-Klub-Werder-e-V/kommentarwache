/**
 * Password hashing with Node's built-in scrypt: no native dependency to build on an old
 * server. Parameters follow OWASP's scrypt guidance (N=2^17, r=8, p=1).
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  if (Number(n) !== N || Number(r) !== R || Number(p) !== P) return false;
  const key = await derive(password, Buffer.from(salt, 'base64url'));
  const expected = Buffer.from(hash, 'base64url');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
