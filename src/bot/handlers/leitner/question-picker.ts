import { Env } from "../../../types";
import { InlineKeyboardButton } from "../../types";
import { DbUser } from "../../../db/users";
import { pe } from "../../premium-emojis";
import { queryOne, execute } from "../../../db/client";
import {
  pickNextReviewWord,
  pickNextNewWord,
  pickNextNewWordByLesson,
  pickNextLeechWord,
  getWordStage,
  countNewWords,
  getLessonNameById,
  DbWord,
} from "../../../db/leitner";
import { getWordStylePrioritySql } from "../../../db/question_priority";
import { sendMessage } from "../../telegram-api";
import { CB_PREFIX, QUESTION_PICK_MAX_ATTEMPTS } from "../../../config/constants";
import { trimLessonName } from "../../../utils/lesson";
import {
  LeitnerQuestionRow,
  ReviewMode,
  isLessonMode,
  getLessonIdFromMode,
  getLevelFromMode,
  isReviewModeType,
  exitButton,
  homeButton,
  getQuestionStyleForStage,
  getStylesForType,
} from "./utils";

// --- Question Picking Helpers ---

/**
 * Pick a question for a user's word from a prioritized set of question styles.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param word - The word to find a question for
 * @param styles - Allowed question_style values to filter by
 * @returns A matching question row, or null if none found
 */
export async function pickQuestionForUserWord(
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


/**
 * Pick a random unseen question for the given word (any style the user hasn't seen).
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param word - The word to find a question for
 * @returns A question row the user hasn't seen, or null if all have been seen
 */
export async function pickRandomUnseenQuestion(
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

/**
 * Pick any random question for the word (including previously seen), preferring unseen ones.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param word - The word to find a question for
 * @returns A question row (possibly previously seen), or null if the word has no questions
 */
export async function pickRandomQuestionAny(
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

// --- Word Picker ---

/**
 * Pick the next word to practice based on the active review mode.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to pick a word for
 * @param mode - The current ReviewMode determining which word pool to draw from
 * @returns The next word to practice, or null if the pool is exhausted
 */
export async function pickWordForMode(env: Env, userId: number, mode: ReviewMode): Promise<DbWord | null> {
  if (mode === "leech") return pickNextLeechWord(env, userId);
  if (isLessonMode(mode)) {
    const lessonId = getLessonIdFromMode(mode);
    if (lessonId !== undefined) {
      const rawName = await getLessonNameById(env, lessonId);
      const lessonName = trimLessonName(rawName);
      return pickNextNewWordByLesson(env, userId, lessonName);
    }
    // Fallback: if lesson_id is invalid, treat as regular new word mode
    return pickNextNewWord(env, userId);
  }
  const level = getLevelFromMode(mode);
  if (isReviewModeType(mode)) return pickNextReviewWord(env, userId, level);
  return pickNextNewWord(env, userId, level);
}

/**
 * Send the next question. Uses a bounded loop (not recursion) to skip words
 * that have no questions, avoiding any chance of a stack overflow / infinite loop.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the question to
 * @param mode - The current ReviewMode determining the word pool
 * @returns void
 */
export async function sendLeitnerQuestion(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode
): Promise<void> {
  const seenWordIds = new Set<number>();

  for (let attempt = 0; attempt < QUESTION_PICK_MAX_ATTEMPTS; attempt++) {
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

    // Record that the user has seen this question. On re-show (same question comes
    // due again — common in FSRS when a word was rated "Again"/"Hard" and no other
    // unseen question exists for it), fully reset the attempt state: answered_at,
    // is_correct AND rated_at. Leaving a stale rated_at here would make the rating
    // claim in handleRating (guarded on rated_at IS NULL) a no-op, stranding the
    // user on "امتیاز قبلاً ثبت شده" with no way to advance.
    const now = new Date().toISOString();
    await execute(
      env,
      `INSERT INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
       VALUES (?, ?, ?, 'leitner', ?)
       ON CONFLICT(user_id, question_id, context)
       DO UPDATE SET shown_at = excluded.shown_at, answered_at = NULL, is_correct = NULL, rated_at = NULL`,
      [user.id, question.word_id, question.id, now]
    );

    const messageText =
      `${pe("✏️")} <b>${question.question_text}</b>\n\n` +
      `1️⃣  ${question.option_a}\n` +
      `2️⃣  ${question.option_b}\n` +
      `3️⃣  ${question.option_c}\n` +
      `4️⃣  ${question.option_d}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "1️⃣", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:A:${mode}`, style: "primary" },
          { text: "2️⃣", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:B:${mode}`, style: "primary" },
          { text: "3️⃣", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:C:${mode}`, style: "primary" },
          { text: "4️⃣", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:D:${mode}`, style: "primary" },
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
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the completion message to
 * @param mode - The ReviewMode that was just completed
 * @returns void
 */
export async function sendCompletionMessage(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode
): Promise<void> {
  if (mode === "review") {
    const newCount = await countNewWords(env, user.id);
    let text = `${pe("🎉")} <b>تبریک! همه مرورهای امروز رو تموم کردی!</b> ${pe("💪")}`;
    const keyboard: InlineKeyboardButton[][] = [];
    if (newCount > 0) {
      text += `\n\n${pe("⚡")} <b>${newCount}</b> واژه جدید آماده یادگیری. میخوای ادامه بدی؟`;
      keyboard.push([{ text: "🆕 شروع واژه‌های جدید", callback_data: `${CB_PREFIX.LEITNER_NEW_LEVEL}:pick`, style: "primary"}]);
    }
    keyboard.push([{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}`}]);
    await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
    return;
  }

  if (mode === "leech") {
    await sendMessage(env, chatId, `${pe("🎉")} <b>تمرین واژه‌های سخت تموم شد! آفرین</b> ${pe("👑")}`, {
      reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}`}]] },
    });
    return;
  }

  // Lesson-filtered mode (newL:X)
  if (isLessonMode(mode)) {
    const lessonId = getLessonIdFromMode(mode);
    let lessonLabel = "این درس";
    if (lessonId !== undefined) {
      const rawName = await getLessonNameById(env, lessonId);
      const lessonName = trimLessonName(rawName);
      if (lessonName) lessonLabel = `درس «${lessonName}»`;
    }
    await sendMessage(env, chatId, `${pe("🌟")} واژه‌های ${lessonLabel} رو تموم کردی! آفرین ${pe("🎉")}`, {
      reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}`}]] },
    });
    return;
  }

  // Level-based mode (new, new1–4)
  const level = getLevelFromMode(mode);
  const levelText = level ? `واژه‌های سطح ${level}` : "همه واژه‌های جدید";
  await sendMessage(env, chatId, `${pe("🌟")} ${levelText} رو تموم کردی! آفرین ${pe("🎉")}`, {
    reply_markup: { inline_keyboard: [[{ text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}`}]] },
  });
}
