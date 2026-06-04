import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
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

// دکمه‌های منوی لیدربورد
const LB_BTN_XP = "📊 لیدربورد امتیاز (XP)";
const LB_BTN_STREAK = "🔥 لیدربورد استریک";
const LB_BTN_BACK = "⬅️ بازگشت";

function getAvatarEmoji(code: string | null): string {
  if (!code) return "👤";
  const avatars: Record<string, string> = {
    lion: "🦁",
    fox: "🦊",
    panda: "🐼",
    owl: "🦉",
    wolf: "🐺",
    eagle: "🦅",
    dragon: "🐉",
    cat: "🐱",
    dog: "🐶",
    bear: "🐻",
    rabbit: "🐰",
    tiger: "🐯",
    koala: "🐨",
    frog: "🐸",
    penguin: "🐧",
    monkey: "🐵",
    horse: "🐴",
    unicorn: "🦄",
    bee: "🐝",
    butterfly: "🦋",
    shark: "🦈",
    whale: "🐋",
    turtle: "🐢",
    octopus: "🐙",
  };
  return avatars[code] || "👤";
}

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
    const inTop10 = entries.some((e) => e.rank === userRank.rank);
    if (!inTop10) {
      text += `\n📍 <b>رتبه شما:</b> ${userRank.rank} — ${userRank.score.toLocaleString("fa-IR")} ${scoreLabel}`;
    }
  }

  return text;
}

// ============================================================
// منوی اصلی لیدربورد
// ============================================================
export async function showLeaderboardHome(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;

  const text = `🏆 <b>لیدربورد</b>\n\nکدوم بخش رو می‌خوای ببینی؟`;
  const replyMarkup = {
    inline_keyboard: [
      [{ text: LB_BTN_XP, callback_data: `${CB_PREFIX.LEADERBOARD}:xp_menu` }],
      [{ text: LB_BTN_STREAK, callback_data: `${CB_PREFIX.LEADERBOARD}:streak_menu` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

// ============================================================
// منوی XP
// ============================================================
async function showXpMenu(env: Env, chatId: number): Promise<void> {
  const text = `📊 <b>لیدربورد امتیاز (XP)</b>\n\nدوره زمانی رو انتخاب کن:`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📅 هفتگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:weekly` },
        { text: "📆 ماهانه", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:monthly` },
      ],
      [{ text: "♾ همیشگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:all` }],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

// ============================================================
// منوی Streak
// ============================================================
async function showStreakMenu(env: Env, chatId: number): Promise<void> {
  const text = `🔥 <b>لیدربورد استریک</b>\n\nکدوم نوع رو می‌خوای ببینی؟`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔥 استریک فعال", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:live` },
        { text: "🏅 رکورد تاریخی", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:record` },
      ],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

// ============================================================
// نمایش XP Leaderboard
// ============================================================
async function showXpLeaderboard(
  env: Env,
  chatId: number,
  userId: number,
  period: LeaderboardPeriod
): Promise<void> {
  const periodLabels: Record<LeaderboardPeriod, string> = {
    weekly: "📊 لیدربورد XP — هفتگی",
    monthly: "📊 لیدربورد XP — ماهانه",
    all: "📊 لیدربورد XP — همیشگی",
  };

  const scoreLabels: Record<LeaderboardPeriod, string> = {
    weekly: "XP",
    monthly: "XP",
    all: "XP",
  };

  const entries = await getLeaderboardXp(env, period);
  const userRank = await getUserRankXp(env, userId, period);

  const text = buildLeaderboardText(
    periodLabels[period],
    entries,
    userRank,
    scoreLabels[period]
  );

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📅 هفتگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:weekly` },
        { text: "📆 ماهانه", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:monthly` },
      ],
      [
        { text: "♾ همیشگی", callback_data: `${CB_PREFIX.LEADERBOARD}:xp:all` },
        { text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` },
      ],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

// ============================================================
// نمایش Streak Leaderboard
// ============================================================
async function showStreakLeaderboard(
  env: Env,
  chatId: number,
  userId: number,
  type: StreakType
): Promise<void> {
  const typeLabels: Record<StreakType, string> = {
    live: "🔥 لیدربورد استریک — فعال",
    record: "🏅 لیدربورد استریک — رکورد تاریخی",
  };

  const scoreLabel = type === "live" ? "روز" : "روز";

  const entries = await getLeaderboardStreak(env, type);
  const userRank = await getUserRankStreak(env, userId, type);

  const text = buildLeaderboardText(
    typeLabels[type],
    entries,
    userRank,
    scoreLabel
  );

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔥 فعال", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:live` },
        { text: "🏅 رکورد", callback_data: `${CB_PREFIX.LEADERBOARD}:streak:record` },
      ],
      [{ text: LB_BTN_BACK, callback_data: `${CB_PREFIX.LEADERBOARD}:home` }],
    ],
  };

  await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
}

// ============================================================
// Callback Handler
// ============================================================
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
  const tgUser = callbackQuery.from;
  const user = await getOrCreateUser(env, tgUser);

  await answerCallbackQuery(env, callbackQuery.id);

  if (action === "home") {
    // منوی اصلی لیدربورد
    const text = `🏆 <b>لیدربورد</b>\n\nکدوم بخش رو می‌خوای ببینی؟`;
    const replyMarkup = {
      inline_keyboard: [
        [{ text: LB_BTN_XP, callback_data: `${CB_PREFIX.LEADERBOARD}:xp_menu` }],
        [{ text: LB_BTN_STREAK, callback_data: `${CB_PREFIX.LEADERBOARD}:streak_menu` }],
      ],
    };
    await sendMessage(env, chatId, text, { reply_markup: replyMarkup });
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
