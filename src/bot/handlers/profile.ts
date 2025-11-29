import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getProfileMenuKeyboard } from "../keyboards";
import { getOrCreateUser } from "../../db/users";
import {
  getUserProfile,
  updateDisplayName,
  setAvatar,
  getUserActivityStats,
  ActivityPeriod,
  ActivityStats
} from "../../db/profile";
import { CB_PREFIX } from "../../config/constants";

const AVATARS: { code: string; emoji: string; label: string }[] = [
  { code: "cat", emoji: "😺", label: "گربه" },
  { code: "fox", emoji: "🦊", label: "روباه" },
  { code: "owl", emoji: "🦉", label: "جغد" },
  { code: "panda", emoji: "🐼", label: "پاندا" },
  { code: "lion", emoji: "🦁", label: "شیر" },
  { code: "robot", emoji: "🤖", label: "ربات" }
];

function getAvatarEmoji(code: string | null | undefined): string {
  const found = AVATARS.find((a) => a.code === code);
  return found ? found.emoji : "🙂";
}

function getAvatarLabel(code: string | null | undefined): string {
  const found = AVATARS.find((a) => a.code === code);
  return found ? found.label : "پیش‌فرض";
}

// تابع اصلاح شده برای محاسبه دقیق زنجیره با ساعت ایران
async function getStreakInfo(env: Env, userId: number): Promise<number> {
  // ۱. گرفتن اطلاعات زنجیره کاربر از دیتابیس
  const row = await env.DB.prepare(`SELECT streak_count, last_streak_date FROM users WHERE id = ?`).bind(userId).first();
  if (!row) return 0;
  
  const count = (row.streak_count as number) || 0;
  const lastDate = (row.last_streak_date as string) || ""; // این تاریخ با وقت ایران ذخیره شده
  
  if (count === 0) return 0;

  // ۲. گرفتن تاریخ دقیق "امروز" و "دیروز" به وقت ایران مستقیماً از دیتابیس
  // این کار باعث میشه ساعت سرور (UTC) دخالتی نکنه و باگ برطرف بشه
  const dateCheck = await env.DB.prepare(`
    SELECT 
      date('now', '+3.5 hours') as today_local,
      date('now', '+3.5 hours', '-1 day') as yesterday_local
  `).first();

  const todayStr = dateCheck?.today_local as string;
  const yesterdayStr = dateCheck?.yesterday_local as string;

  // ۳. مقایسه تاریخ‌ها (چون همه چیز متنی و دقیق شده، دیگه اشتباه نمیشه)
  // اگر آخرین تمرین "امروز" یا "دیروز" بوده باشه، زنجیره برقراره
  if (lastDate === todayStr || lastDate === yesterdayStr) {
    return count;
  }
  
  return 0; // متاسفانه زنجیره پاره شده
}

export async function showProfileHome(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  const user = await getOrCreateUser(env, tgUser);
  const profile = await getUserProfile(env, user.id);

  const displayName =
    profile?.display_name ||
    user.first_name ||
    user.username ||
    `user_${user.id}`;

  const xpTotal = profile?.xp_total ?? 0;
  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);

  // دریافت وضعیت زنجیره
  const streakCount = await getStreakInfo(env, user.id);
  const streakText = streakCount > 0 ? `🔥 <b>${streakCount}</b> روز` : "خاموش ❄️";

  const text =
    `👤 پروفایل تو:\n\n` +
    `نام نمایشی: <b>${displayName}</b>\n` +
    `XP کلی: <b>${xpTotal}</b>\n` +
    `زنجیره (Streak): ${streakText}\n` + // <--- نمایش زنجیره
    `آواتار فعلی: ${avatarEmoji}\n\n` +
    `از منوی زیر یکی از گزینه‌های پروفایل رو انتخاب کن.`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}

export async function showProfileSettings(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  const user = await getOrCreateUser(env, tgUser);
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
    `⚙️ تنظیمات پروفایل\n\n` +
    `نام نمایشی فعلی: <b>${displayName}</b>\n` +
    `تعداد تغییرات نام باقی‌مانده: <b>${remainingChanges}</b> از 3\n\n` +
    `برای تغییر نام نمایشی، دستور زیر را ارسال کن:\n` +
    `<code>/setname نام_جدید</code>\n\n` +
    `آواتار فعلی: ${avatarEmoji} (${avatarLabel})\n` +
    `برای تغییر آواتار، یکی از گزینه‌های زیر را انتخاب کن:`;

  const inlineRows: any[][] = [];
  for (let i = 0; i < AVATARS.length; i += 3) {
    const slice = AVATARS.slice(i, i + 3);
    inlineRows.push(
      slice.map((a) => ({
        text: `${a.emoji} ${a.label}`,
        // av:<code>
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

export async function handleAvatarCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  // av:<code>
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
  const tgUser = callbackQuery.from;
  const user = await getOrCreateUser(env, tgUser);

  await setAvatar(env, user.id, code);

  await answerCallbackQuery(env, callbackQuery.id, "آواتار به‌روزرسانی شد ✅");

  const text = `آواتارت تغییر کرد به ${avatar.emoji} ${avatar.label} ✅`;
  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}

export async function handleSetDisplayNameCommand(
  env: Env,
  update: TelegramUpdate
): Promise<void> {
  const message = update.message;
  if (!message || !message.from || !message.text) return;

  const chatId = message.chat.id;
  const tgUser = message.from;
  const user = await getOrCreateUser(env, tgUser);

  const fullText = message.text.trim();
  const parts = fullText.split(" ");
  const newName = parts.slice(1).join(" ").trim();

  if (!newName) {
    await sendMessage(
      env,
      chatId,
      "برای تغییر نام، بعد از دستور /setname نام جدید رو بنویس.\nمثلاً:\n<code>/setname علی</code>"
    );
    return;
  }

  if (newName.length > 32) {
    await sendMessage(env, chatId, "نام جدید خیلی طولانیه. حداکثر ۳۲ کاراکتر باشه.");
    return;
  }

  const result = await updateDisplayName(env, user.id, newName);

  if (!result.ok) {
    if (result.reason === "limit") {
      await sendMessage(
        env,
        chatId,
        "دیگه نمی‌تونی نام نمایشی رو عوض کنی (حداکثر ۳ بار در طول عمر حساب)."
      );
    } else {
      await sendMessage(env, chatId, "در تغییر نام مشکلی پیش اومد.");
    }
    return;
  }

  const remaining = result.remainingChanges ?? 0;

  await sendMessage(
    env,
    chatId,
    `نام نمایشی‌ات به <b>${newName}</b> تغییر کرد ✅\nتعداد تغییرات باقی‌مانده: <b>${remaining}</b> از 3.`,
    {
      reply_markup: getProfileMenuKeyboard()
    }
  );
}

export async function startProfileStats(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  await getOrCreateUser(env, tgUser);

  await sendMessage(
    env,
    chatId,
    "برای دیدن آمار فعالیت، بازه‌ی زمانی رو انتخاب کن:",
    {
      reply_markup: {
        inline_keyboard: [
          // st:<period>
          [{ text: "امروز", callback_data: `${CB_PREFIX.STATS}:day` }],
          [{ text: "۷ روز اخیر", callback_data: `${CB_PREFIX.STATS}:week` }],
          [{ text: "۳۰ روز اخیر", callback_data: `${CB_PREFIX.STATS}:month` }],
          [{ text: "همه‌ی زمان‌ها", callback_data: `${CB_PREFIX.STATS}:all` }]
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

  let text =
    `📈 آمار فعالیت تو در بازه ${label}:\n\n` +
    `سوال‌های لایتنر: <b>${stats.leitner_questions}</b>\n` +
    `ست‌های تست درک مطلب: <b>${stats.reading_sets}</b>\n` +
    `دوئل‌ها: <b>${stats.duels}</b>\n` +
    `تمرین‌های برداشت از متن: <b>${stats.reflections}</b>\n` +
    `\nXP این بازه: <b>${stats.xp}</b>`;

  return text;
}

export async function handleStatsCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  // st:<period>
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
  const tgUser = callbackQuery.from;
  const user = await getOrCreateUser(env, tgUser);

  const stats = await getUserActivityStats(env, user.id, period);

  await answerCallbackQuery(env, callbackQuery.id);

  const text = buildStatsText(stats);
  await sendMessage(env, chatId, text);
}

export async function showProfileSummary(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  const user = await getOrCreateUser(env, tgUser);
  const profile = await getUserProfile(env, user.id);

  const displayName =
    profile?.display_name ||
    user.first_name ||
    user.username ||
    `user_${user.id}`;

  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);
  const xpTotal = profile?.xp_total ?? 0;

  const createdAt = profile?.created_at ?? "";
  const createdDate = createdAt ? createdAt.substring(0, 10) : "-";
  const lastSeen = profile?.last_seen_at ?? "";
  const lastSeenDate = lastSeen ? lastSeen.substring(0, 10) : "-";

  const text =
    `🪪 خلاصه پروفایل:\n\n` +
    `نام نمایشی: <b>${displayName}</b>\n` +
    `XP کلی: <b>${xpTotal}</b>\n` +
    `آواتار: ${avatarEmoji}\n` +
    `تاریخ عضویت (UTC): <b>${createdDate}</b>\n` +
    `آخرین فعالیت ثبت‌شده (UTC): <b>${lastSeenDate}</b>`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}
