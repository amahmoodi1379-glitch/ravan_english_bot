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
