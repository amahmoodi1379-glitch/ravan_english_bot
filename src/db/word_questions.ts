import { Env } from "../types";
import { execute, queryAll, queryOne, prepare } from "./client";
import { LEITNER_TEST_TYPES } from "../config/constants";

export interface NewWordQuestionRow {
  wordId: number;
  questionText: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  questionStyle: string;
  source?: "manual" | "ai" | "seed";
}

/** Allowed question_style values for a word question (used to validate corrections). */
const ALLOWED_WORD_QUESTION_STYLES: string[] = Object.values(LEITNER_TEST_TYPES);

/** Max rows per D1 batch when updating in bulk (keeps well under statement limits). */
const REVIEW_BATCH_CHUNK = 100;

/** A word question joined with its parent word, as exported for QC review. */
export interface WordQuestionForReview {
  id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  explanation_text: string | null;
  english: string;
  persian: string;
  synonyms: string | null;
  antonyms: string | null;
}

/** Aggregate counts for the QC review page. */
export interface ReviewStats {
  total: number;
  reviewed: number;
  unreviewed: number;
}

/**
 * A single correction returned by the reviewer (Claude), keyed by question id.
 * Only fields the reviewer chose to change are present; omitted fields are
 * left untouched on the existing row.
 */
export interface WordQuestionCorrection {
  id: number;
  question?: string;
  options?: { A?: string; B?: string; C?: string; D?: string };
  correct?: string;
  explanation?: string;
  style?: string;
}

/** Existing word-question fields needed to overlay a correction. */
interface ExistingWordQuestionRow {
  id: number;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_text: string;
  explanation_text: string | null;
  question_style: string;
}

/**
 * Coerce a correction's `id` to a positive integer, rejecting booleans, floats,
 * and non-numeric strings (so e.g. `true` never becomes id 1).
 * @param v - The raw id value from parsed JSON
 * @returns The positive integer id, or null if invalid
 */
function parseQuestionId(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isInteger(v) && v > 0 ? v : null;
  }
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : null;
  }
  return null;
}

/** Outcome of applying a batch of corrections. */
export interface ApplyCorrectionsResult {
  updated: number;
  updatedIds: number[];
  /** ids that were valid-shaped but did not match an existing question. */
  notFoundIds: number[];
  /** human-readable reasons for entries that failed validation. */
  invalid: string[];
}

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

/**
 * Insert multiple-choice questions for a word, shuffling options before storage.
 * @param env - The worker environment containing the D1 database binding
 * @param wordId - The word ID to associate the questions with
 * @param questions - An array of question data rows to insert
 * @returns void
 */
export async function insertWordQuestions(
  env: Env,
  wordId: number,
  questions: NewWordQuestionRow[]
): Promise<void> {
  for (const q of questions) {
    const opts = q.options.slice(0, 4);
    while (opts.length < 4) {
      opts.push("");
    }

    const originalCorrectIndex = (q.correctIndex >= 0 && q.correctIndex < opts.length) ? q.correctIndex : 0;
    const correctAnswerText = opts[originalCorrectIndex];

    const shuffledOpts = shuffleArray(opts);
    const newCorrectIndex = shuffledOpts.indexOf(correctAnswerText);
    const correctLetter = ["A", "B", "C", "D"][newCorrectIndex];

    const [a, b, c, d] = shuffledOpts;

    await execute(
      env,
      `
      INSERT INTO word_questions
        (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_style, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        wordId,
        q.questionText,
        a,
        b,
        c,
        d,
        correctLetter,
        q.explanation || null,
        q.questionStyle,
        q.source || "ai"
      ]
    );
  }
}

/**
 * Get total / reviewed / unreviewed counts of word questions for the QC page.
 * @param env - The worker environment containing the D1 database binding
 * @returns Aggregate review counts
 */
export async function getReviewStats(env: Env): Promise<ReviewStats> {
  const row = await queryOne<{ total: number; reviewed: number }>(
    env,
    `SELECT COUNT(*) AS total,
            COUNT(reviewed_at) AS reviewed
     FROM word_questions`
  );
  const total = row?.total ?? 0;
  const reviewed = row?.reviewed ?? 0;
  return { total, reviewed, unreviewed: total - reviewed };
}

/**
 * Fetch the next batch of not-yet-reviewed word questions joined with their
 * parent word (english/persian/synonyms/antonyms), ordered by id.
 * @param env - The worker environment containing the D1 database binding
 * @param limit - Maximum number of questions to return
 * @returns An array of questions with parent-word context for review
 */
export async function getUnreviewedWordQuestionsBatch(
  env: Env,
  limit: number
): Promise<WordQuestionForReview[]> {
  return await queryAll<WordQuestionForReview>(
    env,
    `
    SELECT wq.id, wq.question_text, wq.option_a, wq.option_b, wq.option_c, wq.option_d,
           wq.correct_option, wq.question_style, wq.explanation_text,
           w.english, w.persian, w.synonyms, w.antonyms
    FROM word_questions wq
    JOIN words w ON w.id = wq.word_id
    WHERE wq.reviewed_at IS NULL
    ORDER BY wq.id ASC
    LIMIT ?
    `,
    [limit]
  );
}

/**
 * Mark the given word questions as reviewed (sets reviewed_at = now), chunked
 * to stay within D1 batch limits.
 * @param env - The worker environment containing the D1 database binding
 * @param ids - The question ids to mark reviewed
 * @returns void
 */
export async function markWordQuestionsReviewed(env: Env, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += REVIEW_BATCH_CHUNK) {
    const chunk = ids.slice(i, i + REVIEW_BATCH_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const statements = [
      prepare(
        env,
        `UPDATE word_questions SET reviewed_at = datetime('now') WHERE id IN (${placeholders})`,
        chunk
      )
    ];
    await env.DB.batch(statements);
  }
}

/**
 * Clear the review status of ALL word questions so they can be pulled into a
 * fresh review batch again.
 * @param env - The worker environment containing the D1 database binding
 * @returns The number of rows affected
 */
export async function resetWordQuestionReview(env: Env): Promise<number> {
  const res = await execute(env, `UPDATE word_questions SET reviewed_at = NULL WHERE reviewed_at IS NOT NULL`);
  return res.meta?.changes ?? 0;
}

/**
 * Apply reviewer corrections to existing word questions in place (UPDATE by id,
 * no option shuffle — the reviewed answer key is preserved exactly). Only the
 * fields present on each correction are changed; omitted fields keep their
 * current value. Invalid or unknown-id entries are skipped and reported.
 * @param env - The worker environment containing the D1 database binding
 * @param corrections - Parsed corrections (already JSON-decoded)
 * @returns A summary of what was updated, not found, and rejected
 */
export async function applyWordQuestionCorrections(
  env: Env,
  corrections: unknown[]
): Promise<ApplyCorrectionsResult> {
  const result: ApplyCorrectionsResult = {
    updated: 0,
    updatedIds: [],
    notFoundIds: [],
    invalid: []
  };

  const statements: D1PreparedStatement[] = [];
  const stagedIds: number[] = [];

  // Phase 1: validate the shape of each entry (skip null / non-object / bad id)
  // and collect the ids so existing rows can be fetched in bulk.
  const valid: Array<{ id: number; entry: Record<string, unknown> }> = [];
  for (const raw of corrections) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      result.invalid.push(`ورودی نامعتبر (باید یک آبجکت باشد) رد شد: ${JSON.stringify(raw).slice(0, 80)}`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const id = parseQuestionId(entry.id);
    if (id === null) {
      result.invalid.push(`ورودی بدون id معتبر رد شد: ${JSON.stringify(raw).slice(0, 80)}`);
      continue;
    }
    valid.push({ id, entry });
  }

  // Phase 2: fetch all referenced rows in chunks of REVIEW_BATCH_CHUNK using an
  // IN (...) list, avoiding one round-trip per correction (N+1).
  const existingById = new Map<number, ExistingWordQuestionRow>();
  const uniqueIds = [...new Set(valid.map((v) => v.id))];
  for (let i = 0; i < uniqueIds.length; i += REVIEW_BATCH_CHUNK) {
    const chunk = uniqueIds.slice(i, i + REVIEW_BATCH_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await queryAll<ExistingWordQuestionRow>(
      env,
      `SELECT id, option_a, option_b, option_c, option_d, correct_option, question_text, explanation_text, question_style
       FROM word_questions WHERE id IN (${placeholders})`,
      chunk
    );
    for (const r of rows) existingById.set(r.id, r);
  }

  // Phase 3: overlay each correction onto its existing row and stage an UPDATE.
  for (const { id, entry } of valid) {
    const existing = existingById.get(id);
    if (!existing) {
      result.notFoundIds.push(id);
      continue;
    }

    // Start from existing values; overlay only provided fields.
    let questionText = existing.question_text;
    let optionA = existing.option_a;
    let optionB = existing.option_b;
    let optionC = existing.option_c;
    let optionD = existing.option_d;
    let correct = existing.correct_option;
    let explanation = existing.explanation_text;
    let style = existing.question_style;

    let entryInvalid: string | null = null;

    if (typeof entry.question === "string" && entry.question.trim()) {
      questionText = entry.question.trim();
    }

    if (entry.options !== undefined) {
      const opts = entry.options as Record<string, unknown>;
      const a = opts?.A, b = opts?.B, c = opts?.C, d = opts?.D;
      if (
        typeof a === "string" && a.trim() &&
        typeof b === "string" && b.trim() &&
        typeof c === "string" && c.trim() &&
        typeof d === "string" && d.trim()
      ) {
        optionA = a.trim();
        optionB = b.trim();
        optionC = c.trim();
        optionD = d.trim();
      } else {
        entryInvalid = `id ${id}: فیلد options باید هر چهار کلید A,B,C,D را با مقدار غیرخالی داشته باشد`;
      }
    }

    if (!entryInvalid && entry.correct !== undefined) {
      const letter = typeof entry.correct === "string" ? entry.correct.trim().toUpperCase() : "";
      if (["A", "B", "C", "D"].includes(letter)) {
        correct = letter;
      } else {
        entryInvalid = `id ${id}: فیلد correct باید یکی از A/B/C/D باشد`;
      }
    }

    if (!entryInvalid && entry.style !== undefined) {
      const s = typeof entry.style === "string" ? entry.style.trim() : "";
      if (ALLOWED_WORD_QUESTION_STYLES.includes(s)) {
        style = s;
      } else {
        entryInvalid = `id ${id}: مقدار style نامعتبر است`;
      }
    }

    if (!entryInvalid && typeof entry.explanation === "string") {
      explanation = entry.explanation.trim() || null;
    }

    if (entryInvalid) {
      result.invalid.push(entryInvalid);
      continue;
    }

    statements.push(
      prepare(
        env,
        `UPDATE word_questions
         SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?,
             correct_option = ?, question_style = ?, explanation_text = ?
         WHERE id = ?`,
        [questionText, optionA, optionB, optionC, optionD, correct, style, explanation, id]
      )
    );
    stagedIds.push(id);
  }

  for (let i = 0; i < statements.length; i += REVIEW_BATCH_CHUNK) {
    await env.DB.batch(statements.slice(i, i + REVIEW_BATCH_CHUNK));
  }

  result.updated = stagedIds.length;
  result.updatedIds = stagedIds;
  return result;
}
