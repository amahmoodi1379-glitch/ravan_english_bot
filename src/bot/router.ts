import { Env } from "../types";
import {
  getMainMenuKeyboard,
  getTrainingMenuKeyboard,
  getProfileMenuKeyboard,
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
  handleReadingAnswerCallback,
  handleReadingTitleSelection
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

  // Leitner (l:...)
  if (data.startsWith(`${CB_PREFIX.LEITNER}:`) || data.startsWith(`${CB_PREFIX.LEITNER_IGNORE}:`)) {
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

  // Leaderboard (lb:...)
  if (data.startsWith(`${CB_PREFIX.LEADERBOARD}:`)) {
    await handleLeaderboardCallback(env, callbackQuery);
    return;
  }

  // Quiz (qz:...)
  if (data.startsWith(`${CB_PREFIX.QUIZ}:`)) {
    // Admin quiz callbacks (admin_view, admin_detail_back, etc.)
    const parts = data.split(":");
    const subAction = parts[1] || "";
    if (subAction.startsWith("admin")) {
      await handleQuizAdminCallback(env, callbackQuery);
      return;
    }
    await handleQuizUserCallback(env, callbackQuery);
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

  // Must have a user to proceed
  if (!tgUser) {
    return;
  }

  // Check admin commands FIRST — this handles text AND media (photos/videos/etc.)
  // because the admin might be in 'await_announcement_content' state
  const adminHandled = await handleAdminCommand(env, update);
  if (adminHandled) return;

  // From here on, text is required for normal user flows
  if (!text) {
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

    // تلاش برای تایید کد و دریافت اطلاعات لایسنس
    const licenseInfo = await queryOne<{ expiration_days: number | null }>(
      env,
      `SELECT expiration_days FROM access_codes WHERE code = ? AND used_by_user_id IS NULL`,
      [inputCode]
    );

    if (licenseInfo) {
      // کد صحیح بود - استفاده از لایسنس
      const result = await execute(
        env,
        `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
        [user.id, now, inputCode]
      );

      if (result.meta.changes > 0) {
        // محاسبه تاریخ انقضا اگر لایسنس محدود داشته باشد
        let expireMessage = "";
        if (licenseInfo.expiration_days && licenseInfo.expiration_days > 0) {
          const expireDate = new Date(Date.now() + licenseInfo.expiration_days * 24 * 60 * 60 * 1000);
          expireMessage = `\n⏰ اعتبار لایسنس: ${licenseInfo.expiration_days} روز (تا ${expireDate.toLocaleDateString('fa-IR')})`;
        }

        await execute(
          env,
          `UPDATE users SET is_approved = 1 WHERE id = ?`,
          [user.id]
        );
        user.is_approved = 1;
        await sendMessage(env, chatId, `✅ تبریک! لایسنس شما تایید شد.${expireMessage}\nحالا می‌تونی از ربات استفاده کنی. برای شروع روی /start بزن یا از منو استفاده کن.`);
        return;
      }
    }
    
    // کد غلط بود
    await sendMessage(
      env,
      chatId,
      "⛔️ کد لایسنس نامعتبر است یا قبلاً استفاده شده.\nلطفاً کد صحیح را ارسال کنید."
    );
    return;
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

    // تلاش برای تایید کد و دریافت اطلاعات لایسنس
    const licenseInfo = await queryOne<{ expiration_days: number | null }>(
      env,
      `SELECT expiration_days FROM access_codes WHERE code = ? AND used_by_user_id IS NULL`,
      [inputCode]
    );

    if (licenseInfo) {
      // کد صحیح بود - استفاده از لایسنس
      const result = await execute(
        env,
        `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
        [user.id, now, inputCode]
      );

      if (result.meta.changes > 0) {
        // محاسبه تاریخ انقضا اگر لایسنس محدود داشته باشد
        let expireMessage = "";
        if (licenseInfo.expiration_days && licenseInfo.expiration_days > 0) {
          const expireDate = new Date(Date.now() + licenseInfo.expiration_days * 24 * 60 * 60 * 1000);
          expireMessage = `\n⏰ اعتبار لایسنس: ${licenseInfo.expiration_days} روز (تا ${expireDate.toLocaleDateString('fa-IR')})`;
        }

        await execute(
          env,
          `UPDATE users SET is_approved = 1 WHERE id = ?`,
          [user.id]
        );
        user.is_approved = 1;

        await sendMessage(env, chatId, `✅ اکانت شما فعال شد!${expireMessage}\nحالا می‌تونید از ربات استفاده کنید.`);
      } else {
        await sendMessage(env, chatId, "⛔️ کد وارد شده معتبر نیست. لطفاً کد صحیح را ارسال کنید.");
      }
    } else {
      await sendMessage(env, chatId, "⛔️ کد وارد شده معتبر نیست. لطفاً کد صحیح را ارسال کنید.");
    }
    return;
  }

  // --- از اینجا به بعد یعنی کاربر هم هست و هم تایید شده ---

  // Check if user is banned
  if (user.is_banned) {
    const banMessage = user.banned_until ? 
      `🚫 حساب کاربری شما مسدود شده است.\nتاریخ رفع مسدودیت: ${new Date(user.banned_until).toLocaleDateString('fa-IR')}` :
      "🚫 حساب کاربری شما به طور دائمی مسدود شده است.";
    
    await sendMessage(env, chatId, banMessage);
    return;
  }

  if (text.startsWith("/setname")) {
    await handleSetDisplayNameCommand(env, update);
    return;
  }

  // Handle quiz deep link: /start quiz_<token> or /start@botname quiz_<token>
  const quizDeepLinkMatch = text.match(/^\/start(?:@[\w_]+)?\s+quiz_(\S+)/);
  if (quizDeepLinkMatch) {
    const token = quizDeepLinkMatch[1];
    if (token && user) {
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
    await showProfileHome(env, update);
    return;
  }

  if (text === MAIN_MENU_BUTTON_LEADERBOARD) {
    await showLeaderboardHome(env, update);
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

  // === فیکس: اگر کاربر در میانه تست درک مطلب است ===
  const activeReadingSession = await queryOne<{ id: number; started_at: string }>(
    env,
    `SELECT id, started_at FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeReadingSession) {
    const sessionAgeHours = (Date.now() - new Date(activeReadingSession.started_at).getTime()) / (1000 * 60 * 60);

    // اگه سشن قدیمی‌تر از ۲۴ ساعت هست → خودکار کنسل کن
    if (sessionAgeHours > 24) {
      await execute(
        env,
        `UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`,
        [activeReadingSession.id]
      );
      // ادامه بده به flow عادی (منوی اصلی)
    } else {
      await sendMessage(
        env,
        chatId,
        "📖 تو الان در حال تست درک مطلب هستی! لطفاً روی دکمه‌های شیشه‌ای سوالات کلیک کن.\nاگر می‌خوای تست رو لغو کنی، دکمه «❌ انصراف و خروج» رو بزن 👇",
        { reply_markup: getMainMenuKeyboard() }
      );
      return;
    }
  }
  // ============================================================

  await sendMessage(
    env,
    chatId,
    "لطفاً از منوی پایین یکی از گزینه‌ها رو انتخاب کن 😊",
    { reply_markup: getMainMenuKeyboard() }
  );
}
