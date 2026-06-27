import { Env } from "../types";
import { queryOne, execute } from "./client";

const STATE_TTL_HOURS = 6;

export type AdminStateScope = "admin" | "quiz" | "letters";

export async function getAdminState<T>(
  env: Env,
  telegramId: number,
  scope: AdminStateScope
): Promise<T | null> {
  const row = await queryOne<{ state_json: string }>(
    env,
    `SELECT state_json FROM admin_bot_state
     WHERE telegram_id = ? AND scope = ?
       AND updated_at > datetime('now', '-${STATE_TTL_HOURS} hours')`,
    [telegramId, scope]
  );
  if (!row) return null;
  try {
    return JSON.parse(row.state_json) as T;
  } catch {
    return null;
  }
}

export async function setAdminState<T>(
  env: Env,
  telegramId: number,
  scope: AdminStateScope,
  state: T
): Promise<void> {
  await execute(
    env,
    `INSERT INTO admin_bot_state (telegram_id, scope, state_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id, scope)
     DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')`,
    [telegramId, scope, JSON.stringify(state)]
  );
}

export async function deleteAdminState(
  env: Env,
  telegramId: number,
  scope: AdminStateScope
): Promise<void> {
  await execute(
    env,
    `DELETE FROM admin_bot_state WHERE telegram_id = ? AND scope = ?`,
    [telegramId, scope]
  );
}

export async function clearAllAdminState(env: Env, telegramId: number): Promise<void> {
  await execute(
    env,
    `DELETE FROM admin_bot_state WHERE telegram_id = ?`,
    [telegramId]
  );
}
