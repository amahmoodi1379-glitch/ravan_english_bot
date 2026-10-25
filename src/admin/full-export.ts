import { Env } from "../types";
import { queryAll, queryOne } from "../db/client";
import { iranDateStr } from "../utils/iran_time";
import { escapeHtml } from "../utils/response";
import { FULL_EXPORT_PAGE_SIZE } from "../config/constants";

/**
 * Full data export for the Zabanyar web app («خروجی کامل برای زبان‌یار»).
 *
 * The whole database can be millions of rows, and one Worker invocation may
 * only run a bounded number of D1 queries, so the export is PAGED instead of
 * streamed from one request: the panel page (GET /admin/export) asks for a
 * manifest, then pulls every table page by page (GET /admin/export/part) and
 * assembles a single gzipped NDJSON file in the admin's browser. Every request
 * is a small, read-only query; nothing here writes to the database.
 *
 * File format (one JSON value per line, gzip-compressed):
 *   {"kind":"manifest","format":"ravan-export","version":1,...}
 *   {"t":"<table>","r":{...the row, column names and values verbatim...}}
 *   ...
 *   {"kind":"end","counts":{"<table>":<rows written>,...}}
 * The trailing "end" line lets the importer tell a complete file from a
 * truncated download.
 */

export const EXPORT_FORMAT = "ravan-export";
export const EXPORT_VERSION = 1;

export interface ExportTable {
  name: string;
  /** Optional row filter (static SQL, no user input). */
  where?: string;
}

const TOURNAMENT_QUIZZES = "SELECT id FROM custom_quizzes WHERE kind = 'tournament'";

/**
 * Every exported table, parents before children, so the importer can insert in
 * file order without breaking a foreign key. Admin-built custom quizzes (and
 * their link tokens) are deliberately left out — the web app does not carry
 * them over; only the nightly tournaments, which live in the same tables, are
 * exported. Telegram-only tables (admin sessions, bot conversation state,
 * announcements, analytics, duels, reflection, AI logs) are not exported.
 */
export const EXPORT_TABLES: ExportTable[] = [
  { name: "users" },
  { name: "access_codes" },
  { name: "words" },
  { name: "word_questions" },
  { name: "word_question_reports" },
  { name: "user_words_sm2" },
  { name: "user_word_question_history" },
  { name: "activity_log" },
  { name: "reading_texts" },
  { name: "text_questions" },
  { name: "reading_sessions" },
  { name: "user_text_question_history" },
  { name: "custom_quizzes", where: "kind = 'tournament'" },
  { name: "custom_quiz_questions", where: `quiz_id IN (${TOURNAMENT_QUIZZES})` },
  { name: "custom_quiz_attempts", where: `quiz_id IN (${TOURNAMENT_QUIZZES})` },
  {
    name: "custom_quiz_answers",
    where: `attempt_id IN (SELECT id FROM custom_quiz_attempts WHERE quiz_id IN (${TOURNAMENT_QUIZZES}))`
  },
  { name: "league_seasons" },
  { name: "league_divisions" },
  { name: "league_members" },
  { name: "league_results" },
  { name: "user_badges" },
  { name: "letter_users" },
  { name: "letter_threads" },
  { name: "letter_messages" },
  { name: "letter_blocks" },
  { name: "system_settings" }
];

const BY_NAME = new Map(EXPORT_TABLES.map((t) => [t.name, t]));

/** Look up an exportable table by name; anything else (including injection attempts) is null. */
export function exportTableByName(name: string): ExportTable | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * The keyset-paged SELECT for one table. Pages by SQLite `rowid` so tables
 * without an integer id (league_seasons, letter_users, letter_blocks,
 * system_settings) page the same way as the rest; for INTEGER PRIMARY KEY
 * tables rowid IS the id. Two bound parameters only (D1 caps a statement at 100).
 */
export function buildPartQuery(table: ExportTable): string {
  const filter = table.where ? ` AND (${table.where})` : "";
  return `SELECT rowid AS __rowid, * FROM ${table.name} WHERE rowid > ?${filter} ORDER BY rowid ASC LIMIT ?`;
}

export function buildCountQuery(table: ExportTable): string {
  return `SELECT COUNT(*) AS n FROM ${table.name}${table.where ? ` WHERE ${table.where}` : ""}`;
}

export interface ExportPart {
  rows: Record<string, unknown>[];
  /** rowid to pass as `after` for the next page. */
  last: number;
  done: boolean;
}

/** Fetch one page of a table, stripping the paging column from the rows. */
export async function fetchExportPart(
  env: Env,
  table: ExportTable,
  after: number,
  pageSize: number = FULL_EXPORT_PAGE_SIZE
): Promise<ExportPart> {
  const raw = await queryAll<Record<string, unknown>>(env, buildPartQuery(table), [after, pageSize]);
  let last = after;
  const rows = raw.map((row) => {
    const { __rowid, ...rest } = row;
    last = Number(__rowid);
    return rest;
  });
  return { rows, last, done: raw.length < pageSize };
}

export interface ExportManifest {
  kind: "manifest";
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  source: "ravan_english_bot";
  exported_at: string;
  /** Row counts at manifest time; used for the progress bar only (the bot is live, rows can change). */
  tables: { name: string; count: number }[];
}

export async function buildExportManifest(env: Env, nowMs: number = Date.now()): Promise<ExportManifest> {
  const tables: { name: string; count: number }[] = [];
  for (const table of EXPORT_TABLES) {
    const row = await queryOne<{ n: number }>(env, buildCountQuery(table));
    tables.push({ name: table.name, count: Number(row?.n ?? 0) });
  }
  return {
    kind: "manifest",
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    source: "ravan_english_bot",
    exported_at: new Date(nowMs).toISOString(),
    tables
  };
}

export function buildFullExportFilename(nowMs: number = Date.now()): string {
  return `ravan-export-${iranDateStr(nowMs)}.ndjson.gz`;
}

/**
 * The panel page. The browser does the assembling: it pulls the manifest and
 * every page, writes NDJSON lines through a gzip CompressionStream and offers
 * the result as one file. A failed page is retried a few times before the run
 * stops with a readable error (nothing is half-written anywhere).
 */
export function renderExportPage(nowMs: number = Date.now()): string {
  const filename = escapeHtml(buildFullExportFilename(nowMs));
  return `
    <p>این صفحه یک فایل کامل از همه‌ی داده‌های ربات می‌سازد تا در پنل ادمین <b>زبان‌یار</b> درون‌ریزی شود:
    کاربران، کدهای لایسنس، واژه‌ها و تست‌ها، وضعیت لایتنر هر نفر، امتیازها، درک مطلب، مسابقه‌ها، لیگ، مدال‌ها و نامه‌ها.</p>
    <p style="font-size:13px;color:#555">این کار فقط <b>می‌خواند</b> و چیزی را در ربات تغییر نمی‌دهد. بسته به حجم داده چند دقیقه طول می‌کشد؛
    تا تمام نشده این صفحه را نبند.</p>
    <button id="zy-start" type="button">📦 ساختن فایل خروجی</button>
    <div id="zy-progress" style="display:none;margin-top:14px">
      <div style="height:12px;border-radius:999px;background:#e5e7eb;overflow:hidden">
        <div id="zy-bar" style="height:100%;width:0;background:#2563eb;transition:width .2s"></div>
      </div>
      <div id="zy-status" style="font-size:13px;margin-top:8px;color:#374151"></div>
    </div>
    <div id="zy-error" class="error" style="display:none;margin-top:12px"></div>
    <p id="zy-done" style="display:none;margin-top:12px">✅ فایل آماده شد. اگر دانلود خودکار شروع نشد:
      <a id="zy-link" download="${filename}">دانلود ${filename}</a></p>
    <script>
    (function () {
      var btn = document.getElementById("zy-start");
      var bar = document.getElementById("zy-bar");
      var statusEl = document.getElementById("zy-status");
      var errorEl = document.getElementById("zy-error");
      function fa(n) { return String(n).replace(/\\d/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹"[d]; }); }
      async function getJson(url) {
        for (var attempt = 0; ; attempt++) {
          try {
            var res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
            if (res.redirected || res.status === 401 || res.status === 302) throw new Error("نشست ادمین تمام شده؛ دوباره وارد پنل شو.");
            if (!res.ok) throw new Error("خطای سرور " + res.status);
            return await res.json();
          } catch (e) {
            if (attempt >= 3 || /نشست/.test(e.message)) throw e;
            await new Promise(function (r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
          }
        }
      }
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        errorEl.style.display = "none";
        document.getElementById("zy-progress").style.display = "block";
        if (typeof CompressionStream === "undefined") {
          errorEl.textContent = "این مرورگر قدیمی است؛ با Chrome یا Firefox به‌روز امتحان کن.";
          errorEl.style.display = "block";
          btn.disabled = false;
          return;
        }
        try {
          statusEl.textContent = "در حال شمارش ردیف‌ها…";
          var manifest = await getJson("/admin/export/manifest");
          var total = manifest.tables.reduce(function (s, t) { return s + t.count; }, 0) || 1;
          var gzip = new CompressionStream("gzip");
          var writer = gzip.writable.getWriter();
          var chunks = [];
          var reader = gzip.readable.getReader();
          var pump = (async function () {
            for (;;) { var r = await reader.read(); if (r.done) return; chunks.push(r.value); }
          })();
          var enc = new TextEncoder();
          await writer.write(enc.encode(JSON.stringify(manifest) + "\\n"));
          var counts = {};
          var done = 0;
          for (var i = 0; i < manifest.tables.length; i++) {
            var name = manifest.tables[i].name;
            counts[name] = 0;
            var after = 0;
            for (;;) {
              var part = await getJson("/admin/export/part?table=" + encodeURIComponent(name) + "&after=" + after);
              if (part.rows.length) {
                var lines = part.rows.map(function (r) { return JSON.stringify({ t: name, r: r }); }).join("\\n") + "\\n";
                await writer.write(enc.encode(lines));
              }
              counts[name] += part.rows.length;
              done += part.rows.length;
              bar.style.width = Math.min(99, Math.round((done / total) * 100)) + "%";
              statusEl.textContent = "جدول " + fa(i + 1) + " از " + fa(manifest.tables.length) + " (" + name + ") — " + fa(done) + " ردیف";
              if (part.done) break;
              after = part.last;
            }
          }
          await writer.write(enc.encode(JSON.stringify({ kind: "end", counts: counts }) + "\\n"));
          await writer.close();
          await pump;
          var blob = new Blob(chunks, { type: "application/gzip" });
          var link = document.getElementById("zy-link");
          link.href = URL.createObjectURL(blob);
          bar.style.width = "100%";
          statusEl.textContent = "تمام شد: " + fa(done) + " ردیف، " + fa((blob.size / 1048576).toFixed(1)) + " مگابایت";
          document.getElementById("zy-done").style.display = "block";
          link.click();
        } catch (e) {
          errorEl.textContent = "خروجی متوقف شد: " + e.message;
          errorEl.style.display = "block";
        } finally {
          btn.disabled = false;
        }
      });
    })();
    </script>
  `;
}
