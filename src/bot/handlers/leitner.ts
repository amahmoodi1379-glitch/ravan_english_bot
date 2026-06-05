import { Env } from "../../types";
import { TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute, prepare } from "../../db/client";
import {
  pickNextWordForUser,
  getOrCreateUserWordState,
  prepareUpdateSm2,
  markWordAsIgnored,
  DbWord
} from "../../db/leitner";
import { prepareXpForLeitner, checkAndUpdateStreak } from "../../db/xp";
import {
  CB_PREFIX,
  LEITNER_TEST_TYPE_ORDER,
  LEITNER_TEST_TYPES,
  LeitnerTestType
} from "../../config/constants";
import { getWordStylePrioritySql } from "../../db/question_priority";
import { optionLetterToNumber } from "../../utils/options";

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

export async function startLeitnerForUser(env: Env, user: DbUser, chatId: number): Promise<void> {
  await sendLeitnerQuestion(env, user, chatId);
}

async function sendLeitnerQuestion(env: Env, user: DbUser, chatId: number): Promise<void> {
  const word = await pickNextWordForUser(env, user.id);

  if (!word) {
    await sendMessage(env, chatId, "فعلاً هیچ واژه‌ای برای تمرین در سیستم ثبت نشده (یا همه رو بلدی!) 👏");
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
    await sendMessage(env, chatId, `برای واژه‌ی <b>${word.english}</b> هنوز سوالی در سیستم ثبت نشده است ❗️`);
    return;
  }

  const now = new Date().toISOString();
  await execute(
    env,
    `
      INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
      VALUES (?, ?, ?, 'leitner', ?)
    `,
    [user.id, question.word_id, question.id, now]
  );

  const messageText =
    `❓ <b>${question.question_text}</b>\n\n` +
    `1️⃣ ${question.option_a}\n` +
    `2️⃣ ${question.option_b}\n` +
    `3️⃣ ${question.option_c}\n` +
    `4️⃣ ${question.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:A` },
        { text: "2", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:B` },
        { text: "3", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:C` },
        { text: "4", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:D` }
      ],
      [{ text: "✅ بلدم (حذف از مرور)", callback_data: `${CB_PREFIX.LEITNER_IGNORE}:${question.id}` }]
    ]
  };

  await sendMessage(env, chatId, messageText, {
    reply_markup: replyMarkup
  });
}

async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  styles: string[],
  allowedSources?: Array<"manual" | "ai" | "seed">
): Promise<LeitnerQuestionRow | null> {
  if (styles.length === 0) return null;

  const placeholders = styles.map(() => "?").join(", ");
  const sourceFilter = allowedSources && allowedSources.length > 0
    ? ` AND q.source IN (${allowedSources.map(() => "?").join(", ")})`
    : "";
  const sourceParams = allowedSources && allowedSources.length > 0 ? [...allowedSources] : [];
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");

  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND q.question_style IN (${placeholders})
      ${sourceFilter}
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY ${priorityOrderSql}, RANDOM()
    LIMIT 1
    `,
    [word.id, ...styles, ...sourceParams, user.id]
  );
}

async function pickRandomUnseenQuestion(
  env: Env,
  user: DbUser,
  word: DbWord,
  allowedSources?: Array<"manual" | "ai" | "seed">
): Promise<LeitnerQuestionRow | null> {
  const sourceFilter = allowedSources && allowedSources.length > 0
    ? ` AND q.source IN (${allowedSources.map(() => "?").join(", ")})`
    : "";
  const sourceParams = allowedSources && allowedSources.length > 0 ? [...allowedSources] : [];
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");

  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      ${sourceFilter}
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY ${priorityOrderSql}, RANDOM()
    LIMIT 1
    `,
    [word.id, ...sourceParams, user.id]
  );
}

async function pickRandomQuestionAny(
  env: Env,
  user: DbUser,
  word: DbWord,
  allowedSources?: Array<"manual" | "ai" | "seed">
): Promise<LeitnerQuestionRow | null> {
  const sourceFilter = allowedSources && allowedSources.length > 0
    ? ` AND q.source IN (${allowedSources.map(() => "?").join(", ")})`
    : "";
  const sourceParams = allowedSources && allowedSources.length > 0 ? [...allowedSources] : [];
  const priorityOrderSql = getWordStylePrioritySql("q.question_style");

  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      ${sourceFilter}
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
    [word.id, ...sourceParams, user.id]
  );
}

export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts[0] === CB_PREFIX.LEITNER_IGNORE) {
    const questionId = Number(parts[1]);
    if (!Number.isFinite(questionId)) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const message = callbackQuery.message;
    if (!message) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const chatId = message.chat.id;
    const user = await getOrCreateUser(env, callbackQuery.from);

    const question = await queryOne<{ word_id: number; english: string }>(
      env,
      `SELECT q.word_id, w.english FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
      [questionId]
    );

    if (question) {
      await markWordAsIgnored(env, user.id, question.word_id);
      await answerCallbackQuery(env, callbackQuery.id, "واژه حذف شد 👌");
      await sendMessage(env, chatId, `واژه‌ی <b>${question.english}</b> از چرخه مرور حذف شد ✅`);
    } else {
      await answerCallbackQuery(env, callbackQuery.id, "خطا در یافتن واژه");
    }

    await sendLeitnerQuestion(env, user, chatId);
    return;
  }

  if (parts[0] === CB_PREFIX.LEITNER) {
    const questionId = Number(parts[1]);
    const chosenOption = parts[2];

    if (!Number.isFinite(questionId)) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }

    const message = callbackQuery.message;
    if (!message) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const chatId = message.chat.id;
    const user = await getOrCreateUser(env, callbackQuery.from);

    const question = await queryOne<LeitnerQuestionRow>(
      env,
      `
      SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
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

    if (!chosenOption || !["A", "B", "C", "D"].includes(chosenOption)) {
      await answerCallbackQuery(env, callbackQuery.id, "گزینه نامعتبر");
      return;
    }

    const isCorrect = chosenOption === question.correct_option;
    const now = new Date().toISOString();

    const alreadyAnswered = await queryOne<{ id: number }>(
      env,
      `SELECT id FROM user_word_question_history 
       WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NOT NULL`,
      [user.id, question.id]
    );
    if (alreadyAnswered) {
      await answerCallbackQuery(env, callbackQuery.id, "قبلاً پاسخ داده شده 👍");
      return;
    }

    await answerCallbackQuery(env, callbackQuery.id);

    const batchStatements: any[] = [];

    batchStatements.push(prepare(
      env,
      `UPDATE user_word_question_history 
       SET is_correct = ?, answered_at = ? 
       WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`,
      [isCorrect ? 1 : 0, now, user.id, question.id]
    ));

    const sm2Stmts = await prepareUpdateSm2(env, user.id, question.word_id, isCorrect);
    batchStatements.push(...sm2Stmts);

    const xpStmts = prepareXpForLeitner(env, user.id, question.word_id, question.level, isCorrect);
    batchStatements.push(...xpStmts);

    await env.DB.batch(batchStatements);

    if (isCorrect) {
      const streakMsg = await checkAndUpdateStreak(env, user.id);
      if (streakMsg) {
        await sendMessage(env, chatId, streakMsg);
      }
    }

    let correctText = "";
    if (question.correct_option === "A") correctText = question.option_a;
    else if (question.correct_option === "B") correctText = question.option_b;
    else if (question.correct_option === "C") correctText = question.option_c;
    else if (question.correct_option === "D") correctText = question.option_d;

    const correctNum = optionLetterToNumber(question.correct_option);
    let replyText: string;
    if (isCorrect) {
      replyText = `آفرین! ✅ جواب درست بود.\n\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    } else {
      replyText = `جوابت درست نبود ❌\n\nجواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    }

    await sendMessage(env, chatId, replyText);
    await sendLeitnerQuestion(env, user, chatId);
  }
}
