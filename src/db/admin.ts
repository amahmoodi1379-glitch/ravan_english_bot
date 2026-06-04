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

// Check if user is admin
export async function isAdmin(env: Env, telegramId: number): Promise<boolean> {
  const admin = await queryOne<{ id: number }>(
    env,
    "SELECT id FROM admins WHERE telegram_id = ?",
    [telegramId]
  );
  return !!admin;
}

// Get admin by Telegram ID
export async function getAdminByTelegramId(env: Env, telegramId: number): Promise<DbAdmin | null> {
  return await queryOne<DbAdmin>(
    env,
    "SELECT * FROM admins WHERE telegram_id = ?",
    [telegramId]
  );
}

// Add new admin (only super admin can do this)
export async function addAdmin(env: Env, telegramId: number, createdByAdminId: number, username?: string, firstName?: string): Promise<boolean> {
  try {
    await execute(
      env,
      "INSERT INTO admins (telegram_id, username, first_name, is_super_admin, created_by_admin_id) VALUES (?, ?, ?, 0, ?)",
      [telegramId, username, firstName, createdByAdminId]
    );
    return true;
  } catch (error) {
    // Likely duplicate telegram_id
    return false;
  }
}

// Remove admin (only super admin can do this)
export async function removeAdmin(env: Env, telegramId: number): Promise<boolean> {
  const result = await execute(
    env,
    "DELETE FROM admins WHERE telegram_id = ? AND is_super_admin = 0",
    [telegramId]
  );
  return result.meta.changes > 0;
}

// Get all admins
export async function getAllAdmins(env: Env): Promise<DbAdmin[]> {
  return await queryAll<DbAdmin>(
    env,
    "SELECT * FROM admins ORDER BY created_at DESC"
  );
}

// Insert license with custom code (admin provides the code)
export async function insertLicense(env: Env, code: string, expirationDays: number, createdByAdminId: number): Promise<boolean> {
  try {
    await execute(
      env,
      "INSERT INTO access_codes (code, expiration_days, created_by_admin_id, created_at) VALUES (?, ?, ?, datetime('now'))",
      [code, expirationDays, createdByAdminId]
    );
    return true;
  } catch (error) {
    // Likely duplicate code
    return false;
  }
}

// Find user with their active license info and remaining days
export async function findUserWithLicense(env: Env, identifier: string): Promise<any> {
  // Try as license code first (user who used this code)
  let user = await queryOne(
    env,
    `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
     FROM users u 
     JOIN access_codes ac ON u.id = ac.used_by_user_id 
     WHERE ac.code = ?`,
    [identifier]
  );
  
  if (user) return user;
  
  // Try as numeric user ID (telegram_id)
  if (/^\d+$/.test(identifier)) {
    user = await queryOne(
      env,
      `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
       FROM users u 
       LEFT JOIN access_codes ac ON u.id = ac.used_by_user_id 
       WHERE u.telegram_id = ?`,
      [parseInt(identifier)]
    );
    if (user) return user;
  }
  
  // Try as username (with or without @)
  const username = identifier.startsWith('@') ? identifier.substring(1) : identifier;
  user = await queryOne(
    env,
    `SELECT u.*, ac.code, ac.expiration_days, ac.used_at, ac.created_at as license_created_at
     FROM users u 
     LEFT JOIN access_codes ac ON u.id = ac.used_by_user_id 
     WHERE u.username = ?`,
    [username]
  );
  
  return user;
}

// Ban user
export async function banUser(env: Env, userId: number, banReason?: string, bannedByAdminId?: number, banDays?: number): Promise<boolean> {
  const bannedUntil = banDays ? new Date(Date.now() + banDays * 24 * 60 * 60 * 1000).toISOString() : null;
  
  const result = await execute(
    env,
    "UPDATE users SET is_banned = 1, banned_until = ?, banned_by_admin_id = ?, ban_reason = ?, updated_at = datetime('now') WHERE id = ?",
    [bannedUntil, bannedByAdminId, banReason, userId]
  );
  
  return result.meta.changes > 0;
}

// Unban user
export async function unbanUser(env: Env, userId: number): Promise<boolean> {
  const result = await execute(
    env,
    "UPDATE users SET is_banned = 0, banned_until = NULL, banned_by_admin_id = NULL, ban_reason = NULL, updated_at = datetime('now') WHERE id = ?",
    [userId]
  );
  
  return result.meta.changes > 0;
}

// Get all approved users for announcement
export async function getApprovedUsers(env: Env): Promise<any[]> {
  return await queryAll(
    env,
    "SELECT id, telegram_id, first_name, username FROM users WHERE is_approved = 1 AND is_banned = 0 ORDER BY id"
  );
}
