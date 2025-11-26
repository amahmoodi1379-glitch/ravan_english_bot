import { Env } from "../types";
import { execute } from "./client";

// نوع کلی فعالیت‌ها (بعداً می‌تونیم بیشترش کنیم)
export type ActivityType =
  | "leitner_question"
  | "reading_session"
  | "duel_question"
  | "duel_match";

// تابع عمومی اضافه کردن XP
export async function addXp(
  env: Env,
  userId: number,
  xpDelta: number,
  activityType: ActivityType,
  refId?: number,
  meta?: any
): Promise<void> {
  if (xpDelta <= 0) return;

  const metaJson = meta ? JSON.stringify(meta) : null;

  // آپدیت XP کلی کاربر
  await execute(
    env,
    `
    UPDATE users
    SET xp_total = xp_total + ?, updated_at = datetime('now')
    WHERE id = ?
    `,
    [xpDelta, userId]
  );

  // ثبت در activity_log
  await execute(
    env,
    `
    INSERT INTO activity_log (user_id, activity_type, ref_id, xp_delta, meta_json)
    VALUES (?, ?, ?, ?, ?)
    `,
    [userId, activityType, refId ?? null, xpDelta, metaJson]
  );
}

// XP برای سوال لایتنر
export async function addXpForLeitnerQuestion(
  env: Env,
  userId: number,
  wordId: number,
  wordLevel: number,
  isCorrect: boolean
): Promise<void> {
  if (!isCorrect) return;

  let xp = 0;
  switch (wordLevel) {
    case 1:
      xp = 5;
      break;
    case 2:
      xp = 8;
      break;
    case 3:
      xp = 12;
      break;
    case 4:
      xp = 16;
      break;
    default:
      xp = 5; // اگر سطح ناشناخته بود، مثل سطح ۱
  }

  await addXp(env, userId, xp, "leitner_question", wordId, {
    word_level: wordLevel
  });
}

// XP برای یک ست تست درک مطلب (3 سوال)
export async function addXpForReadingSession(
  env: Env,
  userId: number,
  sessionId: number,
  correct: number,
  total: number
): Promise<number> {
  const xpPerQuestion = 15;
  const baseXp = correct * xpPerQuestion;

  let bonus = 0;
  if (total === 3) {
    if (correct === 3) bonus = 10;
    else if (correct === 2) bonus = 5;
  }

  const totalXp = baseXp + bonus;
  if (totalXp <= 0) return 0;

  await addXp(env, userId, totalXp, "reading_session", sessionId, {
    correct,
    total,
    xp_per_question: xpPerQuestion,
    bonus
  });

  return totalXp;
}

// XP برای یک دوئل (۵ سوال)
export async function addXpForDuelMatch(
  env: Env,
  userId: number,
  duelId: number,
  correct: number,
  total: number,
  result: "win" | "draw" | "lose"
): Promise<number> {
  const xpPerQuestion = 10;
  const baseXp = correct * xpPerQuestion;

  let bonus = 0;
  if (result === "win") bonus = 30;
  else if (result === "draw") bonus = 10;

  const totalXp = baseXp + bonus;
  if (totalXp <= 0) return 0;

  await addXp(env, userId, totalXp, "duel_match", duelId, {
    correct,
    total,
    result,
    xp_per_question: xpPerQuestion,
    bonus
  });

  return totalXp;
}
