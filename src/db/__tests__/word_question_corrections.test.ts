import { describe, it, expect } from "vitest";
import { applyWordQuestionCorrections } from "../word_questions";
import { Env } from "../../types";

/** A stored word question row as the fake DB holds it. */
interface Row {
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
 * Minimal in-memory D1 double: SELECT ... WHERE id = ? returns the stored row;
 * batched UPDATE ... WHERE id = ? mutates it. Only the two statement shapes used
 * by applyWordQuestionCorrections are supported.
 */
function makeFakeEnv(rows: Row[]): { env: Env; store: Map<number, Row> } {
  const store = new Map<number, Row>(rows.map((r) => [r.id, { ...r }]));

  function makeStmt(sql: string) {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async first() {
        const id = Number(params[0]);
        return store.get(id) ?? null;
      },
      async run() {
        return { meta: { changes: 1 } };
      },
      // Used by env.DB.batch to apply the staged UPDATE.
      _apply() {
        if (!/^\s*UPDATE/i.test(sql)) return;
        // Param order matches the UPDATE in applyWordQuestionCorrections.
        const [qtext, a, b, c, d, correct, style, explanation, id] = params;
        const existing = store.get(Number(id));
        if (!existing) return;
        existing.question_text = qtext as string;
        existing.option_a = a as string;
        existing.option_b = b as string;
        existing.option_c = c as string;
        existing.option_d = d as string;
        existing.correct_option = correct as string;
        existing.question_style = style as string;
        existing.explanation_text = explanation as string | null;
      }
    };
    return stmt;
  }

  const DB = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: Array<{ _apply: () => void }>) {
      stmts.forEach((s) => s._apply());
      return [];
    }
  };

  return { env: { DB } as unknown as Env, store };
}

function baseRow(id: number): Row {
  return {
    id,
    option_a: "کتاب",
    option_b: "میز",
    option_c: "دانه",
    option_d: "درخت",
    correct_option: "A",
    question_text: "معنی seed چیست؟",
    explanation_text: "old",
    question_style: "en_to_fa"
  };
}

describe("applyWordQuestionCorrections", () => {
  it("fixes only the answer key when only 'correct' is provided, leaving options untouched", async () => {
    const { env, store } = makeFakeEnv([baseRow(1)]);
    const res = await applyWordQuestionCorrections(env, [{ id: 1, correct: "C" }]);
    expect(res.updated).toBe(1);
    expect(res.updatedIds).toEqual([1]);
    const row = store.get(1)!;
    expect(row.correct_option).toBe("C");
    expect(row.option_c).toBe("دانه"); // options unchanged, no shuffle
    expect(row.explanation_text).toBe("old"); // untouched field preserved
  });

  it("replaces all four options and preserves the given order (no shuffle)", async () => {
    const { env, store } = makeFakeEnv([baseRow(1)]);
    await applyWordQuestionCorrections(env, [
      { id: 1, options: { A: "دانه", B: "میز", C: "کتاب", D: "درخت" }, correct: "A" }
    ]);
    const row = store.get(1)!;
    expect([row.option_a, row.option_b, row.option_c, row.option_d]).toEqual([
      "دانه",
      "میز",
      "کتاب",
      "درخت"
    ]);
    expect(row.correct_option).toBe("A");
  });

  it("lowercases-safe: accepts correct letter case-insensitively", async () => {
    const { env, store } = makeFakeEnv([baseRow(1)]);
    const res = await applyWordQuestionCorrections(env, [{ id: 1, correct: "b" }]);
    expect(res.updated).toBe(1);
    expect(store.get(1)!.correct_option).toBe("B");
  });

  it("reports not-found ids without failing the batch", async () => {
    const { env } = makeFakeEnv([baseRow(1)]);
    const res = await applyWordQuestionCorrections(env, [
      { id: 1, correct: "B" },
      { id: 999, correct: "C" }
    ]);
    expect(res.updated).toBe(1);
    expect(res.notFoundIds).toEqual([999]);
  });

  it("rejects an invalid correct letter and an incomplete options object", async () => {
    const { env, store } = makeFakeEnv([baseRow(1), baseRow(2)]);
    const res = await applyWordQuestionCorrections(env, [
      { id: 1, correct: "E" },
      { id: 2, options: { A: "x", B: "y", C: "z" } } // missing D
    ]);
    expect(res.updated).toBe(0);
    expect(res.invalid.length).toBe(2);
    // Both rows stay untouched.
    expect(store.get(1)!.correct_option).toBe("A");
    expect(store.get(2)!.option_a).toBe("کتاب");
  });

  it("skips entries without a valid id", async () => {
    const { env } = makeFakeEnv([baseRow(1)]);
    const res = await applyWordQuestionCorrections(env, [{ correct: "B" } as unknown]);
    expect(res.updated).toBe(0);
    expect(res.invalid.length).toBe(1);
  });

  it("rejects an unknown style but keeps a valid one", async () => {
    const { env, store } = makeFakeEnv([baseRow(1), baseRow(2)]);
    const res = await applyWordQuestionCorrections(env, [
      { id: 1, style: "not_a_style" },
      { id: 2, style: "fa_to_en" }
    ]);
    expect(res.updated).toBe(1);
    expect(res.updatedIds).toEqual([2]);
    expect(store.get(2)!.question_style).toBe("fa_to_en");
    expect(res.invalid.length).toBe(1);
  });
});
