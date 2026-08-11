import { describe, it, expect } from "vitest";
import { Env } from "../../types";
import {
  saveAnswer,
  getAnsweredCount,
  getLeaderboardWithNegative,
  getLeaderboardWithoutNegative,
} from "../custom_quizzes";

/**
 * Guards the fix for a tournament leaderboard that showed an attempt scoring
 * "✅11 — 100%" on a 10-question quiz (while everyone else topped out at ✅10),
 * and another scoring 27.27% — i.e. 3/11 — on the same quiz.
 *
 * Cause: custom_quiz_answers could hold TWO rows for one (attempt, question),
 * because saveAnswer read "is there a row?" and then wrote, so a double-tap or a
 * webhook retry let both callbacks take the insert path. The scoring queries JOIN
 * questions to answers, so the extra row fanned the join out and inflated the
 * attempt's correct count and its question total together — leaving the
 * percentage at 100% and only the raw counts looking impossible.
 *
 * Two independent defences are pinned here: the write can no longer produce a
 * duplicate, and the read can no longer be fooled by one.
 */

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeEnv(rows: unknown[] = []) {
  const calls: RecordedCall[] = [];
  const batches: RecordedCall[][] = [];

  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          sql,
          params: [] as unknown[],
          bind(...params: unknown[]) {
            stmt.params = params;
            calls.push({ sql, params });
            return stmt;
          },
          all: async () => ({ results: rows }),
          first: async () => rows[0] ?? null,
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: async (stmts: { sql: string; params: unknown[] }[]) => {
        batches.push(stmts.map((s) => ({ sql: s.sql, params: s.params })));
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;

  return { env, calls, batches };
}

/** Collapse whitespace so assertions don't depend on SQL indentation. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("saveAnswer writes at most one row per (attempt, question)", () => {
  it("is a single atomic batch — no read-then-write window to race in", async () => {
    const { env, calls, batches } = makeEnv();
    await saveAnswer(env, 7, 42, "3");

    // One batch = one transaction. A concurrent save can only run entirely before
    // or entirely after it, never interleaved between a lookup and an insert.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    // And nothing ran outside it — in particular no "does a row exist yet?" SELECT.
    expect(calls).toHaveLength(2);
  });

  it("updates an existing row and only inserts when there is none", async () => {
    const { env, batches } = makeEnv();
    await saveAnswer(env, 7, 42, "3");
    const [update, insert] = batches[0];

    // The update targets the pair, so it is a no-op on the very first save...
    expect(flat(update.sql)).toContain("UPDATE custom_quiz_answers");
    expect(flat(update.sql)).toContain("WHERE attempt_id = ? AND question_id = ?");
    expect(update.params).toEqual(["3", 7, 42]);

    // ...and the insert is guarded, so it is a no-op on every save after it.
    expect(flat(insert.sql)).toContain("INSERT INTO custom_quiz_answers");
    expect(flat(insert.sql)).toContain(
      "WHERE NOT EXISTS ( SELECT 1 FROM custom_quiz_answers WHERE attempt_id = ? AND question_id = ? )"
    );
    expect(insert.params).toEqual([7, 42, "3", 7, 42]);
  });

  it("clears an answer through the same single-row path", async () => {
    const { env, batches } = makeEnv();
    await saveAnswer(env, 7, 42, null);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].params).toEqual([null, 7, 42]);
  });
});

describe("scoring counts each question at most once", () => {
  it("counts DISTINCT questions on every board and total", async () => {
    const { env, calls } = makeEnv([]);
    await getLeaderboardWithoutNegative(env, 1, 50);
    await getLeaderboardWithNegative(env, 1, 50);

    for (const call of calls) {
      const sql = flat(call.sql);
      // A duplicated answer row must not be able to add a second unit to a bucket.
      expect(sql).toContain("COUNT(DISTINCT CASE WHEN ans.chosen_option = q.correct_option");
      expect(sql).toContain("COUNT(DISTINCT q.id)");
      // The pre-fix shape: a plain row count over the fanned-out join.
      expect(sql).not.toMatch(/COUNT\(q\.id\)/);
    }
  });

  it("counts distinct questions when reporting how many are answered", async () => {
    const { env, calls } = makeEnv([{ cnt: 4 }]);
    expect(await getAnsweredCount(env, 7)).toBe(4);
    expect(flat(calls[0].sql)).toContain("COUNT(DISTINCT question_id)");
  });

  it("derives unanswered from the total instead of counting it", async () => {
    // 4 right + 3 wrong on a 10-question quiz leaves 3 untouched, and the negative
    // score is 4 - 3/3 = 3 → 30%.
    const { env } = makeEnv([
      {
        attempt_id: 1,
        user_id: 9,
        display_name: "A",
        avatar_code: null,
        correct: 4,
        wrong: 3,
        total_q: 10,
        total_seconds: 120,
      },
    ]);
    const [row] = await getLeaderboardWithNegative(env, 1, 50);
    expect([row.correct, row.wrong, row.unanswered]).toEqual([4, 3, 3]);
    expect(row.percentage).toBe(30);
  });

  it("never reports a negative unanswered count", async () => {
    // Defensive: if a stored duplicate ever answered one question both right and
    // wrong, the buckets could sum past the question count. Clamp, don't underflow.
    const { env } = makeEnv([
      {
        attempt_id: 1,
        user_id: 9,
        display_name: "A",
        avatar_code: null,
        correct: 6,
        wrong: 5,
        total_q: 10,
        total_seconds: 120,
      },
    ]);
    const [row] = await getLeaderboardWithNegative(env, 1, 50);
    expect(row.unanswered).toBe(0);
  });
});
