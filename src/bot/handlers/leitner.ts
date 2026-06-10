import { Env } from "../../types";
import { TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, prepare } from "../../db/client";
import {
  pickNextReviewWord,
  pickNextNewWord,
  pickNextNewWordByLesson,
  pickNextLeechWord,
  getWordStage,
  prepareUpdateFsrs,
  markWordAsIgnored,
  clearLeech,
  countDueWords,
  countDueWordsByLevel,
  countNewWords,
  countNewWordsByLevel,
  countLeechWords,
  getReviewStats,
  getUnlearnedLessons,
  countNewWordsByLesson,
  peekNextNewWord,
  DbWord,
} from "../../db/leitner";
import { prepareXpForLeitner, checkAndUpdateStreak } from "../../db/xp";
import {
  CB_PREFIX,
  LEITNER_TEST_TYPE_ORDER,
  LEITNER_TEST_TYPES,
  LeitnerTestType,
  LESSON_PICKER_PAGE_SIZE,
} from "../../config/constants";
import { getWordStylePrioritySql } from "../../db/question_priority";
import { optionLetterToNumber } from "../../utils/options";
import { Rating, ratingLabel, ratingEmoji } from "../../utils/fsrs";
import { trimLessonName, lessonNamesEqual } from "../../utils/lesson";
import { getTrainingMenuKeyboard } from "../keyboards";

// --- Types ---

interface LeitnerQuestionRow {
  id: number;
  word_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  explanation_text: string | null;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
}

type ReviewMode = "review" | "new" | "leech" | "new1" | "new2" | "new3" | "new4" | "review1" | "review2" | "review3" | "review4" | `newL:${number}`;

function isReviewMode(m: string): m is ReviewMode {
  return ["review", "new", "leech", "new1", "new2", "new3", "new4", "review1", "review2", "review3", "review4"].includes(m)
    || m.startsWith("newL:");
}

function parseMode(raw: string | undefined): ReviewMode {
  if (!raw) return "review";
  if (isReviewMode(raw)) return raw as ReviewMode;
  return "review";
}

function getLevelFromMode(mode: ReviewMode): number | undefined {
  const match = mode.match(/\d$/);
  return match ? parseInt(match[0], 10) : undefined;
}

function isNewMode(mode: ReviewMode): boolean {
  return mode === "new" || mode.startsWith("new");
}

/** Returns true if the mode is a lesson-filtered new-word mode (e.g., "newL:5"). */
function isLessonMode(mode: ReviewMode): boolean {
  return mode.startsWith("newL:");
}

/** Extract lesson offset from a lesson-filtered mode like "newL:5". Returns undefined if not a lesson mode. */
function getLessonOffsetFromMode(mode: ReviewMode): number | undefined {
  if (!mode.startsWith("newL:")) return undefined;
  const offset = parseInt(mode.slice(5), 10);
  return isNaN(offset) ? undefined : offset;
}

function isReviewModeType(mode: ReviewMode): boolean {
  return mode === "review" || mode.startsWith("review");
}

// --- Button builders (single source of truth) ---

function exitButtonText(mode: ReviewMode): string {
  if (isNewMode(mode)) return "🚪 پایان یادگیری";
  if (mode === "leech") return "🚪 پایان تمرین";
  return "🚪 پایان مرور";
}

function exitConfirmText(mode: ReviewMode): string {
  if (isNewMode(mode)) return "مطمئنی میخوای از یادگیری واژه‌های جدید خارج بشی؟";
  if (mode === "leech") return "مطمئنی میخوای از تمرین واژه‌های سخت خارج بشی؟";
  return "مطمئنی میخوای از مرور خارج بشی؟";
}

function nextButton(mode: ReviewMode) {
  return { text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}`, style: "primary" };
}

function exitButton(mode: ReviewMode) {
  return { text: exitButtonText(mode), callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}`, style: "danger" };
}

function ignoreButton(questionId: number, mode: ReviewMode) {
  return { text: "🗑 دیگه این واژه رو نشونم نده", callback_data: `${CB_PREFIX.LEITNER_IGNORE}:${questionId}:${mode}` };
}

function unleechButton(questionId: number, mode: ReviewMode) {
  return { text: "🎓 یادش گرفتم (حذف از سخت‌ها)", callback_data: `${CB_PREFIX.LEITNER_UNLEECH}:${questionId}:${mode}`, style: "success" };
}

function homeButton() {
  return { text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_HOME}:1` };
}

/** Footer rows shown after the word has been processed (next + exit). */
function nextAndExitRows(mode: ReviewMode) {
  return [[nextButton(mode)], [exitButton(mode)]];
}

// --- Stage / Question Type Logic ---

const TEST_TYPE_STAGE: Record<LeitnerTestType, number> = {
  [LEITNER_TEST_TYPES.EN_TO_FA]: 1,
  [LEITNER_TEST_TYPES.FA_TO_EN]: 2,
  [LEITNER_TEST_TYPES.DEFINITION_TO_WORD]: 3,
  [LEITNER_TEST_TYPES.WORD_TO_DEFINITION]: 4,
  [LEITNER_TEST_TYPES.CLOZE]: 5,
};

const TEST_TYPE_STYLE_ALIASES: Record<LeitnerTestType, string[]> = {
  [LEITNER_TEST_TYPES.EN_TO_FA]: ["en_to_fa", "fa_meaning"],
  [LEITNER_TEST_TYPES.FA_TO_EN]: ["fa_to_en", "en_meaning"],
  [LEITNER_TEST_TYPES.DEFINITION_TO_WORD]: ["definition_to_word", "word_from_definition"],
  [LEITNER_TEST_TYPES.WORD_TO_DEFINITION]: ["word_to_definition", "en_definition"],
  [LEITNER_TEST_TYPES.CLOZE]: ["cloze", "fill_blank"],
};

function getQuestionStyleForStage(stage: number): LeitnerTestType[] {
  const normalizedStage = Math.max(1, Math.min(5, stage || 1));
  return LEITNER_TEST_TYPE_ORDER.filter((testType) => TEST_TYPE_STAGE[testType] <= normalizedStage);
}

function getStylesForType(testType: LeitnerTestType): string[] {
  return TEST_TYPE_STYLE_ALIASES[testType] || [];
}

// --- Entry Point ---

/**
 * Show the leitner home menu (review / new / hard-words), and hide the
 * reply keyboard so the flow is purely inline-button driven.
 */
export async function startLeitnerForUser(env: Env, user: DbUser, chatId: number): Promise<void> {
  const dueCount = await countDueWords(env, user.id);
  const newCount = await countNewWords(env, user.id);
  const leechCount = await countLeechWords(env, user.id);

  if (dueCount === 0 && newCount === 0 && leechCount === 0) {
    await sendMessage(env, chatId, "🎉 عالی! فعلاً هیچ واژه‌ای برای مرور، یادگیری یا تمرین نداری. بعداً سر بزن!", {
      reply_markup: getTrainingMenuKeyboard(),
    });
    return;
  }

  let text = "🧠 <b>سیستم مرور واژگان (FSRS)</b>\n\n";
  text += dueCount > 0 ? `📋 <b>${dueCount}</b> واژه برای مرور امروز داری\n` : `✅ مرورهای امروز تکمیل شده!\n`;
  text += newCount > 0 ? `🆕 <b>${newCount}</b> واژه جدید آماده یادگیری\n` : `📚 همه واژه‌ها رو شروع کردی!\n`;
  if (leechCount > 0) {
    text += `🔁 <b>${leechCount}</b> واژه‌ی سخت داری که نیاز به تمرین بیشتر دارن\n`;
  }

  const keyboard: any[][] = [];
  if (dueCount > 0) {
    keyboard.push([{ text: `📋 شروع مرور (${dueCount})`, callback_data: `${CB_PREFIX.LEITNER_REVIEW_LEVEL}:pick`, style: "success" }]);
  }
  if (newCount > 0) {
    keyboard.push([{ text: `🆕 واژه‌های جدید (${newCount})`, callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:pick`, style: "primary" }]);
  }
  if (leechCount > 0) {
    keyboard.push([{ text: `🔁 واژه‌های سخت (${leechCount})`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:leech`, style: "danger" }]);
  }
  keyboard.push([homeButton()]);

  await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });

  // Remove the reply keyboard while in leitner; navigation is fully inline.
  await sendMessage(env, chatId, "⬇️ از دکمه‌های بالا استفاده کن:", {
    reply_markup: { remove_keyboard: true },
  });
}

// --- Question Sending ---

async function pickWordForMode(env: Env, userId: number, mode: ReviewMode): Promise<DbWord | null> {
  if (mode === "leech") return pickNextLeechWord(env, userId);
  if (isLessonMode(mode)) {
    const offset = getLessonOffsetFromMode(mode);
    if (offset !== undefined) {
      const lessons = await getUnlearnedLessons(env, userId);
      if (offset < lessons.length) {
        return pickNextNewWordByLesson(env, userId, lessons[offset].lesson_name);
      }
    }
    // Fallback: if offset is invalid, treat as regular new word mode
    return pickNextNewWord(env, userId);
  }
  const level = getLevelFromMode(mode);
  if (isReviewModeType(mode)) return pickNextReviewWord(env, userId, level);
  return pickNextNewWord(env, userId, level);
}

/**
 * Send the next question. Uses a bounded loop (not recursion) to skip words
 * that have no questions, avoiding any chance of a stack overflow / infinite loop.
 */
async function sendLeitnerQuestion(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode
): Promise<void> {
  const MAX_ATTEMPTS = 15;
  const seenWordIds = new Set<number>();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const word = await pickWordForMode(env, user.id, mode);

    if (!word) {
      await sendCompletionMessage(env, user, chatId, mode);
      return;
    }

    // If we already tried this exact word in this loop (e.g. leech rotation
    // keeps returning it because it has no usable question), stop to avoid spinning.
    if (seenWordIds.has(word.id)) {
      break;
    }
    seenWordIds.add(word.id);

    const stage = await getWordStage(env, user.id, word.id);
    const prioritizedTypes = getQuestionStyleForStage(stage);

    let question: LeitnerQuestionRow | null = null;
    for (const testType of prioritizedTypes) {
      const styles = getStylesForType(testType);
      if (styles.length === 0) continue;
      question = await pickQuestionForUserWord(env, user, word, styles);
      if (question) break;
    }
    if (!question) question = await pickRandomUnseenQuestion(env, user, word);
    if (!question) question = await pickRandomQuestionAny(env, user, word);

    if (!question) {
      // Word has no questions at all — skip to the next candidate.
      continue;
    }

    // Record that the user has seen this question.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
       VALUES (?, ?, ?, 'leitner', ?)`
    ).bind(user.id, question.word_id, question.id, now).run();

    const messageText =
      `❓ <b>${question.question_text}</b>\n\n` +
      `1️⃣ ${question.option_a}\n` +
      `2️⃣ ${question.option_b}\n` +
      `3️⃣ ${question.option_c}\n` +
      `4️⃣ ${question.option_d}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "1", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:A:${mode}` },
          { text: "2", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:B:${mode}` },
          { text: "3", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:C:${mode}` },
          { text: "4", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:D:${mode}` },
        ],
        [{ text: "🤔 نمیدونم", callback_data: `${CB_PREFIX.LEITNER_DUNNO}:${question.id}:${mode}` }],
        [exitButton(mode)],
      ],
    };

    await sendMessage(env, chatId, messageText, { reply_markup: replyMarkup });
    return;
  }

  // No usable question found — never leave the user stuck; offer a way back.
  await sendMessage(env, chatId, "❗️ فعلاً سوالی برای نمایش پیدا نشد. لطفاً بعداً دوباره تلاش کن.", {
    reply_markup: { inline_keyboard: [[homeButton()]] },
  });
}

/**
 * Completion / congratulations message based on the mode.
 */
async function sendCompletionMessage(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode
): Promise<void> {
  if (mode === "review") {
    const newCount = await countNewWords(env, user.id);
    let text = "🎉 تبریک! همه مرورهای امروز رو تموم کردی! 👏";
    const keyboard: any[][] = [];
    if (newCount > 0) {
      text += `\n\n🆕 ${newCount} واژه جدید آماده یادگیری. میخوای ادامه بدی؟`;
      keyboard.push([{ text: "🆕 شروع واژه‌های جدید", callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:pick`, style: "primary" }]);
    }
    keyboard.push([{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}` }]);
    await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (mode === "leech") {
    await sendMessage(env, chatId, "🎉 تمرین واژه‌های سخت تموم شد! آفرین 👏", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}` }]] },
    });
    return;
  }

  // new / new1-4
  const level = getLevelFromMode(mode);
  const levelText = level ? `واژه‌های سطح ${level}` : "همه واژه‌های موجود";
  await sendMessage(env, chatId, `📚 ${levelText} رو شروع کردی! آفرین! 🌟`, {
    reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}` }]] },
  });
}

// --- Question Picking Helpers ---

async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  styles: string[]
): Promise<LeitnerQuestionRow | null> {
  if (styles.length === 0) return null;
  const placeholders = styles.map(() => "?").join(", ");
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");

  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND q.question_style IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY ${priorityOrderSql}, RANDOM()
    LIMIT 1
    `,
    [word.id, ...styles, user.id]
  );
}

async function pickRandomUnseenQuestion(
  env: Env,
  user: DbUser,
  word: DbWord
): Promise<LeitnerQuestionRow | null> {
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");
  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY ${priorityOrderSql}, RANDOM()
    LIMIT 1
    `,
    [word.id, user.id]
  );
}

async function pickRandomQuestionAny(
  env: Env,
  user: DbUser,
  word: DbWord
): Promise<LeitnerQuestionRow | null> {
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");
  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
    ORDER BY
      ${priorityOrderSql},
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM user_word_question_history h
          WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
        ) THEN 0
        ELSE 1
      END,
      RANDOM()
    LIMIT 1
    `,
    [word.id, user.id]
  );
}

// --- Small helpers ---

function getCorrectOptionText(q: LeitnerQuestionRow): string {
  switch (q.correct_option) {
    case "A": return q.option_a;
    case "B": return q.option_b;
    case "C": return q.option_c;
    case "D": return q.option_d;
    default: return "";
  }
}

/** Remove an inline keyboard from a previous message (preserves its text). */
async function removeInlineKeyboard(env: Env, chatId: number, messageId: number): Promise<void> {
  try {
    await editMessageReplyMarkup(env, chatId, messageId);
  } catch {
    // Ignore — message may be too old or already edited.
  }
}

// --- Lesson Picker Handler ---

async function handleLessonPicker(
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
    const offset = parseInt(parts[2], 10);
    const lessons = await getUnlearnedLessons(env, user.id);

    if (isNaN(offset) || offset < 0 || offset >= lessons.length) {
      await sendMessage(env, chatId, "⚠️ درس نامعتبر. لطفاً دوباره انتخاب کن.", {
        reply_markup: { inline_keyboard: [[{ text: "📖 بازگشت به لیست درس‌ها", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0` }], [homeButton()]] },
      });
      return;
    }

    const lesson = lessons[offset];
    const lessonName = lesson.lesson_name;

    // Validate lesson still has words
    const wordCount = await countNewWordsByLesson(env, user.id, lessonName);
    if (wordCount === 0) {
      await sendMessage(env, chatId, "واژه‌ای برای یادگیری در این درس باقی نمانده", {
        reply_markup: { inline_keyboard: [[{ text: "📖 بازگشت به لیست درس‌ها", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0` }], [homeButton()]] },
      });
      return;
    }

    // Start lesson-filtered learning
    const mode: ReviewMode = `newL:${offset}`;
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
    const keyboard: any[][] = [];
    for (let i = 0; i < pageItems.length; i++) {
      const lesson = pageItems[i];
      const displayName = trimLessonName(lesson.lesson_name) ?? "بدون درس";
      const globalOffset = startIdx + i;
      keyboard.push([{
        text: `${displayName} (${lesson.word_count})`,
        callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:s:${globalOffset}`,
      }]);
    }

    // Pagination buttons
    const navRow: any[] = [];
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

// --- Callback Dispatcher ---

export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  const prefix = parts[0];

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  try {
    switch (prefix) {
      case CB_PREFIX.LEITNER_HOME:
        await handleHome(env, callbackQuery, chatId, messageId);
        return;
      case CB_PREFIX.LEITNER_DUNNO:
        await handleDunno(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_EXIT:
        await handleExitRequest(env, callbackQuery, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_EXIT_CONFIRM:
        await handleExitConfirm(env, callbackQuery, user, chatId, messageId);
        return;
      case CB_PREFIX.LEITNER_NEXT: {
        const mode = parseMode(parts[1]);
        await answerCallbackQuery(env, callbackQuery.id);
        await removeInlineKeyboard(env, chatId, messageId);
        await sendLeitnerQuestion(env, user, chatId, mode);
        return;
      }
      case CB_PREFIX.LEITNER_RATE:
        await handleRating(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_IGNORE:
        await handleIgnoreWord(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_IGNORE_CONFIRM:
        await handleIgnoreWordConfirm(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_UNLEECH:
        await handleUnleech(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_NEW_LEVEL:
        await handleNewLevel(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_LESSON_PICK:
        await handleLessonPicker(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_LESSON_CONT:
        await handleLessonTransition(env, callbackQuery, user, chatId, messageId, parts, "continue");
        return;
      case CB_PREFIX.LEITNER_LESSON_STOP:
        await handleLessonTransition(env, callbackQuery, user, chatId, messageId, parts, "stop");
        return;
      case CB_PREFIX.LEITNER_REVIEW_LEVEL:
        await handleReviewLevel(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER:
        await handleAnswer(env, callbackQuery, user, chatId, messageId, parts);
        return;
      default:
        await answerCallbackQuery(env, callbackQuery.id);
        return;
    }
  } catch (error) {
    console.error("Error in handleLeitnerCallback:", error);
    try {
      await answerCallbackQuery(env, callbackQuery.id, "خطایی رخ داد. لطفاً دوباره تلاش کن.");
    } catch {
      // nothing more we can do
    }
  }
}

// --- Sub-handlers ---

async function handleHome(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number,
  messageId: number
): Promise<void> {
  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);
  await sendMessage(env, chatId, "به منوی تمرین‌ها برگشتی 👇", {
    reply_markup: getTrainingMenuKeyboard(),
  });
}

async function handleDunno(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = parseMode(parts[2]);

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const alreadyAnswered = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM user_word_question_history
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NOT NULL`,
    [user.id, questionId]
  );
  if (alreadyAnswered) {
    await answerCallbackQuery(env, callbackQuery.id, "قبلاً پاسخ داده شده 👍");
    return;
  }

  const question = await queryOne<LeitnerQuestionRow>(
    env,
    `SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
            q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level,
            w.lesson_name
     FROM word_questions q JOIN words w ON q.word_id = w.id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد");
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  const now = new Date().toISOString();
  const batch: any[] = [];
  batch.push(prepare(
    env,
    `UPDATE user_word_question_history
     SET is_correct = 0, answered_at = ?
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`,
    [now, user.id, question.id]
  ));
  const fsrsStmts = await prepareUpdateFsrs(env, user.id, question.word_id, Rating.Again);
  batch.push(...fsrsStmts);
  await env.DB.batch(batch);

  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);
  const explanation = question.explanation_text;
  const levelLabel = `سطح ${question.level}`;

  let replyText =
    `🔴 جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
    `کلمه: <b>${question.english}</b>\n` +
    `معنی: <b>${question.persian}</b>\n` +
    `📊 ${levelLabel}`;

  const lessonDisplayDunno = trimLessonName(question.lesson_name);
  if (lessonDisplayDunno) {
    replyText += `\n📖 درس: ${lessonDisplayDunno}`;
  }

  if (explanation) {
    replyText += `\n\n${explanation}`;
  }

  const rows: any[][] = [];
  if (mode === "leech") rows.push([unleechButton(question.id, mode)]);
  rows.push([ignoreButton(question.id, mode)]);
  rows.push([nextButton(mode)]);
  rows.push([exitButton(mode)]);

  await sendMessage(env, chatId, replyText, { reply_markup: { inline_keyboard: rows } });
}

async function handleExitRequest(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const mode = parseMode(parts[1]);
  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  let confirmText = exitConfirmText(mode);

  await sendMessage(env, chatId, confirmText, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ بله، خروج", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}`, style: "danger" },
          { text: "❌ نه، ادامه بده", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}`, style: "success" },
        ],
      ],
    },
  });
}

async function handleExitConfirm(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number
): Promise<void> {
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

  // Restore the reply keyboard so the user can navigate again.
  await sendMessage(env, chatId, summaryText, { reply_markup: getTrainingMenuKeyboard() });
}

async function handleLessonTransition(
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
    const mode = parseMode(parts.slice(1).join(":"));
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
 */
async function checkLessonTransitionAndSend(
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
    const offset = getLessonOffsetFromMode(mode);
    if (offset !== undefined) {
      const lessons = await getUnlearnedLessons(env, user.id);
      if (offset < lessons.length) {
        peekLessonName = lessons[offset].lesson_name;
      }
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

async function handleRating(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const ratingValue = Number(parts[2]) as Rating;
  const mode = parseMode(parts[3]);

  if (!Number.isFinite(questionId) || !Number.isFinite(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id, "نامعتبر");
    return;
  }

  // Idempotency guard: a rating is "already applied" if the word has been
  // reviewed at/after the moment this question was answered. This is robust
  // (not time-based) and still allows legitimate same-day relearning, because
  // each relearning attempt is a fresh answer with a newer answered_at.
  const alreadyRated = await queryOne<{ id: number }>(
    env,
    `SELECT s.id
     FROM user_words_sm2 s
     JOIN word_questions q ON q.word_id = s.word_id
     JOIN user_word_question_history h
          ON h.user_id = s.user_id AND h.word_id = s.word_id
         AND h.question_id = q.id AND h.context = 'leitner'
     WHERE s.user_id = ? AND q.id = ?
       AND s.last_reviewed_at IS NOT NULL
       AND h.answered_at IS NOT NULL
       AND s.last_reviewed_at >= h.answered_at`,
    [user.id, questionId]
  );
  if (alreadyRated) {
    await answerCallbackQuery(env, callbackQuery.id, "امتیاز قبلاً ثبت شده 👍");
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  const question = await queryOne<{ word_id: number; level: number; lesson_name: string | null }>(
    env,
    `SELECT q.word_id, w.level, w.lesson_name FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await sendMessage(env, chatId, "❗️ خطا: سوال پیدا نشد.", {
      reply_markup: { inline_keyboard: [[nextButton(mode)], [homeButton()]] },
    });
    return;
  }

  const batch: any[] = [];
  const fsrsStmts = await prepareUpdateFsrs(env, user.id, question.word_id, ratingValue);
  batch.push(...fsrsStmts);

  if (ratingValue >= Rating.Good) {
    const xpStmts = prepareXpForLeitner(env, user.id, question.word_id, question.level, true);
    batch.push(...xpStmts);
  }
  await env.DB.batch(batch);

  if (ratingValue >= Rating.Good) {
    const streakMsg = await checkAndUpdateStreak(env, user.id);
    if (streakMsg) await sendMessage(env, chatId, streakMsg);
  }

  const emoji = ratingEmoji(ratingValue);
  await sendMessage(env, chatId, `${emoji} ثبت شد!`);

  // Auto-advance: check for lesson transition before showing next question
  await checkLessonTransitionAndSend(env, user, chatId, mode, question.lesson_name);
}

async function handleIgnoreWord(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = parseMode(parts[2]);

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const question = await queryOne<{ word_id: number; english: string }>(
    env,
    `SELECT q.word_id, w.english FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "خطا در یافتن واژه");
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  // Ask for confirmation
  await sendMessage(env, chatId,
    `⚠️ مطمئنی واژه‌ی <b>${question.english}</b> رو از چرخه مرور حذف کنی؟\n\nاین واژه دیگه نشون داده نمیشه.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ بله، حذف کن", callback_data: `${CB_PREFIX.LEITNER_IGNORE_CONFIRM}:${questionId}:${mode}` },
            { text: "❌ نه، برگرد", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` },
          ],
        ],
      },
    }
  );
}

async function handleIgnoreWordConfirm(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = parseMode(parts[2]);

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const question = await queryOne<{ word_id: number; english: string }>(
    env,
    `SELECT q.word_id, w.english FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "خطا در یافتن واژه");
    return;
  }

  await markWordAsIgnored(env, user.id, question.word_id);
  await answerCallbackQuery(env, callbackQuery.id, "واژه حذف شد 👌");
  await removeInlineKeyboard(env, chatId, messageId);

  await sendMessage(env, chatId, `واژه‌ی <b>${question.english}</b> از چرخه مرور حذف شد ✅`);

  // Auto-advance to next question
  await sendLeitnerQuestion(env, user, chatId, mode);
}

async function handleUnleech(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = parseMode(parts[2]);

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const question = await queryOne<{ word_id: number; english: string }>(
    env,
    `SELECT q.word_id, w.english FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "خطا در یافتن واژه");
    return;
  }

  await clearLeech(env, user.id, question.word_id);
  await answerCallbackQuery(env, callbackQuery.id, "از واژه‌های سخت حذف شد 🎓");
  await removeInlineKeyboard(env, chatId, messageId);

  await sendMessage(
    env,
    chatId,
    `واژه‌ی <b>${question.english}</b> از فهرست واژه‌های سخت حذف شد 🎓\n(همچنان در مرور عادی باقی می‌ماند)`,
    { reply_markup: { inline_keyboard: nextAndExitRows(mode) } }
  );
}

async function handleNewLevel(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const action = parts[1]; // "pick" to show menu, or a level number

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  if (action === "pick") {
    // Show level selection menu with counts
    const levelCounts = await countNewWordsByLevel(env, user.id);
    const total = levelCounts.reduce((sum, l) => sum + l.count, 0);

    if (total === 0) {
      await sendMessage(env, chatId, "📚 همه واژه‌ها رو شروع کردی! واژه جدیدی باقی نمونده 🌟", {
        reply_markup: { inline_keyboard: [[homeButton()]] },
      });
      return;
    }

    let text = "🆕 <b>واژه‌های جدید</b>\n\nکدوم سطح رو میخوای شروع کنی؟\n\n";
    const keyboard: any[][] = [];

    for (const { level, count } of levelCounts) {
      if (count > 0) {
        text += `📗 سطح ${level}: <b>${count}</b> واژه\n`;
        keyboard.push([{
          text: `📗 سطح ${level} (${count} واژه)`,
          callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:${level}`
        }]);
      }
    }

    text += `\n🎲 درهم: <b>${total}</b> واژه`;
    keyboard.push([{ text: `🎲 درهم (${total} واژه)`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:new` }]);
    keyboard.push([{ text: "📖 انتخاب بر اساس درس", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0` }]);
    keyboard.push([homeButton()]);

    await sendMessage(env, chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  // A specific level was chosen (1-4)
  const level = parseInt(action, 10);
  if (isNaN(level) || level < 1 || level > 4) {
    await sendMessage(env, chatId, "⚠️ سطح نامعتبر.", { reply_markup: { inline_keyboard: [[homeButton()]] } });
    return;
  }

  const mode: ReviewMode = `new${level}` as ReviewMode;
  await sendLeitnerQuestion(env, user, chatId, mode);
}

async function handleReviewLevel(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const action = parts[1];

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  if (action === "pick") {
    const levelCounts = await countDueWordsByLevel(env, user.id);
    const total = levelCounts.reduce((sum, l) => sum + l.count, 0);

    if (total === 0) {
      await sendMessage(env, chatId, "✅ مرورهای امروز تکمیل شده! 🎉", {
        reply_markup: { inline_keyboard: [[homeButton()]] },
      });
      return;
    }

    let text = "📋 <b>مرور واژگان</b>\n\nکدوم سطح رو میخوای مرور کنی؟\n\n";
    const keyboard: any[][] = [];

    for (const { level, count } of levelCounts) {
      if (count > 0) {
        text += `📗 سطح ${level}: <b>${count}</b> واژه\n`;
        keyboard.push([{
          text: `📗 سطح ${level} (${count} واژه)`,
          callback_data: `${CB_PREFIX.LEITNER_REVIEW_LEVEL}:${level}`
        }]);
      }
    }

    text += `\n🎲 درهم: <b>${total}</b> واژه`;
    keyboard.push([{ text: `🎲 درهم (${total} واژه)`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:review` }]);
    keyboard.push([homeButton()]);

    await sendMessage(env, chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  const level = parseInt(action, 10);
  if (isNaN(level) || level < 1 || level > 4) {
    await sendMessage(env, chatId, "⚠️ سطح نامعتبر.", { reply_markup: { inline_keyboard: [[homeButton()]] } });
    return;
  }

  const mode: ReviewMode = `review${level}` as ReviewMode;
  await sendLeitnerQuestion(env, user, chatId, mode);
}

async function handleAnswer(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const chosenOption = parts[2];
  const mode = parseMode(parts[3]);

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  if (!chosenOption || !["A", "B", "C", "D"].includes(chosenOption)) {
    await answerCallbackQuery(env, callbackQuery.id, "گزینه نامعتبر");
    return;
  }

  const alreadyAnswered = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM user_word_question_history
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NOT NULL`,
    [user.id, questionId]
  );
  if (alreadyAnswered) {
    await answerCallbackQuery(env, callbackQuery.id, "قبلاً پاسخ داده شده 👍");
    return;
  }

  const question = await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level,
           w.lesson_name
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.id = ?
    `,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد ❗️");
    return;
  }

  const isCorrect = chosenOption === question.correct_option;
  const now = new Date().toISOString();

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  await env.DB.prepare(
    `UPDATE user_word_question_history
     SET is_correct = ?, answered_at = ?
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`
  ).bind(isCorrect ? 1 : 0, now, user.id, question.id).run();

  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);
  const levelLabel = `سطح ${question.level}`;
  const explanation = question.explanation_text;

  let replyText: string;
  if (isCorrect) {
    replyText =
      `✅ آفرین! جواب درسته.\n\n` +
      `کلمه: <b>${question.english}</b>\n` +
      `معنی: <b>${question.persian}</b>\n` +
      `📊 ${levelLabel}`;
  } else {
    replyText =
      `❌ جوابت درست نبود.\n\n` +
      `جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
      `کلمه: <b>${question.english}</b>\n` +
      `معنی: <b>${question.persian}</b>\n` +
      `📊 ${levelLabel}`;
  }

  const lessonDisplay = trimLessonName(question.lesson_name);
  if (lessonDisplay) {
    replyText += `\n📖 درس: ${lessonDisplay}`;
  }

  if (explanation) {
    replyText += `\n\n${explanation}`;
  }

  let ratingButtons: any[];
  if (isCorrect) {
    ratingButtons = [
      { text: ratingLabel(Rating.Good), callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Good}:${mode}`, style: "success" },
      { text: ratingLabel(Rating.Easy), callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Easy}:${mode}`, style: "primary" },
    ];
  } else {
    ratingButtons = [
      { text: ratingLabel(Rating.Again), callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Again}:${mode}`, style: "danger" },
      { text: ratingLabel(Rating.Hard), callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Hard}:${mode}`, style: "primary" },
    ];
  }

  replyText += `\n\n💡 <i>چقدر این واژه رو بلد بودی؟</i>`;

  const rows: any[][] = [ratingButtons];
  if (mode === "leech") rows.push([unleechButton(question.id, mode)]);
  rows.push([ignoreButton(question.id, mode)]);
  rows.push([exitButton(mode)]);

  await sendMessage(env, chatId, replyText, { reply_markup: { inline_keyboard: rows } });
}
