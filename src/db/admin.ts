import { Env } from "../types";
import { queryOne, queryAll, execute } from "./client";

export interface DbAdmin {
  id: number;
  telegram_id: number;
  username?: string;
  first_name?: string;
  is_super_admin: number;
  created_at: string;
  created_by_admin_id?: number;
}

export async function isAdmin(env: Env, telegramId: number): Promise<boolean> {
  const admin = await queryOne<{ id: number }>(
    env,
    "SELECT id FROM admins WHERE telegram_id = ?",
    [telegramId]
  );
  return !!admin;
}

export async function getAdminByTelegramId(env: Env, telegramId: number): Promise<DbAdmin | null> {
  return await queryOne<DbAdmin>(
    env,
    "SELECT * FROM admins WHERE telegram_id = ?",
    [telegramId]
  );
}

export async function addAdmin(env: Env, telegramId: number, createdByAdminId: number, username?: string, firstName?: string): Promise<boolean> {
  try {
    await execute(
      env,
      // D1's bind() rejects `undefined`, so coalesce optional fields to null.
      "INSERT INTO admins (telegram_id, username, first_name, is_super_admin, created_by_admin_id) VALUES (?, ?, ?, 0, ?)",
      [telegramId, username ?? null, firstName ?? null, createdByAdminId]
    );
    return true;
  } catch (error) {
    return false;
  }
}

export async function removeAdmin(env: Env, telegramId: number): Promise<boolean> {
  const result = await execute(
    env,
    "DELETE FROM admins WHERE telegram_id = ? AND is_super_admin = 0",
    [telegramId]
  );
  return result.meta.changes > 0;
}

export async function getAllAdmins(env: Env): Promise<DbAdmin[]> {
  return await queryAll<DbAdmin>(
    env,
    "SELECT * FROM admins ORDER BY created_at DESC"
  );
}

export async function insertLicense(env: Env, code: string, expirationDays: number, createdByAdminId: number): Promise<boolean> {
  try {
    await execute(
      env,
      "INSERT INTO access_codes (code, expiration_days, created_by_admin_id, created_at) VALUES (?, ?, ?, datetime('now'))",
      [code, expirationDays, createdByAdminId]
    );
    return true;
  } catch (error) {
    return false;
  }
}

/** Row shape returned by findUserWithLicense — user columns joined with license info. */
export interface UserWithLicenseRow {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  xp_total: number;
  is_approved: number;
  is_banned: number;
  banned_until: string | null;
  banned_by_admin_id: number | null;
  ban_reason: string | null;
  created_at: string;
  code: string | null;
  expiration_days: number | null;
  used_at: string | null;
  license_created_at: string | null;
}

export async function findUserWithLicense(env: Env, identifier: string): Promise<UserWithLicenseRow | null> {
  let user = await queryOne<UserWithLicenseRow>(
    env,
    `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
     FROM users u 
     JOIN access_codes ac ON u.id = ac.used_by_user_id 
     WHERE ac.code = ?`,
    [identifier]
  );

  if (user) return user;

  if (/^\d+$/.test(identifier)) {
    user = await queryOne<UserWithLicenseRow>(
      env,
      `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
       FROM users u 
       LEFT JOIN access_codes ac ON u.id = ac.used_by_user_id 
       WHERE u.telegram_id = ?`,
      [parseInt(identifier)]
    );
    if (user) return user;
  }

  const username = identifier.startsWith('@') ? identifier.substring(1) : identifier;
  user = await queryOne<UserWithLicenseRow>(
    env,
    `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
     FROM users u 
     LEFT JOIN access_codes ac ON u.id = ac.used_by_user_id 
     WHERE u.username = ?`,
    [username]
  );

  return user;
}

export async function banUser(env: Env, userId: number, banReason?: string, bannedByAdminId?: number, banDays?: number): Promise<boolean> {
  const bannedUntil = banDays ? new Date(Date.now() + banDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const result = await execute(
    env,
    "UPDATE users SET is_banned = 1, banned_until = ?, banned_by_admin_id = ?, ban_reason = ?, updated_at = datetime('now') WHERE id = ?",
    [bannedUntil, bannedByAdminId ?? null, banReason ?? null, userId]
  );

  return result.meta.changes > 0;
}

export async function unbanUser(env: Env, userId: number): Promise<boolean> {
  const result = await execute(
    env,
    "UPDATE users SET is_banned = 0, banned_until = NULL, banned_by_admin_id = NULL, ban_reason = NULL, updated_at = datetime('now') WHERE id = ?",
    [userId]
  );

  return result.meta.changes > 0;
}

export interface ApprovedUserRow {
  id: number;
  telegram_id: number;
  first_name: string | null;
  username: string | null;
}

export async function getApprovedUsers(env: Env): Promise<ApprovedUserRow[]> {
  return await queryAll<ApprovedUserRow>(
    env,
    "SELECT id, telegram_id, first_name, username FROM users WHERE is_approved = 1 AND is_banned = 0 ORDER BY id"
  );
}
