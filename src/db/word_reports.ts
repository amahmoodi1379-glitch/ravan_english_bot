import { Env } from "../types";
import { queryOne, queryAll } from "./client";

export type ReportResult = "created" | "duplicate" | "not_found";

/**
 * Record a user's report against a Leitner word-test question.
 *
 * Idempotent per (question, user): the UNIQUE(question_id, user_id) constraint
 * means a user can only count once toward a question's report counter. Uses
 * INSERT OR IGNORE so a duplicate is a quiet no-op (returns "duplicate").
 *
 * @param env - The worker environment containing the D1 database binding
 * @param questionId - The word_questions.id being reported
 * @param userId - The internal users.id of the reporter
 * @returns "created" on a new report, "duplicate" if the user already reported it,
 *          "not_found" if the question no longer exists
 */
export async function recordWordQuestionReport(
  env: Env,
  questionId: number,
  userId: number
): Promise<ReportResult> {
  const question = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM word_questions WHERE id = ?`,
    [questionId]
  );
  if (!question) return "not_found";

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO word_question_reports (question_id, user_id) VALUES (?, ?)`
  ).bind(questionId, userId).run();

  return res.meta.changes > 0 ? "created" : "duplicate";
}

/** A reported-question row for the admin list. */
export interface ReportedQuestionRow {
  question_id: number;
  question_text: string;
  correct_option: string;
  question_style: string;
  source: string;
  word_id: number;
  english: string;
  persian: string;
  report_count: number;
  last_reported: string;
}

/**
 * Count distinct word-test questions that currently have at least one report.
 * Joins to word_questions so orphaned reports (if any) are never counted.
 * @param env - The worker environment containing the D1 database binding
 * @returns The number of reported questions
 */
export async function countReportedQuestions(env: Env): Promise<number> {
  const row = await queryOne<{ total: number }>(
    env,
    `SELECT COUNT(*) AS total FROM (
       SELECT r.question_id
       FROM word_question_reports r
       JOIN word_questions wq ON wq.id = r.question_id
       GROUP BY r.question_id
     )`,
    []
  );
  return row?.total || 0;
}

/**
 * Fetch a page of reported word-test questions, most-reported first, then most
 * recently reported. Only questions that still exist are returned.
 * @param env - The worker environment containing the D1 database binding
 * @param limit - Page size
 * @param offset - Row offset
 * @returns The reported questions for the page
 */
export async function getPaginatedReportedQuestions(
  env: Env,
  limit: number,
  offset: number
): Promise<ReportedQuestionRow[]> {
  return await queryAll<ReportedQuestionRow>(
    env,
    `SELECT
       wq.id AS question_id,
       wq.question_text,
       wq.correct_option,
       wq.question_style,
       wq.source,
       w.id AS word_id,
       w.english,
       w.persian,
       COUNT(r.id) AS report_count,
       MAX(r.created_at) AS last_reported
     FROM word_question_reports r
     JOIN word_questions wq ON wq.id = r.question_id
     JOIN words w ON w.id = wq.word_id
     GROUP BY wq.id, wq.question_text, wq.correct_option, wq.question_style, wq.source, w.id, w.english, w.persian
     ORDER BY report_count DESC, last_reported DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

/**
 * Reset a question's report counter to zero by deleting all its report rows.
 * Used by an admin after fixing the question.
 * @param env - The worker environment containing the D1 database binding
 * @param questionId - The word_questions.id whose reports to clear
 * @returns The number of report rows removed
 */
export async function resetWordQuestionReports(env: Env, questionId: number): Promise<number> {
  const res = await env.DB.prepare(
    `DELETE FROM word_question_reports WHERE question_id = ?`
  ).bind(questionId).run();
  return res.meta.changes || 0;
}
