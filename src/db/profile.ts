import { Env } from "../types";
import { queryOne, execute } from "./client";
import { TIME_ZONE_OFFSET, DISPLAY_NAME } from "../config/constants";

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

  // The three windows are independent — run them together instead of serially.
  const [xpRow, qRow, wRow] = await Promise.all([
    // XP from activity_log
    queryOne<{ cur: number; prev: number }>(
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
    ),
    // Answered questions: leitner + reading combined
    queryOne<{ cur: number; prev: number }>(
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
    ),
    // New words learned (state row created), excluding ignored
    queryOne<{ cur: number; prev: number }>(
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
    ),
  ]);

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
  streak_count: number;
  last_streak_date: string | null;
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
  reason?: "not_found";
}

/**
 * Normalise a name for placeholder matching only: unify the Arabic/Persian
 * letter variants (ي/ی, ك/ک), turn the separators people copy along with a
 * placeholder (_ - <> «» …) into spaces, collapse whitespace and lowercase.
 * Display keeps the user's original text — this form is never stored.
 */
function normalizeForPlaceholder(value: string): string {
  return value
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[_\-<>«»[\](){}"'‹›]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Texts that are obviously the instruction rather than a name. The old settings
 * screen told users to send "/setname اسم_جدید", and a large number of them sent
 * it verbatim — so their display name literally became "اسم_جدید". These are
 * rejected with a message that explains what to type instead.
 */
const PLACEHOLDER_NAMES = new Set([
  "اسم جدید",
  "اسم جدیدم",
  "اسم جدیدت",
  "اسم جدید من",
  "نام جدید",
  "نام جدیدم",
  "نام جدیدت",
  "نام جدید من",
  "اسم",
  "نام",
  "اسم من",
  "نام من",
  "اسمم",
  "نامم",
  "اسم نمایشی",
  "نام نمایشی",
  "setname",
  "name",
  "new name",
  "newname",
  "your name",
  "yourname",
  "my name",
  "myname",
]);

/**
 * Validate a display name typed by a user. Pure/side-effect-free so the rules are
 * unit-testable. Returns the cleaned-up value (whitespace collapsed to single
 * spaces, trimmed) or a ready-to-send Persian reason.
 * @param raw - The raw text the user sent
 * @returns Either the accepted value or the reason it was rejected
 */
export function validateDisplayName(
  raw: string
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();

  if (value.length === 0) {
    return { ok: false, reason: "اسمت خالیه 🙂 یه اسم برای خودت بنویس." };
  }
  if (value.startsWith("/")) {
    return {
      ok: false,
      reason: "این یه دستوره، نه اسم 🙂 فقط خودِ اسمت رو بنویس، مثلاً: رضا",
    };
  }
  if (PLACEHOLDER_NAMES.has(normalizeForPlaceholder(value))) {
    return {
      ok: false,
      reason:
        "😅 «اسم جدید» فقط یه نمونه بود، نه اسم واقعی!\nاسم خودت رو بنویس، مثلاً: رضا",
    };
  }
  if (value.length < DISPLAY_NAME.MIN) {
    return { ok: false, reason: `اسمت خیلی کوتاهه 🙂 حداقل ${DISPLAY_NAME.MIN} حرف بنویس.` };
  }
  if (value.length > DISPLAY_NAME.MAX) {
    return {
      ok: false,
      reason: `اسمت خیلی طولانیه 😅 حداکثر ${DISPLAY_NAME.MAX} حرف. یه اسم کوتاه‌تر بنویس.`,
    };
  }
  if (!/\p{L}/u.test(value)) {
    return { ok: false, reason: "اسمت باید حداقل یه حرف داشته باشه 🙂" };
  }
  if (/@\w/.test(value) || /https?:\/\//i.test(value) || /t\.me\//i.test(value)) {
    return { ok: false, reason: "اسم نباید شامل لینک یا آیدی باشه. یه اسم ساده بنویس 🙂" };
  }
  if (/\d{7,}/.test(value.replace(/\D/g, ""))) {
    return { ok: false, reason: "اسم نباید شماره تماس داشته باشه. یه اسم ساده بنویس 🙂" };
  }

  return { ok: true, value };
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
      name_change_count,
      streak_count,
      last_streak_date
    FROM users
    WHERE id = ?
    `,
    [userId]
  );
  return row ?? null;
}

/**
 * Update a user's display name. There is NO limit on how often a user may rename
 * themselves — `name_change_count` is still incremented, but purely as history.
 * One statement, no pre-read: a missing user simply affects zero rows.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to update
 * @param newName - The new display name to set (already validated)
 * @returns A NameChangeResult indicating success or the reason for failure
 */
export async function updateDisplayName(
  env: Env,
  userId: number,
  newName: string
): Promise<NameChangeResult> {
  const now = new Date().toISOString();

  const res = await execute(
    env,
    `
    UPDATE users
    SET display_name = ?, name_change_count = name_change_count + 1, updated_at = ?
    WHERE id = ?
    `,
    [newName, now, userId]
  );

  if (res.meta?.changes === 0) {
    return { ok: false, reason: "not_found" };
  }

  return { ok: true };
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
    // "all time" period — the five aggregates are independent, so run them together.
    const [xpRow, lRow, newRow, rRow, rqRow] = await Promise.all([
      queryOne<{ xp: number | null }>(
        env,
        `SELECT xp_total AS xp FROM users WHERE id = ?`,
        [userId]
      ),
      queryOne<{ cnt: number; correct: number; incorrect: number }>(
        env,
        `SELECT COUNT(*) AS cnt,
                COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct,
                COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect
         FROM user_word_question_history WHERE user_id = ? AND context = 'leitner' AND answered_at IS NOT NULL`,
        [userId]
      ),
      queryOne<{ cnt: number }>(
        env,
        `SELECT COUNT(*) AS cnt FROM user_words_sm2 WHERE user_id = ? AND ignored = 0`,
        [userId]
      ),
      queryOne<{ cnt: number }>(
        env,
        `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed'`,
        [userId]
      ),
      queryOne<{ total: number; correct: number }>(
        env,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct
         FROM user_text_question_history WHERE user_id = ? AND answered_at IS NOT NULL`,
        [userId]
      ),
    ]);
    xp = xpRow?.xp ?? 0;
    leitnerQuestions = lRow?.cnt ?? 0;
    leitnerCorrect = lRow?.correct ?? 0;
    leitnerIncorrect = lRow?.incorrect ?? 0;
    newWordsLearned = newRow?.cnt ?? 0;
    readingSets = rRow?.cnt ?? 0;
    readingQuestionsTotal = rqRow?.total ?? 0;
    readingQuestionsCorrect = rqRow?.correct ?? 0;
  } else {
    // Time-bounded period — same five aggregates, run together.
    const [xpRow, lRow, newRow, rRow, rqRow] = await Promise.all([
      queryOne<{ xp: number | null }>(
        env,
        `SELECT COALESCE(SUM(xp_delta), 0) AS xp FROM activity_log WHERE user_id = ? AND created_at >= ${sinceExpr}`,
        [userId]
      ),
      queryOne<{ cnt: number; correct: number; incorrect: number }>(
        env,
        `SELECT COUNT(*) AS cnt,
                COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct,
                COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect
         FROM user_word_question_history WHERE user_id = ? AND context = 'leitner' AND answered_at IS NOT NULL AND answered_at >= ${sinceExpr}`,
        [userId]
      ),
      queryOne<{ cnt: number }>(
        env,
        `SELECT COUNT(*) AS cnt FROM user_words_sm2 WHERE user_id = ? AND ignored = 0 AND created_at >= ${sinceExpr}`,
        [userId]
      ),
      queryOne<{ cnt: number }>(
        env,
        `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed' AND completed_at >= ${sinceExpr}`,
        [userId]
      ),
      queryOne<{ total: number; correct: number }>(
        env,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct
         FROM user_text_question_history WHERE user_id = ? AND answered_at IS NOT NULL AND answered_at >= ${sinceExpr}`,
        [userId]
      ),
    ]);
    xp = xpRow?.xp ?? 0;
    leitnerQuestions = lRow?.cnt ?? 0;
    leitnerCorrect = lRow?.correct ?? 0;
    leitnerIncorrect = lRow?.incorrect ?? 0;
    newWordsLearned = newRow?.cnt ?? 0;
    readingSets = rRow?.cnt ?? 0;
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
