import { describe, it, expect } from "vitest";
import { Env } from "../../types";
import { WORDS_EXPORT_CHUNK_SIZE } from "../../config/constants";
import {
  buildWordExportFilename,
  buildWordExportFilter,
  serializeQuestion,
  streamWordsExport,
  WordExportRow,
  QuestionExportRow
} from "../word-export";

// The admin "خروجی JSON" download. The export streams the words table in
// id-keyset chunks, so the things worth pinning are the ones a single manual
// click would not reveal: that the concatenated chunks still parse as one JSON
// document, that the chunk boundary neither drops nor duplicates a word, and
// that the id-range question lookup (a workaround for D1's 100-parameter cap)
// does not leak questions belonging to words the search filter excluded.

function makeWord(id: number, over: Partial<WordExportRow> = {}): WordExportRow {
  return {
    id,
    english: `word${id}`,
    persian: `واژه${id}`,
    level: 1,
    lesson_name: `Lesson ${id % 5}`,
    synonyms: null,
    antonyms: null,
    order_index: id,
    is_active: 1,
    created_at: "2026-01-01 00:00:00",
    updated_at: null,
    ...over
  };
}

function makeQuestion(id: number, wordId: number, over: Partial<QuestionExportRow> = {}): QuestionExportRow {
  return {
    id,
    word_id: wordId,
    question_text: `q${id}?`,
    option_a: "a",
    option_b: "b",
    option_c: "c",
    option_d: "d",
    correct_option: "B",
    question_style: "en_to_fa",
    explanation_text: null,
    source: "ai",
    created_at: "2026-01-01 00:00:00",
    ...over
  };
}

/**
 * A D1 stand-in that answers exactly the two statements the export issues:
 * the keyset page over `words` and the id-range lookup over `word_questions`.
 */
function makeEnv(words: WordExportRow[], questions: QuestionExportRow[] = []): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              if (sql.includes("FROM words")) {
                const lastId = params[0] as number;
                const limit = params[params.length - 1] as number;
                const likes = params.slice(1, -1) as string[];
                let rows = words.filter((w) => w.id > lastId);
                if (likes.length > 0) {
                  const term = likes[0].replace(/%/g, "").toLowerCase();
                  rows = rows.filter((w) =>
                    [w.english, w.persian, w.lesson_name ?? ""].some((v) => v.toLowerCase().includes(term))
                  );
                }
                return { results: [...rows].sort((a, b) => a.id - b.id).slice(0, limit) };
              }
              const [minId, maxId] = params as [number, number];
              const rows = questions
                .filter((q) => q.word_id >= minId && q.word_id <= maxId)
                .sort((a, b) => a.word_id - b.word_id || a.id - b.id);
              return { results: rows };
            }
          };
        }
      };
    }
  };
  return { DB } as unknown as Env;
}

async function exportJson(
  env: Env,
  options: { search?: string; includeQuestions?: boolean } = {}
): Promise<{ response: Response; body: Record<string, any> }> {
  const response = streamWordsExport(
    env,
    { search: options.search ?? "", includeQuestions: options.includeQuestions ?? false },
    Date.UTC(2026, 7, 8, 12, 0, 0)
  );
  return { response, body: JSON.parse(await response.text()) };
}

describe("buildWordExportFilter", () => {
  it("returns no predicate for an empty or whitespace-only search", () => {
    expect(buildWordExportFilter("")).toEqual({ whereSql: "", params: [] });
    expect(buildWordExportFilter("   ")).toEqual({ whereSql: "", params: [] });
  });

  it("wraps the term for LIKE once per searched column", () => {
    const { whereSql, params } = buildWordExportFilter("  book ");
    expect(whereSql.startsWith(" AND (")).toBe(true);
    expect(whereSql.match(/\?/g)).toHaveLength(3);
    expect(params).toEqual(["%book%", "%book%", "%book%"]);
  });
});

describe("buildWordExportFilename", () => {
  it("is dated in Iran local time and flags whether questions are included", () => {
    // 2026-08-08 21:30 UTC is already 2026-08-09 in Iran (UTC+3:30).
    const late = Date.UTC(2026, 7, 8, 21, 30, 0);
    expect(buildWordExportFilename(false, late)).toBe("ravan-words-2026-08-09.json");
    expect(buildWordExportFilename(true, late)).toBe("ravan-words-with-questions-2026-08-09.json");
  });
});

describe("serializeQuestion", () => {
  it("emits the shape the admin question importer accepts", () => {
    const q = serializeQuestion(makeQuestion(7, 3, { correct_option: "C", explanation_text: "چون" }));
    expect(q.questionText).toBe("q7?");
    expect(q.options).toEqual(["a", "b", "c", "d"]);
    expect(q.correctIndex).toBe(2);
    expect(q.explanation).toBe("چون");
    expect(q.questionStyle).toBe("en_to_fa");
  });

  it("marks an out-of-range correct_option with -1 rather than guessing", () => {
    expect(serializeQuestion(makeQuestion(1, 1, { correct_option: "X" })).correctIndex).toBe(-1);
  });
});

describe("streamWordsExport", () => {
  it("serves a downloadable JSON attachment", async () => {
    const { response } = await exportJson(makeEnv([makeWord(1)]));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="ravan-words-2026-08-08.json"'
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("produces valid JSON for an empty database", async () => {
    const { body } = await exportJson(makeEnv([]));
    expect(body.words).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.exported_at).toBe("2026-08-08T12:00:00.000Z");
    expect(body.filters).toEqual({ search: null, include_questions: false });
  });

  it("streams every word exactly once across chunk boundaries", async () => {
    const words = Array.from({ length: WORDS_EXPORT_CHUNK_SIZE * 2 + 37 }, (_, i) => makeWord(i + 1));
    const { body } = await exportJson(makeEnv(words));
    expect(body.count).toBe(words.length);
    expect(body.words).toHaveLength(words.length);
    expect(body.words.map((w: WordExportRow) => w.id)).toEqual(words.map((w) => w.id));
  });

  it("terminates cleanly when the row count is an exact multiple of the chunk size", async () => {
    const words = Array.from({ length: WORDS_EXPORT_CHUNK_SIZE }, (_, i) => makeWord(i + 1));
    const { body } = await exportJson(makeEnv(words));
    expect(body.count).toBe(WORDS_EXPORT_CHUNK_SIZE);
    expect(body.words).toHaveLength(WORDS_EXPORT_CHUNK_SIZE);
  });

  it("keeps stored column names and values verbatim", async () => {
    const word = makeWord(4, { is_active: 0, synonyms: "a,b", antonyms: "c", updated_at: "2026-02-02 10:00:00" });
    const { body } = await exportJson(makeEnv([word]));
    expect(body.words[0]).toEqual({
      id: 4,
      english: "word4",
      persian: "واژه4",
      level: 1,
      lesson_name: "Lesson 4",
      synonyms: "a,b",
      antonyms: "c",
      order_index: 4,
      is_active: 0,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-02-02 10:00:00"
    });
    expect(body.words[0]).not.toHaveProperty("questions");
  });

  it("omits words the search filter excludes and records the term", async () => {
    const env = makeEnv([
      makeWord(1, { english: "notebook" }),
      makeWord(2, { english: "table" }),
      makeWord(3, { persian: "کتاب", english: "book" })
    ]);
    const { body } = await exportJson(env, { search: "book" });
    expect(body.words.map((w: WordExportRow) => w.id)).toEqual([1, 3]);
    expect(body.count).toBe(2);
    expect(body.filters.search).toBe("book");
  });

  it("nests each word's own questions, and an empty list when it has none", async () => {
    const env = makeEnv(
      [makeWord(1), makeWord(2), makeWord(3)],
      [makeQuestion(10, 1), makeQuestion(11, 1), makeQuestion(12, 3)]
    );
    const { body } = await exportJson(env, { includeQuestions: true });
    expect(body.filters.include_questions).toBe(true);
    expect(body.words[0].questions.map((q: { id: number }) => q.id)).toEqual([10, 11]);
    expect(body.words[1].questions).toEqual([]);
    expect(body.words[2].questions.map((q: { id: number }) => q.id)).toEqual([12]);
  });

  it("does not leak questions of words that the search filter excluded", async () => {
    // Ids 1 and 3 match; id 2 sits inside the same id range the question lookup
    // scans, so its questions must be discarded rather than attached to a neighbour.
    const env = makeEnv(
      [makeWord(1, { english: "book" }), makeWord(2, { english: "table" }), makeWord(3, { english: "bookmark" })],
      [makeQuestion(20, 1), makeQuestion(21, 2), makeQuestion(22, 3)]
    );
    const { body } = await exportJson(env, { search: "book", includeQuestions: true });
    const exportedQuestionIds = body.words.flatMap((w: { questions: { id: number }[] }) => w.questions.map((q) => q.id));
    expect(exportedQuestionIds).toEqual([20, 22]);
  });
});
