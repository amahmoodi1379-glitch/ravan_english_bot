import { Env } from "../types";
import { prepare } from "./client";
import { XP_VALUES } from "../config/constants";

export type ActivityType =
  | "leitner_question"
  | "reading_session"
  | "duel_question"
  | "duel_match";

// بازگرداندن آرایه‌ای از دستورات (بدون اجرا)
export function prepareAddXp(
  env: Env,
  userId: number,
  xpDelta: number,
  activityType: ActivityType,
  refId?: number,
  meta?: any
): any[] {
  if (xpDelta <= 0) return [];

  const metaJson = meta ? JSON.stringify(meta) : null;

  const stmt1 = prepare(
    env,
    `
    UPDATE users
    SET xp_total = xp_total + ?, updated_at = datetime('now')
    WHERE id = ?
    `,
    [xpDelta, userId]
  );

  const stmt2 = prepare(
    env,
    `
    INSERT INTO activity_log (user_id, activity_type, ref_id, xp_delta, meta_json)
    VALUES (?, ?, ?, ?, ?)
    `,
    [userId, activityType, refId ?? null, xpDelta, metaJson]
  );

  return [stmt1, stmt2];
}

// توابع قدیمی برای backward compatibility (اگر جایی هنوز استفاده می‌شود)
export async function addXp(env: Env, userId: number, xpDelta: number, activityType: ActivityType, refId?: number, meta?: any): Promise<void> {
  const stmts = prepareAddXp(env, userId, xpDelta, activityType, refId, meta);
  if (stmts.length > 0) await env.DB.batch(stmts);
}

// --- توابع آماده‌ساز اختصاصی ---

export function prepareXpForLeitner(
  env: Env,
  userId: number,
  wordId: number,
  wordLevel: number,
  isCorrect: boolean
): any[] {
  if (!isCorrect) return [];

  let xp = 0;
  switch (wordLevel) {
    case 1: xp = XP_VALUES.LEITNER_LEVEL_1; break;
    case 2: xp = XP_VALUES.LEITNER_LEVEL_2; break;
    case 3: xp = XP_VALUES.LEITNER_LEVEL_3; break;
    case 4: xp = XP_VALUES.LEITNER_LEVEL_4; break;
    default: xp = XP_VALUES.LEITNER_LEVEL_1;
  }

  return prepareAddXp(env, userId, xp, "leitner_question", wordId, { word_level: wordLevel });
}

// این تابع چون باید XP محاسبه شده را برگرداند (برای نمایش به کاربر)، همزمان محاسبه می‌کند و استیتمنت می‌دهد
export function calculateAndPrepareXpForReading(
  env: Env,
  userId: number,
  sessionId: number,
  correct: number,
  total: number
): { totalXp: number; stmts: any[] } {
  const xpPerQuestion = XP_VALUES.READING_QUESTION;
  const baseXp = correct * xpPerQuestion;

  let bonus = 0;
  if (total === 3) {
    if (correct === 3) bonus = XP_VALUES.READING_BONUS_PERFECT;
    else if (correct === 2) bonus = XP_VALUES.READING_BONUS_GOOD;
  }

  const totalXp = baseXp + bonus;
  if (totalXp <= 0) return { totalXp: 0, stmts: [] };

  const stmts = prepareAddXp(env, userId, totalXp, "reading_session", sessionId, {
    correct,
    total,
    xp_per_question: xpPerQuestion,
    bonus
  });

  return { totalXp, stmts };
}

// برای Backward Compatibility نگه‌ش می‌داریم ولی در کد جدید استفاده نمی‌کنیم
export async function addXpForReadingSession(env: Env, userId: number, sessionId: number, correct: number, total: number): Promise<number> {
  const { totalXp, stmts } = calculateAndPrepareXpForReading(env, userId, sessionId, correct, total);
  if (stmts.length > 0) await env.DB.batch(stmts);
  return totalXp;
}

export async function addXpForDuelMatch(
  env: Env,
  userId: number,
  duelId: number,
  correct: number,
  total: number,
  result: "win" | "draw" | "lose"
): Promise<number> {
  const xpPerQuestion = XP_VALUES.DUEL_QUESTION;
  const baseXp = correct * xpPerQuestion;

  let bonus = 0;
  if (result === "win") bonus = XP_VALUES.DUEL_WIN_BONUS;
  else if (result === "draw") bonus = XP_VALUES.DUEL_DRAW_BONUS;

  const totalXp = baseXp + bonus;
  if (totalXp <= 0) return 0;

  const stmts = prepareAddXp(env, userId, totalXp, "duel_match", duelId, {
    correct,
    total,
    result,
    xp_per_question: xpPerQuestion,
    bonus
  });
  
  if (stmts.length > 0) await env.DB.batch(stmts);
  return totalXp;
}

// چک کردن و آپدیت زنجیره (Streak) با پشتیبانی از تایم‌زون
export async function checkAndUpdateStreak(env: Env, userId: number): Promise<string | null> {
  const TARGET_DAILY_XP = 50; // هدف روزانه
  
  // تنظیم اختلاف ساعت (مثلاً برای ایران +3.5 ساعت)
  // این باعث می‌شود "روز جدید" دقیقاً ساعت ۰۰:۰۰ به وقت محلی شروع شود
  const TIME_MODIFIER = '+3.5 hours';

  // 1. محاسبه XP امروز (با لحاظ کردن اختلاف ساعت)
  const xpRow = await env.DB.prepare(`
    SELECT SUM(xp_delta) as total
    FROM activity_log
    WHERE user_id = ? 
      AND date(created_at, ?) = date('now', ?)
  `).bind(userId, TIME_MODIFIER, TIME_MODIFIER).first();

  const todayXp = (xpRow?.total as number) || 0;

  // اگر هنوز به هدف نرسیده، کاری نداریم
  if (todayXp < TARGET_DAILY_XP) return null;

  // 2. گرفتن وضعیت فعلی کاربر
  const user = await env.DB.prepare(`
    SELECT streak_count, last_streak_date 
    FROM users 
    WHERE id = ?
  `).bind(userId).first();

  if (!user) return null;

  const currentStreak = (user.streak_count as number) || 0;
  const lastStreakDate = (user.last_streak_date as string) || ""; // فرمت YYYY-MM-DD ذخیره شده

  // گرفتن تاریخ "امروز" و "دیروز" به وقت محلی از دیتابیس (برای دقت صددرصد)
  const dateCheck = await env.DB.prepare(`
    SELECT 
      date('now', ?) as today_local,
      date('now', ?, '-1 day') as yesterday_local
  `).bind(TIME_MODIFIER, TIME_MODIFIER).first();

  const todayLocal = dateCheck?.today_local as string;
  const yesterdayLocal = dateCheck?.yesterday_local as string;

  // اگر همین امروز (به وقت محلی) قبلاً زنجیره ثبت شده، دیگه اضافه نکن
  if (lastStreakDate === todayLocal) {
    return null; 
  }

  let newStreak = 1;
  let message = "";

  if (lastStreakDate === yesterdayLocal) {
    // اگر آخرین بار دیروز بوده، زنجیره ادامه داره
    newStreak = currentStreak + 1;
    message = `🔥 زنجیره‌ی تو به ${newStreak} روز رسید! ایول!`;
  } else {
    // اگر بیشتر فاصله افتاده (یا بار اوله)، ریست میشه به 1
    newStreak = 1;
    message = `🔥 زنجیره جدید شروع شد! امروز روز اوله.`;
  }

  // 3. آپدیت دیتابیس با تاریخ محلی
  await env.DB.prepare(`
    UPDATE users 
    SET streak_count = ?, last_streak_date = ? 
    WHERE id = ?
  `).bind(newStreak, todayLocal, userId).run();

  return message;
}
