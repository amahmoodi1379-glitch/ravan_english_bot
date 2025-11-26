import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute } from "../../db/client";
import {
  pickNextWordForUser,
  getOrCreateUserWordState,
  updateSm2AndStageAfterAnswer,
  markWordAsIgnored,
  DbWord
} from "../../db/leitner";
import { addXpForLeitnerQuestion } from "../../db/xp";
import { generateWordQuestionsWithGemini } from "../../ai/gemini";
import { insertWordQuestions } from "../../db/word_questions";
import { CB_PREFIX } from "../../config/constants"; // Import added

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

function getQuestionStyleForStage(stage: number): string {
  if (stage <= 1) return "fa_meaning";
  if (stage === 2) return "en_definition";
  if (stage === 3) return "word_from_definition";
  const advanced = ["synonym", "antonym", "fa_to_en"];
  const idx = Math.floor(Math.random() * advanced.length);
  return advanced[idx];
}

export async function startLeitnerForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;
  const chatId = message.chat.id;
  const tgUser = message.from;
  const user = await getOrCreateUser(env, tgUser);
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
  const desiredStyle = getQuestionStyleForStage(stage);

  let question = await pickQuestionForUserWord(env, user, word, desiredStyle);

  if (!question) {
    await sendMessage(env, chatId, "⏳ در حال طراحی سوال جدید با هوش مصنوعی...");
    try {
      const aiQuestions = await generateWordQuestionsWithGemini({
        env,
        english: word.english,
        persian: word.persian,
        level: word.level,
        questionStyle: desiredStyle,
        count: 2
      });

      if (aiQuestions.length > 0) {
        await insertWordQuestions(
          env,
          word.id,
          aiQuestions.map((q) => ({
            wordId: word.id,
            questionText: q.question,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation,
            questionStyle: desiredStyle
          }))
        );
        question = await pickQuestionForUserWord(env, user, word, desiredStyle);
      }
    } catch (error) {
      console.error("Error auto-generating questions:", error);
    }
  }

  if (!question) {
    await sendMessage(
      env,
      chatId,
      `برای واژه‌ی <b>${word.english}</b> هنوز هیچ سوالی در بانک سوال‌ها وجود ندارد و ساخت خودکار هم ناموفق بود ❗️`
    );
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

  // ساخت دکمه‌ها با پیشوندهای کوتاه
  const replyMarkup = {
    inline_keyboard: [
      [{ text: question.option_a, callback_data: `${CB_PREFIX.LEITNER}:${question.id}:A` }],
      [{ text: question.option_b, callback_data: `${CB_PREFIX.LEITNER}:${question.id}:B` }],
      [{ text: question.option_c, callback_data: `${CB_PREFIX.LEITNER}:${question.id}:C` }],
      [{ text: question.option_d, callback_data: `${CB_PREFIX.LEITNER}:${question.id}:D` }],
      // lig = Leitner IGnore
      [{ text: "✅ بلدم (حذف از مرور)", callback_data: `${CB_PREFIX.LEITNER_IGNORE}:${question.id}` }]
    ]
  };

  const text = `${question.question_text}`;

  await sendMessage(env, chatId, text, {
    reply_markup: replyMarkup
  });
}

async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  desiredStyle: string
): Promise<LeitnerQuestionRow | null> {
  let q = await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT
      q.id,
      q.word_id,
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      q.question_style,
      w.english,
      w.persian,
      w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND q.question_style = ?
      AND NOT EXISTS (
        SELECT 1
        FROM user_word_question_history h
        WHERE h.user_id = ?
          AND h.question_id = q.id
          AND h.context = 'leitner'
      )
    ORDER BY q.id
    LIMIT 1
    `,
    [word.id, desiredStyle, user.id]
  );

  if (q) return q;

  q = await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT
      q.id,
      q.word_id,
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      q.question_style,
      w.english,
      w.persian,
      w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND q.question_style = ?
    ORDER BY q.id
    LIMIT 1
    `,
    [word.id, desiredStyle]
  );

  if (q) return q;

  q = await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT
      q.id,
      q.word_id,
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      q.question_style,
      w.english,
      w.persian,
      w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM user_word_question_history h
        WHERE h.user_id = ?
          AND h.question_id = q.id
          AND h.context = 'leitner'
      )
    ORDER BY q.id
    LIMIT 1
    `,
    [word.id, user.id]
  );

  if (q) return q;

  q = await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT
      q.id,
      q.word_id,
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      q.question_style,
      w.english,
      w.persian,
      w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
    ORDER BY q.id
    LIMIT 1
    `,
    [word.id]
  );

  return q ?? null;
}

export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  // فرمت جدید: lig:<questionId>
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
    const tgUser = callbackQuery.from;
    const user = await getOrCreateUser(env, tgUser);

    const question = await queryOne<{ word_id: number; english: string }>(
      env,
      `
      SELECT q.word_id, w.english
      FROM word_questions q
      JOIN words w ON w.id = q.word_id
      WHERE q.id = ?
      `,
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

  // فرمت جدید: l:<questionId>:<option>
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
    const tgUser = callbackQuery.from;
    const user = await getOrCreateUser(env, tgUser);

    const question = await queryOne<LeitnerQuestionRow>(
      env,
      `
      SELECT
        q.id,
        q.word_id,
        q.question_text,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        q.correct_option,
        q.question_style,
        w.english,
        w.persian,
        w.level
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

    await execute(
      env,
      `
        UPDATE user_word_question_history
        SET is_correct = ?, answered_at = ?
        WHERE user_id = ? AND question_id = ? AND context = 'leitner'
      `,
      [isCorrect ? 1 : 0, now, user.id, question.id]
    );

    await updateSm2AndStageAfterAnswer(env, user.id, question.word_id, isCorrect);
    await addXpForLeitnerQuestion(env, user.id, question.word_id, question.level, isCorrect);

    await answerCallbackQuery(env, callbackQuery.id);

    const getOptionText = (letter: string): string => {
      switch (letter) {
        case "A": return question.option_a;
        case "B": return question.option_b;
        case "C": return question.option_c;
        case "D": return question.option_d;
        default: return "";
      }
    };

    const correctText = getOptionText(question.correct_option);
    let replyText: string;

    if (isCorrect) {
      replyText = `آفرین! ✅ جواب درست بود.\n\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    } else {
      replyText = `جوابت درست نبود ❌\n\nجواب صحیح: <b>${correctText}</b>\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    }

    await sendMessage(env, chatId, replyText);
    await sendLeitnerQuestion(env, user, chatId);
  }
}
