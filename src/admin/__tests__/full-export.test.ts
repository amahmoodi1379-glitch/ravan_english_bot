import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Env } from "../../types";
import {
  EXPORT_TABLES,
  buildCountQuery,
  buildFullExportFilename,
  buildPartQuery,
  exportTableByName,
  fetchExportPart,
  renderExportPage
} from "../full-export";

// The «خروجی کامل برای زبان‌یار» export. What a manual click would not reveal:
// that the table order lets the importer insert parents before children, that
// the paging cursor neither drops nor repeats a row, that the table name in the
// URL can only ever be one of the known tables, and that the page's inline
// script survives the TypeScript template escaping as valid JavaScript.

const schemaSql = readFileSync(resolve(__dirname, "../../../migrations/schema.sql"), "utf8");

/** table -> tables it references, parsed from schema.sql. */
function foreignKeys(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const tableRe = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  for (const m of schemaSql.matchAll(tableRe)) {
    const refs = new Set<string>();
    for (const r of m[2].matchAll(/REFERENCES (\w+)\(/g)) refs.add(r[1]);
    map.set(m[1], refs);
  }
  return map;
}

describe("EXPORT_TABLES", () => {
  it("only lists tables that exist in schema.sql", () => {
    const fks = foreignKeys();
    for (const t of EXPORT_TABLES) expect(fks.has(t.name), t.name).toBe(true);
  });

  it("puts every referenced (exported) table before the tables that reference it", () => {
    const fks = foreignKeys();
    const position = new Map(EXPORT_TABLES.map((t, i) => [t.name, i]));
    for (const t of EXPORT_TABLES) {
      for (const parent of fks.get(t.name) ?? []) {
        if (parent === t.name || !position.has(parent)) continue;
        expect(position.get(parent)!, `${t.name} -> ${parent}`).toBeLessThan(position.get(t.name)!);
      }
    }
  });

  it("leaves out admin-built custom quizzes but keeps tournaments", () => {
    expect(exportTableByName("custom_quizzes")?.where).toContain("kind = 'tournament'");
    expect(exportTableByName("custom_quiz_answers")?.where).toContain("kind = 'tournament'");
    expect(exportTableByName("custom_quiz_links")).toBeNull();
    expect(exportTableByName("admin_sessions")).toBeNull();
  });
});

describe("exportTableByName (the table name comes from the URL)", () => {
  it("rejects anything that is not a known table", () => {
    expect(exportTableByName("users")?.name).toBe("users");
    expect(exportTableByName("users; DROP TABLE users")).toBeNull();
    expect(exportTableByName("")).toBeNull();
    expect(exportTableByName("sqlite_master")).toBeNull();
  });
});

describe("queries", () => {
  it("pages by rowid with exactly two bound parameters", () => {
    const sql = buildPartQuery(exportTableByName("custom_quiz_questions")!);
    expect(sql).toMatch(/^SELECT rowid AS __rowid, \* FROM custom_quiz_questions WHERE rowid > \? AND \(.+\) ORDER BY rowid ASC LIMIT \?$/);
    expect(sql.split("?").length - 1).toBe(2);
    expect(buildCountQuery(exportTableByName("users")!)).toBe("SELECT COUNT(*) AS n FROM users");
  });
});

/** A D1 stand-in serving the keyset page over an in-memory table. */
function makeEnv(rowids: number[]): Env {
  const DB = {
    prepare(_sql: string) {
      return {
        bind(after: number, limit: number) {
          return {
            async all() {
              const results = rowids
                .filter((r) => r > after)
                .sort((a, b) => a - b)
                .slice(0, limit)
                .map((r) => ({ __rowid: r, id: r, name: `row${r}` }));
              return { results };
            }
          };
        }
      };
    }
  };
  return { DB } as unknown as Env;
}

describe("fetchExportPart", () => {
  it("walks every row exactly once across pages and strips the paging column", async () => {
    const rowids = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
    const env = makeEnv(rowids);
    const seen: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 20; guard++) {
      const part = await fetchExportPart(env, exportTableByName("users")!, after, 4);
      for (const row of part.rows) {
        expect(row).not.toHaveProperty("__rowid");
        seen.push(row.id as number);
      }
      if (part.done) break;
      after = part.last;
    }
    expect(seen).toEqual(rowids);
  });

  it("reports done on an empty table without moving the cursor", async () => {
    const part = await fetchExportPart(makeEnv([]), exportTableByName("users")!, 0, 4);
    expect(part).toEqual({ rows: [], last: 0, done: true });
  });
});

describe("renderExportPage", () => {
  it("embeds a script that is valid JavaScript after template escaping", () => {
    const html = renderExportPage(Date.UTC(2026, 9, 25, 8));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("/admin/export/manifest");
    expect(script).toContain("/admin/export/part?table=");
    expect(() => new Function(script)).not.toThrow();
  });

  it("names the file by the Iran-local date", () => {
    // 2026-10-24 21:00 UTC is already 25 Oct in Iran.
    expect(buildFullExportFilename(Date.UTC(2026, 9, 24, 21))).toBe("ravan-export-2026-10-25.ndjson.gz");
  });
});
