import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser } from "../../db/users";
import {
  getLeaderboard,
  getUserRank,
  LeaderboardPeriod,
  LeaderboardRow
} from "../../db/leaderboard";
import { CB_PREFIX } from "../../config/constants"; // Import added

function periodLabel(period: LeaderboardPeriod): string {
  switch (period) {
    case "weekly": return "هفتگی (۷ روز اخیر)";
    case "monthly": return "ماهانه (۳۰ روز اخیر)";
    case "all_time": return "کلی (همه‌ی زمان‌ها)";
  }
}

export async function startLeaderboardMenu(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  await getOrCreateUser(env, tgUser);

  const replyMarkup = {
    inline_keyboard: [
      [{ text: "🏅 هفتگی", callback_data: `${CB_PREFIX.LEADERBOARD}:weekly` }],
      [{ text: "🥇 ماهانه", callback_data: `${CB_PREFIX.LEADERBOARD}:monthly` }],
      [{ text: "🏆 کلی", callback_data: `${CB_PREFIX.LEADERBOARD}:all_time` }]
    ]
  };

  await sendMessage(
    env,
    chatId,
    "برای دیدن لیدربورد جهانی، بازه‌ی زمانی رو انتخاب کن:",
    { reply_markup: replyMarkup }
  );
}

export async function handleLeaderboardCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); 
  
  // lb:<period>
  if (parts.length !== 2 || parts[0] !== CB_PREFIX.LEADERBOARD) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const period = parts[1] as LeaderboardPeriod;
  if (!["weekly", "monthly", "all_time"].includes(period)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;
  const tgUser = callbackQuery.from;

  const user = await getOrCreateUser(env, tgUser);

  await answerCallbackQuery(env, callbackQuery.id);

  const top = await getLeaderboard(env, period, 10);
  const myRank = await getUserRank(env, period, user.id);

  const text = buildLeaderboardText(period, top, myRank, user.id);
  await sendMessage(env, chatId, text);
}

function buildLeaderboardText(
  period: LeaderboardPeriod,
  rows: LeaderboardRow[],
  myRank: { rank: number; xp: number } | null,
  myUserId: number
): string {
  let text = `📊 لیدربورد جهانی - ${periodLabel(period)}\n\n`;

  if (rows.length === 0) {
    text += "هنوز کسی در این بازه XP نگرفته.\n";
  } else {
    text += "۱۰ نفر برتر:\n";
    rows.forEach((r, idx) => {
      const rank = idx + 1;
      const name = r.display_name || `user_${r.user_id}`;
      const meMark = r.user_id === myUserId ? " (تو)" : "";
      text += `\n${rank}) ${name}${meMark} — <b>${r.xp}</b> XP`;
    });
  }

  text += "\n\n👤 جایگاه تو:\n";

  if (!myRank) {
    text += "در این بازه XP نگرفتی، پس الان تو لیدربورد این بازه نیستی.";
  } else {
    text += `رتبه: <b>${myRank.rank}</b>\nXP این بازه: <b>${myRank.xp}</b>`;
  }

  return text;
}
