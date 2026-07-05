import { Env } from "../types";
import { queryOne, queryAll, execute, prepare, batch } from "./client";
import { CustomQuiz, getLeaderboardWithoutNegative, setQuizStatus, getQuestionCount } from "./custom_quizzes";
import { prepareXpForTournament, prepareXpForTournamentRank } from "./xp";
import { awardTournamentBadges, TournamentBadgeEntry } from "./badges";
import { TOURNAMENT_CONFIG } from "../config/constants";

/** Map a word_questions correct-option letter to the custom_quiz digit format. */
const LETTER_TO_DIGIT: Record<string, string> = { A: "1", B: "2", C: "3", D: "4" };

/** Max prepared statements per DB.batch() (kept well under D1 limits). */
const XP_BATCH_CHUNK = 100;

interface PickedQuestion {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string; // 'A'..'D'
  explanation_text: string | null;
}

/**
 * Pick N random multiple-choice questions from the word-question bank for a
 * tournament, preferring QC-reviewed questions and falling back to the full bank
 * if there aren't enough reviewed ones.
 * @param env - The worker environment containing the D1 database binding
 * @param n - Number of questions to pick
 * @returns The picked question rows (may be fewer than n if the bank is small)
 */
async function pickTournamentQuestions(env: Env, n: number): Promise<PickedQuestion[]> {
  const cols = `question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text`;
  const reviewed = await queryAll<PickedQuestion>(
    env,
    `SELECT ${cols} FROM word_questions WHERE reviewed_at IS NOT NULL ORDER BY RANDOM() LIMIT ?`,
    [n]
  );
  if (reviewed.length >= n) return reviewed;
  // Fallback: not enough reviewed questions yet — pull from the whole bank.
  return await queryAll<PickedQuestion>(
    env,
    `SELECT ${cols} FROM word_questions ORDER BY RANDOM() LIMIT ?`,
    [n]
  );
}

/** Get an admin id to own auto-generated tournaments (custom_quizzes.admin_id FK). */
async function getSystemAdminId(env: Env): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM admins ORDER BY is_super_admin DESC, id ASC LIMIT 1`
  );
  return row?.id ?? null;
}

/**
 * Fetch the tournament for a given Iran-local date, if one exists.
 * @param env - The worker environment containing the D1 database binding
 * @param iranDate - Iran-local 'YYYY-MM-DD'
 * @returns The tournament quiz row, or null
 */
export async function getTournamentByDate(env: Env, iranDate: string): Promise<CustomQuiz | null> {
  return queryOne<CustomQuiz>(
    env,
    `SELECT * FROM custom_quizzes WHERE kind = 'tournament' AND tournament_date = ?`,
    [iranDate]
  );
}

/**
 * Create the tournament for the given Iran-local date if it does not already
 * exist. Idempotent: a second call for the same date returns the existing id
 * (guarded by the partial unique index on tournament_date).
 * @param env - The worker environment containing the D1 database binding
 * @param iranDate - Iran-local 'YYYY-MM-DD' identity of the tournament
 * @param opensAtUtc - UTC 'YYYY-MM-DD HH:MM:SS' window open
 * @param closesAtUtc - UTC hard close
 * @returns The tournament quiz id, or null if it could not be created (no admin / no questions)
 */
export async function createDailyTournament(
  env: Env,
  iranDate: string,
  opensAtUtc: string,
  closesAtUtc: string
): Promise<number | null> {
  const existing = await getTournamentByDate(env, iranDate);
  if (existing) return existing.id;

  const adminId = await getSystemAdminId(env);
  if (adminId === null) {
    console.error("createDailyTournament: no admin row to own the tournament");
    return null;
  }

  const questions = await pickTournamentQuestions(env, TOURNAMENT_CONFIG.QUESTION_COUNT);
  if (questions.length === 0) {
    console.error("createDailyTournament: no word_questions available");
    return null;
  }

  const title = `🎯 مسابقه‌ی ${iranDate}`;
  let quizId: number;
  try {
    const res = await execute(
      env,
      `INSERT INTO custom_quizzes (admin_id, title, total_time_minutes, status, kind, opens_at, closes_at, tournament_date)
       VALUES (?, ?, ?, 'active', 'tournament', ?, ?, ?)`,
      [adminId, title, TOURNAMENT_CONFIG.DURATION_MINUTES, opensAtUtc, closesAtUtc, iranDate]
    );
    quizId = (res.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
  } catch (err) {
    // Lost a race on the unique index — re-fetch the winner's row.
    const raced = await getTournamentByDate(env, iranDate);
    if (raced) return raced.id;
    throw err;
  }
  if (!quizId) return null;

  const stmts = questions.map((q, i) =>
    prepare(
      env,
      `INSERT INTO custom_quiz_questions (quiz_id, question_index, question_text, option_a, option_b, option_c, option_d, correct_option, explanation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quizId,
        i + 1,
        q.question_text,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        LETTER_TO_DIGIT[(q.correct_option || "").toUpperCase()] || "1",
        q.explanation_text ?? null,
      ]
    )
  );
  await batch(env, stmts);

  return quizId;
}

/**
 * Settle the tournament for the given Iran-local date: force-finish stragglers,
 * award XP (participation + per-correct + rank bonus) once, and mark it complete.
 * Idempotent — a second call returns null once the quiz is 'completed'.
 * @param env - The worker environment containing the D1 database binding
 * @param iranDate - Iran-local 'YYYY-MM-DD'
 * @returns The settled quiz id and ranked participants (for announcement), or null
 */
export async function settleTournament(
  env: Env,
  iranDate: string
): Promise<{
  quizId: number;
  ranking: { rank: number; user_id: number; correct: number }[];
  newBadgesByUser: Map<number, string[]>;
} | null> {
  const quiz = await getTournamentByDate(env, iranDate);
  if (!quiz) return null;
  if (quiz.status === "completed") return null; // already settled

  // Include anyone who opened but never pressed "finish".
  await execute(
    env,
    `UPDATE custom_quiz_attempts SET status = 'auto_ended', finished_at = datetime('now')
     WHERE quiz_id = ? AND status = 'in_progress'`,
    [quiz.id]
  );

  // Full ranking (correct desc, speed asc). ~hundreds of rows at most.
  const ranking = await getLeaderboardWithoutNegative(env, quiz.id, 100000);

  // Award XP once per participant (guarded), chunked to stay under batch limits.
  const stmts: D1PreparedStatement[] = [];
  for (const r of ranking) {
    stmts.push(...prepareXpForTournament(env, r.user_id, quiz.id, r.correct));
    const bonus = TOURNAMENT_CONFIG.RANK_BONUS_XP[r.rank - 1];
    if (bonus) {
      stmts.push(...prepareXpForTournamentRank(env, r.user_id, quiz.id, bonus, r.rank));
    }
  }
  for (let i = 0; i < stmts.length; i += XP_BATCH_CHUNK) {
    await batch(env, stmts.slice(i, i + XP_BATCH_CHUNK));
  }

  // Award tournament medals (participation / top3 / win / perfect / 10-count).
  const total = await getQuestionCount(env, quiz.id);
  const partCounts = await getTournamentParticipationCounts(env, quiz.id);
  const entries: TournamentBadgeEntry[] = ranking.map((r) => ({
    userId: r.user_id,
    rank: r.rank,
    correct: r.correct,
    total,
    participationCount: partCounts.get(r.user_id) ?? 1,
  }));
  const newBadgesByUser = await awardTournamentBadges(env, quiz.id, entries);

  await setQuizStatus(env, quiz.id, "completed");

  return {
    quizId: quiz.id,
    ranking: ranking.map((r) => ({ rank: r.rank, user_id: r.user_id, correct: r.correct })),
    newBadgesByUser,
  };
}

/** Lifetime finished-tournament count for each participant of the given tournament. */
async function getTournamentParticipationCounts(env: Env, quizId: number): Promise<Map<number, number>> {
  const rows = await queryAll<{ user_id: number; cnt: number }>(
    env,
    `SELECT a.user_id, COUNT(*) as cnt
     FROM custom_quiz_attempts a
     JOIN custom_quizzes q ON q.id = a.quiz_id AND q.kind = 'tournament'
     WHERE a.status IN ('finished', 'auto_ended')
       AND a.user_id IN (
         SELECT user_id FROM custom_quiz_attempts
         WHERE quiz_id = ? AND status IN ('finished', 'auto_ended')
       )
     GROUP BY a.user_id`,
    [quizId]
  );
  return new Map(rows.map((r) => [r.user_id, r.cnt]));
}

/** Recipients (telegram_id) who opted into the nightly tournament reminder. */
export async function getTournamentReminderOptIns(env: Env): Promise<{ telegram_id: number }[]> {
  return queryAll<{ telegram_id: number }>(
    env,
    `SELECT telegram_id FROM users
     WHERE tournament_reminder = 1 AND is_approved = 1 AND COALESCE(is_banned, 0) = 0`
  );
}

/** Read a user's tournament-reminder opt-in flag. */
export async function getTournamentReminder(env: Env, userId: number): Promise<boolean> {
  const row = await queryOne<{ tournament_reminder: number }>(
    env,
    `SELECT tournament_reminder FROM users WHERE id = ?`,
    [userId]
  );
  return (row?.tournament_reminder ?? 0) === 1;
}

/** Toggle a user's tournament-reminder opt-in flag; returns the new state. */
export async function toggleTournamentReminder(env: Env, userId: number): Promise<boolean> {
  const current = await getTournamentReminder(env, userId);
  const next = current ? 0 : 1;
  await execute(env, `UPDATE users SET tournament_reminder = ? WHERE id = ?`, [next, userId]);
  return next === 1;
}
