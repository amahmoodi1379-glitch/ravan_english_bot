import { Env } from "../types";
import { TelegramUpdate, TelegramCallbackQuery } from "./types";
import {
  getMainMenuKeyboard,
  getTrainingMenuKeyboard,
  MAIN_MENU_BUTTON_TRAINING,
  MAIN_MENU_BUTTON_PROFILE,
  MAIN_MENU_BUTTON_LEADERBOARD,
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
  handleReadingAnswerCallback
} from "./handlers/reading";
import {
  showLeaderboardHome,
  handleLeaderboardCallback
} from "./handlers/leaderboard";
import {
  handleQuizStart,
  handleQuizUserCallback
} from "./handlers/custom_quiz_user";
import {
  handleQuizAdminCallback
} from "./handlers/custom_quiz_admin";
import {
  showProfileHome,
  showProfileSettings,
  startProfileStats,
  showProfileSummary,
  handleAvatarCallback,
  handleStatsCallback,
  handleSetDisplayNameCommand
} from "./handlers/profile";
import {
  handleAdminCommand
} from "./handlers/admin";
import { handleNewUserLicenseFlow, handleUnapprovedUserLicenseFlow } from "./handlers/license";
import { checkAndCancelStaleSession } from "./handlers/reading";
import { CB_PREFIX } from "../config/constants";
import { getUserByTelegramId, touchExistingUser } from "../db/users";

/**
 * Process an incoming Telegram update by delegating to callback or message handlers.
 * @param env - The worker environment containing bindings and secrets
 * @param update - The raw Telegram Update object from the webhook
 * @returns void
 */
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

const leitnerPrefixes = new Set([
  CB_PREFIX.LEITNER,
  CB_PREFIX.LEITNER_IGNORE,
  CB_PREFIX.LEITNER_IGNORE_CONFIRM,
  CB_PREFIX.LEITNER_RATE,
  CB_PREFIX.LEITNER_NEXT,
  CB_PREFIX.LEITNER_EXIT,
  CB_PREFIX.LEITNER_EXIT_CONFIRM,
  CB_PREFIX.LEITNER_DUNNO,
  CB_PREFIX.LEITNER_HOME,
  CB_PREFIX.LEITNER_UNLEECH,
  CB_PREFIX.LEITNER_NEW_LEVEL,
  CB_PREFIX.LEITNER_REVIEW_LEVEL,
  CB_PREFIX.LEITNER_LESSON_PICK,
  CB_PREFIX.LEITNER_LESSON_CONT,
  CB_PREFIX.LEITNER_LESSON_STOP,
]);

async function handleCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const prefix = data.split(":")[0];

  if (leitnerPrefixes.has(prefix)) {
    await handleLeitnerCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.READING_TEXT}:`)) {
    await handleReadingTextChosen(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.READING_ANSWER}:`)) {
    await handleReadingAnswerCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.AVATAR}:`)) {
    await handleAvatarCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.STATS}:`)) {
    await handleStatsCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.LEADERBOARD}:`)) {
    await handleLeaderboardCallback(env, callbackQuery);
    return;
  }

  if (data.startsWith(`${CB_PREFIX.QUIZ}:`)) {
    const parts = data.split(":");
    const subAction = parts[1] || "";
    if (subAction.startsWith("admin")) {
      await handleQuizAdminCallback(env, callbackQuery);
      return;
    }
    await handleQuizUserCallback(env, callbackQuery);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
}



async function handleMessage(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const text = message.text;
  const chatId = message.chat.id;
  const tgUser = message.from;

  if (!tgUser) {
    return;
  }

  const adminHandled = await handleAdminCommand(env, update);
  if (adminHandled) return;

  if (!text) {
    return;
  }

  let user = await getUserByTelegramId(env, tgUser.id);

  if (!user) {
    await handleNewUserLicenseFlow(env, chatId, tgUser, text);
    return;
  }

  if (!user.is_approved) {
    await handleUnapprovedUserLicenseFlow(env, chatId, user, text);
    return;
  }

  if (user.is_banned) {
    const banMessage = user.banned_until
      ? `🚫 حساب کاربری شما مسدود شده است.\nتاریخ رفع مسدودیت: ${new Date(user.banned_until).toLocaleDateString('fa-IR')}`
      : "🚫 حساب کاربری شما به طور دائمی مسدود شده است.";

    await sendMessage(env, chatId, banMessage);
    return;
  }

  await touchExistingUser(env, user, tgUser);

  if (text.startsWith("/setname")) {
    await handleSetDisplayNameCommand(env, user, chatId, text);
    return;
  }

  const quizDeepLinkMatch = text.match(/^\/start(?:@[\w_]+)?\s+quiz_(\S+)/);
  if (quizDeepLinkMatch) {
    const token = quizDeepLinkMatch[1];
    if (token) {
      await handleQuizStart(env, user, chatId, token);
      return;
    }
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
    await showProfileHome(env, user, chatId);
    return;
  }

  if (text === MAIN_MENU_BUTTON_LEADERBOARD) {
    await showLeaderboardHome(env, chatId);
    return;
  }

  if (text === TRAINING_MENU_BUTTON_LEITNER) {
    await startLeitnerForUser(env, user, chatId);
    return;
  }

  if (text === TRAINING_MENU_BUTTON_READING) {
    await startReadingMenuForUser(env, chatId, 1);
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
    await showProfileSettings(env, user, chatId);
    return;
  }
  if (text === PROFILE_MENU_BUTTON_STATS) {
    await startProfileStats(env, chatId);
    return;
  }
  if (text === PROFILE_MENU_BUTTON_SUMMARY) {
    await showProfileSummary(env, user, chatId);
    return;
  }

  const staleHandled = await checkAndCancelStaleSession(env, user, chatId);
  if (staleHandled) return;

  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
