import { Env } from "../types";
import { queryOne, execute, prepare } from "./client";
import { getTextQuestionTypePrioritySql } from "./question_priority";

export interface DbTextQuestion {
  id: number;
  text_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  explanation_text: string | null;
  question_type: string | null;
}

/**
 * Aggregate how all users FIRST answered a specific reading-comprehension question.
 * A user may answer the same question across multiple sessions; we take each user's
 * earliest answered attempt (by answered_at) so the stats reflect first attempts.
 */
export async function getTextQuestionAnswerStats(
  env: Env,
  questionId: number
): Promise<{ correct: number; incorrect: number; total: number }> {
  const row = await queryOne<{ correct: number; incorrect: number; total: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) as correct,
      COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) as incorrect,
      COUNT(*) as total
    FROM (
      SELECT is_correct,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY answered_at ASC, id ASC) AS rn
      FROM user_text_question_history
      WHERE question_id = ?
        AND answered_at IS NOT NULL
    )
    WHERE rn = 1
    `,
    [questionId]
  );
  return row ?? { correct: 0, incorrect: 0, total: 0 };
}

export interface ReadingSession {
  id: number;
  user_id: number;
  text_id: number;
  status: string;
  num_correct: number;
  num_questions: number;
  xp_gained: number;
  started_at: string;
  completed_at: string | null;
}

/**
 * Create a new reading session for a user and text.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID starting the reading session
 * @param textId - The text ID to create a session for
 * @param numQuestions - Maximum number of questions in this session (defaults to 3)
 * @returns The newly created ReadingSession record
 */
export async function createReadingSession(env: Env, userId: number, textId: number, numQuestions: number = 3): Promise<ReadingSession> {
  const now = new Date().toISOString();
  await execute(env, `INSERT INTO reading_sessions (user_id, text_id, status, num_correct, num_questions, xp_gained, started_at) VALUES (?, ?, 'in_progress', 0, ?, 0, ?)`, [userId, textId, numQuestions, now]);
  const session = await queryOne<ReadingSession>(env, `SELECT * FROM reading_sessions WHERE user_id = ? AND text_id = ? ORDER BY id DESC LIMIT 1`, [userId, textId]);
  if (!session) throw new Error("Failed to create reading session");
  return session;
}

/**
 * Retrieve a reading session by its ID.
 * @param env - The worker environment containing the D1 database binding
 * @param id - The reading session ID
 * @returns The ReadingSession record, or null if not found
 */
export async function getReadingSessionById(env: Env, id: number): Promise<ReadingSession | null> {
  return await queryOne<ReadingSession>(env, `SELECT * FROM reading_sessions WHERE id = ?`, [id]);
}

/**
 * Pick the next unshown question for a reading session, respecting the question limit.
 * @param env - The worker environment containing the D1 database binding
 * @param session - The active reading session
 * @param userId - The user ID (used for history-aware ordering)
 * @param allowedSources - Optional filter for question sources (manual, ai, seed)
 * @returns The next question to show, or null if the limit is reached or no questions remain
 */
export async function getNextQuestionForSession(
  env: Env,
  session: ReadingSession,
  userId: number,
  allowedSources?: Array<"manual" | "ai" | "seed">
): Promise<DbTextQuestion | null> {
  const countRow = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM user_text_question_history WHERE reading_session_id = ?`, [session.id]);
  const shownCount = countRow?.cnt ?? 0;
  const maxQuestions = session.num_questions || 3;
  if (shownCount >= maxQuestions) return null;

  const sourceFilter = allowedSources && allowedSources.length > 0
    ? ` AND q.source IN (${allowedSources.map(() => "?").join(", ")})`
    : "";
  const sourceParams = allowedSources && allowedSources.length > 0 ? [...allowedSources] : [];

  const typePrioritySql = getTextQuestionTypePrioritySql("COALESCE(q.question_type, 'reading')");

  const question = await queryOne<DbTextQuestion>(
    env,
    `
    SELECT q.id, q.text_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.explanation_text, q.question_type
    FROM text_questions q
    WHERE q.text_id = ?${sourceFilter}
      AND NOT EXISTS (
        SELECT 1 FROM user_text_question_history h
        WHERE h.reading_session_id = ? AND h.question_id = q.id
      )
    ORDER BY
      ${typePrioritySql},
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM user_text_question_history h
          WHERE h.user_id = ? AND h.text_id = ? AND h.question_id = q.id
        ) THEN 0
        ELSE 1
      END,
      RANDOM()
    LIMIT 1
    `,
    [session.text_id, ...sourceParams, session.id, userId, session.text_id]
  );
  return question ?? null;
}

/**
 * Record that a question was shown to the user in a reading session (idempotent).
 * @param env - The worker environment containing the D1 database binding
 * @param session - The active reading session
 * @param userId - The user ID being shown the question
 * @param questionId - The question ID being shown
 * @returns True if the record was inserted, false if already recorded
 */
export async function recordQuestionShown(env: Env, session: ReadingSession, userId: number, questionId: number): Promise<boolean> {
  const now = new Date().toISOString();

  const result = await execute(env, `
    INSERT INTO user_text_question_history (user_id, text_id, question_id, reading_session_id, shown_at)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM user_text_question_history 
      WHERE reading_session_id = ? AND question_id = ?
    )
  `, [userId, session.text_id, questionId, session.id, now, session.id, questionId]);

  return result.meta.changes > 0;
}

/**
 * Get answer statistics (total answered and correct count) for a reading session.
 * @param env - The worker environment containing the D1 database binding
 * @param sessionId - The reading session ID
 * @returns An object with total and correct counts
 */
export async function getSessionStats(env: Env, sessionId: number): Promise<{ total: number; correct: number }> {
  const row = await queryOne<{ total: number; correct: number | null }>(env, `SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM user_text_question_history WHERE reading_session_id = ?`, [sessionId]);
  return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
}

/**
 * Prepare a statement to update the XP gained for a reading session.
 * @param env - The worker environment containing the D1 database binding
 * @param sessionId - The reading session ID to update
 * @param xp - The XP amount to set
 * @returns A D1PreparedStatement ready for batching
 */
export function prepareUpdateSessionXp(env: Env, sessionId: number, xp: number): D1PreparedStatement {
  return prepare(
    env,
    `UPDATE reading_sessions SET xp_gained = ? WHERE id = ?`,
    [xp, sessionId]
  );
}

/**
 * Count newly correct answers in a session (correct for the first time across all sessions).
 * @param env - The worker environment containing the D1 database binding
 * @param sessionId - The reading session ID to check
 * @param userId - The user ID
 * @returns The count of questions answered correctly for the first time
 */
export async function getNewCorrectCount(env: Env, sessionId: number, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt
    FROM user_text_question_history h
    LEFT JOIN user_text_question_history old
      ON old.user_id = h.user_id
      AND old.question_id = h.question_id
      AND old.is_correct = 1
      AND old.reading_session_id != h.reading_session_id
    WHERE h.reading_session_id = ?
      AND h.is_correct = 1
      AND old.id IS NULL
    `,
    [sessionId]
  );
  return row?.cnt ?? 0;
}
