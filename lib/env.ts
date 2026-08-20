/**
 * Tiny env helpers. Copied verbatim from `leads AI/lib/env.ts` so the two
 * projects read config the same way.
 *
 * Note: in Outreach AI most configuration lives in the `settings` table, not in
 * the environment — see lib/config.ts, which layers env on top of the database.
 */

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}
