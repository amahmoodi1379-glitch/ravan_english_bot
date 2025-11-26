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
// NEW IMPORTS
import { startReflectionForUser, handleReflectionAnswer } from "./handlers/reflection";

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

  if (data.startsWith("leitner:")) {
    await handleLeitnerCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("reading:text:")) {
    await handleReadingTextChosen(env, callbackQuery);
    return;
  }

  if (data.startsWith("reading:ans:")) {
    await handleReadingAnswerCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("duel:")) {
    await handleDuelAnswerCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("lb:")) {
    await handleLeaderboardCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("avatar:")) {
    await handleAvatarCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith("stats:")) {
    await handleStatsCallback(env, callbackQuery);
    return;
  }
}

async function handleMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const text = message.text;
  const chatId = message.chat.id;

  if (!text) {
    return;
  }

  // اولویت ۱: دستورهای خاص (/start, /setname)
  if (text.startsWith("/setname")) {
    await handleSetDisplayNameCommand(env, update);
    return;
  }

  if (text === "/start") {
    await handleStartCommand(env, update);
    return;
  }

  // اولویت ۲: دکمه‌های منو
  // منوی اصلی
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

  // منوی تمرین‌ها
  if (text === TRAINING_MENU_BUTTON_LEITNER) {
    await startLeitnerForUser(env, update);
    return;
  }
  if (text === TRAINING_MENU_BUTTON_READING) {
    await startReadingMenuForUser(env, update);
    return;
  }
  // NEW: هندل کردن دکمه Reflection
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

  // منوی رقابت‌ها و پروفایل ...
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

  // اولویت ۳: بررسی اینکه آیا متن ارسالی، جواب تمرین Reflection است؟
  const wasReflection = await handleReflectionAnswer(env, update, text);
  if (wasReflection) {
    return; // پیام هندل شد
  }

  // اگر هیچکدام نبود
  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
