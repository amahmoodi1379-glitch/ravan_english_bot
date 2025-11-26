import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute } from "../../db/client";
import {
  pickNextWordForUser,
  getOrCreateUserWordState,
  updateSm2AndStageAfterAnswer,
  markWordAsIgnored, // اضافه شد
  DbWord
} from "../../db/leitner";
import { addXpForLeitnerQuestion } from "../../db/xp";
import { generateWordQuestionsWithGemini } from "../../ai/gemini";
import { insertWordQuestions } from "../../db/word_questions";


// شکل سوالی که برای لایتنر می‌گیریم
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

// مپ stage → question_style
function getQuestionStyleForStage(stage: number): string {
  if (stage <= 1) return "fa_meaning";
  if (stage === 2) return "en_definition";
  if (stage === 3) return "word_from_definition";

  // stage 4 → یکی از سه style پیشرفته به صورت تصادفی
  const advanced = ["synonym", "antonym", "fa_to_en"];
  const idx = Math.floor(Math.random() * advanced.length);
  return advanced[idx];
}

// شروع لایتنر وقتی کاربر دکمه 🎯 تمرین‌ها را می‌زند
export async function startLeitnerForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  const user = await getOrCreateUser(env, tgUser);
  await sendLeitnerQuestion(env, user, chatId);
}

// گرفتن و ارسال یک سوال لایتنر برای کاربر
async function sendLeitnerQuestion(env: Env, user: DbUser, chatId: number): Promise<void> {
  // 1) انتخاب واژه‌ی بعدی برای این کاربر
  const word = await pickNextWordForUser(env, user.id);

  if (!word) {
    await sendMessage(env, chatId, "فعلاً هیچ واژه‌ای برای تمرین در سیستم ثبت نشده (یا همه رو بلدی!) 👏");
    return;
  }

  // 2) وضعیت SM2 و stage این واژه برای این کاربر
  const state = await getOrCreateUserWordState(env, user.id, word.id);
  const stage = state.question_stage || 1;
  const desiredStyle = getQuestionStyleForStage(stage);

  // 3) انتخاب سوال مناسب از بانک سوال‌ها
  let question = await pickQuestionForUserWord(env, user, word, desiredStyle);

  // اگر سوالی نبود، بسازیم
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
        // دوباره سعی کن سوال را بخوانی
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

  // 4) ثبت در تاریخچه
  await execute(
    env,
    `
      INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
      VALUES (?, ?, ?, 'leitner', ?)
    `,
    [user.id, question.word_id, question.id, now]
  );

  // 5) ساخت inline keyboard
  const replyMarkup = {
    inline_keyboard: [
      [{ text: question.option_a, callback_data: `leitner:${question.id}:A` }],
      [{ text: question.option_b, callback_data: `leitner:${question.id}:B` }],
      [{ text: question.option_c, callback_data: `leitner:${question.id}:C` }],
      [{ text: question.option_d, callback_data: `leitner:${question.id}:D` }],
      // دکمه جدید: بلدم
      [{ text: "✅ بلدم (حذف از مرور)", callback_data: `leitner:ignore:${question.id}` }]
    ]
  };

  const text = `${question.question_text}`;

  await sendMessage(env, chatId, text, {
    reply_markup: replyMarkup
  });
}

// انتخاب سوال برای یک (user, word)
async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  desiredStyle: string
): Promise<LeitnerQuestionRow | null> {
  // 1) سوال‌هایی با style مورد نظر که کاربر ندیده
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

  // 2) سوال با style مورد نظر (حتی اگر دیده)
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

  // 3) هر سوالی که ندیده
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

  // 4) هر سوالی
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

// هندل کردن کلیک روی گزینه‌های لایتنر
export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  // فرمت جدید: leitner:ignore:<questionId>
  if (parts.length === 3 && parts[1] === "ignore") {
    const questionId = Number(parts[2]);
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

    // پیدا کردن word_id از روی سوال
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

    // سوال بعدی
    await sendLeitnerQuestion(env, user, chatId);
    return;
  }

  // فرمت استاندارد: leitner:<questionId>:<option>
  if (parts.length !== 3 || parts[0] !== "leitner") {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

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
