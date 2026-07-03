import { Env } from "../types";
import { queryAll, queryOne, prepare, batch } from "./client";

/** Allowed reading-comprehension question types stored in text_questions.question_type. */
const ALLOWED_TEXT_QUESTION_TYPES = [
  "main_idea",
  "detail",
  "inference",
  "vocabulary_in_context",
  "title",
  "reading"
];

/** Shape for a reading-comprehension question parsed from the admin JSON import. */
export interface NewTextQuestionRow {
  questionText: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  questionType: string;
  source?: "manual" | "ai" | "seed";
}

export interface DbReadingText {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

/**
 * Get the total count of active reading texts.
 * @param env - The worker environment containing the D1 database binding
 * @returns The number of active reading texts
 */
export async function getReadingTextsCount(env: Env): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(*) as cnt FROM reading_texts WHERE is_active = 1`
  );
  return row?.cnt ?? 0;
}

/**
 * Retrieve a paginated list of active reading texts.
 * @param env - The worker environment containing the D1 database binding
 * @param limit - Maximum number of texts to return
 * @param offset - Number of texts to skip before returning results
 * @returns An array of DbReadingText records
 */
export async function getPaginatedReadingTexts(env: Env, limit: number, offset: number): Promise<DbReadingText[]> {
  return await queryAll<DbReadingText>(
    env,
    `
    SELECT id, title, body_en, level, is_active
    FROM reading_texts
    WHERE is_active = 1
    ORDER BY id ASC
    LIMIT ? OFFSET ?
    `,
    [limit, offset]
  );
}

/**
 * Find an active reading text by its exact title.
 * @param env - The worker environment containing the D1 database binding
 * @param title - The title to search for
 * @returns The matching DbReadingText, or null if not found
 */
export async function getReadingTextByTitle(env: Env, title: string): Promise<DbReadingText | null> {
  const row = await queryOne<DbReadingText>(
    env,
    `SELECT * FROM reading_texts WHERE title = ? AND is_active = 1 LIMIT 1`,
    [title]
  );
  return row ?? null;
}

/**
 * Insert multiple-choice reading-comprehension questions for a text.
 *
 * Options are stored in the order provided (A, B, C, D) and `correctIndex`
 * is mapped directly to the corresponding letter, so the answer key produced
 * by the AI is preserved exactly as the admin reviewed it (no shuffling).
 * @param env - The worker environment containing the D1 database binding
 * @param textId - The reading text ID to associate the questions with
 * @param questions - An array of question data rows to insert
 * @returns The number of questions inserted
 */
export async function insertTextQuestions(
  env: Env,
  textId: number,
  questions: NewTextQuestionRow[]
): Promise<number> {
  const statements: D1PreparedStatement[] = [];
  for (const q of questions) {
    const opts = q.options.slice(0, 4);
    while (opts.length < 4) {
      opts.push("");
    }

    const idx = q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0;
    const correctLetter = ["A", "B", "C", "D"][idx];
    const questionType = ALLOWED_TEXT_QUESTION_TYPES.includes(q.questionType) ? q.questionType : "reading";

    const [a, b, c, d] = opts;

    statements.push(
      prepare(
        env,
        `
        INSERT INTO text_questions
          (text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          textId,
          q.questionText,
          a,
          b,
          c,
          d,
          correctLetter,
          q.explanation || null,
          questionType,
          q.source || "ai"
        ]
      )
    );
  }

  if (statements.length > 0) {
    await batch(env, statements);
  }
  return statements.length;
}
