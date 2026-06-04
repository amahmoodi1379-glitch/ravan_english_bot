import { Env } from "../types";
import { queryAll, queryOne, execute, prepare } from "./client";

// ============================================================
// Types
// ============================================================
export interface CustomQuiz {
  id: number;
  admin_id: number;
  title: string;
  total_time_minutes: number;
  status: string;
  created_at: string;
}

export interface CustomQuizQuestion {
  id: number;
  quiz_id: number;
  question_index: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  explanation: string | null;
}

export interface CustomQuizAttempt {
  id: number;
  quiz_id: number;
  user_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  current_question_index: number;
}

export interface CustomQuizAnswer {
  id: number;
  attempt_id: number;
  question_id: number;
  chosen_option: string | null;
  answered_at: string | null;
}

// ============================================================
// Quiz CRUD
// ============================================================

export async function createQuiz(
  env: Env,
  adminId: number,
  title: string,
  totalTimeMinutes: number
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO custom_quizzes (admin_id, title, total_time_minutes, status) VALUES (?, ?, ?, 'draft')`
  ).bind(adminId, title, totalTimeMinutes).run();
  return (result.meta as any)?.last_row_id || 0;
}

export async function updateQuizTitle(
  env: Env,
  quizId: number,
  title: string
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quizzes SET title = ? WHERE id = ?`,
    [title, quizId]
  );
}

export async function updateQuizTime(
  env: Env,
  quizId: number,
  minutes: number
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quizzes SET total_time_minutes = ? WHERE id = ?`,
    [minutes, quizId]
  );
}

export async function setQuizStatus(
  env: Env,
  quizId: number,
  status: string
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quizzes SET status = ? WHERE id = ?`,
    [status, quizId]
  );
}

export async function getQuizById(
  env: Env,
  quizId: number
): Promise<CustomQuiz | null> {
  return queryOne<CustomQuiz>(
    env,
    `SELECT * FROM custom_quizzes WHERE id = ?`,
    [quizId]
  );
}

export async function getDraftQuizzesByAdmin(
  env: Env,
  adminId: number
): Promise<CustomQuiz[]> {
  return queryAll<CustomQuiz>(
    env,
    `SELECT * FROM custom_quizzes WHERE admin_id = ? AND status IN ('draft', 'active') ORDER BY created_at DESC`,
    [adminId]
  );
}

// ============================================================
// Questions
// ============================================================

export async function addQuizQuestion(
  env: Env,
  quizId: number,
  questionIndex: number,
  questionText: string,
  optionA: string,
  optionB: string,
  optionC: string,
  optionD: string,
  correctOption: string,
  explanation?: string
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO custom_quiz_questions (quiz_id, question_index, question_text, option_a, option_b, option_c, option_d, correct_option, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(quizId, questionIndex, questionText, optionA, optionB, optionC, optionD, correctOption, explanation || null).run();
  return (result.meta as any)?.last_row_id || 0;
}

export async function updateQuizQuestion(
  env: Env,
  questionId: number,
  questionText: string,
  optionA: string,
  optionB: string,
  optionC: string,
  optionD: string,
  correctOption: string,
  explanation?: string
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quiz_questions
     SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_option = ?, explanation = ?
     WHERE id = ?`,
    [questionText, optionA, optionB, optionC, optionD, correctOption, explanation || null, questionId]
  );
}

export async function getQuizQuestions(
  env: Env,
  quizId: number
): Promise<CustomQuizQuestion[]> {
  return queryAll<CustomQuizQuestion>(
    env,
    `SELECT * FROM custom_quiz_questions WHERE quiz_id = ? ORDER BY question_index ASC`,
    [quizId]
  );
}

export async function getQuizQuestionByIndex(
  env: Env,
  quizId: number,
  questionIndex: number
): Promise<CustomQuizQuestion | null> {
  return queryOne<CustomQuizQuestion>(
    env,
    `SELECT * FROM custom_quiz_questions WHERE quiz_id = ? AND question_index = ?`,
    [quizId, questionIndex]
  );
}

export async function getQuizQuestionById(
  env: Env,
  questionId: number
): Promise<CustomQuizQuestion | null> {
  return queryOne<CustomQuizQuestion>(
    env,
    `SELECT * FROM custom_quiz_questions WHERE id = ?`,
    [questionId]
  );
}

export async function deleteQuizQuestion(env: Env, questionId: number): Promise<void> {
  await execute(env, `DELETE FROM custom_quiz_questions WHERE id = ?`, [questionId]);
}

export async function getQuestionCount(env: Env, quizId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) as cnt FROM custom_quiz_questions WHERE quiz_id = ?`, [quizId]);
  return row?.cnt || 0;
}

// ============================================================
// Links
// ============================================================

export async function createQuizLink(
  env: Env,
  quizId: number,
  linkToken: string,
  expiresAt: string
): Promise<void> {
  await execute(
    env,
    `INSERT INTO custom_quiz_links (quiz_id, link_token, expires_at) VALUES (?, ?, ?)`,
    [quizId, linkToken, expiresAt]
  );
}

export async function getQuizLinkByToken(
  env: Env,
  token: string
): Promise<{ quiz_id: number; expires_at: string | null } | null> {
  return queryOne(
    env,
    `SELECT quiz_id, expires_at FROM custom_quiz_links WHERE link_token = ?`,
    [token]
  );
}

// ============================================================
// Attempts & Answers
// ============================================================

export async function createAttempt(
  env: Env,
  quizId: number,
  userId: number
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO custom_quiz_attempts (quiz_id, user_id, status) VALUES (?, ?, 'in_progress')`
  ).bind(quizId, userId).run();
  return (result.meta as any)?.last_row_id || 0;
}

export async function getAttempt(
  env: Env,
  attemptId: number
): Promise<CustomQuizAttempt | null> {
  return queryOne<CustomQuizAttempt>(
    env,
    `SELECT * FROM custom_quiz_attempts WHERE id = ?`,
    [attemptId]
  );
}

export async function getAttemptByQuizAndUser(
  env: Env,
  quizId: number,
  userId: number
): Promise<CustomQuizAttempt | null> {
  return queryOne<CustomQuizAttempt>(
    env,
    `SELECT * FROM custom_quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 1`,
    [quizId, userId]
  );
}

export async function finishAttempt(
  env: Env,
  attemptId: number,
  status: 'finished' | 'auto_ended'
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quiz_attempts SET finished_at = datetime('now'), status = ? WHERE id = ?`,
    [status, attemptId]
  );
}

export async function updateCurrentQuestionIndex(
  env: Env,
  attemptId: number,
  index: number
): Promise<void> {
  await execute(
    env,
    `UPDATE custom_quiz_attempts SET current_question_index = ? WHERE id = ?`,
    [index, attemptId]
  );
}

export async function saveAnswer(
  env: Env,
  attemptId: number,
  questionId: number,
  chosenOption: string | null
): Promise<void> {
  const existing = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM custom_quiz_answers WHERE attempt_id = ? AND question_id = ?`,
    [attemptId, questionId]
  );
  if (existing) {
    await execute(
      env,
      `UPDATE custom_quiz_answers SET chosen_option = ?, answered_at = datetime('now') WHERE id = ?`,
      [chosenOption, existing.id]
    );
  } else {
    await execute(
      env,
      `INSERT INTO custom_quiz_answers (attempt_id, question_id, chosen_option, answered_at) VALUES (?, ?, ?, datetime('now'))`,
      [attemptId, questionId, chosenOption]
    );
  }
}

export async function getAnswersForAttempt(
  env: Env,
  attemptId: number
): Promise<CustomQuizAnswer[]> {
  return queryAll<CustomQuizAnswer>(
    env,
    `SELECT * FROM custom_quiz_answers WHERE attempt_id = ?`,
    [attemptId]
  );
}

export async function getAnswerForQuestion(
  env: Env,
  attemptId: number,
  questionId: number
): Promise<CustomQuizAnswer | null> {
  return queryOne<CustomQuizAnswer>(
    env,
    `SELECT * FROM custom_quiz_answers WHERE attempt_id = ? AND question_id = ?`,
    [attemptId, questionId]
  );
}

// ============================================================
// Scoring & Leaderboard
// ============================================================

export async function getLeaderboardWithNegative(
  env: Env,
  quizId: number,
  limit = 50
): Promise<{ rank: number; user_id: number; display_name: string; avatar_code: string | null; percentage: number; correct: number; wrong: number; unanswered: number; total_seconds: number }[]> {
  const rows = await queryAll<any>(
    env,
    `
    SELECT
      a.id as attempt_id,
      a.user_id,
      COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
      u.avatar_code,
      COUNT(CASE WHEN ans.chosen_option = q.correct_option THEN 1 END) as correct,
      COUNT(CASE WHEN ans.chosen_option IS NOT NULL AND ans.chosen_option != q.correct_option THEN 1 END) as wrong,
      COUNT(CASE WHEN ans.chosen_option IS NULL THEN 1 END) as unanswered,
      COUNT(q.id) as total_q,
      (julianday(a.finished_at) - julianday(a.started_at)) * 86400 as total_seconds
    FROM custom_quiz_attempts a
    JOIN users u ON u.id = a.user_id
    JOIN custom_quiz_questions q ON q.quiz_id = a.quiz_id
    LEFT JOIN custom_quiz_answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
    WHERE a.quiz_id = ? AND a.status IN ('finished', 'auto_ended')
    GROUP BY a.id
    ORDER BY (correct - (wrong * 1.0 / 3)) DESC, total_seconds ASC
    LIMIT ?
    `,
    [quizId, limit]
  );

  return rows.map((r, i) => {
    const correct = r.correct || 0;
    const wrong = r.wrong || 0;
    const unanswered = r.unanswered || 0;
    const total = r.total_q || 1;
    const score = correct - (wrong / 3);
    const percentage = Math.max(0, (score / total) * 100);
    return {
      rank: i + 1,
      user_id: r.user_id,
      display_name: r.display_name,
      avatar_code: r.avatar_code,
      percentage: Math.round(percentage * 100) / 100,
      correct,
      wrong,
      unanswered,
      total_seconds: Math.round(r.total_seconds || 0),
    };
  });
}

export async function getLeaderboardWithoutNegative(
  env: Env,
  quizId: number,
  limit = 50
): Promise<{ rank: number; user_id: number; display_name: string; avatar_code: string | null; percentage: number; correct: number; total_seconds: number }[]> {
  const rows = await queryAll<any>(
    env,
    `
    SELECT
      a.id as attempt_id,
      a.user_id,
      COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
      u.avatar_code,
      COUNT(CASE WHEN ans.chosen_option = q.correct_option THEN 1 END) as correct,
      COUNT(q.id) as total_q,
      (julianday(a.finished_at) - julianday(a.started_at)) * 86400 as total_seconds
    FROM custom_quiz_attempts a
    JOIN users u ON u.id = a.user_id
    JOIN custom_quiz_questions q ON q.quiz_id = a.quiz_id
    LEFT JOIN custom_quiz_answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
    WHERE a.quiz_id = ? AND a.status IN ('finished', 'auto_ended')
    GROUP BY a.id
    ORDER BY correct DESC, total_seconds ASC
    LIMIT ?
    `,
    [quizId, limit]
  );

  return rows.map((r, i) => {
    const correct = r.correct || 0;
    const total = r.total_q || 1;
    const percentage = (correct / total) * 100;
    return {
      rank: i + 1,
      user_id: r.user_id,
      display_name: r.display_name,
      avatar_code: r.avatar_code,
      percentage: Math.round(percentage * 100) / 100,
      correct,
      total_seconds: Math.round(r.total_seconds || 0),
    };
  });
}

export async function getUserRankWithNegative(
  env: Env,
  quizId: number,
  userId: number
): Promise<{ rank: number; percentage: number; correct: number; wrong: number; unanswered: number } | null> {
  const userAttempt = await queryOne<CustomQuizAttempt>(
    env,
    `SELECT * FROM custom_quiz_attempts WHERE quiz_id = ? AND user_id = ? AND status IN ('finished', 'auto_ended') ORDER BY started_at DESC LIMIT 1`,
    [quizId, userId]
  );
  if (!userAttempt) return null;

  const stats = await queryOne<any>(
    env,
    `
    SELECT
      COUNT(CASE WHEN ans.chosen_option = q.correct_option THEN 1 END) as correct,
      COUNT(CASE WHEN ans.chosen_option IS NOT NULL AND ans.chosen_option != q.correct_option THEN 1 END) as wrong,
      COUNT(CASE WHEN ans.chosen_option IS NULL THEN 1 END) as unanswered,
      COUNT(q.id) as total_q
    FROM custom_quiz_attempts a
    JOIN custom_quiz_questions q ON q.quiz_id = a.quiz_id
    LEFT JOIN custom_quiz_answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
    WHERE a.id = ?
    `,
    [userAttempt.id]
  );
  if (!stats) return null;

  const correct = stats.correct || 0;
  const wrong = stats.wrong || 0;
  const unanswered = stats.unanswered || 0;
  const total = stats.total_q || 1;
  const score = correct - (wrong / 3);
  const percentage = Math.max(0, (score / total) * 100);

  const rankResult = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt FROM (
      SELECT a2.id,
        COUNT(CASE WHEN ans2.chosen_option = q2.correct_option THEN 1 END) - COUNT(CASE WHEN ans2.chosen_option IS NOT NULL AND ans2.chosen_option != q2.correct_option THEN 1 END) * 1.0 / 3 as score2,
        (julianday(a2.finished_at) - julianday(a2.started_at)) * 86400 as sec2
      FROM custom_quiz_attempts a2
      JOIN custom_quiz_questions q2 ON q2.quiz_id = a2.quiz_id
      LEFT JOIN custom_quiz_answers ans2 ON ans2.attempt_id = a2.id AND ans2.question_id = q2.id
      WHERE a2.quiz_id = ? AND a2.status IN ('finished', 'auto_ended')
      GROUP BY a2.id
      HAVING score2 > ? OR (score2 = ? AND sec2 < ?)
    )
    `,
    [quizId, score, score, Math.round((userAttempt.finished_at ? new Date(userAttempt.finished_at).getTime() : Date.now()) - new Date(userAttempt.started_at).getTime()) / 1000]
  );

  return {
    rank: (rankResult?.cnt || 0) + 1,
    percentage: Math.round(percentage * 100) / 100,
    correct,
    wrong,
    unanswered,
  };
}

export async function getUserRankWithoutNegative(
  env: Env,
  quizId: number,
  userId: number
): Promise<{ rank: number; percentage: number; correct: number } | null> {
  const userAttempt = await queryOne<CustomQuizAttempt>(
    env,
    `SELECT * FROM custom_quiz_attempts WHERE quiz_id = ? AND user_id = ? AND status IN ('finished', 'auto_ended') ORDER BY started_at DESC LIMIT 1`,
    [quizId, userId]
  );
  if (!userAttempt) return null;

  const stats = await queryOne<any>(
    env,
    `
    SELECT
      COUNT(CASE WHEN ans.chosen_option = q.correct_option THEN 1 END) as correct,
      COUNT(q.id) as total_q,
      (julianday(a.finished_at) - julianday(a.started_at)) * 86400 as total_seconds
    FROM custom_quiz_attempts a
    JOIN custom_quiz_questions q ON q.quiz_id = a.quiz_id
    LEFT JOIN custom_quiz_answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
    WHERE a.id = ?
    `,
    [userAttempt.id]
  );
  if (!stats) return null;

  const correct = stats.correct || 0;
  const total = stats.total_q || 1;
  const percentage = (correct / total) * 100;
  const totalSeconds = Math.round(stats.total_seconds || 0);

  const rankResult = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt FROM (
      SELECT a2.id,
        COUNT(CASE WHEN ans2.chosen_option = q2.correct_option THEN 1 END) as correct2,
        (julianday(a2.finished_at) - julianday(a2.started_at)) * 86400 as sec2
      FROM custom_quiz_attempts a2
      JOIN custom_quiz_questions q2 ON q2.quiz_id = a2.quiz_id
      LEFT JOIN custom_quiz_answers ans2 ON ans2.attempt_id = a2.id AND ans2.question_id = q2.id
      WHERE a2.quiz_id = ? AND a2.status IN ('finished', 'auto_ended')
      GROUP BY a2.id
      HAVING correct2 > ? OR (correct2 = ? AND sec2 < ?)
    )
    `,
    [quizId, correct, correct, totalSeconds]
  );

  return {
    rank: (rankResult?.cnt || 0) + 1,
    percentage: Math.round(percentage * 100) / 100,
    correct,
  };
}
