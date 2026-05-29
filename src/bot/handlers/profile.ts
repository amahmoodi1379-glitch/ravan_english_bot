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
import { CB_PREFIX, TIME_ZONE_OFFSET } from "../../config/constants";

// لیست جدید، متنوع و جذاب آواتارها
const AVATARS: { code: string; emoji: string; label: string }[] = [
  // حیوانات بامزه
  { code: "cat", emoji: "😺", label: "گربه" },
  { code: "fox", emoji: "🦊", label: "روباه" },
  { code: "panda", emoji: "🐼", label: "پاندا" },
  { code: "koala", emoji: "🐨", label: "کوالا" },
  
  // حیوانات قدرتمند
  { code: "lion", emoji: "🦁", label: "شیر" },
  { code: "tiger", emoji: "🐯", label: "ببر" },
  { code: "wolf", emoji: "🐺", label: "گرگ" },
  { code: "eagle", emoji: "🦅", label: "عقاب" },

  // پرندگان و فانتزی
  { code: "owl", emoji: "🦉", label: "جغد" },
  { code: "unicorn", emoji: "🦄", label: "تک‌شاخ" },
  { code: "dragon", emoji: "🐉", label: "اژدها" },
  { code: "dino", emoji: "🦖", label: "دایناسور" },

  // شخصیت‌ها
  { code: "robot", emoji: "🤖", label: "ربات" },
  { code: "alien", emoji: "👽", label: "فضایی" },
  { code: "ninja", emoji: "🥷", label: "نینجا" },
  { code: "ghost", emoji: "👻", label: "روح" },

  // مشاغل و انسان‌ها
  { code: "detective", emoji: "🕵️‍♂️", label: "کارآگاه" },
  { code: "astronaut", emoji: "👩‍🚀", label: "فضانورد" },
  { code: "scientist", emoji: "👨‍🔬", label: "دانشمند" },
  { code: "wizard", emoji: "🧙‍♂️", label: "جادوگر" }
];

function getAvatarEmoji(code: string | null | undefined): string {
  if (!code) return "👤"; // آواتار پیش‌فرض برای کاربرانی که انتخاب نکردند
  const found = AVATARS.find((a) => a.code === code);
  return found ? found.emoji : "👤"; // فال‌بک امن
}

function getAvatarLabel(code: string | null | undefined): string {
  if (!code) return "انتخاب نشده";
  const found = AVATARS.find((a) => a.code === code);
  return found ? found.label : "نامشخص";
}

// تابع اصلاح شده برای محاسبه دقیق زنجیره با ساعت ایران
async function getStreakInfo(env: Env, userId: number): Promise<number> {
  // ۱. گرفتن اطلاعات زنجیره کاربر از دیتابیس
  const row = await env.DB.prepare(`SELECT streak_count, last_streak_date FROM users WHERE id = ?`).bind(userId).first();
  if (!row) return 0;
  
  const count = (row.streak_count as number) || 0;
  const lastDate = (row.last_streak_date as string) || ""; 
  
  if (count === 0) return 0;

  // ۲. گرفتن تاریخ دقیق "امروز" و "دیروز" به وقت ایران
  const dateCheck = await env.DB.prepare(`
    SELECT 
      date('now', ?) as today_local,
      date('now', ?, '-1 day') as yesterday_local
  `).bind(TIME_ZONE_OFFSET, TIME_ZONE_OFFSET).first();

  const todayStr = dateCheck?.today_local as string;
  const yesterdayStr = dateCheck?.yesterday_local as string;

  // ۳. مقایسه تاریخ‌ها
  if (lastDate === todayStr || lastDate === yesterdayStr) {
    return count;
  }
  
  return 0; 
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
    `👤 <b>پروفایل کاربری</b>\n\n` +
    `🏷 نام نمایشی: <b>${displayName}</b>\n` +
    `⭐️ مجموع امتیاز: <b>${xpTotal}</b> XP\n` +
    `🔥 زنجیره مطالعه: ${streakText}\n` +
    `🖼 آواتار فعلی: ${avatarEmoji}\n\n` +
    `👇 از منوی زیر تنظیمات رو انتخاب کن:`;

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
    `⚙️ <b>تنظیمات پروفایل</b>\n\n` +
    `✏️ <b>نام نمایشی:</b> ${displayName}\n` +
    `<i>(تغییرات باقی‌مانده: ${remainingChanges} از 3)</i>\n` +
    `برای تغییر نام، دستور زیر رو بفرست:\n` +
    `<code>/setname اسم_جدید</code>\n\n` +
    `🎭 <b>آواتار فعلی:</b> ${avatarEmoji} (${avatarLabel})\n` +
    `برای تغییر، یکی از گزینه‌های زیر رو انتخاب کن: 👇`;

  const inlineRows: any[][] = [];
  // تغییر چیدمان به ۴ تایی برای زیبایی بیشتر
  for (let i = 0; i < AVATARS.length; i += 4) {
    const slice = AVATARS.slice(i, i + 4);
    inlineRows.push(
      slice.map((a) => ({
        text: `${a.emoji}`, // فقط ایموجی رو نشون میدیم که جا بشه
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

  await answerCallbackQuery(env, callbackQuery.id, "آواتار جدید ثبت شد! 😍");

  const text = `🎉 آواتار تو به ${avatar.emoji} <b>${avatar.label}</b> تغییر کرد!`;
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
    `✅ نام نمایشی به <b>${newName}</b> تغییر کرد.\nتعداد تغییرات باقی‌مانده: <b>${remaining}</b>`,
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
    "📊 بازه‌ی زمانی آمار رو انتخاب کن:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📅 امروز", callback_data: `${CB_PREFIX.STATS}:day` }],
          [{ text: "🗓 ۷ روز اخیر", callback_data: `${CB_PREFIX.STATS}:week` }],
          [{ text: "📆 ۳۰ روز اخیر", callback_data: `${CB_PREFIX.STATS}:month` }],
          [{ text: "♾ همه‌ی زمان‌ها", callback_data: `${CB_PREFIX.STATS}:all` }]
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
    `📈 <b>گزارش عملکرد (${label})</b>\n\n` +
    `🧠 سوال‌های لایتنر: <b>${stats.leitner_questions}</b>\n` +
    `📖 درک مطلب (Reading): <b>${stats.reading_sets}</b>\n` +
    `\n⭐️ <b>XP کسب شده: ${stats.xp}</b>`

  return text;
}

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
    `🪪 <b>کارت شناسایی زبان‌آموز</b>\n\n` +
    `👤 نام: <b>${displayName}</b>\n` +
    `⭐️ امتیاز کل: <b>${xpTotal}</b>\n` +
    `🎭 آواتار: ${avatarEmoji}\n` +
    `📅 تاریخ عضویت: <b>${createdDate}</b>\n` +
    `⏰ آخرین بازدید: <b>${lastSeenDate}</b>`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}
