import { Env } from "../../types";
import { TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, prepare } from "../../db/client";
import {
  pickNextReviewWord,
  pickNextNewWord,
  getOrCreateUserWordState,
  prepareUpdateFsrs,
  markWordAsIgnored,
  countDueWords,
  countNewWords,
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

type ReviewMode = "review" | "new";

// --- Stage/Question Type Logic ---

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
 * Start the leitner review menu for a user (shows review/new word options).
 */
export async function startLeitnerForUser(env: Env, user: DbUser, chatId: number): Promise<void> {
  const dueCount = await countDueWords(env, user.id);
  const newCount = await countNewWords(env, user.id);

  if (dueCount === 0 && newCount === 0) {
    await sendMessage(env, chatId, "🎉 عالی! هیچ واژه‌ای برای مرور یا یادگیری نداری. بعداً سر بزن!");
    return;
  }

  let text = "🧠 <b>سیستم مرور واژگان (FSRS)</b>\n\n";

  if (dueCount > 0) {
    text += `📋 <b>${dueCount}</b> واژه برای مرور امروز داری\n`;
  } else {
    text += `✅ مرورهای امروز تکمیل شده!\n`;
  }

  if (newCount > 0) {
    text += `🆕 <b>${newCount}</b> واژه جدید آماده یادگیری\n`;
  } else {
    text += `📚 همه واژه‌ها رو شروع کردی!\n`;
  }

  const keyboard: any[][] = [];

  if (dueCount > 0) {
    keyboard.push([{ text: "📋 شروع مرور", callback_data: `${CB_PREFIX.LEITNER_NEXT}:review` }]);
  }
  if (newCount > 0) {
    keyboard.push([{ text: "🆕 واژه‌های جدید", callback_data: `${CB_PREFIX.LEITNER_NEXT}:new` }]);
  }

  await sendMessage(env, chatId, text, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

// --- Question Sending ---

/**
 * Send the next question to the user.
 * Uses a loop instead of recursion to avoid stack overflow when words have no questions.
 */
async function sendLeitnerQuestion(
  env: Env,
  user: DbUser,
  chatId: number,
  mode: ReviewMode
): Promise<void> {
  // Loop with a max attempt guard to prevent infinite loops
  const MAX_ATTEMPTS = 10;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const word = mode === "review"
      ? await pickNextReviewWord(env, user.id)
      : await pickNextNewWord(env, user.id);

    if (!word) {
      // No more words available
      if (mode === "review") {
        const newCount = await countNewWords(env, user.id);
        if (newCount > 0) {
          await sendMessage(
            env,
            chatId,
            `🎉 تبریک! همه مرورهای امروز رو تموم کردی! 👏\n\n🆕 ${newCount} واژه جدید آماده یادگیری.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🆕 شروع واژه‌های جدید", callback_data: `${CB_PREFIX.LEITNER_NEXT}:new` }],
                ],
              },
            }
          );
        } else {
          await sendMessage(env, chatId, "🎉 تبریک! همه مرورهای امروز رو تموم کردی! 👏");
        }
      } else {
        await sendMessage(env, chatId, "📚 همه واژه‌های موجود رو شروع کردی! آفرین! 🌟");
      }
      return;
    }

    const state = await getOrCreateUserWordState(env, user.id, word.id);
    const stage = state.question_stage || 1;
    const prioritizedTypes = getQuestionStyleForStage(stage);

    let question: LeitnerQuestionRow | null = null;

    for (const testType of prioritizedTypes) {
      const styles = getStylesForType(testType);
      if (styles.length === 0) continue;
      question = await pickQuestionForUserWord(env, user, word, styles);
      if (question) break;
    }

    if (!question) {
      question = await pickRandomUnseenQuestion(env, user, word);
    }

    if (!question) {
      question = await pickRandomQuestionAny(env, user, word);
    }

    if (!question) {
      // This word has no questions at all — skip and try next word
      // Mark it so we don't get stuck (create state so it's not "new" anymore)
      continue;
    }

    // Record that user has seen this question
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
       VALUES (?, ?, ?, 'leitner', ?)`
    ).bind(user.id, question.word_id, question.id, now).run();

    // Build question message
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
        [
          { text: "❌ نمیدونم", callback_data: `${CB_PREFIX.LEITNER_DUNNO}:${question.id}:${mode}` },
        ],
        [
          { text: "🚪 خروج از مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` },
        ],
      ],
    };

    await sendMessage(env, chatId, messageText, { reply_markup: replyMarkup });
    return;
  }

  // If we exhausted all attempts (all words lack questions)
  await sendMessage(env, chatId, "❗️ متأسفانه برای واژه‌های فعلی سوالی ثبت نشده. لطفاً بعداً دوباره تلاش کن.");
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

// --- Helper: get correct option text ---
function getCorrectOptionText(q: LeitnerQuestionRow): string {
  switch (q.correct_option) {
    case "A": return q.option_a;
    case "B": return q.option_b;
    case "C": return q.option_c;
    case "D": return q.option_d;
    default: return "";
  }
}

// --- Callback Handler ---

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
  const user = await getOrCreateUser(env, callbackQuery.from);

  try {
    // --- "نمیدونم" button ---
    if (prefix === CB_PREFIX.LEITNER_DUNNO) {
      await handleDunno(env, callbackQuery, user, chatId, parts);
      return;
    }

    // --- "خروج از مرور" button ---
    if (prefix === CB_PREFIX.LEITNER_EXIT) {
      await handleExitRequest(env, callbackQuery, chatId, parts);
      return;
    }

    // --- Exit confirmed ---
    if (prefix === CB_PREFIX.LEITNER_EXIT_CONFIRM) {
      await handleExitConfirm(env, callbackQuery, user, chatId, parts);
      return;
    }

    // --- "سوال بعدی" or start mode ---
    if (prefix === CB_PREFIX.LEITNER_NEXT) {
      const mode = (parts[1] || "review") as ReviewMode;
      await answerCallbackQuery(env, callbackQuery.id);
      await sendLeitnerQuestion(env, user, chatId, mode);
      return;
    }

    // --- FSRS Rating after answer ---
    if (prefix === CB_PREFIX.LEITNER_RATE) {
      await handleRating(env, callbackQuery, user, chatId, parts);
      return;
    }

    // --- Ignore word (بلدم) ---
    if (prefix === CB_PREFIX.LEITNER_IGNORE) {
      await handleIgnoreWord(env, callbackQuery, user, chatId, parts);
      return;
    }

    // --- Answer to a question ---
    if (prefix === CB_PREFIX.LEITNER) {
      await handleAnswer(env, callbackQuery, user, chatId, parts);
      return;
    }

    // Unrecognized — acknowledge silently
    await answerCallbackQuery(env, callbackQuery.id);
  } catch (error) {
    console.error("Error in handleLeitnerCallback:", error);
    try {
      await answerCallbackQuery(env, callbackQuery.id, "خطایی رخ داد. لطفاً دوباره تلاش کن.");
    } catch {
      // If answerCallbackQuery also fails, nothing we can do
    }
  }
}

// --- Sub-handlers ---

async function handleDunno(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = (parts[2] || "review") as ReviewMode;

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // Prevent double-submission
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

  const now = new Date().toISOString();

  // Mark as answered (incorrect) + apply FSRS Again
  const batchStatements: any[] = [];
  batchStatements.push(prepare(
    env,
    `UPDATE user_word_question_history
     SET is_correct = 0, answered_at = ?
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`,
    [now, user.id, question.id]
  ));

  const fsrsStmts = await prepareUpdateFsrs(env, user.id, question.word_id, Rating.Again);
  batchStatements.push(...fsrsStmts);

  await env.DB.batch(batchStatements);

  // Show the correct answer
  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);

  const replyText =
    `🔴 جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
    `کلمه: <b>${question.english}</b>\n` +
    `معنی: <b>${question.persian}</b>`;

  await sendMessage(env, chatId, replyText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` }],
        [{ text: "🚪 پایان مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` }],
      ],
    },
  });
}

async function handleExitRequest(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  chatId: number,
  parts: string[]
): Promise<void> {
  const mode = (parts[1] || "review") as ReviewMode;
  await answerCallbackQuery(env, callbackQuery.id);

  await sendMessage(env, chatId, "مطمئنی میخوای از مرور خارج بشی؟", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ بله، خروج", callback_data: `${CB_PREFIX.LEITNER_EXIT_CONFIRM}:${mode}` },
          { text: "❌ نه، ادامه بده", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` },
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
  parts: string[]
): Promise<void> {
  await answerCallbackQuery(env, callbackQuery.id);

  const stats = await getReviewStats(env, user.id, 24);

  let summaryText = "📊 <b>خلاصه مرور امروز:</b>\n\n";
  if (stats.total > 0) {
    const accuracy = Math.round((stats.correct / stats.total) * 100);
    summaryText += `✅ درست: ${stats.correct}\n`;
    summaryText += `❌ غلط: ${stats.incorrect}\n`;
    summaryText += `📈 دقت: ${accuracy}%\n`;
    summaryText += `📝 کل: ${stats.total} سوال\n`;
  } else {
    summaryText += `هنوز سوالی جواب نداده‌ای.\n`;
  }

  summaryText += `\nخسته نباشی! از منوی پایین ادامه بده 😊`;
  await sendMessage(env, chatId, summaryText);
}

async function handleRating(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const ratingValue = Number(parts[2]) as Rating;
  const mode = (parts[3] || "review") as ReviewMode;

  if (!Number.isFinite(questionId) || !Number.isFinite(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (![Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].includes(ratingValue)) {
    await answerCallbackQuery(env, callbackQuery.id, "نامعتبر");
    return;
  }

  // Prevent double-rating: check if FSRS was already applied for this question
  // We use the answered_at + a heuristic: if the word was reviewed in the last 30 seconds,
  // the rating was already applied.
  const recentReview = await queryOne<{ id: number }>(
    env,
    `SELECT s.id FROM user_words_sm2 s
     JOIN word_questions q ON q.word_id = s.word_id
     WHERE s.user_id = ? AND q.id = ?
       AND s.last_reviewed_at IS NOT NULL
       AND (julianday('now') - julianday(s.last_reviewed_at)) * 86400 < 30`,
    [user.id, questionId]
  );
  if (recentReview) {
    await answerCallbackQuery(env, callbackQuery.id, "امتیاز قبلاً ثبت شده 👍");
    // Still show next button so user isn't stuck
    await sendMessage(env, chatId, "👍 قبلاً ثبت شده بود.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` }],
          [{ text: "🚪 پایان مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` }],
        ],
      },
    });
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);

  // Get the question to find the word
  const question = await queryOne<{ word_id: number; level: number }>(
    env,
    `SELECT q.word_id, w.level FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
    [questionId]
  );

  if (!question) {
    await sendMessage(env, chatId, "❗️ خطا: سوال پیدا نشد.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` }],
        ],
      },
    });
    return;
  }

  // Apply FSRS rating
  const batchStatements: any[] = [];
  const fsrsStmts = await prepareUpdateFsrs(env, user.id, question.word_id, ratingValue);
  batchStatements.push(...fsrsStmts);

  // Award XP only for Good/Easy ratings
  if (ratingValue >= Rating.Good) {
    const xpStmts = prepareXpForLeitner(env, user.id, question.word_id, question.level, true);
    batchStatements.push(...xpStmts);
  }

  await env.DB.batch(batchStatements);

  // Check streak for Good/Easy
  if (ratingValue >= Rating.Good) {
    const streakMsg = await checkAndUpdateStreak(env, user.id);
    if (streakMsg) {
      await sendMessage(env, chatId, streakMsg);
    }
  }

  // Show next button
  const emoji = ratingEmoji(ratingValue);
  await sendMessage(env, chatId, `${emoji} ثبت شد!`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` }],
        [{ text: "🚪 پایان مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` }],
      ],
    },
  });
}

async function handleIgnoreWord(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const mode = (parts[2] || "review") as ReviewMode;

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

  await sendMessage(env, chatId, `واژه‌ی <b>${question.english}</b> از چرخه مرور حذف شد ✅`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➡️ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}` }],
        [{ text: "🚪 پایان مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` }],
      ],
    },
  });
}

async function handleAnswer(
  env: Env,
  callbackQuery: TelegramCallbackQuery,
  user: DbUser,
  chatId: number,
  parts: string[]
): Promise<void> {
  const questionId = Number(parts[1]);
  const chosenOption = parts[2];
  const mode = (parts[3] || "review") as ReviewMode;

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (!chosenOption || !["A", "B", "C", "D"].includes(chosenOption)) {
    await answerCallbackQuery(env, callbackQuery.id, "گزینه نامعتبر");
    return;
  }

  // Prevent double-submission
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

  // Record answer in history
  await env.DB.prepare(
    `UPDATE user_word_question_history
     SET is_correct = ?, answered_at = ?
     WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`
  ).bind(isCorrect ? 1 : 0, now, user.id, question.id).run();

  // Build feedback message
  const correctNum = optionLetterToNumber(question.correct_option);
  const correctText = getCorrectOptionText(question);

  let replyText: string;
  if (isCorrect) {
    replyText =
      `✅ آفرین! جواب درسته.\n\n` +
      `کلمه: <b>${question.english}</b>\n` +
      `معنی: <b>${question.persian}</b>`;
  } else {
    replyText =
      `❌ جوابت درست نبود.\n\n` +
      `جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
      `کلمه: <b>${question.english}</b>\n` +
      `معنی: <b>${question.persian}</b>`;
  }

  // Show FSRS self-assessment buttons
  let ratingButtons: any[];

  if (isCorrect) {
    ratingButtons = [
      {
        text: `🟢 ${ratingLabel(Rating.Good)}`,
        callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Good}:${mode}`,
      },
      {
        text: `⭐ ${ratingLabel(Rating.Easy)}`,
        callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Easy}:${mode}`,
      },
    ];
  } else {
    ratingButtons = [
      {
        text: `🔴 ${ratingLabel(Rating.Again)}`,
        callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Again}:${mode}`,
      },
      {
        text: `🟠 ${ratingLabel(Rating.Hard)}`,
        callback_data: `${CB_PREFIX.LEITNER_RATE}:${question.id}:${Rating.Hard}:${mode}`,
      },
    ];
  }

  replyText += `\n\n💡 <i>چقدر این واژه رو بلد بودی؟</i>`;

  await sendMessage(env, chatId, replyText, {
    reply_markup: {
      inline_keyboard: [
        ratingButtons,
        [{ text: "🚪 خروج از مرور", callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}` }],
      ],
    },
  });
}
