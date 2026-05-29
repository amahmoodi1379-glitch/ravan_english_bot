import { Env } from "../types";
import {
  getMainMenuKeyboard,
  getTrainingMenuKeyboard,
  getProfileMenuKeyboard,
  MAIN_MENU_BUTTON_TRAINING,
  MAIN_MENU_BUTTON_PROFILE,
  TRAINING_MENU_BUTTON_LEITNER,
  TRAINING_MENU_BUTTON_READING,
  TRAINING_MENU_BUTTON_BACK,
  PROFILE_MENU_BUTTON_SETTINGS,
  PROFILE_MENU_BUTTON_STATS,
  PROFILE_MENU_BUTTON_SUMMARY
} from "./keyboards";
import { sendMessage, answerCallbackQuery } from "./telegram-api";
import { handleStartCommand } from "./handlers/start";
import {
  startLeitnerForUser,
  handleLeitnerCallback
} from "./handlers/leitner";
import {
  startReadingMenuForUser,
  handleReadingTextChosen,
  handleReadingAnswerCallback,
  handleReadingTitleSelection
} from "./handlers/reading";
import {
  showProfileHome,
  showProfileSettings,
  startProfileStats,
  showProfileSummary,
  handleAvatarCallback,
  handleStatsCallback,
  handleSetDisplayNameCommand
} from "./handlers/profile";
import { CB_PREFIX } from "../config/constants";
import { getOrCreateUser, getUserByTelegramId } from "../db/users";
import { queryOne, execute } from "../db/client";

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  if (update.message) {
    await handleMessage(env, update);
    return;
  }
}

async function handleCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";

  // Leitner (l:...)
  if (data.startsWith(`${CB_PREFIX.LEITNER}:`)) {
    await handleLeitnerCallback(env, callbackQuery);
    return;
  }

  // Reading Text Selection (rt:...)
  if (data.startsWith(`${CB_PREFIX.READING_TEXT}:`)) {
    await handleReadingTextChosen(env, callbackQuery);
    return;
  }

  // Reading Answer (ra:...)
  if (data.startsWith(`${CB_PREFIX.READING_ANSWER}:`)) {
    await handleReadingAnswerCallback(env, callbackQuery);
    return;
  }

  // Avatar (av:...)
  if (data.startsWith(`${CB_PREFIX.AVATAR}:`)) {
    await handleAvatarCallback(env, callbackQuery);
    return;
  }

  // Stats (st:...)
  if (data.startsWith(`${CB_PREFIX.STATS}:`)) {
    await handleStatsCallback(env, callbackQuery);
    return;
  }

  // اگر دکمه ناشناس بود، لودینگ را ببند تا کاربر معطل نشود
  await answerCallbackQuery(env, callbackQuery.id);
}

async function handleMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const text = message.text;
  const chatId = message.chat.id;
  const tgUser = message.from;

  if (!text || !tgUser) {
    return;
  }

  // 1. اول فقط چک می‌کنیم کاربر قبلاً ثبت نام کرده یا نه (بدون ساختن)
  let user = await getUserByTelegramId(env, tgUser.id);

  // 2. اگر کاربر در دیتابیس نیست (یعنی هنوز ثبت نام نشده)
  if (!user) {
    // اصلاح باگ: جدا کردن دستور /start از کد لایسنس
    let inputCode = text.trim();
    if (inputCode.startsWith("/start")) {
      inputCode = inputCode.replace("/start", "").trim();
    }

    // اگر کاربر فقط /start خالی فرستاده بود (بدون کد)
    if (!inputCode) {
      await sendMessage(env, chatId, "👋 سلام! به ربات خوش اومدی.\n\nاین یک ربات خصوصی است. لطفاً کد لایسنس (Access Code) خودتون رو ارسال کنید تا اکانت شما فعال شود.");
      return;
    }

    // کاربر را می‌سازیم
    user = await getOrCreateUser(env, tgUser);
    
    const now = new Date().toISOString();

    // تلاش برای تایید کد
    const result = await execute(
      env,
      `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
      [user.id, now, inputCode]
    );

    if (result.meta.changes > 0) {
      // کد صحیح بود
      await execute(
        env,
        `UPDATE users SET is_approved = 1 WHERE id = ?`,
        [user.id]
      );
      user.is_approved = 1;
      await sendMessage(env, chatId, "✅ تبریک! لایسنس شما تایید شد.\nحالا می‌تونی از ربات استفاده کنی. برای شروع روی /start بزن یا از منو استفاده کن.");
      return;
    } else {
      // کد غلط بود
      await sendMessage(
        env,
        chatId,
        "⛔️ کد لایسنس نامعتبر است یا قبلاً استفاده شده.\nلطفاً کد صحیح را ارسال کنید."
      );
      return; 
    }
  }

 // 3. اگر کاربر در دیتابیس هست، اما هنوز تایید نشده
  if (user && !user.is_approved) {
    // اصلاح باگ: اینجا هم باید /start رو تمیز کنیم
    let inputCode = text.trim();
    if (inputCode.startsWith("/start")) {
      inputCode = inputCode.replace("/start", "").trim();
    }

    if (!inputCode) {
      await sendMessage(env, chatId, "لطفاً کد لایسنس خود را ارسال کنید:");
      return;
    }

    const now = new Date().toISOString();

    const result = await execute(
      env,
      `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
      [user.id, now, inputCode]
    );

    if (result.meta.changes > 0) {
      await execute(
        env,
        `UPDATE users SET is_approved = 1 WHERE id = ?`,
        [user.id]
      );
      user.is_approved = 1;

      await sendMessage(env, chatId, "✅ اکانت شما فعال شد! حالا می‌تونید از ربات استفاده کنید.");
    } else {
      await sendMessage(env, chatId, "⛔️ کد وارد شده معتبر نیست. لطفاً کد صحیح را ارسال کنید.");
    }
    return;
  }

  // --- از اینجا به بعد یعنی کاربر هم هست و هم تایید شده ---

  if (text.startsWith("/setname")) {
    await handleSetDisplayNameCommand(env, update);
    return;
  }

  if (text === "/start") {
    await handleStartCommand(env, update);
    return;
  }

  if (text === MAIN_MENU_BUTTON_TRAINING) {
    await sendMessage(
      env,
      chatId,
      "یکی از گزینه‌های تمرین رو انتخاب کن:",
      { reply_markup: getTrainingMenuKeyboard() }
    );
    return;
  }
  if (text === MAIN_MENU_BUTTON_PROFILE) {
    await showProfileHome(env, update);
    return;
  }

  if (text === TRAINING_MENU_BUTTON_LEITNER) {
    await startLeitnerForUser(env, update);
    return;
  }

  if (text === TRAINING_MENU_BUTTON_READING) {
    await startReadingMenuForUser(env, update, 1);
    return;
  }

  if (text.includes("صفحه") && (text.includes("◀️") || text.includes("▶️"))) {
     const numMatch = text.match(/\d+/);
     if (numMatch) {
        const page = parseInt(numMatch[0]);
        if (!isNaN(page)) {
            await startReadingMenuForUser(env, update, page);
            return;
        }
     }
  }

  const isReadingTitle = await handleReadingTitleSelection(env, update, text);
  if (isReadingTitle) {
    return;
  }
  
  if (text === TRAINING_MENU_BUTTON_BACK) {
    await sendMessage(
      env,
      chatId,
      "به منوی اصلی برگشتی 👇",
      { reply_markup: getMainMenuKeyboard() }
    );
    return;
  }

  if (text === PROFILE_MENU_BUTTON_SETTINGS) {
    await showProfileSettings(env, update);
    return;
  }
  if (text === PROFILE_MENU_BUTTON_STATS) {
    await startProfileStats(env, update);
    return;
  }
  if (text === PROFILE_MENU_BUTTON_SUMMARY) {
    await showProfileSummary(env, update);
    return;
  }

  // === فیکس: اگر کاربر در میانه تست درک مطلب است و کیبورد حذف شده ===
  const activeReadingSession = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeReadingSession) {
    await sendMessage(
      env,
      chatId,
      "📖 تو الان در حال تست درک مطلب هستی! لطفاً روی دکمه‌های زیر سوالات کلیک کن.\nاگر می‌خوای تست رو رها کنی، دکمه «❌ انصراف و خروج» رو بزن یا از منوی زیر استفاده کن 👇",
      { reply_markup: getMainMenuKeyboard() }
    );
    return;
  }
  // ============================================================

  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
