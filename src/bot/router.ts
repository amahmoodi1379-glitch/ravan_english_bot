import { Env } from "../types";
import {
  getMainMenuKeyboard,
  getTrainingMenuKeyboard,
  getCompetitionsMenuKeyboard,
  getProfileMenuKeyboard,
  MAIN_MENU_BUTTON_TRAINING,
  MAIN_MENU_BUTTON_COMPETITIONS,
  MAIN_MENU_BUTTON_PROFILE,
  TRAINING_MENU_BUTTON_LEITNER,
  TRAINING_MENU_BUTTON_READING,
  TRAINING_MENU_BUTTON_REFLECTION,
  TRAINING_MENU_BUTTON_BACK,
  COMP_MENU_BUTTON_DUEL_EASY,
  COMP_MENU_BUTTON_DUEL_HARD,
  COMP_MENU_BUTTON_LEADERBOARD,
  PROFILE_MENU_BUTTON_SETTINGS,
  PROFILE_MENU_BUTTON_STATS,
  PROFILE_MENU_BUTTON_SUMMARY
} from "./keyboards";
import { sendMessage } from "./telegram-api";
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
  startDuelEasyForUser,
  startDuelHardForUser,
  handleDuelAnswerCallback
} from "./handlers/duel";
import {
  startLeaderboardMenu,
  handleLeaderboardCallback
} from "./handlers/leaderboard";
import {
  showProfileHome,
  showProfileSettings,
  startProfileStats,
  showProfileSummary,
  handleAvatarCallback,
  handleStatsCallback,
  handleSetDisplayNameCommand
} from "./handlers/profile";
import { startReflectionForUser, handleReflectionAnswer } from "./handlers/reflection";
import { deletePendingReflectionSession } from "../db/reflection";
import { CB_PREFIX } from "../config/constants";
import { getOrCreateUser, getUserByTelegramId } from "../db/users";
import { queryOne, execute } from "../db/client";
import { quitActiveMatch } from "../db/duels";

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

  // Duel (d:...)
  if (data.startsWith(`${CB_PREFIX.DUEL}:`)) {
    await handleDuelAnswerCallback(env, callbackQuery);
    return;
  }

  // Leaderboard (lb:...)
  if (data.startsWith(`${CB_PREFIX.LEADERBOARD}:`)) {
    await handleLeaderboardCallback(env, callbackQuery);
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
    const inputCode = text.trim();

    // کاربر را می‌سازیم (اما هنوز تایید نشده)
    user = await getOrCreateUser(env, tgUser);
    
    const now = new Date().toISOString();

    // === اصلاح امنیتی: تلاش برای گرفتن کد به صورت اتمیک ===
    // این دستور همزمان چک می‌کند کد آزاد باشد و آن را به نام کاربر می‌زند
    const result = await execute(
      env,
      `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
      [user.id, now, inputCode]
    );

    // بررسی می‌کنیم آیا دیتابیس تغییری کرد؟ (یعنی آیا کد با موفقیت گرفته شد؟)
    if (result.meta.changes > 0) {
      // عالی! کد مال این کاربر شد. حالا کاربر را تایید می‌کنیم
      await execute(
        env,
        `UPDATE users SET is_approved = 1 WHERE id = ?`,
        [user.id]
      );
      // آبجکت کاربر در حافظه را هم آپدیت می‌کنیم
      user.is_approved = 1;

      await sendMessage(env, chatId, "✅ تبریک! لایسنس شما تایید شد.\nثبت‌نام شما انجام شد و حالا می‌تونی از ربات استفاده کنی. بزن روی /start");
      return;
    } else {
      // کد پیدا نشد یا قبلاً توسط کسی دیگر استفاده شده
      await sendMessage(
        env,
        chatId,
        "⛔️ این ربات خصوصی است.\n\nکد لایسنس ارسال شده نامعتبر است یا قبلاً استفاده شده. لطفاً کد صحیح را ارسال کنید."
      );
      return; 
    }
  }

  // 3. اگر کاربر در دیتابیس هست، اما هنوز تایید نشده (شاید قبلاً کد غلط زده)
  if (user && !user.is_approved) {
    const inputCode = text.trim();
    const now = new Date().toISOString();

    // === اصلاح امنیتی مشابه بالا ===
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

      await sendMessage(env, chatId, "✅ اکانت شما فعال شد! مجدد تلاش کنید.");
    } else {
      await sendMessage(env, chatId, "⛔️ اکانت شما هنوز تایید نشده است. لطفاً کد لایسنس صحیح و استفاده‌نشده را ارسال کنید.");
    }
    return;
  }

  // --- کد جدید: پاکسازی تمرین‌های نیمه‌کاره با تغییر منو ---
  const EXIT_COMMANDS = [
    "/start",
    MAIN_MENU_BUTTON_TRAINING,
    MAIN_MENU_BUTTON_COMPETITIONS,
    MAIN_MENU_BUTTON_PROFILE,
    TRAINING_MENU_BUTTON_LEITNER,
    TRAINING_MENU_BUTTON_READING,
    TRAINING_MENU_BUTTON_REFLECTION,
    TRAINING_MENU_BUTTON_BACK,
    COMP_MENU_BUTTON_DUEL_EASY,
    COMP_MENU_BUTTON_DUEL_HARD,
    COMP_MENU_BUTTON_LEADERBOARD,
    PROFILE_MENU_BUTTON_SETTINGS,
    PROFILE_MENU_BUTTON_STATS,
    PROFILE_MENU_BUTTON_SUMMARY
  ];

  if (EXIT_COMMANDS.includes(text) || text.startsWith("/setname")) {
     if (user) {
       await deletePendingReflectionSession(env, user.id);
     }
  }
  // -------------------------------------------------------

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
  if (text === MAIN_MENU_BUTTON_COMPETITIONS) {
    await sendMessage(
      env,
      chatId,
      "یکی از گزینه‌های رقابت رو انتخاب کن:",
      { reply_markup: getCompetitionsMenuKeyboard() }
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
  
  if (text === TRAINING_MENU_BUTTON_REFLECTION) {
    await startReflectionForUser(env, update);
    return;
  }
  if (text === TRAINING_MENU_BUTTON_BACK) {
    const user = await getOrCreateUser(env, tgUser);
    await quitActiveMatch(env, user.id);

    await sendMessage(
      env,
      chatId,
      "به منوی اصلی برگشتی 👇",
      { reply_markup: getMainMenuKeyboard() }
    );
    return;
  }

  if (text === COMP_MENU_BUTTON_DUEL_EASY) {
    await startDuelEasyForUser(env, update);
    return;
  }
  if (text === COMP_MENU_BUTTON_DUEL_HARD) {
    await startDuelHardForUser(env, update);
    return;
  }
  if (text === COMP_MENU_BUTTON_LEADERBOARD) {
    await startLeaderboardMenu(env, update);
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

  const wasReflection = await handleReflectionAnswer(env, update, text);
  if (wasReflection) {
    return;
  }

  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
