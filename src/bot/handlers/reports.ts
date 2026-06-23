import { Env } from "../../types";
import { sendMessage } from "../telegram-api";
import { getActiveUsersForReport } from "../../db/notifications";
import { getActivityComparison, PeriodMetrics } from "../../db/profile";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ReportKind = "daily" | "weekly" | "monthly";

const IRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** Iran-local "now" as a Date whose UTC fields represent Iran wall-clock time. */
function localNow(): Date {
  return new Date(Date.now() + IRAN_OFFSET_MS);
}

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

/** Build the four local-date window boundaries for the given report kind. */
function windowsFor(kind: ReportKind) {
  const today = localNow();
  const tomorrow = addDays(today, 1);
  if (kind === "daily") {
    return {
      curStart: fmtDate(today),
      curEnd: fmtDate(tomorrow),
      prevStart: fmtDate(addDays(today, -1)),
      prevEnd: fmtDate(today),
    };
  }
  if (kind === "weekly") {
    return {
      curStart: fmtDate(addDays(today, -6)),
      curEnd: fmtDate(tomorrow),
      prevStart: fmtDate(addDays(today, -13)),
      prevEnd: fmtDate(addDays(today, -6)),
    };
  }
  // monthly (rolling 30 days)
  return {
    curStart: fmtDate(addDays(today, -29)),
    curEnd: fmtDate(tomorrow),
    prevStart: fmtDate(addDays(today, -59)),
    prevEnd: fmtDate(addDays(today, -29)),
  };
}

function periodWord(kind: ReportKind): string {
  if (kind === "daily") return "دیروز";
  if (kind === "weekly") return "هفته‌ی قبل";
  return "ماه قبل";
}

function reportTitle(kind: ReportKind): string {
  if (kind === "daily") return "📅 گزارش امروزت";
  if (kind === "weekly") return "📆 گزارش این هفته‌ت";
  return "🗓️ گزارش این ماهت";
}

function deltaPart(cur: number, prev: number): string {
  const diff = cur - prev;
  if (diff > 0) return `📈 +${diff}`;
  if (diff < 0) return `📉 ${diff}`;
  return "➖ بدون تغییر";
}

function buildReportText(name: string | null, kind: ReportKind, cur: PeriodMetrics, prev: PeriodMetrics): string {
  const greetName = name ? ` ${name}` : "";
  const pw = periodWord(kind);

  let text = `👋 سلام${greetName}!\n<b>${reportTitle(kind)}</b>\n\n`;
  text += `⭐️ امتیاز (XP): <b>${cur.xp}</b>  (${deltaPart(cur.xp, prev.xp)} نسبت به ${pw})\n`;
  text += `📝 سوال‌های پاسخ‌داده: <b>${cur.questions}</b>  (${deltaPart(cur.questions, prev.questions)})\n`;
  text += `🆕 واژه‌های جدید: <b>${cur.new_words}</b>  (${deltaPart(cur.new_words, prev.new_words)})\n`;

  const better = cur.xp >= prev.xp;
  text += better
    ? `\n🔥 آفرین! روند خوبی داری، همینطور ادامه بده!`
    : `\n💪 امروز یه کم بیشتر تلاش کن تا دوباره اوج بگیری!`;

  return text;
}

/**
 * Send progress reports comparing the current period to the previous one, only to
 * subscribers who were active in the current window.
 * @param env - The worker environment containing the D1 database binding and bot token
 * @param kind - The report cadence: daily / weekly / monthly
 * @returns void
 */
export async function sendProgressReports(env: Env, kind: ReportKind): Promise<void> {
  const w = windowsFor(kind);
  const recipients = await getActiveUsersForReport(env, w.curStart, w.curEnd);
  let sent = 0;

  for (const u of recipients) {
    try {
      const cmp = await getActivityComparison(env, u.id, w);
      const text = buildReportText(u.display_name, kind, cmp.current, cmp.previous);
      await sendMessage(env, u.telegram_id, text);
      sent++;
    } catch (err) {
      console.error(`Progress report (${kind}) failed for ${u.telegram_id}:`, err);
    }

    if (sent > 0 && sent % 25 === 0) {
      await sleep(100);
    }
  }
}
