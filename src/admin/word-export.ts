import { Env } from "../types";
import { queryAll } from "../db/client";
import { iranDateStr } from "../utils/iran_time";
import { WORDS_EXPORT_CHUNK_SIZE } from "../config/constants";

/**
 * JSON export of the `words` table for the admin panel ("دانلود خروجی JSON").
 *
 * The response is streamed rather than buffered: the whole vocabulary (plus,
 * optionally, every word question) can be far larger than a comfortable single
 * D1 result, so the words are walked in id-keyset chunks and each chunk is
 * serialized straight into the response body. Memory stays flat at one chunk.
 */

export interface WordExportRow {
  id: number;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
  synonyms: string | null;
  antonyms: string | null;
  order_index: number;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface QuestionExportRow {
  id: number;
  word_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  explanation_text: string | null;
  source: string;
  created_at: string;
}

export interface WordExportOptions {
  /** Same free-text filter as the words list; empty string exports everything. */
  search: string;
  /** Nest each word's test questions under it. */
  includeQuestions: boolean;
}

const WORD_COLUMNS =
  "id, english, persian, level, lesson_name, synonyms, antonyms, order_index, is_active, created_at, updated_at";

const QUESTION_COLUMNS =
  "id, word_id, question_text, option_a, option_b, option_c, option_d, correct_option, question_style, explanation_text, source, created_at";

/**
 * Build the optional search predicate for the export, matching the filter the
 * words list view uses so "export" and "what I'm looking at" agree.
 * @param search - Free-text search term (may be empty)
 * @returns A SQL fragment to append after an existing WHERE clause, plus its params
 */
export function buildWordExportFilter(search: string): { whereSql: string; params: unknown[] } {
  const term = search.trim();
  if (!term) return { whereSql: "", params: [] };
  return {
    whereSql: " AND (english LIKE ? OR persian LIKE ? OR lesson_name LIKE ?)",
    params: [`%${term}%`, `%${term}%`, `%${term}%`]
  };
}

/**
 * Build the download filename for a words export.
 * @param includeQuestions - Whether questions are nested in the export
 * @param nowMs - Optional epoch ms (defaults to now); dated in Iran local time
 * @returns A filename such as "ravan-words-2026-08-08.json"
 */
export function buildWordExportFilename(includeQuestions: boolean, nowMs: number = Date.now()): string {
  const suffix = includeQuestions ? "-with-questions" : "";
  return `ravan-words${suffix}-${iranDateStr(nowMs)}.json`;
}

/**
 * Serialize one word question in the *same* shape the admin panel's question
 * importer accepts (`/admin/words/questions/import_json`), so an exported file
 * can be edited and fed straight back in. `id`/`source`/`created_at` are extra
 * context; the importer ignores unknown keys.
 * @param row - The raw word_questions row
 * @returns A plain object ready for JSON.stringify
 */
export function serializeQuestion(row: QuestionExportRow): Record<string, unknown> {
  return {
    id: row.id,
    questionText: row.question_text,
    options: [row.option_a, row.option_b, row.option_c, row.option_d],
    // "A".."D" -> 0..3; -1 signals a value the DB should not have contained.
    correctIndex: ["A", "B", "C", "D"].indexOf((row.correct_option || "").toUpperCase()),
    explanation: row.explanation_text,
    questionStyle: row.question_style,
    source: row.source,
    created_at: row.created_at
  };
}

/**
 * Serialize one word. Column names and stored values are kept verbatim (e.g.
 * `is_active` stays 1/0) so the file is a faithful dump of the row.
 * @param row - The raw words row
 * @param questions - Nested questions, or null when questions were not requested
 * @returns A plain object ready for JSON.stringify
 */
export function serializeWord(row: WordExportRow, questions: QuestionExportRow[] | null): Record<string, unknown> {
  const word: Record<string, unknown> = {
    id: row.id,
    english: row.english,
    persian: row.persian,
    level: row.level,
    lesson_name: row.lesson_name,
    synonyms: row.synonyms,
    antonyms: row.antonyms,
    order_index: row.order_index,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (questions) word.questions = questions.map(serializeQuestion);
  return word;
}

/**
 * Fetch the questions belonging to one chunk of words, grouped by word id.
 *
 * The chunk is looked up by its id *range* rather than an `IN (...)` list: D1
 * caps a statement at 100 bound parameters, which a 200-word chunk would blow
 * straight through. A range over-selects when a search filter is active (ids in
 * the range that the filter excluded), so the result is narrowed back down to
 * the chunk's own ids.
 * @param env - The worker environment containing the D1 database binding
 * @param words - The chunk of words, ordered by ascending id
 * @returns A map from word id to that word's questions
 */
async function fetchQuestionsForChunk(env: Env, words: WordExportRow[]): Promise<Map<number, QuestionExportRow[]>> {
  const byWord = new Map<number, QuestionExportRow[]>();
  if (words.length === 0) return byWord;

  for (const word of words) byWord.set(word.id, []);

  const rows = await queryAll<QuestionExportRow>(
    env,
    `SELECT ${QUESTION_COLUMNS} FROM word_questions WHERE word_id >= ? AND word_id <= ? ORDER BY word_id ASC, id ASC`,
    [words[0].id, words[words.length - 1].id]
  );
  for (const row of rows) {
    byWord.get(row.word_id)?.push(row);
  }
  return byWord;
}

/**
 * Stream the words table as a downloadable JSON file.
 *
 * Shape: `{ source, exported_at, filters, words: [...], count }`. `count` is
 * written last because it is the number of rows actually streamed, not a
 * separately-queried total that could disagree with the array above it.
 * @param env - The worker environment containing the D1 database binding
 * @param options - Search filter and whether to nest questions
 * @param nowMs - Optional epoch ms (defaults to now), used for the timestamp and filename
 * @returns A Response whose body streams the JSON export as a file download
 */
export function streamWordsExport(env: Env, options: WordExportOptions, nowMs: number = Date.now()): Response {
  const encoder = new TextEncoder();
  const filter = buildWordExportFilter(options.search);
  const wordsSql = `SELECT ${WORD_COLUMNS} FROM words WHERE id > ?${filter.whereSql} ORDER BY id ASC LIMIT ?`;

  let phase: "header" | "rows" | "footer" = "header";
  let lastId = 0;
  let count = 0;

  const body = new ReadableStream<Uint8Array>({
    // Every path through this loop must enqueue or close before returning: a
    // pull() that resolves having done neither is never called again, which
    // would hang the download (e.g. when the last page came back empty).
    async pull(controller) {
      for (;;) {
        if (phase === "header") {
          const header = {
            source: "ravan_english_bot",
            exported_at: new Date(nowMs).toISOString(),
            filters: {
              search: options.search.trim() || null,
              include_questions: options.includeQuestions
            }
          };
          const headerJson = JSON.stringify(header);
          // Splice `"words":[` in place of the closing brace so the rows can be
          // appended chunk by chunk instead of held in memory as one array.
          controller.enqueue(encoder.encode(`${headerJson.slice(0, -1)},"words":[`));
          phase = "rows";
          return;
        }

        if (phase === "rows") {
          const rows = await queryAll<WordExportRow>(env, wordsSql, [
            lastId,
            ...filter.params,
            WORDS_EXPORT_CHUNK_SIZE
          ]);
          if (rows.length === 0) {
            phase = "footer";
            continue;
          }

          const questions = options.includeQuestions ? await fetchQuestionsForChunk(env, rows) : null;
          const chunkJson = rows
            .map((row) => JSON.stringify(serializeWord(row, questions ? questions.get(row.id) ?? [] : null)))
            .join(",");
          controller.enqueue(encoder.encode(count === 0 ? chunkJson : `,${chunkJson}`));

          count += rows.length;
          lastId = rows[rows.length - 1].id;
          if (rows.length < WORDS_EXPORT_CHUNK_SIZE) phase = "footer";
          return;
        }

        controller.enqueue(encoder.encode(`],"count":${count}}`));
        controller.close();
        return;
      }
    }
  });

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${buildWordExportFilename(options.includeQuestions, nowMs)}"`,
      "cache-control": "no-store"
    }
  });
}
