import { Env } from "../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getProfileMenuKeyboard } from "../keyboards";
import { pe } from "../premium-emojis";
import { escapeHtml } from "../../utils/html";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne } from "../../db/client";
import {
  getUserProfile,
  updateDisplayName,
  setAvatar,
  getUserActivityStats,
  ActivityPeriod,
  ActivityStats
} from "../../db/profile";
import { CB_PREFIX, TIME_ZONE_OFFSET } from "../../config/constants";
import { AVATARS, getAvatarEmoji, getAvatarLabel } from "../avatars";
import { toJalaliString } from "../../utils/jalali";
import { evaluateThresholdBadges } from "../../db/badges";
import { notifyNewBadges } from "./medals";

async function getStreakInfo(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ streak_count: number; last_streak_date: string }>(
    env,
    `SELECT streak_count, last_streak_date FROM users WHERE id = ?`,
    [userId]
  );
  if (!row) return 0;

  const count = (row.streak_count as number) || 0;
  const lastDate = (row.last_streak_date as string) || "";

  if (count === 0) return 0;

  const dateCheck = await queryOne<{ today_local: string; yesterday_local: string }>(
    env,
    `SELECT
      date('now', ?) as today_local,
      date('now', ?, '-1 day') as yesterday_local`,
    [TIME_ZONE_OFFSET, TIME_ZONE_OFFSET]
  );

  const todayStr = dateCheck?.today_local as string;
  const yesterdayStr = dateCheck?.yesterday_local as string;

  if (lastDate === todayStr || lastDate === yesterdayStr) {
    return count;
  }

  return 0;
}

/**
 * Display the user's profile home with name, XP, streak, and avatar.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the profile to
 * @returns void
 */
export async function showProfileHome(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName =
    profile?.display_name ||
    user.first_name ||
    user.username ||
    `user_${user.id}`;

  const xpTotal = profile?.xp_total ?? 0;
  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);

  const streakCount = await getStreakInfo(env, user.id);
  const streakText = streakCount > 0 ? `${pe("🔥")} <b>${streakCount}</b> روز` : "خاموش ❄️";

  const text =
    `${pe("👤")} <b>پروفایل کاربری</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏷 نام: <b>${escapeHtml(displayName)}</b>\n` +
    `${pe("⭐️")} امتیاز: <b>${xpTotal}</b> XP\n` +
    `زنجیره مطالعه: ${streakText}\n` +
    `🖼 آواتار: ${avatarEmoji}\n\n` +
    `👇 از منوی زیر تنظیمات رو انتخاب کن:`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });

  // Catch-up: award any threshold medals the user has newly earned and announce them.
  const fresh = await evaluateThresholdBadges(env, user.id);
  await notifyNewBadges(env, chatId, fresh);
}

/**
 * Display the profile settings page with avatar selection and name change instructions.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the settings to
 * @returns void
 */
export async function showProfileSettings(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName =
    profile?.display_name ||
    user.first_name ||
    user.username ||
    `user_${user.id}`;

  const remainingChanges = Math.max(0, 3 - (profile?.name_change_count ?? 0));
  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);
  const avatarLabel = getAvatarLabel(profile?.avatar_code);

  const text =
    `⚙️ <b>تنظیمات پروفایل</b>\n\n` +
    `✏️ <b>نام نمایشی:</b> ${escapeHtml(displayName)}\n` +
    `<i>(تغییرات باقی‌مانده: ${remainingChanges} از 3)</i>\n` +
    `برای تغییر نام، دستور زیر رو بفرست:\n` +
    `<code>/setname اسم_جدید</code>\n\n` +
    `🎭 <b>آواتار فعلی:</b> ${avatarEmoji} (${avatarLabel})\n` +
    `برای تغییر، یکی از گزینه‌های زیر رو انتخاب کن: 👇`;

  const inlineRows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < AVATARS.length; i += 4) {
    const slice = AVATARS.slice(i, i + 4);
    inlineRows.push(
      slice.map((a) => ({
        text: `${a.emoji}`,
        callback_data: `${CB_PREFIX.AVATAR}:${a.code}`
      }))
    );
  }

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: inlineRows
    }
  });
}

/**
 * Handle the avatar selection callback from the inline keyboard.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query containing the selected avatar code
 * @returns void
 */
export async function handleAvatarCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts.length !== 2 || parts[0] !== CB_PREFIX.AVATAR) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const code = parts[1];
  const avatar = AVATARS.find((a) => a.code === code);
  if (!avatar) {
    await answerCallbackQuery(env, callbackQuery.id, "آواتار نامعتبر است.");
    return;
  }

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  await setAvatar(env, user.id, code);

  await answerCallbackQuery(env, callbackQuery.id, "آواتار جدید ثبت شد! 😍");

  const text = `${pe("🎉")} آواتار تو به ${avatar.emoji} <b>${avatar.label}</b> تغییر کرد! ${pe("✨")}`;
  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}

/**
 * Process the /setname command to update the user's display name.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to respond to
 * @param text - The full command text (e.g., "/setname NewName")
 * @returns void
 */
export async function handleSetDisplayNameCommand(
  env: Env,
  user: DbUser,
  chatId: number,
  text: string
): Promise<void> {
  const parts = text.trim().split(" ");
  const newName = parts.slice(1).join(" ").trim();

  if (!newName) {
    await sendMessage(
      env,
      chatId,
      "⚠️ لطفاً نام جدید رو بعد از دستور بنویس.\nمثال:\n<code>/setname رضا</code>"
    );
    return;
  }

  if (newName.length > 32) {
    await sendMessage(env, chatId, "نام جدید خیلی طولانیه! (حداکثر ۳۲ حرف)");
    return;
  }

  const result = await updateDisplayName(env, user.id, newName);

  if (!result.ok) {
    if (result.reason === "limit") {
      await sendMessage(
        env,
        chatId,
        "⛔️ متاسفانه سقف تغییر نام (۳ بار) پر شده است."
      );
    } else {
      await sendMessage(env, chatId, "❌ مشکلی در تغییر نام پیش آمد.");
    }
    return;
  }

  const remaining = result.remainingChanges ?? 0;

  await sendMessage(
    env,
    chatId,
    `${pe("✨")} نام نمایشی به <b>${escapeHtml(newName)}</b> تغییر کرد ✅\nتعداد تغییرات باقی‌مانده: <b>${remaining}</b>`,
    {
      reply_markup: getProfileMenuKeyboard()
    }
  );
}

/**
 * Show the activity stats period selection menu.
 * @param env - The worker environment containing the bot token
 * @param chatId - The Telegram chat ID to send the period picker to
 * @returns void
 */
export async function startProfileStats(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env,
    chatId,
    `${pe("📊")} <b>آمار فعالیت</b>\n\nبازه‌ی زمانی رو انتخاب کن:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📅 امروز", callback_data: `${CB_PREFIX.STATS}:day`, style: "primary" }],
          [{ text: "🗓 ۷ روز اخیر", callback_data: `${CB_PREFIX.STATS}:week`, style: "primary" }],
          [{ text: "📆 ۳۰ روز اخیر", callback_data: `${CB_PREFIX.STATS}:month`, style: "primary" }],
          [{ text: "♾ همه‌ی زمان‌ها", callback_data: `${CB_PREFIX.STATS}:all`, style: "success" }]
        ]
      }
    }
  );
}

function periodLabel(period: ActivityPeriod): string {
  switch (period) {
    case "day": return "امروز";
    case "week": return "۷ روز اخیر";
    case "month": return "۳۰ روز اخیر";
    case "all": return "همه‌ی زمان‌ها";
  }
}

function buildStatsText(stats: ActivityStats): string {
  const label = periodLabel(stats.period);

  let text = `${pe("📊")} <b>گزارش عملکرد — ${label}</b>\n`;
  text += `━━━━━━━━━━━━━━\n\n`;

  text += `${pe("🧠")} <b>واژگان (لایتنر)</b>\n`;
  text += `  سوالات پاسخ‌داده: <b>${stats.leitner_questions}</b>\n`;
  if (stats.leitner_questions > 0) {
    const accuracy = Math.round((stats.leitner_correct / stats.leitner_questions) * 100);
    text += `  ✅ درست: <b>${stats.leitner_correct}</b>  ❌ غلط: <b>${stats.leitner_incorrect}</b>\n`;
    text += `  📈 دقت: <b>${accuracy}٪</b>\n`;
  }
  text += `  🆕 واژه‌های یادگرفته: <b>${stats.new_words_learned}</b>\n`;

  text += `\n${pe("📖")} <b>درک مطلب</b>\n`;
  text += `  تست‌های انجام‌شده: <b>${stats.reading_sets}</b>\n`;
  if (stats.reading_questions_total > 0) {
    const rAccuracy = Math.round((stats.reading_questions_correct / stats.reading_questions_total) * 100);
    text += `  سوالات: <b>${stats.reading_questions_correct}</b> درست از <b>${stats.reading_questions_total}</b> (${rAccuracy}٪)\n`;
  }

  text += `\n${pe("⭐️")} XP کسب شده: <b>${stats.xp}</b>`;

  return text;
}

/**
 * Handle the stats period selection callback and display activity statistics.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query containing the chosen period
 * @returns void
 */
export async function handleStatsCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts.length !== 2 || parts[0] !== CB_PREFIX.STATS) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const period = parts[1] as ActivityPeriod;
  if (!["day", "week", "month", "all"].includes(period)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  const stats = await getUserActivityStats(env, user.id, period);

  await answerCallbackQuery(env, callbackQuery.id);

  const text = buildStatsText(stats);
  await sendMessage(env, chatId, text);
}

/**
 * Show a concise profile summary card with name, XP, avatar, and join date.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the summary to
 * @returns void
 */
export async function showProfileSummary(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName =
    profile?.display_name ||
    user.first_name ||
    user.username ||
    `user_${user.id}`;

  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);
  const xpTotal = profile?.xp_total ?? 0;

  const createdAt = profile?.created_at ?? "";
  const createdDateJalali = createdAt ? toJalaliString(createdAt) : "-";

  const text =
    `${pe("👑")} <b>کارت شناسایی زبان‌آموز</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 نام: <b>${escapeHtml(displayName)}</b>\n` +
    `${pe("⭐️")} امتیاز کل: <b>${xpTotal}</b> XP\n` +
    `🎭 آواتار: ${avatarEmoji}\n` +
    `📅 تاریخ عضویت: <b>${createdDateJalali}</b>`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}
