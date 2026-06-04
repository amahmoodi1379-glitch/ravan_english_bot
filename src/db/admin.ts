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

export interface DbAnnouncement {
  id: number;
  title?: string;
  message: string;
  status: 'draft' | 'confirmed' | 'sending' | 'completed' | 'failed';
  total_users: number;
  sent_count: number;
  failed_count: number;
  created_by_admin_id: number;
  created_at: string;
  confirmed_at?: string;
  started_sending_at?: string;
  completed_at?: string;
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
export async function addAdmin(env: Env, telegramId: number, username?: string, firstName?: string, createdByAdminId: number): Promise<boolean> {
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

// Create license with expiration days
export async function createLicense(env: Env, expirationDays: number, createdByAdminId: number): Promise<string | null> {
  const code = crypto.randomUUID().replace(/-/g, '').substring(0, 12).toUpperCase();
  
  try {
    await execute(
      env,
      "INSERT INTO access_codes (code, expiration_days, created_by_admin_id, created_at) VALUES (?, ?, ?, datetime('now'))",
      [code, expirationDays, createdByAdminId]
    );
    return code;
  } catch (error) {
    // Likely duplicate code (very unlikely with UUID)
    return null;
  }
}

// Check if license code exists
export async function licenseExists(env: Env, code: string): Promise<boolean> {
  const existing = await queryOne<{ id: number }>(
    env,
    "SELECT id FROM access_codes WHERE code = ?",
    [code]
  );
  return !!existing;
}

// Get license details
export async function getLicenseByCode(env: Env, code: string): Promise<any> {
  return await queryOne(
    env,
    `SELECT ac.*, u.telegram_id as used_by_telegram_id, u.first_name as used_by_name 
     FROM access_codes ac 
     LEFT JOIN users u ON ac.used_by_user_id = u.id 
     WHERE ac.code = ?`,
    [code]
  );
}

// Update license expiration
export async function updateLicenseExpiration(env: Env, code: string, expirationDays: number): Promise<boolean> {
  const result = await execute(
    env,
    "UPDATE access_codes SET expiration_days = ? WHERE code = ? AND used_by_user_id IS NULL",
    [expirationDays, code]
  );
  return result.meta.changes > 0;
}

// Find user by license, ID, or username
export async function findUser(env: Env, identifier: string): Promise<any> {
  // Try as license code first
  let user = await queryOne(
    env,
    `SELECT u.* FROM users u 
     JOIN access_codes ac ON u.id = ac.used_by_user_id 
     WHERE ac.code = ?`,
    [identifier]
  );
  
  if (user) return user;
  
  // Try as numeric user ID
  if (/^\d+$/.test(identifier)) {
    user = await queryOne(
      env,
      "SELECT * FROM users WHERE telegram_id = ?",
      [parseInt(identifier)]
    );
    if (user) return user;
  }
  
  // Try as username (with or without @)
  const username = identifier.startsWith('@') ? identifier.substring(1) : identifier;
  user = await queryOne(
    env,
    "SELECT * FROM users WHERE username = ?",
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

// Delete user (with all their data)
export async function deleteUser(env: Env, userId: number): Promise<boolean> {
  // This is a destructive operation - make sure to cascade delete all related data
  try {
    await execute(env, "DELETE FROM user_words_sm2 WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM user_word_question_history WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM reading_sessions WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM user_text_question_history WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM reflection_sessions WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM activity_log WHERE user_id = ?", [userId]);
    await execute(env, "DELETE FROM users WHERE id = ?", [userId]);
    return true;
  } catch (error) {
    console.error("Error deleting user:", error);
    return false;
  }
}

// Create announcement
export async function createAnnouncement(env: Env, title: string | null, message: string, createdByAdminId: number): Promise<number> {
  const result = await execute(
    env,
    "INSERT INTO announcements (title, message, status, created_by_admin_id) VALUES (?, ?, 'draft', ?)",
    [title, message, createdByAdminId]
  );
  return result.meta.last_row_id || 0;
}

// Get announcement by ID
export async function getAnnouncement(env: Env, announcementId: number): Promise<DbAnnouncement | null> {
  return await queryOne<DbAnnouncement>(
    env,
    "SELECT * FROM announcements WHERE id = ?",
    [announcementId]
  );
}

// Get all announcements
export async function getAllAnnouncements(env: Env): Promise<DbAnnouncement[]> {
  return await queryAll<DbAnnouncement>(
    env,
    "SELECT * FROM announcements ORDER BY created_at DESC"
  );
}

// Update announcement status
export async function updateAnnouncementStatus(env: Env, announcementId: number, status: string): Promise<boolean> {
  const updateFields: string[] = ["status = ?"];
  const params: any[] = [status];
  
  if (status === 'confirmed') {
    updateFields.push("confirmed_at = datetime('now')");
  } else if (status === 'sending') {
    updateFields.push("started_sending_at = datetime('now')");
  } else if (status === 'completed' || status === 'failed') {
    updateFields.push("completed_at = datetime('now')");
  }
  
  const result = await execute(
    env,
    `UPDATE announcements SET ${updateFields.join(', ')} WHERE id = ?`,
    [...params, announcementId]
  );
  
  return result.meta.changes > 0;
}

// Update announcement counts
export async function updateAnnouncementCounts(env: Env, announcementId: number, sentCount: number, failedCount: number): Promise<boolean> {
  const result = await execute(
    env,
    "UPDATE announcements SET sent_count = ?, failed_count = ? WHERE id = ?",
    [sentCount, failedCount, announcementId]
  );
  return result.meta.changes > 0;
}

// Log announcement delivery
export async function logAnnouncementDelivery(env: Env, announcementId: number, userId: number, status: string, errorMessage?: string): Promise<void> {
  await execute(
    env,
    "INSERT INTO announcement_logs (announcement_id, user_id, status, error_message, sent_at) VALUES (?, ?, ?, ?, datetime('now'))",
    [announcementId, userId, status, errorMessage]
  );
}

// Get announcement delivery report
export async function getAnnouncementReport(env: Env, announcementId: number): Promise<any> {
  const summary = await queryOne(
    env,
    `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
     FROM announcement_logs WHERE announcement_id = ?`,
    [announcementId]
  );
  
  const failedLogs = await queryAll(
    env,
    `SELECT al.*, u.telegram_id, u.first_name, u.username 
     FROM announcement_logs al 
     JOIN users u ON al.user_id = u.id 
     WHERE al.announcement_id = ? AND al.status = 'failed' 
     ORDER BY al.created_at DESC LIMIT 10`,
    [announcementId]
  );
  
  return { summary, failedLogs };
}

// Get all approved users for announcement
export async function getApprovedUsers(env: Env): Promise<any[]> {
  return await queryAll(
    env,
    "SELECT id, telegram_id, first_name, username FROM users WHERE is_approved = 1 AND is_banned = 0 ORDER BY id"
  );
}
