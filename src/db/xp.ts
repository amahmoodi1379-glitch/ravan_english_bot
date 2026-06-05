import { Env } from "../types";
import { prepare } from "./client";
import { XP_VALUES, TIME_ZONE_OFFSET } from "../config/constants";

export type ActivityType =
  | "leitner_question"
  | "reading_session";

// بازگرداندن آرایه‌ای از دستورات (بدون اجرا)
function prepareAddXp(
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

// چک کردن و آپدیت زنجیره (Streak) با پشتیبانی از تایم‌زون
// شرط streak: حداقل ۵ تست لایتنر در روز (تغییر از ۵۰ XP)
// بهینه‌سازی: ترکیب ۳ کوئری مجزا در ۲ کوئری
export async function checkAndUpdateStreak(env: Env, userId: number): Promise<string | null> {
  const TARGET_DAILY_TESTS = 5;
  const TIME_MODIFIER = TIME_ZONE_OFFSET;

  // 1. شمردن تعداد تست لایتنر امروز + گرفتن وضعیت streak کاربر (در یک round-trip)
  const combined = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM user_word_question_history
       WHERE user_id = ? AND context = 'leitner'
       AND date(answered_at, ?) = date('now', ?)) as today_tests,
      u.streak_count,
      u.last_streak_date,
      u.max_streak_record,
      date('now', ?) as today_local,
      date('now', ?, '-1 day') as yesterday_local
    FROM users u
    WHERE u.id = ?
  `).bind(userId, TIME_MODIFIER, TIME_MODIFIER, TIME_MODIFIER, TIME_MODIFIER, userId).first();

  if (!combined) return null;

  const todayTests = (combined.today_tests as number) || 0;
  if (todayTests < TARGET_DAILY_TESTS) return null;

  const currentStreak = (combined.streak_count as number) || 0;
  const maxStreakRecord = (combined.max_streak_record as number) || 0;
  const lastStreakDate = (combined.last_streak_date as string) || "";
  const todayLocal = combined.today_local as string;
  const yesterdayLocal = combined.yesterday_local as string;

  if (lastStreakDate === todayLocal) {
    return null;
  }

  let newStreak = 1;
  let message = "";

  if (lastStreakDate === yesterdayLocal) {
    newStreak = currentStreak + 1;
    message = `🔥 زنجیره‌ی تو به ${newStreak} روز رسید! ایول!`;
  } else {
    newStreak = 1;
    message = `🔥 زنجیره جدید شروع شد! امروز روز اوله.`;
  }

  const newMaxStreak = Math.max(maxStreakRecord, newStreak);

  // 2. آپدیت دیتابیس (streak + max_streak_record)
  await env.DB.prepare(`
    UPDATE users
    SET streak_count = ?,
        last_streak_date = ?,
        max_streak_record = ?
    WHERE id = ?
  `).bind(newStreak, todayLocal, newMaxStreak, userId).run();

  return message;
}
