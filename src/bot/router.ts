import { Env } from "../types";
import { TelegramUpdate, TelegramCallbackQuery } from "./types";
import {
  getMainMenuKeyboard,
  getTrainingMenuKeyboard,
  MAIN_MENU_BUTTON_TRAINING,
  MAIN_MENU_BUTTON_PROFILE,
  MAIN_MENU_BUTTON_LEADERBOARD,
  MAIN_MENU_BUTTON_LETTERS,
  TRAINING_MENU_BUTTON_LEITNER,
  TRAINING_MENU_BUTTON_READING,
  TRAINING_MENU_BUTTON_BACK,
  PROFILE_MENU_BUTTON_SETTINGS,
  PROFILE_MENU_BUTTON_STATS,
  PROFILE_MENU_BUTTON_SUMMARY,
  LETTERS_MENU_BUTTON_WRITE,
  LETTERS_MENU_BUTTON_INBOX,
  LETTERS_MENU_BUTTON_SETTINGS,
  LETTERS_MENU_BUTTON_BACK
} from "./keyboards";
import { sendMessage, answerCallbackQuery, getChatMemberStatus } from "./telegram-api";
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
import {
  showLettersEntry,
  startWriteLetter,
  showInbox,
  showSettings,
  handleLettersMessage,
  handleLettersCallback
} from "./handlers/letters";
import { handleNewUserLicenseFlow, handleUnapprovedUserLicenseFlow } from "./handlers/license";
import { checkAndCancelStaleSession } from "./handlers/reading";
import { handlePremiumEmojiCommand } from "./handlers/premium_emoji_admin";
import { loadEmojiMap, canonicalizeUserMenu } from "./premium-emojis";
import { isAdmin } from "../db/admin";
import { CB_PREFIX, REQUIRED_CHANNEL } from "../config/constants";
import { getUserByTelegramId, getOrCreateUser, touchExistingUser } from "../db/users";

/** Channel-membership statuses that count as "joined". */
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);

/**
 * Build the force-join prompt keyboard: a link to the channel and a re-check button.
 */
function joinKeyboard() {
  const channelUrl = `https://t.me/${REQUIRED_CHANNEL.replace(/^@/, "")}`;
  return {
    inline_keyboard: [
      [{ text: "📢 عضویت در کانال", url: channelUrl }],
      [{ text: "✅ عضو شدم، بررسی کن", callback_data: `${CB_PREFIX.JOIN_CHECK}:1` }],
    ],
  };
}

const JOIN_PROMPT_TEXT =
  `🔒 برای استفاده از ربات، لازمه اول عضو کانال ما بشی:\n\n` +
  `${REQUIRED_CHANNEL}\n\n` +
  `بعد از عضویت، دکمه‌ی «✅ عضو شدم، بررسی کن» رو بزن.`;

/**
 * Check whether the user is a member of the required channel.
 * Fails open (treats as member) if the API call errors — e.g. the bot is not yet
 * an admin of the channel — to avoid locking everyone out on misconfiguration.
 * @param env - The worker environment containing the bot token
 * @param tgUserId - The Telegram user ID to check
 * @returns True if the user may proceed (member or fail-open), false if blocked
 */
async function isChannelMember(env: Env, tgUserId: number): Promise<boolean> {
  const res = await getChatMemberStatus(env, REQUIRED_CHANNEL, tgUserId);
  if (res === null) return true; // fail-open on API error
  if (MEMBER_STATUSES.has(res.status)) return true;
  if (res.status === "restricted" && res.isMember) return true;
  return false;
}

/**
 * Process an incoming Telegram update by delegating to callback or message handlers.
 * @param env - The worker environment containing bindings and secrets
 * @param update - The raw Telegram Update object from the webhook
 * @returns void
 */
export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  // Warm the premium-emoji map so pe() can render animated emoji in any handler.
  await loadEmojiMap(env);

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
  CB_PREFIX.LEITNER_REPORT,
  CB_PREFIX.LEITNER_REPORT_CONFIRM,
  CB_PREFIX.LEITNER_REPORT_CANCEL,
  CB_PREFIX.LEITNER_LESSON_PICK,
  CB_PREFIX.LEITNER_LESSON_CONT,
  CB_PREFIX.LEITNER_LESSON_STOP,
]);

const lettersPrefixes = new Set([
  CB_PREFIX.LETTERS_HOME,
  CB_PREFIX.LETTER_INBOX,
  CB_PREFIX.LETTER_OPEN,
  CB_PREFIX.LETTER_REPLY,
  CB_PREFIX.LETTER_BLOCK,
  CB_PREFIX.LETTER_BLOCK_CONFIRM,
  CB_PREFIX.LETTER_SETTINGS,
  CB_PREFIX.LETTER_NOTIF_TOGGLE,
  CB_PREFIX.LETTER_DISABLE,
  CB_PREFIX.LETTER_OPEN_PROACTIVE,
]);

async function handleCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const prefix = data.split(":")[0];
  const cbChatId = callbackQuery.message?.chat.id;

  // Force-join gate (except the membership re-check button itself).
  if (prefix === CB_PREFIX.JOIN_CHECK) {
    await handleJoinCheck(env, callbackQuery, cbChatId);
    return;
  }
  if (callbackQuery.from && !(await isChannelMember(env, callbackQuery.from.id))) {
    await answerCallbackQuery(env, callbackQuery.id, "ابتدا باید عضو کانال شوی 🔒");
    if (cbChatId !== undefined) {
      await sendMessage(env, cbChatId, JOIN_PROMPT_TEXT, { reply_markup: joinKeyboard() });
    }
    return;
  }

  if (prefix === CB_PREFIX.REMINDER_OPEN) {
    await handleReminderOpen(env, callbackQuery, cbChatId, data);
    return;
  }

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

  if (lettersPrefixes.has(prefix)) {
    await handleLettersCallback(env, callbackQuery);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
}

/**
 * Handle the "I joined, re-check" button: re-verify membership and grant access if joined.
 */
async function handleJoinCheck(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number | undefined
): Promise<void> {
  if (!callbackQuery.from || chatId === undefined) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  if (await isChannelMember(env, callbackQuery.from.id)) {
    await answerCallbackQuery(env, callbackQuery.id, "عضویت تأیید شد ✅");
    await sendMessage(env, chatId, "🎉 عالی! حالا می‌تونی از ربات استفاده کنی 👇", {
      reply_markup: getMainMenuKeyboard(),
    });
  } else {
    // The user clicked this button on the existing join-prompt message, so the
    // alert alone is enough — re-sending the prompt would spam the chat.
    await answerCallbackQuery(env, callbackQuery.id, "هنوز عضو کانال نیستی 🔒");
  }
}

/**
 * Handle the glassy reminder buttons that jump straight into a practice section.
 */
async function handleReminderOpen(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number | undefined,
  data: string
): Promise<void> {
  await answerCallbackQuery(env, callbackQuery.id);
  if (chatId === undefined || !callbackQuery.from) return;

  const target = data.split(":")[1];
  const user = await getOrCreateUser(env, callbackQuery.from);
  if (target === "reading") {
    await startReadingMenuForUser(env, chatId, 1);
  } else {
    await startLeitnerForUser(env, user, chatId);
  }
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

  // Force-join gate: everyone (including admins) must be a channel member.
  if (!(await isChannelMember(env, tgUser.id))) {
    await sendMessage(env, chatId, JOIN_PROMPT_TEXT, { reply_markup: joinKeyboard() });
    return;
  }

  // Premium-emoji registration (admin only): /pe + premium emoji → store ids.
  if (text?.startsWith("/pe") && (await isAdmin(env, tgUser.id))) {
    await handlePremiumEmojiCommand(env, message);
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

  // Letters free-text flows (nickname / letter body / reply body). Runs before
  // nav matching so an in-progress letter body isn't mistaken for a menu tap.
  // A tap on a registered menu button cancels the flow and falls through here.
  if (await handleLettersMessage(env, user, update)) return;

  // A reply-keyboard button we animated arrives emoji-stripped; map it back to
  // its canonical label so the matching below keeps working. Non-menu text is
  // returned unchanged.
  const navText = canonicalizeUserMenu(text);

  if (navText === MAIN_MENU_BUTTON_TRAINING) {
    await sendMessage(
      env,
      chatId,
      "یکی از گزینه‌های تمرین رو انتخاب کن:",
      { reply_markup: getTrainingMenuKeyboard() }
    );
    return;
  }
  if (navText === MAIN_MENU_BUTTON_PROFILE) {
    await showProfileHome(env, user, chatId);
    return;
  }

  if (navText === MAIN_MENU_BUTTON_LEADERBOARD) {
    await showLeaderboardHome(env, chatId);
    return;
  }

  if (navText === MAIN_MENU_BUTTON_LETTERS) {
    await showLettersEntry(env, user, chatId);
    return;
  }

  if (navText === LETTERS_MENU_BUTTON_WRITE) {
    await startWriteLetter(env, user, chatId);
    return;
  }
  if (navText === LETTERS_MENU_BUTTON_INBOX) {
    await showInbox(env, user, chatId);
    return;
  }
  if (navText === LETTERS_MENU_BUTTON_SETTINGS) {
    await showSettings(env, user, chatId);
    return;
  }
  if (navText === LETTERS_MENU_BUTTON_BACK) {
    await sendMessage(env, chatId, "به منوی اصلی برگشتی 👇", { reply_markup: getMainMenuKeyboard() });
    return;
  }

  if (navText === TRAINING_MENU_BUTTON_LEITNER) {
    await startLeitnerForUser(env, user, chatId);
    return;
  }

  if (navText === TRAINING_MENU_BUTTON_READING) {
    await startReadingMenuForUser(env, chatId, 1);
    return;
  }

  if (navText === TRAINING_MENU_BUTTON_BACK) {
    await sendMessage(
      env,
      chatId,
      "به منوی اصلی برگشتی 👇",
      { reply_markup: getMainMenuKeyboard() }
    );
    return;
  }

  if (navText === PROFILE_MENU_BUTTON_SETTINGS) {
    await showProfileSettings(env, user, chatId);
    return;
  }
  if (navText === PROFILE_MENU_BUTTON_STATS) {
    await startProfileStats(env, chatId);
    return;
  }
  if (navText === PROFILE_MENU_BUTTON_SUMMARY) {
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
