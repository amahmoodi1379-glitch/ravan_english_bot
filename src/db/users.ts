import { Env } from "../types";
import { queryOne, execute } from "./client";

export interface DbUser {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  xp_total: number;
  is_approved: number;
  last_seen_at: string | null;
  is_banned: number;
  banned_until: string | null;
  banned_by_admin_id: number | null;
  ban_reason: string | null;
}

export interface TelegramUserLike {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Update an existing user's Telegram profile info and last-seen timestamp if stale.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The existing database user record to update
 * @param tg - The Telegram user data from the incoming message
 * @returns void
 */
export async function touchExistingUser(env: Env, user: DbUser, tg: TelegramUserLike): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();

  const infoChanged =
    (user.username || "") !== (tg.username || "") ||
    (user.first_name || "") !== (tg.first_name || "") ||
    (user.last_name || "") !== (tg.last_name || "");

  let timeToUpdate = true;
  if (user.last_seen_at) {
    const diffHours = (now.getTime() - new Date(user.last_seen_at).getTime()) / (1000 * 60 * 60);
    if (diffHours < 1) timeToUpdate = false;
  }

  if (!infoChanged && !timeToUpdate) return;

  const displayName =
    user.display_name ||
    [tg.first_name, tg.last_name].filter(Boolean).join(" ") ||
    tg.username ||
    null;

  await execute(
    env,
    `
      UPDATE users
      SET username = ?, first_name = ?, last_name = ?, display_name = COALESCE(display_name, ?), last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `,
    [tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, displayName, nowIso, nowIso, user.id]
  );

  user.username = tg.username ?? null;
  user.first_name = tg.first_name ?? null;
  user.last_name = tg.last_name ?? null;
  if (!user.display_name) user.display_name = displayName;
  user.last_seen_at = nowIso;
}

/**
 * Retrieve an existing user by Telegram ID or create a new one if not found.
 * @param env - The worker environment containing the D1 database binding
 * @param tg - The Telegram user data from the incoming message
 * @returns The existing or newly created DbUser record
 */
export async function getOrCreateUser(env: Env, tg: TelegramUserLike): Promise<DbUser> {
  const existing = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);
  if (existing) {
    await touchExistingUser(env, existing, tg);
    return existing;
  }

  const nowIso = new Date().toISOString();
  const displayName =
    [tg.first_name, tg.last_name].filter(Boolean).join(" ") ||
    tg.username ||
    `user_${tg.id}`;

  try {
    await execute(
      env,
      `
        INSERT INTO users (telegram_id, username, first_name, last_name, display_name, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [tg.id, tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, displayName, nowIso]
    );
  } catch (e) {
    console.warn("Duplicate user creation avoided:", tg.id);
  }

  const newUser = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);
  if (!newUser) {
    throw new Error("Failed to create user.");
  }
  return newUser;
}

/**
 * Look up a user by their Telegram ID.
 * @param env - The worker environment containing the D1 database binding
 * @param telegramId - The Telegram user ID to search for
 * @returns The matching DbUser record, or null if not found
 */
export async function getUserByTelegramId(env: Env, telegramId: number): Promise<DbUser | null> {
  return await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [telegramId]);
}
