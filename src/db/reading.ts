// ... (بخش‌های بالایی فایل تغییری نمی‌کند، فقط توابع پایین را اضافه/اصلاح کنید) ...
import { Env } from "../types";
import { queryOne, execute, queryAll, prepare } from "./client"; // Import prepare

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

export interface NewTextQuestionRow {
  questionText: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

// ... (توابع createReadingSession, getReadingSessionById, getNextQuestionForSession مثل قبل بمانند) ...
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

export async function getNextQuestionForSession(env: Env, session: ReadingSession, userId: number): Promise<DbTextQuestion | null> {
  const countRow = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM user_text_question_history WHERE reading_session_id = ?`, [session.id]);
  const shownCount = countRow?.cnt ?? 0;
  const maxQuestions = session.num_questions || 3;
  if (shownCount >= maxQuestions) return null;

  let q = await queryOne<DbTextQuestion>(env, `SELECT q.id, q.text_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.explanation_text FROM text_questions q WHERE q.text_id = ? AND NOT EXISTS ( SELECT 1 FROM user_text_question_history h WHERE h.user_id = ? AND h.text_id = ? AND h.question_id = q.id ) AND NOT EXISTS ( SELECT 1 FROM user_text_question_history h2 WHERE h2.reading_session_id = ? AND h2.question_id = q.id ) ORDER BY q.id LIMIT 1`, [session.text_id, userId, session.text_id, session.id]);
  if (q) return q;

  q = await queryOne<DbTextQuestion>(env, `SELECT q.id, q.text_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.explanation_text FROM text_questions q WHERE q.text_id = ? AND NOT EXISTS ( SELECT 1 FROM user_text_question_history h WHERE h.reading_session_id = ? AND h.question_id = q.id ) ORDER BY q.id LIMIT 1`, [session.text_id, session.id]);
  return q ?? null;
}

export async function recordQuestionShown(env: Env, session: ReadingSession, userId: number, questionId: number): Promise<void> {
  const now = new Date().toISOString();
  await execute(env, `INSERT INTO user_text_question_history (user_id, text_id, question_id, reading_session_id, shown_at) VALUES (?, ?, ?, ?, ?)`, [userId, session.text_id, questionId, session.id, now]);
}

// NEW: نسخه Prepare
export function prepareRecordAnswer(
  env: Env,
  session: ReadingSession,
  userId: number,
  questionId: number,
  isCorrect: boolean
): any[] {
  const now = new Date().toISOString();
  const stmts: any[] = [];

  stmts.push(prepare(
    env,
    `
    UPDATE user_text_question_history
    SET is_correct = ?, answered_at = ?
    WHERE reading_session_id = ?
      AND user_id = ?
      AND question_id = ?
    `,
    [isCorrect ? 1 : 0, now, session.id, userId, questionId]
  ));

  if (isCorrect) {
    stmts.push(prepare(
      env,
      `
      UPDATE reading_sessions
      SET num_correct = num_correct + 1
      WHERE id = ?
      `,
      [session.id]
    ));
  }

  return stmts;
}

// نسخه قدیمی (سازگاری)
export async function recordAnswerAndUpdateSession(env: Env, session: ReadingSession, userId: number, questionId: number, isCorrect: boolean): Promise<void> {
  const stmts = prepareRecordAnswer(env, session, userId, questionId, isCorrect);
  await env.DB.batch(stmts);
}

export async function getSessionStats(env: Env, sessionId: number): Promise<{ total: number; correct: number }> {
  const row = await queryOne<{ total: number; correct: number | null }>(env, `SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM user_text_question_history WHERE reading_session_id = ?`, [sessionId]);
  return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
}

export async function markSessionCompleted(env: Env, sessionId: number): Promise<void> {
  const now = new Date().toISOString();
  await execute(env, `UPDATE reading_sessions SET status = 'completed', completed_at = ? WHERE id = ?`, [now, sessionId]);
}

// NEW: Prepare برای آپدیت XP سشن
export function prepareUpdateSessionXp(env: Env, sessionId: number, xp: number): any {
  return prepare(
    env,
    `UPDATE reading_sessions SET xp_gained = ? WHERE id = ?`,
    [xp, sessionId]
  );
}

export async function insertTextQuestions(env: Env, textId: number, questions: NewTextQuestionRow[]): Promise<void> {
  const stmts: any[] = [];
  for (const q of questions) {
    const opts = q.options.slice(0, 4);
    while (opts.length < 4) opts.push("");
    const [a, b, c, d] = opts;
    const correctIndex = (q.correctIndex >= 0 && q.correctIndex <= 3) ? q.correctIndex : 0;
    const correctLetter = ["A", "B", "C", "D"][correctIndex];

    stmts.push(prepare(
      env,
      `INSERT INTO text_questions (text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai')`,
      [textId, q.questionText, a, b, c, d, correctLetter, q.explanation || null]
    ));
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
}
