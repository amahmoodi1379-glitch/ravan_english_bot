import { Env } from "../types";
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
import { CB_PREFIX } from "../config/constants";
import { getOrCreateUser, getUserByTelegramId, touchExistingUser, DbUser } from "../db/users";
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
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  video?: { file_id: string; file_size?: number; width?: number; height?: number; duration?: number };
  audio?: { file_id: string; file_size?: number; duration?: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; file_size?: number; duration?: number };
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

  if (
    data.startsWith(`${CB_PREFIX.LEITNER}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_IGNORE}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_IGNORE_CONFIRM}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_RATE}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_NEXT}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_EXIT}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_EXIT_CONFIRM}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_DUNNO}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_HOME}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_UNLEECH}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_NEW_LEVEL}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_REVIEW_LEVEL}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_LESSON_PICK}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_LESSON_CONT}:`) ||
    data.startsWith(`${CB_PREFIX.LEITNER_LESSON_STOP}:`)
  ) {
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

function extractLicenseCode(text: string): string {
  let code = text.trim();
  if (code.startsWith("/start")) {
    code = code.replace("/start", "").trim();
  }
  return code;
}

async function applyLicenseCode(
  env: Env,
  user: DbUser,
  code: string
): Promise<{ ok: boolean; expireMessage: string }> {
  const licenseInfo = await queryOne<{ expiration_days: number | null }>(
    env,
    `SELECT expiration_days FROM access_codes WHERE code = ? AND used_by_user_id IS NULL`,
    [code]
  );
  if (!licenseInfo) return { ok: false, expireMessage: "" };

  const now = new Date().toISOString();
  const result = await execute(
    env,
    `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
    [user.id, now, code]
  );
  if (result.meta.changes === 0) return { ok: false, expireMessage: "" };

  let expireMessage = "";
  if (licenseInfo.expiration_days && licenseInfo.expiration_days > 0) {
    const expireDate = new Date(Date.now() + licenseInfo.expiration_days * 24 * 60 * 60 * 1000);
    expireMessage = `\n⏰ اعتبار لایسنس: ${licenseInfo.expiration_days} روز (تا ${expireDate.toLocaleDateString('fa-IR')})`;
  }

  await execute(env, `UPDATE users SET is_approved = 1 WHERE id = ?`, [user.id]);
  user.is_approved = 1;
  return { ok: true, expireMessage };
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
    const inputCode = extractLicenseCode(text);
    if (!inputCode) {
      await sendMessage(env, chatId, "👋 سلام! به ربات خوش اومدی.\n\nاین یک ربات خصوصی است. لطفاً کد لایسنس (Access Code) خودتون رو ارسال کنید تا اکانت شما فعال شود.");
      return;
    }

    user = await getOrCreateUser(env, tgUser);
    const result = await applyLicenseCode(env, user, inputCode);
    if (result.ok) {
      await sendMessage(env, chatId, `✅ تبریک! لایسنس شما تایید شد.${result.expireMessage}\nحالا می‌تونی از ربات استفاده کنی. برای شروع روی /start بزن یا از منو استفاده کن.`);
    } else {
      await sendMessage(env, chatId, "⛔️ کد لایسنس نامعتبر است یا قبلاً استفاده شده.\nلطفاً کد صحیح را ارسال کنید.");
    }
    return;
  }

  if (!user.is_approved) {
    const inputCode = extractLicenseCode(text);
    if (!inputCode) {
      await sendMessage(env, chatId, "لطفاً کد لایسنس خود را ارسال کنید:");
      return;
    }

    const result = await applyLicenseCode(env, user, inputCode);
    if (result.ok) {
      await sendMessage(env, chatId, `✅ اکانت شما فعال شد!${result.expireMessage}\nحالا می‌تونید از ربات استفاده کنید.`);
    } else {
      await sendMessage(env, chatId, "⛔️ کد وارد شده معتبر نیست. لطفاً کد صحیح را ارسال کنید.");
    }
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

  const activeReadingSession = await queryOne<{ id: number; started_at: string }>(
    env,
    `SELECT id, started_at FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeReadingSession) {
    const sessionAgeHours = (Date.now() - new Date(activeReadingSession.started_at).getTime()) / (1000 * 60 * 60);

    if (sessionAgeHours > 2) {
      // Auto-cancel stale sessions (2 hours is generous)
      await execute(
        env,
        `UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`,
        [activeReadingSession.id]
      );
    } else {
      await sendMessage(
        env,
        chatId,
        "📖 یک تست درک مطلب فعال داری! روی دکمه‌های سوالات کلیک کن.\nاگه می‌خوای لغوش کنی، دکمه «❌ انصراف و خروج» رو بزن.",
        { reply_markup: getMainMenuKeyboard() }
      );
      return;
    }
  }

  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
