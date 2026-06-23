import { Env } from "../types";
import { prepare, SqlGuard } from "./client";
import { XP_VALUES, TIME_ZONE_OFFSET } from "../config/constants";

export type ActivityType = "leitner_question" | "reading_session";

/**
 * Build the statements that award XP. When `guard` is supplied, both the
 * xp_total increment and the activity_log insert are gated on it, so they can
 * be placed in the same atomic DB.batch() as the "claim" statement and only
 * take effect for the request that actually wins the claim (no double XP, and
 * no partial-failure window where the claim commits but XP doesn't).
 */
function prepareAddXp(
  env: Env,
  userId: number,
  xpDelta: number,
  activityType: ActivityType,
  refId?: number,
  meta?: Record<string, unknown>,
  guard?: SqlGuard
): D1PreparedStatement[] {
  if (xpDelta <= 0) return [];

  const metaJson = meta ? JSON.stringify(meta) : null;

  const stmt1 = prepare(
    env,
    `
    UPDATE users
    SET xp_total = xp_total + ?, updated_at = datetime('now')
    WHERE id = ?${guard ? ` AND ${guard.sql}` : ""}
    `,
    [xpDelta, userId, ...(guard ? guard.params : [])]
  );

  // When guarded, use INSERT ... SELECT ... WHERE <guard> so the row is only
  // logged if the guard holds (VALUES has no WHERE).
  const stmt2 = guard
    ? prepare(
        env,
        `
        INSERT INTO activity_log (user_id, activity_type, ref_id, xp_delta, meta_json)
        SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
        `,
        [userId, activityType, refId ?? null, xpDelta, metaJson, ...guard.params]
      )
    : prepare(
        env,
        `
        INSERT INTO activity_log (user_id, activity_type, ref_id, xp_delta, meta_json)
        VALUES (?, ?, ?, ?, ?)
        `,
        [userId, activityType, refId ?? null, xpDelta, metaJson]
      );

  return [stmt1, stmt2];
}

/**
 * Prepare DB statements to award XP for a correct leitner answer based on word level.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user receiving XP
 * @param wordId - The word ID that was answered correctly
 * @param wordLevel - The word's difficulty level (1–4)
 * @param isCorrect - Whether the user's answer was correct
 * @returns An array of D1PreparedStatements to execute in a batch (empty if incorrect)
 */
export function prepareXpForLeitner(
  env: Env,
  userId: number,
  wordId: number,
  wordLevel: number,
  isCorrect: boolean,
  guard?: SqlGuard
): D1PreparedStatement[] {
  if (!isCorrect) return [];

  let xp = 0;
  switch (wordLevel) {
    case 1: xp = XP_VALUES.LEITNER_LEVEL_1; break;
    case 2: xp = XP_VALUES.LEITNER_LEVEL_2; break;
    case 3: xp = XP_VALUES.LEITNER_LEVEL_3; break;
    case 4: xp = XP_VALUES.LEITNER_LEVEL_4; break;
    default: xp = XP_VALUES.LEITNER_LEVEL_1;
  }

  return prepareAddXp(env, userId, xp, "leitner_question", wordId, { word_level: wordLevel }, guard);
}

/**
 * Calculate reading session XP (including bonus) and prepare DB statements to award it.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user receiving XP
 * @param sessionId - The reading session ID
 * @param correct - Number of correct answers in the session
 * @param total - Total number of questions in the session
 * @returns An object with totalXp earned and prepared D1PreparedStatements
 */
export function calculateAndPrepareXpForReading(
  env: Env,
  userId: number,
  sessionId: number,
  correct: number,
  total: number,
  guard?: SqlGuard
): { totalXp: number; stmts: D1PreparedStatement[] } {
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
  }, guard);

  return { totalXp, stmts };
}

/**
 * Check if the user has met today's daily test goal and update their streak accordingly.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to check streak for
 * @returns A Persian streak message string if the streak was updated, or null otherwise
 */
export async function checkAndUpdateStreak(env: Env, userId: number): Promise<string | null> {
  const TARGET_DAILY_TESTS = 5;
  const TIME_MODIFIER = TIME_ZONE_OFFSET;

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

  await env.DB.prepare(`
    UPDATE users
    SET streak_count = ?,
        last_streak_date = ?,
        max_streak_record = ?
    WHERE id = ?
  `).bind(newStreak, todayLocal, newMaxStreak, userId).run();

  return message;
}
