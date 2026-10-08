import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load .env from the working directory if present; real environment variables win. */
export function loadDotenv(cwd = process.cwd()): void {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}
