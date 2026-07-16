import { Env } from "../types";
import { queryOne, execute } from "./client";

/** Default license validity (in days) used when the "ask" prompt is disabled. */
export const DEFAULT_LICENSE_DAYS = 700;

const LICENSE_DEFAULT_MODE_KEY = "license_default_days_mode";

/**
 * Read a single system setting value.
 * @param env - The worker environment containing the D1 database binding
 * @param key - The setting key to read
 * @returns The stored string value, or null if the key (or the table) is absent
 */
export async function getSetting(env: Env, key: string): Promise<string | null> {
  try {
    const row = await queryOne<{ value: string }>(
      env,
      "SELECT value FROM system_settings WHERE key = ?",
      [key]
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a single system setting value. The `system_settings` table is
 * provided by the schema migrations, so no DDL is issued here.
 * @param env - The worker environment containing the D1 database binding
 * @param key - The setting key to write
 * @param value - The string value to store
 */
export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await execute(
    env,
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

/**
 * Whether license creation should skip the day-count prompt and use the default
 * ({@link DEFAULT_LICENSE_DAYS}). Enabled by default when no setting is stored.
 * @param env - The worker environment containing the D1 database binding
 * @returns True if the default day count should be applied without asking
 */
export async function isLicenseDefaultDaysEnabled(env: Env): Promise<boolean> {
  const value = await getSetting(env, LICENSE_DEFAULT_MODE_KEY);
  if (value === null) return true; // default: use DEFAULT_LICENSE_DAYS without asking
  return value === "on";
}

/**
 * Turn the "use default license days without asking" mode on or off.
 * @param env - The worker environment containing the D1 database binding
 * @param enabled - True to skip the prompt and use the default, false to ask each time
 */
export async function setLicenseDefaultDaysEnabled(env: Env, enabled: boolean): Promise<void> {
  await setSetting(env, LICENSE_DEFAULT_MODE_KEY, enabled ? "on" : "off");
}
