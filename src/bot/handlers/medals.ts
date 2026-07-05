import { Env } from "../../types";
import { DbUser } from "../../db/users";
import { sendMessage } from "../telegram-api";
import {
  ALL_BADGES,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  BadgeDef,
} from "../../config/badges";
import { getUserBadges, evaluateThresholdBadges } from "../../db/badges";

/**
 * Send a single congratulatory message for newly-earned badges (batched).
 * @param env - The worker environment containing the bot token
 * @param chatId - The Telegram chat ID
 * @param badges - The newly-awarded badge definitions (may be empty → no message)
 * @returns void
 */
export async function notifyNewBadges(env: Env, chatId: number, badges: BadgeDef[]): Promise<void> {
  if (!badges.length) return;
  const lines = badges.map((b) => `${b.emoji} <b>${b.title}</b> — ${b.description}`).join("\n");
  const header = badges.length === 1 ? "🏅 <b>مدال جدید گرفتی!</b>" : "🏅 <b>مدال‌های جدید گرفتی!</b>";
  await sendMessage(env, chatId, `${header}\n\n${lines}\n\nآفرین! 🎉`, { parse_mode: "HTML" });
}

/**
 * Show the medals page: catalog grouped by category, earned marked, locked shown
 * with their unlock condition. Evaluates threshold badges first (catch-up) and
 * notifies of any newly-unlocked ones.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @returns void
 */
export async function showMedals(env: Env, user: DbUser, chatId: number): Promise<void> {
  // Catch-up evaluation so opening the page reveals (and announces) new medals.
  const fresh = await evaluateThresholdBadges(env, user.id);

  const earnedRows = await getUserBadges(env, user.id);
  const earned = new Set(earnedRows.map((r) => r.badge_code));

  let text = `🏅 <b>مدال‌های تو</b> (${earned.size} از ${ALL_BADGES.length})\n`;

  for (const category of CATEGORY_ORDER) {
    const badges = ALL_BADGES.filter((b) => b.category === category);
    if (!badges.length) continue;
    text += `\n<b>${CATEGORY_LABELS[category]}</b>\n`;
    for (const b of badges) {
      text += earned.has(b.code)
        ? `${b.emoji} ${b.title} ✅\n`
        : `🔒 ${b.title} — <i>${b.description}</i>\n`;
    }
  }

  await sendMessage(env, chatId, text, { parse_mode: "HTML" });

  // Announce any newly-unlocked medals (in addition to showing them above).
  await notifyNewBadges(env, chatId, fresh);
}
