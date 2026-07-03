import { Env } from "../../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../../types";
import { sendMessage, answerCallbackQuery, editMessageText } from "../../telegram-api";
import { getOrCreateUser, DbUser } from "../../../db/users";
import { pe } from "../../premium-emojis";
import { queryOne, prepare, SqlGuard, batch as runBatch, withD1Retry } from "../../../db/client";
import {
  prepareUpdateFsrs,
  markWordAsIgnored,
  clearLeech,
  countDueWords,
  countDueWordsByLevel,
  countNewWords,
  countNewWordsByLevel,
  countLeechWords,
  getReviewStats,
  getQuestionAnswerStats,
} from "../../../db/leitner";
import { formatAnswerStatsLine } from "../../../utils/answer_stats";
import { prepareXpForLeitner, prepareXpForLeitnerDunno, checkAndUpdateStreak } from "../../../db/xp";
import { recordWordQuestionReport } from "../../../db/word_reports";
import {
  CB_PREFIX,
} from "../../../config/constants";
import { optionLetterToNumber } from "../../../utils/options";
import { Rating, ratingLabel, ratingEmoji } from "../../../utils/fsrs";
import { trimLessonName } from "../../../utils/lesson";
import { getTrainingMenuKeyboard } from "../../keyboards";
import {
  LeitnerQuestionRow,
  ReviewMode,
  extractMode,
  exitConfirmText,
  nextButton,
  exitButton,
  ignoreButton,
  unleechButton,
  reportButton,
  homeButton,
  nextAndExitRows,
  getCorrectOptionText,
  removeInlineKeyboard,
} from "./utils";
import {
  sendLeitnerQuestion,
} from "./question-picker";
import {
  handleLessonPicker,
  handleLessonTransition,
  checkLessonTransitionAndSend,
} from "./lesson-picker";

// --- Entry Point ---

/**
 * Show the leitner home menu (review / new / hard-words), and hide the
 * reply keyboard so the flow is purely inline-button driven.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the menu to
 * @returns void
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

  let text = `${pe("🧠")} <b>سیستم مرور واژگان (FSRS)</b>\n\n`;
  text += dueCount > 0
    ? `📋 <b>${dueCount}</b> واژه برای مرور امروز داری\n`
    : `${pe("✅")} مرورهای امروز تکمیل شده!\n`;
  text += newCount > 0
    ? `${pe("⚡")} <b>${newCount}</b> واژه جدید آماده یادگیری\n`
    : `📚 همه واژه‌ها رو شروع کردی!\n`;
  if (leechCount > 0) {
    text += `${pe("🔥")} <b>${leechCount}</b> واژه‌ی سخت نیاز به تمرین بیشتر دارن\n`;
  }

  const keyboard: InlineKeyboardButton[][] = [];
  if (dueCount > 0) {
    keyboard.push([{ text: `📋 شروع مرور (${dueCount})`, callback_data: `${CB_PREFIX.LEITNER_REVIEW_LEVEL}:pick`, style: "success" }]);
  }
  if (newCount > 0) {
    keyboard.push([{ text: `🆕 واژه‌های جدید (${newCount})`, callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:pick`, style: "primary" }]);
  }
  if (leechCount > 0) {
    keyboard.push([{ text: `🔥 واژه‌های سخت (${leechCount})`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:leech`, style: "danger" }]);
  }
  keyboard.push([homeButton()]);

  await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });

  // Remove the reply keyboard while in leitner; navigation is fully inline.
  await sendMessage(env, chatId, "⬇️ از دکمه‌های بالا استفاده کن:", {
    reply_markup: { remove_keyboard: true },
  });
}

// --- Callback Dispatcher ---

/**
 * Dispatch a leitner-related callback query to the appropriate sub-handler.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query with leitner-prefixed data
 * @returns void
 */
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
        const mode = extractMode(parts, 1);
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
      case CB_PREFIX.LEITNER_REPORT:
        await handleReportRequest(env, callbackQuery, chatId, parts);
        return;
      case CB_PREFIX.LEITNER_REPORT_CONFIRM:
        await handleReportConfirm(env, callbackQuery, user, chatId, messageId, parts);
        return;
      case CB_PREFIX.LEITNER_REPORT_CANCEL:
        await handleReportCancel(env, callbackQuery, chatId, messageId);
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
  const mode = extractMode(parts, 2);

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

  // Exactly-once, fully atomic: apply FSRS (Again) and claim answered_at as ONE
  // DB.batch() (single transaction). FSRS is gated on the row still being
  // unanswered and the claim runs LAST, so within the winning transaction FSRS
  // applies (gate still sees NULL) while any concurrent/duplicate request finds
  // answered_at already set and becomes a full no-op. One transaction ⇒ no
  // partial-failure window: FSRS and the answered mark commit together or not.
  const now = new Date().toISOString();
  const guard: SqlGuard = {
    sql: `EXISTS (SELECT 1 FROM user_word_question_history
                  WHERE user_id = ? AND question_id = ? AND context = 'leitner'
                    AND answered_at IS NULL)`,
    params: [user.id, question.id],
  };

  const batch: D1PreparedStatement[] = [];
  batch.push(...await prepareUpdateFsrs(env, user.id, question.word_id, Rating.Again, guard));
  batch.push(...prepareXpForLeitnerDunno(env, user.id, question.word_id, question.level, guard));
  // Claim LAST so the gates above evaluate against the pre-claim state.
  batch.push(prepare(
    env,
    `UPDATE user_word_question_history
     SET is_correct = 0, answered_at = ?, first_is_correct = COALESCE(first_is_correct, 0)
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`,
    [now, user.id, question.id]
  ));

  const results = await runBatch(env, batch);
  const claimResult = results[results.length - 1];
  if (!claimResult || claimResult.meta.changes === 0) {
    await answerCallbackQuery(env, callbackQuery.id, "قبلاً پاسخ داده شده 👍");
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);
  const explanation = question.explanation_text;
  const levelLabel = `سطح ${question.level}`;

  let replyText =
    `🤔 <b>نمیدونستی؟</b> اشکال نداره!\n\n` +
    `✅ جواب صحیح: گزینه <b>${correctNum}</b> — ${correctText}\n` +
    `🔤 کلمه: <b>${question.english}</b>\n` +
    `🔵 معنی: <b>${question.persian}</b>\n` +
    `📊 ${levelLabel}`;

  const lessonDisplayDunno = trimLessonName(question.lesson_name);
  if (lessonDisplayDunno) {
    replyText += `\n📖 درس: ${lessonDisplayDunno}`;
  }

  if (explanation) {
    replyText += `\n\n${explanation}`;
  }

  const dunnoStats = await getQuestionAnswerStats(env, question.id);
  replyText += formatAnswerStatsLine(dunnoStats);

  const rows: InlineKeyboardButton[][] = [];
  if (mode === "leech") rows.push([unleechButton(question.id, mode)]);
  rows.push([ignoreButton(question.id, mode), reportButton(question.id)]);
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
  const mode = extractMode(parts, 1);
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

  let summaryText = `${pe("📊")} <b>خلاصه امروز</b>\n`;
  summaryText += `━━━━━━━━━━━━━━\n`;
  if (stats.total > 0) {
    const accuracy = Math.round((stats.correct / stats.total) * 100);
    summaryText += `✅ درست: <b>${stats.correct}</b>\n`;
    summaryText += `❌ غلط: <b>${stats.incorrect}</b>\n`;
    summaryText += `📈 دقت: <b>${accuracy}٪</b>\n`;
    summaryText += `📝 کل: <b>${stats.total}</b> سوال\n`;
  } else {
    summaryText += `هنوز سوالی جواب نداده‌ای.\n`;
  }
  summaryText += `\n${pe("💪")} خسته نباشی!`;

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
  const mode = extractMode(parts, 3);

  if (!Number.isFinite(questionId) || !Number.isFinite(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id, "نامعتبر");
    return;
  }

  // Read question/word info first — this is a side-effect-free read.
  const question = await queryOne<{ word_id: number; level: number; lesson_name: string | null }>(
    env,
    `SELECT q.word_id, w.level, w.lesson_name FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(env, chatId, "❗️ خطا: سوال پیدا نشد.", {
      reply_markup: { inline_keyboard: [[nextButton(mode)], [homeButton()]] },
    });
    return;
  }

  // Exactly-once, fully atomic: build the whole effect (FSRS + XP + the rated_at
  // claim) as ONE DB.batch() — a single transaction. The FSRS/XP statements are
  // gated on the row still being unclaimed (rated_at IS NULL) and the claim
  // statement runs LAST. Within the winning transaction the gates still see NULL
  // (claim hasn't run yet) so everything applies; any concurrent/duplicate
  // request runs after the first commits, sees rated_at set, and every statement
  // (gates + claim) becomes a no-op. Because it is one transaction there is no
  // partial-failure window: either the claim AND its XP/FSRS all commit, or none
  // do — so XP can never be burned, nor double-awarded.
  const ratedAt = new Date().toISOString();
  const guard: SqlGuard = {
    sql: `EXISTS (SELECT 1 FROM user_word_question_history
                  WHERE user_id = ? AND question_id = ? AND context = 'leitner'
                    AND answered_at IS NOT NULL AND rated_at IS NULL)`,
    params: [user.id, questionId],
  };

  const batch: D1PreparedStatement[] = [];
  batch.push(...await prepareUpdateFsrs(env, user.id, question.word_id, ratingValue, guard));
  batch.push(...prepareXpForLeitner(env, user.id, question.word_id, question.level, ratingValue, guard));
  // Claim LAST so the gates above evaluate against the pre-claim (NULL) state.
  batch.push(prepare(
    env,
    `UPDATE user_word_question_history
     SET rated_at = ?
     WHERE user_id = ? AND question_id = ? AND context = 'leitner'
       AND answered_at IS NOT NULL AND rated_at IS NULL`,
    [ratedAt, user.id, questionId]
  ));

  const results = await runBatch(env, batch);
  const claimResult = results[results.length - 1];
  if (!claimResult || claimResult.meta.changes === 0) {
    // Lost the race / already rated — nothing was applied by this request.
    await answerCallbackQuery(env, callbackQuery.id, "امتیاز قبلاً ثبت شده 👍");
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
  await removeInlineKeyboard(env, chatId, messageId);

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
  const mode = extractMode(parts, 2);

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
  const mode = extractMode(parts, 2);

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
  const mode = extractMode(parts, 2);

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

async function handleReportRequest(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);

  // Send a SEPARATE confirmation message so the answer message (and its rating
  // buttons) stays intact — the user must still be able to rate the word.
  await sendMessage(
    env,
    chatId,
    "🚩 می‌خوای این سوال رو برای بررسی به ادمین گزارش کنی؟\n\nاگه سوال یا گزینه‌ها اشکال داره، گزارشت کمک می‌کنه اصلاحش کنیم.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ بله، گزارش کن", callback_data: `${CB_PREFIX.LEITNER_REPORT_CONFIRM}:${questionId}`, style: "danger" },
            { text: "❌ نه، بیخیال", callback_data: `${CB_PREFIX.LEITNER_REPORT_CANCEL}:1` },
          ],
        ],
      },
    }
  );
}

async function handleReportConfirm(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  messageId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const result = await recordWordQuestionReport(env, questionId, user.id);

  let toast: string;
  let finalText: string;
  if (result === "created") {
    toast = "گزارش ثبت شد ✅";
    finalText = "✅ گزارش تو ثبت شد. ممنون که به بهتر شدن سوال‌ها کمک کردی! 🙏";
  } else if (result === "duplicate") {
    toast = "قبلاً گزارش کرده بودی 👍";
    finalText = "🚩 این سوال رو قبلاً گزارش کرده بودی. ممنون!";
  } else {
    toast = "سوال پیدا نشد";
    finalText = "❗️ این سوال دیگه در دسترس نیست.";
  }

  await answerCallbackQuery(env, callbackQuery.id, toast);
  // Replace the confirmation message (also removes its buttons) with the result.
  await editMessageText(env, chatId, messageId, finalText).catch(() => {});
}

async function handleReportCancel(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number,
  messageId: number
): Promise<void> {
  await answerCallbackQuery(env, callbackQuery.id, "لغو شد");
  await editMessageText(env, chatId, messageId, "باشه، گزارش لغو شد.").catch(() => {});
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
    text += `📚 به‌ترتیب کتاب: <b>${total}</b> واژه\n`;
    const keyboard: InlineKeyboardButton[][] = [];

    // Primary options first: book-order (green) then lesson-based (blue)
    keyboard.push([{ text: `📚 به‌ترتیب کتاب (${total} واژه)`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:new`, style: "success" }]);
    keyboard.push([{ text: "📖 انتخاب بر اساس درس", callback_data: `${CB_PREFIX.LEITNER_LESSON_PICK}:0`, style: "primary" }]);

    for (const { level, count } of levelCounts) {
      if (count > 0) {
        text += `📗 سطح ${level}: <b>${count}</b> واژه\n`;
        keyboard.push([{
          text: `📗 سطح ${level} (${count} واژه)`,
          callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:${level}`
        }]);
      }
    }

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
    text += `📚 به‌ترتیب کتاب: <b>${total}</b> واژه\n`;
    const keyboard: InlineKeyboardButton[][] = [];

    // Book-order option first (green)
    keyboard.push([{ text: `📚 به‌ترتیب کتاب (${total} واژه)`, callback_data: `${CB_PREFIX.LEITNER_NEXT}:review`, style: "success" }]);

    for (const { level, count } of levelCounts) {
      if (count > 0) {
        text += `📗 سطح ${level}: <b>${count}</b> واژه\n`;
        keyboard.push([{
          text: `📗 سطح ${level} (${count} واژه)`,
          callback_data: `${CB_PREFIX.LEITNER_REVIEW_LEVEL}:${level}`
        }]);
      }
    }

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
  const mode = extractMode(parts, 3);

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
    `SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, q.question_style, q.explanation_text, w.english, w.persian, w.level,
           w.lesson_name
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.id = ?`,
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

  // Atomically mark as answered — if another request already answered, changes=0
  const answerResult = await withD1Retry(() => env.DB.prepare(
    `UPDATE user_word_question_history
     SET is_correct = ?, answered_at = ?, first_is_correct = COALESCE(first_is_correct, ?)
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`
  ).bind(isCorrect ? 1 : 0, now, isCorrect ? 1 : 0, user.id, question.id).run());

  if (answerResult.meta.changes === 0) {
    // Already answered by a concurrent request — silently stop
    return;
  }

  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);
  const levelLabel = `سطح ${question.level}`;
  const explanation = question.explanation_text;

  let replyText: string;
  if (isCorrect) {
    replyText =
      `${pe("✨")} <b>آفرین! جواب درسته</b> ✅\n\n` +
      `🔤 کلمه: <b>${question.english}</b>\n` +
      `🔵 معنی: <b>${question.persian}</b>\n` +
      `📊 ${levelLabel}`;
  } else {
    replyText =
      `❌ <b>جوابت درست نبود</b>\n\n` +
      `✅ جواب صحیح: گزینه <b>${correctNum}</b> — ${correctText}\n` +
      `🔤 کلمه: <b>${question.english}</b>\n` +
      `🔵 معنی: <b>${question.persian}</b>\n` +
      `📊 ${levelLabel}`;
  }

  const lessonDisplay = trimLessonName(question.lesson_name);
  if (lessonDisplay) {
    replyText += `\n📖 درس: ${lessonDisplay}`;
  }

  if (explanation) {
    replyText += `\n\n${explanation}`;
  }

  const answerStats = await getQuestionAnswerStats(env, question.id);
  replyText += formatAnswerStatsLine(answerStats);

  let ratingButtons: InlineKeyboardButton[];
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

  const rows: InlineKeyboardButton[][] = [ratingButtons];
  if (mode === "leech") rows.push([unleechButton(question.id, mode)]);
  rows.push([ignoreButton(question.id, mode), reportButton(question.id)]);
  rows.push([exitButton(mode)]);

  await sendMessage(env, chatId, replyText, { reply_markup: { inline_keyboard: rows } });
}
