import { Env } from "../../types";
import { TelegramCallbackQuery } from "../types";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser } from "../../db/users";
import { CB_PREFIX } from "../../config/constants";
import {
  getLeaderboardXp,
  getUserRankXp,
  getLeaderboardStreak,
  getUserRankStreak,
  LeaderboardPeriod,
  StreakType,
} from "../../db/leaderboard";
import { getAvatarEmoji } from "../avatars";
import { pe } from "../premium-emojis";

const LB_BTN_XP = "⭐ لیدربورد امتیاز (XP)";
const LB_BTN_STREAK = "🔥 لیدربورد استریک";
const LB_BTN_BACK = "🏠 بازگشت";

function getRankEmoji(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}

function buildLeaderboardText(
  title: string,
  entries: { rank: number; display_name: string; avatar_code: string | null; score: number }[],
  userRank: { rank: number; score: number } | null,
  scoreLabel: string
): string {
  let text = `${title}\n\n`;

  if (entries.length === 0) {
    text += "🙈 هنوز کسی در این بخش امتیازی ندارد!\nاولین نفر باش 😉";
  } else {
    for (const e of entries) {
      const emoji = getRankEmoji(e.rank);
      const avatar = getAvatarEmoji(e.avatar_code);
      text += `${emoji} ${avatar} <b>${e.display_name}</b> — <b>${e.score.toLocaleString("fa-IR")}</b> ${scoreLabel}\n`;
    }
  }

  if (userRank && userRank.score > 0) {
    const inList = entries.some((e) => e.rank === userRank.rank);
    if (!inList) {
      text += `\n📍 <b>رتبه شما:</b> ${userRank.rank} — ${userRank.score.toLocaleString("fa-IR")} ${scoreLabel}`;
    }
  }

  return text;
}

/**
 * Show the leaderboard home menu with XP and streak category buttons.
 * @param env - The worker environment containing the bot token
 * @param chatId - The Telegram chat ID to send the menu to
 * @returns void
 */
export async function showLeaderboardHome(env: Env, chatId: number): Promise<void> {
  const text = `${pe("🏆")} <b>لیدربورد</b>\n\nکدوم بخش رو می‌خوای ببینی؟`;
  const replyMarkup = {
    inline_keyboard: [
      [{ text: LB_BTN_XP, callback_data: `${CB_PREFIX.LEADERBOARD}:xp_menu`, style: "success" }],
      [{ text: LB_BTN_STREAK, callback_data: `${CB_PREFIX.LEADERBOARD}:streak_menu`, style: "primary" }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

async function showXpMenu(env: Env, chatId: number): Promise<void> {
  const text = `${pe("⭐")} <b>لیدربورد امتیاز (XP)</b>\n\nدوره زمانی رو انتخاب کن:`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📅 هفتگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:weekly`, style: "success" },
        { text: "📆 ماهانه", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:monthly`, style: "success" },
      ],
      [{ text: "♾ همیشگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:all`, style: "primary" }],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

async function showStreakMenu(env: Env, chatId: number): Promise<void> {
  const text = `${pe("🔥")} <b>لیدربورد استریک</b>\n\nکدوم نوع رو می‌خوای ببینی؟`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔥 استریک فعال", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:live`, style: "primary" },
        { text: "🏅 رکورد تاریخی", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:record`, style: "success" },
      ],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

async function showXpLeaderboard(
  env: Env,
  chatId: number,
  userId: number,
  period: LeaderboardPeriod
): Promise<void> {
  const periodLabels: Record<LeaderboardPeriod, string> = {
    weekly: `${pe("⭐")} لیدربورد XP — هفتگی`,
    monthly: `${pe("⭐")} لیدربورد XP — ماهانه`,
    all: `${pe("⭐")} لیدربورد XP — همیشگی`,
  };

  // Kept sequential on purpose: both reads share the same cached standings
  // snapshot, so the first populates the in-isolate cache and the second is a
  // free lookup — cheaper than running them in parallel and double-fetching on a
  // cold cache.
  const entries = await getLeaderboardXp(env, period);
  const userRank = await getUserRankXp(env, userId, period);

  const text = buildLeaderboardText(periodLabels[period], entries, userRank, "XP");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📅 هفتگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:weekly`, style: "success" },
        { text: "📆 ماهانه", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:monthly`, style: "success" },
      ],
      [
        { text: "♾ همیشگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:all`, style: "primary" },
        { text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` },
      ],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

async function showStreakLeaderboard(
  env: Env,
  chatId: number,
  userId: number,
  type: StreakType
): Promise<void> {
  const typeLabels: Record<StreakType, string> = {
    live: `${pe("🔥")} لیدربورد استریک — فعال`,
    record: `🏅 لیدربورد استریک — رکورد تاریخی`,
  };

  // Streak reads are index-backed and independent — run them together.
  const [entries, userRank] = await Promise.all([
    getLeaderboardStreak(env, type),
    getUserRankStreak(env, userId, type),
  ]);

  const text = buildLeaderboardText(typeLabels[type], entries, userRank, "روز");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔥 فعال", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:live`, style: "primary" },
        { text: "🏅 رکورد", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:record`, style: "success" },
      ],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

/**
 * Handle inline button callbacks for leaderboard navigation and display.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query from the inline button press
 * @returns void
 */
export async function handleLeaderboardCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  const action = parts[1] || "";

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  await answerCallbackQuery(env, callbackQuery.id);

  if (action === "home") {
    await showLeaderboardHome(env, chatId);
    return;
  }

  if (action === "xp_menu") {
    await showXpMenu(env, chatId);
    return;
  }

  if (action === "streak_menu") {
    await showStreakMenu(env, chatId);
    return;
  }

  if (action === "xp" && parts[2]) {
    const period = parts[2] as LeaderboardPeriod;
    await showXpLeaderboard(env, chatId, user.id, period);
    return;
  }

  if (action === "streak" && parts[2]) {
    const type = parts[2] as StreakType;
    await showStreakLeaderboard(env, chatId, user.id, type);
    return;
  }
}
