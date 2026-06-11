import { Env } from "../types";
import { queryAll, queryOne, execute } from "./client";

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
  chat_id: number | null;
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

/**
 * Create a new custom quiz in draft status.
 * @param env - The worker environment containing the D1 database binding
 * @param adminId - The admin user ID creating the quiz
 * @param title - The quiz title
 * @param totalTimeMinutes - Time limit for the quiz in minutes
 * @returns The newly created quiz's row ID
 */
export async function createQuiz(
  env: Env,
  adminId: number,
  title: string,
  totalTimeMinutes: number
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO custom_quizzes (admin_id, title, total_time_minutes, status) VALUES (?, ?, ?, 'draft')`
  ).bind(adminId, title, totalTimeMinutes).run();
  // D1 meta.last_row_id is not in official types but is returned at runtime
  return (result.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
}

/**
 * Update the title of an existing quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to update
 * @param title - The new title string
 * @returns void
 */
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

/**
 * Update the time limit of an existing quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to update
 * @param minutes - The new time limit in minutes
 * @returns void
 */
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

/**
 * Set the status of a quiz (e.g., draft, active, published).
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to update
 * @param status - The new status string
 * @returns void
 */
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

/**
 * Retrieve a quiz by its ID.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to look up
 * @returns The CustomQuiz record, or null if not found
 */
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

/**
 * List all active quizzes belonging to a specific admin.
 * @param env - The worker environment containing the D1 database binding
 * @param adminId - The admin user ID
 * @returns An array of active CustomQuiz records
 */
export async function getActiveQuizzesByAdmin(
  env: Env,
  adminId: number
): Promise<CustomQuiz[]> {
  return queryAll<CustomQuiz>(
    env,
    `SELECT * FROM custom_quizzes WHERE admin_id = ? AND status = 'active' ORDER BY created_at DESC`,
    [adminId]
  );
}

/**
 * List all published quizzes belonging to a specific admin.
 * @param env - The worker environment containing the D1 database binding
 * @param adminId - The admin user ID
 * @returns An array of published CustomQuiz records
 */
export async function getPublishedQuizzesByAdmin(
  env: Env,
  adminId: number
): Promise<CustomQuiz[]> {
  return queryAll<CustomQuiz>(
    env,
    `SELECT * FROM custom_quizzes WHERE admin_id = ? AND status = 'published' ORDER BY created_at DESC`,
    [adminId]
  );
}

/**
 * Permanently delete a quiz and its associated data.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to delete
 * @returns void
 */
export async function deleteQuiz(
  env: Env,
  quizId: number
): Promise<void> {
  await execute(env, `DELETE FROM custom_quizzes WHERE id = ?`, [quizId]);
}

/**
 * Count the number of distinct participants who have completed a quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to count participants for
 * @returns The distinct participant count
 */
export async function getParticipantCount(
  env: Env,
  quizId: number
): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(DISTINCT user_id) as cnt FROM custom_quiz_attempts WHERE quiz_id = ? AND status IN ('finished', 'auto_ended')`,
    [quizId]
  );
  return row?.cnt || 0;
}

/**
 * Add a multiple-choice question to a quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to add the question to
 * @param questionIndex - The display order index of the question
 * @param questionText - The question text
 * @param optionA - Answer option A
 * @param optionB - Answer option B
 * @param optionC - Answer option C
 * @param optionD - Answer option D
 * @param correctOption - The correct option letter ("A", "B", "C", or "D")
 * @param explanation - Optional explanation text for the correct answer
 * @returns The newly created question's row ID
 */
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
  // D1 meta.last_row_id is not in official types but is returned at runtime
  return (result.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
}

/**
 * Update an existing quiz question's text, options, and correct answer.
 * @param env - The worker environment containing the D1 database binding
 * @param questionId - The question ID to update
 * @param questionText - The new question text
 * @param optionA - Updated answer option A
 * @param optionB - Updated answer option B
 * @param optionC - Updated answer option C
 * @param optionD - Updated answer option D
 * @param correctOption - The updated correct option letter
 * @param explanation - Optional updated explanation text
 * @returns void
 */
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

/**
 * Get all questions for a quiz ordered by their index.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to retrieve questions for
 * @returns An array of CustomQuizQuestion records
 */
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

/**
 * Retrieve a single quiz question by ID.
 * @param env - The worker environment containing the D1 database binding
 * @param questionId - The question ID to look up
 * @returns The CustomQuizQuestion record, or null if not found
 */
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

/**
 * Get the total number of questions in a quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to count questions for
 * @returns The question count
 */
export async function getQuestionCount(env: Env, quizId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) as cnt FROM custom_quiz_questions WHERE quiz_id = ?`, [quizId]);
  return row?.cnt || 0;
}

/**
 * Create a shareable link for a quiz with an expiration date.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to generate a link for
 * @param linkToken - The unique token for the link
 * @param expiresAt - The ISO timestamp when the link expires
 * @returns void
 */
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

/**
 * Look up a quiz link by its token string.
 * @param env - The worker environment containing the D1 database binding
 * @param token - The link token to search for
 * @returns The quiz_id and expiration, or null if not found
 */
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

/**
 * Get the most recently created link for a quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to find the link for
 * @returns The link token and expiration, or null if no link exists
 */
export async function getLatestQuizLink(
  env: Env,
  quizId: number
): Promise<{ link_token: string; expires_at: string | null } | null> {
  return queryOne(
    env,
    `SELECT link_token, expires_at FROM custom_quiz_links WHERE quiz_id = ? ORDER BY created_at DESC LIMIT 1`,
    [quizId]
  );
}

/**
 * Create a new quiz attempt for a user.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID being attempted
 * @param userId - The user ID starting the attempt
 * @param chatId - Optional Telegram chat ID for sending results
 * @returns The newly created attempt's row ID
 */
export async function createAttempt(
  env: Env,
  quizId: number,
  userId: number,
  chatId?: number
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO custom_quiz_attempts (quiz_id, user_id, chat_id, status) VALUES (?, ?, ?, 'in_progress')`
  ).bind(quizId, userId, chatId ?? null).run();
  // D1 meta.last_row_id is not in official types but is returned at runtime
  return (result.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
}

/**
 * Retrieve a quiz attempt by its ID.
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID to look up
 * @returns The CustomQuizAttempt record, or null if not found
 */
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

/**
 * Find the most recent attempt by a user on a specific quiz.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID
 * @param userId - The user ID
 * @returns The most recent CustomQuizAttempt, or null if none exists
 */
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

/**
 * Mark a quiz attempt as finished (completed or auto-ended).
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID to finish
 * @param status - The finish status: "finished" or "auto_ended"
 * @returns void
 */
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

/**
 * Update the current question index pointer for an in-progress attempt.
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID to update
 * @param index - The new question index value
 * @returns void
 */
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

/**
 * Count how many attempts are currently in-progress and within the time limit.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to check
 * @returns The number of active in-progress attempts
 */
export async function getInProgressAttemptsCount(
  env: Env,
  quizId: number
): Promise<number> {
  const result = await queryOne(
    env,
    `SELECT COUNT(*) as count
     FROM custom_quiz_attempts a
     JOIN custom_quizzes q ON q.id = a.quiz_id
     WHERE a.quiz_id = ?
       AND a.status = 'in_progress'
       AND datetime(a.started_at, '+' || q.total_time_minutes || ' minutes') > datetime('now')`,
    [quizId]
  ) as { count: number } | null;
  return result?.count || 0;
}

/**
 * Get all finished attempts that have a chat_id (for sending results back to users).
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to look up
 * @returns An array of attempt records with id, user_id, and chat_id
 */
export async function getFinishedAttemptsWithChatId(
  env: Env,
  quizId: number
): Promise<{ id: number; user_id: number; chat_id: number }[]> {
  return queryAll<{ id: number; user_id: number; chat_id: number }>(
    env,
    `SELECT id, user_id, chat_id FROM custom_quiz_attempts
     WHERE quiz_id = ? AND status IN ('finished', 'auto_ended') AND chat_id IS NOT NULL`,
    [quizId]
  );
}

/**
 * Save or update the user's answer for a specific question in an attempt.
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID the answer belongs to
 * @param questionId - The question ID being answered
 * @param chosenOption - The chosen option letter, or null if unanswered
 * @returns void
 */
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

/**
 * Retrieve the user's saved answer for a specific question in an attempt.
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID
 * @param questionId - The question ID
 * @returns The CustomQuizAnswer record, or null if not answered
 */
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

/**
 * Count how many questions have been answered in a given attempt.
 * @param env - The worker environment containing the D1 database binding
 * @param attemptId - The attempt ID to count answers for
 * @returns The number of answered questions
 */
export async function getAnsweredCount(
  env: Env,
  attemptId: number
): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(*) as cnt FROM custom_quiz_answers WHERE attempt_id = ? AND chosen_option IS NOT NULL`,
    [attemptId]
  );
  return row?.cnt ?? 0;
}

interface LeaderboardNegativeRow {
  attempt_id: number;
  user_id: number;
  display_name: string;
  avatar_code: string | null;
  correct: number;
  wrong: number;
  unanswered: number;
  total_q: number;
  total_seconds: number;
}

/**
 * Compute a ranked leaderboard for a quiz using negative marking (wrong answers penalized).
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to compute leaderboard for
 * @param limit - Maximum number of entries to return (default 50)
 * @returns An array of ranked leaderboard entries with scores and timing
 */
export async function getLeaderboardWithNegative(
  env: Env,
  quizId: number,
  limit = 50
): Promise<{ rank: number; user_id: number; display_name: string; avatar_code: string | null; percentage: number; correct: number; wrong: number; unanswered: number; total_seconds: number }[]> {
  const rows = await queryAll<LeaderboardNegativeRow>(
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

interface LeaderboardPositiveRow {
  attempt_id: number;
  user_id: number;
  display_name: string;
  avatar_code: string | null;
  correct: number;
  total_q: number;
  total_seconds: number;
}

/**
 * Compute a ranked leaderboard for a quiz without negative marking (correct answers only).
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID to compute leaderboard for
 * @param limit - Maximum number of entries to return (default 50)
 * @returns An array of ranked leaderboard entries with correct counts and timing
 */
export async function getLeaderboardWithoutNegative(
  env: Env,
  quizId: number,
  limit = 50
): Promise<{ rank: number; user_id: number; display_name: string; avatar_code: string | null; percentage: number; correct: number; total_seconds: number }[]> {
  const rows = await queryAll<LeaderboardPositiveRow>(
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

/**
 * Get a specific user's rank and detailed results using negative marking scoring.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID
 * @param userId - The user ID to look up
 * @returns The user's rank, percentage, correct/wrong/unanswered counts, or null if no attempt
 */
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

  const stats = await queryOne<{ correct: number; wrong: number; unanswered: number; total_q: number }>(
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

/**
 * Get a specific user's rank and results without negative marking.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The quiz ID
 * @param userId - The user ID to look up
 * @returns The user's rank, percentage, and correct count, or null if no attempt
 */
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

  const stats = await queryOne<{ correct: number; total_q: number; total_seconds: number }>(
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
