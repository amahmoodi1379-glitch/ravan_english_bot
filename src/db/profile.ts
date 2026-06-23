import { Env } from "../types";
import { queryOne, execute } from "./client";
import { TIME_ZONE_OFFSET } from "../config/constants";

export type ActivityPeriod = "day" | "week" | "month" | "all";

export interface PeriodMetrics {
  xp: number;
  questions: number;
  new_words: number;
}

export interface PeriodComparison {
  current: PeriodMetrics;
  previous: PeriodMetrics;
}

/** Local-date bucketing modifier shared across analytics queries. */
const LOCAL_DATE = `'${TIME_ZONE_OFFSET}'`;

/**
 * Compute study metrics (XP, answered questions, new words) for a user across two
 * consecutive local-date windows: the current window [curStart, curEnd) and the
 * previous window [prevStart, prevEnd). Dates are 'YYYY-MM-DD' in Iran local time.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to compute metrics for
 * @param r - The window boundaries as local date strings
 * @returns A PeriodComparison with current and previous metric totals
 */
export async function getActivityComparison(
  env: Env,
  userId: number,
  r: { curStart: string; curEnd: string; prevStart: string; prevEnd: string }
): Promise<PeriodComparison> {
  const { curStart, curEnd, prevStart, prevEnd } = r;

  // XP from activity_log
  const xpRow = await queryOne<{ cur: number; prev: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN xp_delta ELSE 0 END), 0) AS cur,
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN xp_delta ELSE 0 END), 0) AS prev
    FROM (
      SELECT xp_delta, date(created_at, ${LOCAL_DATE}) AS d
      FROM activity_log
      WHERE user_id = ? AND date(created_at, ${LOCAL_DATE}) >= ? AND date(created_at, ${LOCAL_DATE}) < ?
    )
    `,
    [curStart, curEnd, prevStart, prevEnd, userId, prevStart, curEnd]
  );

  // Answered questions: leitner + reading combined
  const qRow = await queryOne<{ cur: number; prev: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN 1 ELSE 0 END), 0) AS cur,
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN 1 ELSE 0 END), 0) AS prev
    FROM (
      SELECT date(answered_at, ${LOCAL_DATE}) AS d
      FROM user_word_question_history
      WHERE user_id = ? AND context = 'leitner' AND answered_at IS NOT NULL
        AND date(answered_at, ${LOCAL_DATE}) >= ? AND date(answered_at, ${LOCAL_DATE}) < ?
      UNION ALL
      SELECT date(answered_at, ${LOCAL_DATE}) AS d
      FROM user_text_question_history
      WHERE user_id = ? AND answered_at IS NOT NULL
        AND date(answered_at, ${LOCAL_DATE}) >= ? AND date(answered_at, ${LOCAL_DATE}) < ?
    )
    `,
    [curStart, curEnd, prevStart, prevEnd, userId, prevStart, curEnd, userId, prevStart, curEnd]
  );

  // New words learned (state row created), excluding ignored
  const wRow = await queryOne<{ cur: number; prev: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN 1 ELSE 0 END), 0) AS cur,
      COALESCE(SUM(CASE WHEN d >= ? AND d < ? THEN 1 ELSE 0 END), 0) AS prev
    FROM (
      SELECT date(created_at, ${LOCAL_DATE}) AS d
      FROM user_words_sm2
      WHERE user_id = ? AND ignored = 0
        AND date(created_at, ${LOCAL_DATE}) >= ? AND date(created_at, ${LOCAL_DATE}) < ?
    )
    `,
    [curStart, curEnd, prevStart, prevEnd, userId, prevStart, curEnd]
  );

  return {
    current: {
      xp: xpRow?.cur ?? 0,
      questions: qRow?.cur ?? 0,
      new_words: wRow?.cur ?? 0,
    },
    previous: {
      xp: xpRow?.prev ?? 0,
      questions: qRow?.prev ?? 0,
      new_words: wRow?.prev ?? 0,
    },
  };
}

export interface UserProfile {
  id: number;
  display_name: string | null;
  avatar_code: string | null;
  xp_total: number;
  created_at: string;
  last_seen_at: string | null;
  name_change_count: number;
}

export interface ActivityStats {
  period: ActivityPeriod;
  xp: number;
  leitner_questions: number;
  leitner_correct: number;
  leitner_incorrect: number;
  new_words_learned: number;
  reading_sets: number;
  reading_questions_correct: number;
  reading_questions_total: number;
}

export interface NameChangeResult {
  ok: boolean;
  reason?: "limit" | "not_found";
  remainingChanges?: number;
}

function getSinceExpr(period: ActivityPeriod): string | null {
  if (period === "day") return "datetime('now', '-1 day')";
  if (period === "week") return "datetime('now', '-7 days')";
  if (period === "month") return "datetime('now', '-30 days')";
  return null;
}

/**
 * Retrieve a user's profile data (display name, avatar, XP, timestamps).
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to look up
 * @returns The UserProfile record, or null if not found
 */
export async function getUserProfile(env: Env, userId: number): Promise<UserProfile | null> {
  const row = await queryOne<UserProfile>(
    env,
    `
    SELECT
      id,
      display_name,
      avatar_code,
      xp_total,
      created_at,
      last_seen_at,
      name_change_count
    FROM users
    WHERE id = ?
    `,
    [userId]
  );
  return row ?? null;
}

/**
 * Update a user's display name (subject to a 3-change lifetime limit).
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to update
 * @param newName - The new display name to set
 * @returns A NameChangeResult indicating success or the reason for failure
 */
export async function updateDisplayName(
  env: Env,
  userId: number,
  newName: string
): Promise<NameChangeResult> {
  const row = await queryOne<{ name_change_count: number }>(
    env,
    `
    SELECT name_change_count
    FROM users
    WHERE id = ?
    `,
    [userId]
  );

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  const currentCount = row.name_change_count ?? 0;
  if (currentCount >= 3) {
    return { ok: false, reason: "limit", remainingChanges: 0 };
  }

  const now = new Date().toISOString();

  await execute(
    env,
    `
    UPDATE users
    SET display_name = ?, name_change_count = name_change_count + 1, updated_at = ?
    WHERE id = ?
    `,
    [newName, now, userId]
  );

  const remaining = Math.max(0, 3 - (currentCount + 1));

  return {
    ok: true,
    remainingChanges: remaining
  };
}

/**
 * Set the avatar code for a user.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to update
 * @param avatarCode - The avatar code string to store
 * @returns void
 */
export async function setAvatar(env: Env, userId: number, avatarCode: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    env,
    `
    UPDATE users
    SET avatar_code = ?, updated_at = ?
    WHERE id = ?
    `,
    [avatarCode, now, userId]
  );
}

/**
 * Compute aggregated activity statistics for a user over a given time period.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to compute stats for
 * @param period - The time window: "day", "week", "month", or "all"
 * @returns An ActivityStats object with XP, question counts, and reading data
 */
export async function getUserActivityStats(
  env: Env,
  userId: number,
  period: ActivityPeriod
): Promise<ActivityStats> {
  const sinceExpr = getSinceExpr(period);

  let xp = 0;
  let leitnerQuestions = 0;
  let leitnerCorrect = 0;
  let leitnerIncorrect = 0;
  let newWordsLearned = 0;
  let readingSets = 0;
  let readingQuestionsCorrect = 0;
  let readingQuestionsTotal = 0;

  if (!sinceExpr) {
    // "all time" period
    const xpRow = await queryOne<{ xp: number | null }>(
      env,
      `SELECT xp_total AS xp FROM users WHERE id = ?`,
      [userId]
    );
    xp = xpRow?.xp ?? 0;

    const lRow = await queryOne<{ cnt: number; correct: number; incorrect: number }>(
      env,
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct,
              COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect
       FROM user_word_question_history WHERE user_id = ? AND context = 'leitner' AND answered_at IS NOT NULL`,
      [userId]
    );
    leitnerQuestions = lRow?.cnt ?? 0;
    leitnerCorrect = lRow?.correct ?? 0;
    leitnerIncorrect = lRow?.incorrect ?? 0;

    const newRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM user_words_sm2 WHERE user_id = ? AND ignored = 0`,
      [userId]
    );
    newWordsLearned = newRow?.cnt ?? 0;

    const rRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed'`,
      [userId]
    );
    readingSets = rRow?.cnt ?? 0;

    const rqRow = await queryOne<{ total: number; correct: number }>(
      env,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct
       FROM user_text_question_history WHERE user_id = ? AND answered_at IS NOT NULL`,
      [userId]
    );
    readingQuestionsTotal = rqRow?.total ?? 0;
    readingQuestionsCorrect = rqRow?.correct ?? 0;
  } else {
    // Time-bounded period
    const xpRow = await queryOne<{ xp: number | null }>(
      env,
      `SELECT COALESCE(SUM(xp_delta), 0) AS xp FROM activity_log WHERE user_id = ? AND created_at >= ${sinceExpr}`,
      [userId]
    );
    xp = xpRow?.xp ?? 0;

    const lRow = await queryOne<{ cnt: number; correct: number; incorrect: number }>(
      env,
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct,
              COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect
       FROM user_word_question_history WHERE user_id = ? AND context = 'leitner' AND answered_at IS NOT NULL AND answered_at >= ${sinceExpr}`,
      [userId]
    );
    leitnerQuestions = lRow?.cnt ?? 0;
    leitnerCorrect = lRow?.correct ?? 0;
    leitnerIncorrect = lRow?.incorrect ?? 0;

    const newRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM user_words_sm2 WHERE user_id = ? AND ignored = 0 AND created_at >= ${sinceExpr}`,
      [userId]
    );
    newWordsLearned = newRow?.cnt ?? 0;

    const rRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed' AND completed_at >= ${sinceExpr}`,
      [userId]
    );
    readingSets = rRow?.cnt ?? 0;

    const rqRow = await queryOne<{ total: number; correct: number }>(
      env,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct
       FROM user_text_question_history WHERE user_id = ? AND answered_at IS NOT NULL AND answered_at >= ${sinceExpr}`,
      [userId]
    );
    readingQuestionsTotal = rqRow?.total ?? 0;
    readingQuestionsCorrect = rqRow?.correct ?? 0;
  }

  return {
    period,
    xp,
    leitner_questions: leitnerQuestions,
    leitner_correct: leitnerCorrect,
    leitner_incorrect: leitnerIncorrect,
    new_words_learned: newWordsLearned,
    reading_sets: readingSets,
    reading_questions_correct: readingQuestionsCorrect,
    reading_questions_total: readingQuestionsTotal,
  };
}
