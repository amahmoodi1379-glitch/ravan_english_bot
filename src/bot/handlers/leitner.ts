import { Env } from "../../types";
import { TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, prepare } from "../../db/client";
import {
  pickNextReviewWord,
  pickNextNewWord,
  pickNextLeechWord,
  getWordStage,
  prepareUpdateFsrs,
  markWordAsIgnored,
  clearLeech,
  countDueWords,
  countNewWords,
  countNewWordsByLevel,
  countLeechWords,
  getReviewStats,
  DbWord,
} from "../../db/leitner";
import { prepareXpForLeitner, checkAndUpdateStreak } from "../../db/xp";
import {
  CB_PREFIX,
  LEITNER_TEST_TYPE_ORDER,
  LEITNER_TEST_TYPES,
  LeitnerTestType,
} from "../../config/constants";
import { getWordStylePrioritySql } from "../../db/question_priority";
import { optionLetterToNumber } from "../../utils/options";
import { Rating, ratingLabel, ratingEmoji } from "../../utils/fsrs";
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
  english: string;
  persian: string;
  level: number;
}

type ReviewMode = "review" | "new" | "leech" | "new1" | "new2" | "new3" | "new4";

function isReviewMode(m: string): m is ReviewMode {
  return m === "review" || m === "new" || m === "leech" || m === "new1" || m === "new2" || m === "new3" || m === "new4";
}

function parseMode(raw: string | undefined): ReviewMode {
  return raw && isReviewMode(raw) ? raw : "review";
}

function getLevelFromMode(mode: ReviewMode): number | undefined {
  if (mode === "new1") return 1;
  if (mode === "new2") return 2;
  if (mode === "new3") return 3;
  if (mode === "new4") return 4;
  return undefined;
}

function isNewMode(mode: ReviewMode): boolean {
  return mode === "new" || mode === "new1" || mode === "new2" || mode === "new3" || mode === "new4";
}

// --- Button builders (single source of truth) ---

function exitButtonText(mode: ReviewMode): string {
  if (isNewMode(mode)) return "🚪 پایان یادگیری";
  if (mode === "leech") return "🚪 پایان تمرین";
  return "🚪 پایان مرور";
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
    keyboard.push([{ text: `📋 شروع مرور (${dueCount})`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:review`, style: "success" }]);
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
  if (mode === "review") return pickNextReviewWord(env, userId);
  if (mode === "leech") return pickNextLeechWord(env, userId);
  // All "new" modes (new, new1, new2, new3, new4)
  const level = getLevelFromMode(mode);
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
  await sendMessage(env, chatId, "📚 همه واژه‌های موجود رو شروع کردی! آفرین! 🌟", {
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
           q.correct_option, q.question_style, w.english, w.persian, w.level
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
           q.correct_option, q.question_style, w.english, w.persian, w.level
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
           q.correct_option, q.question_style, w.english, w.persian, w.level
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
            q.correct_option, q.question_style, w.english, w.persian, w.level
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

  // Fetch explanation
  const explanationRow = await queryOne<{ explanation_text: string | null }>(
    env,
    `SELECT explanation_text FROM word_questions WHERE id = ?`,
    [question.id]
  );
  const explanation = explanationRow?.explanation_text;
  const levelLabel = `سطح ${question.level}`;

  let replyText =
    `🔴 جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
    `کلمه: <b>${question.english}</b>\n` +
    `معنی: <b>${question.persian}</b>\n` +
    `📊 ${levelLabel}`;

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

  let confirmText = "مطمئنی میخوای از مرور خارج بشی؟";
  if (isNewMode(mode)) confirmText = "مطمئنی میخوای از یادگیری واژه‌های جدید خارج بشی؟";
  else if (mode === "leech") confirmText = "مطمئنی میخوای از تمرین واژه‌های سخت خارج بشی؟";

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

  const question = await queryOne<{ word_id: number; level: number }>(
    env,
    `SELECT q.word_id, w.level FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
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

  // Auto-advance: go directly to next question
  await sendLeitnerQuestion(env, user, chatId, mode);
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
           q.correct_option, q.question_style, w.english, w.persian, w.level
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

  // Fetch explanation
  const explanationRow = await queryOne<{ explanation_text: string | null }>(
    env,
    `SELECT explanation_text FROM word_questions WHERE id = ?`,
    [question.id]
  );
  const explanation = explanationRow?.explanation_text;

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
