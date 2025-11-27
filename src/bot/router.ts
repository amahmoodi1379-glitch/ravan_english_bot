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
  handleReadingAnswerCallback
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
import { CB_PREFIX } from "../config/constants";
// --- ایمپورت‌های جدید اضافه شده ---
import { getOrCreateUser } from "../db/users";
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

// --- تابع هندل مسیج جدید (با قابلیت چک کردن لایسنس) ---
async function handleMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const text = message.text;
  const chatId = message.chat.id;
  const tgUser = message.from;

  if (!text || !tgUser) {
    return;
  }

  // 1. دریافت اطلاعات کاربر از دیتابیس
  const user = await getOrCreateUser(env, tgUser);

  // 2. چک کردن وضعیت تایید (لایسنس)
  if (!user.is_approved) {
    // اگر کاربر کدی ارسال کرده، بررسی کن
    const inputCode = text.trim();
    
    // چک کنیم آیا این کد در جدول کدهای ما وجود دارد و استفاده نشده؟
    const codeRow = await queryOne<{ code: string }>(
      env,
      `SELECT code FROM access_codes WHERE code = ? AND used_by_user_id IS NULL`,
      [inputCode]
    );

    if (codeRow) {
      // کد معتبر است!
      const now = new Date().toISOString();
      
      // الف: کد را باطل کن (بزن به نام این کاربر)
      await execute(
        env,
        `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ?`,
        [user.id, now, inputCode]
      );

      // ب: کاربر را تایید کن
      await execute(
        env,
        `UPDATE users SET is_approved = 1 WHERE id = ?`,
        [user.id]
      );

      await sendMessage(env, chatId, "✅ تبریک! لایسنس شما تایید شد.\nحالا می‌تونی از ربات استفاده کنی. بزن روی /start");
    } else {
      // کد نامعتبر یا قبلا استفاده شده
      await sendMessage(env, chatId, "⛔️ شما مجوز استفاده از این ربات را ندارید.\nلطفاً کد لایسنس معتبر خود را ارسال کنید.");
    }
    return; // <--- خیلی مهم: اینجا تابع را متوقف می‌کنیم تا بقیه دستورات اجرا نشوند
  }

  // --- از اینجا به بعد کدهای قبلی ربات اجرا می‌شوند (چون کاربر تایید شده است) ---

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
    await startReadingMenuForUser(env, update);
    return;
  }
  if (text === TRAINING_MENU_BUTTON_REFLECTION) {
    await startReflectionForUser(env, update);
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
