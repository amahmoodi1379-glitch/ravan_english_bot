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
}

// ورودی ساده از تلگرام (فقط چیزهایی که لازم داریم)
export interface TelegramUserLike {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

// گرفتن یا ساختن کاربر بر اساس telegram_id
export async function getOrCreateUser(env: Env, tg: TelegramUserLike): Promise<DbUser> {
  // 1) ببینیم قبلاً همچین کاربری داریم یا نه
  let user = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);

  const now = new Date().toISOString();

  if (user) {
    // اگر هست، فقط آخرین زمان دیده شدن و اطلاعات تلگرام رو آپدیت می‌کنیم
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
      [tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, displayName, now, now, user.id]
    );

    // دوباره از دیتابیس بخونیم تا مقدار به‌روز برگردونیم
    user = await queryOne<DbUser>(env, "SELECT * FROM users WHERE id = ?", [user.id]);
    if (!user) {
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

  await execute(
    env,
    `
      INSERT INTO users (telegram_id, username, first_name, last_name, display_name, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [tg.id, tg.username ?? null, tg.first_name ?? null, tg.last_name ?? null, displayName, now]
  );

  // کاربر تازه ساخته شده را دوباره بخوانیم
  const newUser = await queryOne<DbUser>(env, "SELECT * FROM users WHERE telegram_id = ?", [tg.id]);
  if (!newUser) {
    throw new Error("Failed to create user.");
  }

  return newUser;
}

// گرفتن کاربر بر اساس id دیتابیسی (برای پیام دادن در دوئل)
export async function getUserById(env: Env, userId: number): Promise<DbUser | null> {
  const user = await queryOne<DbUser>(
    env,
    `
    SELECT *
    FROM users
    WHERE id = ?
    `,
    [userId]
  );
  return user ?? null;
}
