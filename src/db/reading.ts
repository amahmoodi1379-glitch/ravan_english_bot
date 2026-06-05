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

export async function createReadingSession(env: Env, userId: number, textId: number, numQuestions: number = 3): Promise<ReadingSession> {
  const now = new Date().toISOString();
  await execute(env, `INSERT INTO reading_sessions (user_id, text_id, status, num_correct, num_questions, xp_gained, started_at) VALUES (?, ?, 'in_progress', 0, ?, 0, ?)`, [userId, textId, numQuestions, now]);
  const session = await queryOne<ReadingSession>(env, `SELECT * FROM reading_sessions WHERE user_id = ? AND text_id = ? ORDER BY id DESC LIMIT 1`, [userId, textId]);
  if (!session) throw new Error("Failed to create reading session");
  return session;
}

export async function getReadingSessionById(env: Env, id: number): Promise<ReadingSession | null> {
  return await queryOne<ReadingSession>(env, `SELECT * FROM reading_sessions WHERE id = ?`, [id]);
}

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

  const q = await queryOne<DbTextQuestion>(
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
  return q ?? null;
}

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

export async function getSessionStats(env: Env, sessionId: number): Promise<{ total: number; correct: number }> {
  const row = await queryOne<{ total: number; correct: number | null }>(env, `SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM user_text_question_history WHERE reading_session_id = ?`, [sessionId]);
  return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
}

export function prepareUpdateSessionXp(env: Env, sessionId: number, xp: number): any {
  return prepare(
    env,
    `UPDATE reading_sessions SET xp_gained = ? WHERE id = ?`,
    [xp, sessionId]
  );
}

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
