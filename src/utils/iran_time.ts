/**
 * Iran-local time helpers shared by the tournament and league features.
 *
 * The whole app stores timestamps as UTC via SQLite `datetime('now')` and treats
 * "Iran local" as a fixed +3.5h offset (Iran no longer observes DST). These
 * helpers centralise that convention so daily/weekly boundaries are computed the
 * same way everywhere. The Cloudflare Workers runtime clock is UTC, so
 * `new Date('YYYY-MM-DD HH:MM:SS')` parses as UTC — matching stored timestamps.
 */

export const IRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/**
 * Iran-local "now" as a Date whose UTC getters return Iran wall-clock fields.
 * @param nowMs - Optional epoch ms to base the calculation on (defaults to now)
 * @returns A Date shifted by +3.5h
 */
export function iranNow(nowMs: number = Date.now()): Date {
  return new Date(nowMs + IRAN_OFFSET_MS);
}

/** Format a Date's UTC fields as 'YYYY-MM-DD'. */
function fmtYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date's UTC fields as 'YYYY-MM-DD HH:MM:SS' (SQLite datetime shape). */
function fmtStamp(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${fmtYmd(d)} ${hh}:${mm}:${ss}`;
}

/**
 * The Iran-local calendar date ('YYYY-MM-DD') for the given instant.
 * @param nowMs - Optional epoch ms (defaults to now)
 */
export function iranDateStr(nowMs: number = Date.now()): string {
  return fmtYmd(iranNow(nowMs));
}

/**
 * A UTC 'YYYY-MM-DD HH:MM:SS' timestamp for the given instant (defaults to now).
 * Matches the format written by SQLite `datetime('now')`, so values are directly
 * comparable to stored columns and parseable via `new Date(...)` in the Workers
 * (UTC) runtime.
 * @param nowMs - Optional epoch ms (defaults to now)
 */
export function utcStamp(nowMs: number = Date.now()): string {
  return fmtStamp(new Date(nowMs));
}

/**
 * Shift a 'YYYY-MM-DD' date string by a whole number of calendar days.
 * @param ymd - The date string to shift
 * @param days - Number of days to add (may be negative)
 * @returns The shifted 'YYYY-MM-DD'
 */
export function shiftDateStr(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return fmtYmd(base);
}

/**
 * The Iran-local Saturday date ('YYYY-MM-DD') that opens the week containing the
 * given instant. The Iran calendar week runs Saturday → Friday.
 * @param nowMs - Optional epoch ms (defaults to now)
 */
export function iranWeekStartDate(nowMs: number = Date.now()): string {
  const local = iranNow(nowMs);
  const dow = local.getUTCDay(); // 0=Sun .. 6=Sat
  const daysSinceSaturday = (dow + 1) % 7; // Sat→0, Sun→1, ... Fri→6
  return shiftDateStr(fmtYmd(local), -daysSinceSaturday);
}

/**
 * Convert an Iran-local date string to the UTC datetime string that marks its
 * 00:00 boundary, for comparison against UTC-stored columns like
 * activity_log.created_at. e.g. Iran '2026-07-04' 00:00 → '2026-07-03 20:30:00'.
 * @param ymd - Iran-local 'YYYY-MM-DD'
 */
export function iranMidnightToUtc(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - IRAN_OFFSET_MS;
  return fmtStamp(new Date(ms));
}

/**
 * The UTC datetime string ('YYYY-MM-DD HH:MM:SS') for a given Iran-local
 * wall-clock time on a given Iran date. Used to pin a cron-created window to an
 * exact Iran hour (e.g. 21:00) regardless of when the hourly trigger actually
 * fires — so the tournament window doesn't drift with trigger jitter.
 * @param ymd - Iran-local 'YYYY-MM-DD'
 * @param hour - Iran-local hour (0-23)
 * @param minute - Iran-local minute (default 0)
 */
export function iranWallClockToUtcStamp(ymd: string, hour: number, minute = 0): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d, hour, minute) - IRAN_OFFSET_MS;
  return fmtStamp(new Date(ms));
}

/**
 * Parse a SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS', as written by
 * datetime('now') / utcStamp) as UTC in every runtime. Plain
 * `new Date('YYYY-MM-DD HH:MM:SS')` is implementation-defined and V8 treats it as
 * LOCAL time — correct on the (UTC) Workers runtime but wrong under a non-UTC
 * local dev/test machine. This forces UTC so behaviour is environment-independent.
 * @param stamp - A UTC 'YYYY-MM-DD HH:MM:SS' timestamp string
 */
export function parseUtcStamp(stamp: string): Date {
  return new Date(stamp.replace(" ", "T") + "Z");
}
