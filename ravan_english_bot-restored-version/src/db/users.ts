import { Env } from "../types";
import { queryOne, execute } from "./client";

// شکل کاربر در دیتابیس
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
}

// ورودی ساده از تلگرام
export interface TelegramUserLike {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export async function getOrCreateUser(env: Env, tg: TelegramUserLike): Promise<DbUser> {
  // 1) ببینیم قبلاً همچین کاربری داریم یا نه
  let user = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);

  const now = new Date();
  const nowIso = now.toISOString();

  if (user) {
    // === بهینه‌سازی: فقط در صورت تغییر یا گذشت زمان آپدیت کن ===
    
    // آیا اطلاعات پروفایل تغییر کرده؟
    const infoChanged = 
      (user.username || "") !== (tg.username || "") ||
      (user.first_name || "") !== (tg.first_name || "") ||
      (user.last_name || "") !== (tg.last_name || "");

    // آیا از آخرین بازدید بیش از ۱ ساعت گذشته؟
    let timeToUpdate = true;
    if (user.last_seen_at) {
      const lastSeen = new Date(user.last_seen_at);
      const diffMs = now.getTime() - lastSeen.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours < 1) {
        timeToUpdate = false;
      }
    }

    // اگر نه اطلاعات عوض شده و نه زمان زیادی گذشته، بیخیال آپدیت شو (صرفه‌جویی در دیتابیس)
    if (!infoChanged && !timeToUpdate) {
      return user;
    }
    // ==========================================================

    const displayName =
      user.display_name ||
      tg.first_name ||
      tg.username ||
      (tg.last_name ? `${tg.first_name ?? ""} ${tg.last_name}`.trim() : null);

    await execute(
      env,
      `
        UPDATE users
        SET username = ?, first_name = ?, last_name = ?, display_name = COALESCE(display_name, ?), last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, displayName, nowIso, nowIso, user.id]
    );

    // دوباره از دیتابیس بخونیم
    user = await queryOne<DbUser>(env, "SELECT * FROM users WHERE id = ?", [user.id]);
    if (!user) {
      // این حالت خیلی بعیده، ولی محض احتیاط
      throw new Error("User disappeared after update (unexpected).");
    }
    return user;
  }

  // 2) اگر نبود، کاربر جدید بسازیم
  const displayName =
    tg.first_name ||
    tg.username ||
    (tg.last_name ? `${tg.first_name ?? ""} ${tg.last_name}`.trim() : null) ||
    `user_${tg.id}`;

  // === تغییر مهم اینجاست: استفاده از try-catch ===
  // ما تلاش می‌کنیم بسازیم، اما اگر همزمان یکی دیگه ساخت و ارور داد، برنامه کرش نمیکنه
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
    // اگر ارور داد (مثلاً گفت تکراریه)، ما نادیده می‌گیریم چون پایین دوباره کاربر رو می‌خونیم
    console.warn("Duplicate user creation avoided:", tg.id);
  }

  // حالا دوباره تلاش می‌کنیم کاربر رو بگیریم (چه خودمون ساخته باشیم چه یکی دیگه همزمان ساخته باشه)
  const newUser = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);
  
  if (!newUser) {
    throw new Error("Failed to create user.");
  }

  return newUser;
}

// توابع کمکی دیگر (بدون تغییر)
export async function getUserById(env: Env, userId: number): Promise<DbUser | null> {
  const user = await queryOne<DbUser>(
    env,
    `SELECT * FROM users WHERE id = ?`,
    [userId]
  );
  return user ?? null;
}

export async function getUserByTelegramId(env: Env, telegramId: number): Promise<DbUser | null> {
  return await queryOne<DbUser>(
    env, 
    "SELECT * FROM users WHERE telegram_id = ?", 
    [telegramId]
  );
}
