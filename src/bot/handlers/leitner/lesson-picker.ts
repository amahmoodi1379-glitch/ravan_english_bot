import { Env } from "../../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../../types";
import { DbUser } from "../../../db/users";
import { sendMessage, answerCallbackQuery } from "../../telegram-api";
import {
  getUnlearnedLessons,
  countNewWordsByLesson,
  peekNextNewWord,
  getLessonNameById,
  getReviewStats,
} from "../../../db/leitner";
import {
  CB_PREFIX,
  LESSON_PICKER_PAGE_SIZE,
} from "../../../config/constants";
import { trimLessonName, lessonNamesEqual } from "../../../utils/lesson";
import { getTrainingMenuKeyboard } from "../../keyboards";
import {
  ReviewMode,
  extractMode,
  isNewMode,
  isLessonMode,
  getLessonIdFromMode,
  getLevelFromMode,
  homeButton,
  removeInlineKeyboard,
} from "./utils";
import { sendLeitnerQuestion } from "./question-picker";

/**
 * Handle the lesson picker callback (page display or lesson selection).
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @param messageId - The message ID to edit/remove keyboard from
 * @param parts - The callback data parts split by ":"
 * @returns void
 */
export async function handleLessonPicker(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  // Determine mode: selection ("s") or page display
  if (parts[1] === "s") {
    // --- Lesson Selection Mode ---
    const lessonId = parseInt(parts[2], 10);

    if (isNaN(lessonId)) {
      await sendMessage(env, chatId, "⚠️ درس نامعتبر. لطفاً دوباره انتخاب کن.", {
        reply_markup: { inline_keyboard: [[{ text: "📖 بازگشت به لیست درس‌ها", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0` }], [homeButton()]] },
      });
      return;
    }

    // Resolve lesson name from the stable lesson_id (fast PK lookup)
    const rawName = await getLessonNameById(env, lessonId);
    const lessonName = trimLessonName(rawName);

    // Validate lesson still has words
    const wordCount = await countNewWordsByLesson(env, user.id, lessonName);
    if (wordCount === 0) {
      await sendMessage(env, chatId, "واژه‌ای برای یادگیری در این درس باقی نمانده", {
        reply_markup: { inline_keyboard: [[{ text: "📖 بازگشت به لیست درس‌ها", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0` }], [homeButton()]] },
      });
      return;
    }

    // Start lesson-filtered learning (lesson_id is stable across sessions)
    const mode: ReviewMode = `newL:${lessonId}`;
    await sendLeitnerQuestion(env, user, chatId, mode);
  } else {
    // --- Page Display Mode ---
    const page = Math.max(0, parseInt(parts[1], 10) || 0);
    const lessons = await getUnlearnedLessons(env, user.id);

    if (lessons.length === 0) {
      await sendMessage(env, chatId, "📚 واژه جدیدی برای یادگیری باقی نمونده! 🌟", {
        reply_markup: { inline_keyboard: [[homeButton()]] },
      });
      return;
    }

    const totalPages = Math.ceil(lessons.length / LESSON_PICKER_PAGE_SIZE);
    const startIdx = page * LESSON_PICKER_PAGE_SIZE;
    const pageItems = lessons.slice(startIdx, startIdx + LESSON_PICKER_PAGE_SIZE);

    // Build keyboard: one button per lesson per row
    const keyboard: InlineKeyboardButton[][] = [];
    for (let i = 0; i < pageItems.length; i++) {
      const lesson = pageItems[i];
      const displayName = trimLessonName(lesson.lesson_name) ?? "بدون درس";
      keyboard.push([{
        text: `${displayName} (${lesson.word_count})`,
        callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:s:${lesson.lesson_id}`,
      }]);
    }

    // Pagination buttons
    const navRow: InlineKeyboardButton[] = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ صفحه قبل", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:${page - 1}` });
    }
    if (page < totalPages - 1) {
      navRow.push({ text: "➡️ صفحه بعد", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:${page + 1}` });
    }
    if (navRow.length > 0) {
      keyboard.push(navRow);
    }

    // Home button as last row
    keyboard.push([homeButton()]);

    await sendMessage(env, chatId, "📖 انتخاب درس", {
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

/**
 * Handle lesson transition continue/stop callbacks.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @param messageId - The message ID to edit/remove keyboard from
 * @param parts - The callback data parts split by ":"
 * @param action - Whether to "continue" to the next lesson or "stop" the session
 * @returns void
 */
export async function handleLessonTransition(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[],
  action: "continue" | "stop"
): Promise<void> {
  if (action === "continue") {
    // parts = ["llc", mode] e.g. ["llc", "newL", "5"] — rejoin mode from index 1
    const mode = extractMode(parts, 1);
    await answerCallbackQuery(env, callbackQuery.id);
    await removeInlineKeyboard(env, chatId, messageId);
    await sendLeitnerQuestion(env, user, chatId, mode);
  } else {
    // stop — show session summary stats (same as handleExitConfirm)
    await answerCallbackQuery(env, callbackQuery.id);
    await removeInlineKeyboard(env, chatId, messageId);

    const stats = await getReviewStats(env, user.id, 24);

    let summaryText = "📊 <b>خلاصه امروز:</b>\n\n";
    if (stats.total > 0) {
      const accuracy = Math.round((stats.correct / stats.total) * 100);
      summaryText += `✅ درست: ${stats.correct}\n`;
      summaryText += `❌ غلط: ${stats.incorrect}\n`;
      summaryText += `📈 دقت: ${accuracy}%\n`;
      summaryText += `📝 کل: ${stats.total} سوال\n`;
    } else {
      summaryText += `هنوز سوالی جواب نداده‌ای.\n`;
    }
    summaryText += `\nخسته نباشی! 😊`;

    await sendMessage(env, chatId, summaryText, { reply_markup: getTrainingMenuKeyboard() });
  }
}

/**
 * Check for a lesson transition before sending the next question in new-word mode.
 * If the next word is from a different lesson than the current word, show a
 * transition notification with continue/stop buttons.
 * If not in new-word mode, or same lesson, go directly to sendLeitnerQuestion.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @param mode - The current ReviewMode
 * @param currentLessonName - The lesson name of the word just practiced (or null)
 * @returns void
 */
export async function checkLessonTransitionAndSend(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode,
  currentLessonName: string | null
): Promise<void> {
  // Only check transitions for new-word modes
  if (!isNewMode(mode)) {
    await sendLeitnerQuestion(env, user, chatId, mode);
    return;
  }

  // Determine peek parameters based on mode
  let peekLevel: number | undefined;
  let peekLessonName: string | null | undefined;

  if (isLessonMode(mode)) {
    // For lesson-filtered mode, peek within the same lesson
    const lessonId = getLessonIdFromMode(mode);
    if (lessonId !== undefined) {
      const rawName = await getLessonNameById(env, lessonId);
      peekLessonName = trimLessonName(rawName);
    }
  } else {
    // For newN modes, peek with level filter
    peekLevel = getLevelFromMode(mode);
  }

  // Peek at the next word
  const nextWord = await peekNextNewWord(env, user.id, peekLevel, peekLessonName);

  if (!nextWord) {
    // No next word — sendLeitnerQuestion will show the completion message
    await sendLeitnerQuestion(env, user, chatId, mode);
    return;
  }

  // Compare current word's lesson with next word's lesson
  if (lessonNamesEqual(currentLessonName, nextWord.lesson_name)) {
    // Same lesson — show next question directly
    await sendLeitnerQuestion(env, user, chatId, mode);
    return;
  }

  // Different lesson — show transition notification
  const nextTrimmed = trimLessonName(nextWord.lesson_name);
  let notificationText: string;
  if (nextTrimmed !== null) {
    notificationText = `📖 واژه بعدی از درس «${nextTrimmed}» است. ادامه می‌دهی؟`;
  } else {
    notificationText = `📖 واژه بعدی بدون درس مشخص است. ادامه می‌دهی؟`;
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ ادامه", callback_data: `${CB_PREFIX.LEITNER_LESSON_CONT}:${mode}` },
        { text: "🛑 توقف", callback_data: `${CB_PREFIX.LEITNER_LESSON_STOP}:${mode}` },
      ],
    ],
  };

  await sendMessage(env, chatId, notificationText, { reply_markup: keyboard });
}
