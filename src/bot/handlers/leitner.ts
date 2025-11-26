import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute } from "../../db/client";
import {
  pickNextWordForUser,
  getOrCreateUserWordState,
  updateSm2AndStageAfterAnswer,
  DbWord
} from "../../db/leitner";
import { addXpForLeitnerQuestion } from "../../db/xp";
import { generateWordQuestionsWithGemini } from "../../ai/gemini";
import { insertWordQuestions } from "../../db/word_questions";


// شکل سوالی که برای لایتنر می‌گیریم (همراه با انگلیسی/فارسی واژه)
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
  level: number; // سطح واژه (۱ تا ۴)
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

  // 1) کاربر را در دیتابیس ثبت/آپدیت می‌کنیم
  const user = await getOrCreateUser(env, tgUser);

  // 2) یک سوال برایش می‌فرستیم
  await sendLeitnerQuestion(env, user, chatId);
}

async function sendLeitnerQuestion(env: Env, user: DbUser, chatId: number): Promise<void> {
  // 1) انتخاب واژه‌ی بعدی برای این کاربر
  const word = await pickNextWordForUser(env, user.id);

  if (!word) {
    await sendMessage(env, chatId, "فعلاً هیچ واژه‌ای برای تمرین در سیستم ثبت نشده ❗️");
    return;
  }

  // 2) وضعیت SM2 و stage این واژه برای این کاربر
  const state = await getOrCreateUserWordState(env, user.id, word.id);
  const stage = state.question_stage || 1;
  const desiredStyle = getQuestionStyleForStage(stage);

  // 3) انتخاب سوال مناسب از بانک سوال‌ها
  let question = await pickQuestionForUserWord(env, user, word, desiredStyle);

  // --- NEW: اگر سوالی پیدا نشد، همان لحظه بساز ---
  if (!question) {
    // یک پیام "در حال ساخت" بدهیم چون AI ممکن است چند ثانیه طول بکشد
    await sendMessage(env, chatId, "⏳ در حال طراحی سوال جدید با هوش مصنوعی...");

    try {
      // درخواست به جمینای برای ساخت 2 سوال با استایل مورد نظر
      const aiQuestions = await generateWordQuestionsWithGemini({
        env,
        english: word.english,
        persian: word.persian,
        level: word.level,
        questionStyle: desiredStyle,
        count: 2 
      });

      if (aiQuestions.length > 0) {
        // ذخیره در دیتابیس
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

        // تلاش مجدد برای گرفتن سوال از دیتابیس
        question = await pickQuestionForUserWord(env, user, word, desiredStyle);
      }
    } catch (error) {
      console.error("Error auto-generating questions:", error);
    }
  }
  // ---------------------------------------------

  if (!question) {
    await sendMessage(
      env,
      chatId,
      `برای واژه‌ی <b>${word.english}</b> هنوز هیچ سوالی در بانک سوال‌ها وجود ندارد و ساخت خودکار هم ناموفق بود ❗️`
    );
    return;
  }

  const now = new Date().toISOString();

  // 4) ثبت در تاریخچه که این سوال را نشان داده‌ایم
  await execute(
    env,
    `
      INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
      VALUES (?, ?, ?, 'leitner', ?)
    `,
    [user.id, question.word_id, question.id, now]
  );

  // 5) ساخت inline keyboard برای گزینه‌ها
  const replyMarkup = {
    inline_keyboard: [
      [{ text: question.option_a, callback_data: `leitner:${question.id}:A` }],
      [{ text: question.option_b, callback_data: `leitner:${question.id}:B` }],
      [{ text: question.option_c, callback_data: `leitner:${question.id}:C` }],
      [{ text: question.option_d, callback_data: `leitner:${question.id}:D` }]
    ]
  };

  const text = `${question.question_text}`;

  await sendMessage(env, chatId, text, {
    reply_markup: replyMarkup
  });
}

// انتخاب سوال برای یک (user, word) با در نظر گرفتن question_style و تاریخچه
async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  desiredStyle: string
): Promise<LeitnerQuestionRow | null> {
  // 1) سوال‌هایی با style مورد نظر که این کاربر در context='leitner' ندیده
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

  // 2) اگر سوال ندیده با این style نداریم، هر سوالی با این style (حتی دیده‌شده) را امتحان می‌کنیم
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

  // 3) اگر اصلاً سوالی با این style نیست، سعی می‌کنیم هر سوالی از این واژه که هنوز ندیده را بگیریم
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

  // 4) آخرین تلاش: هر سوالی برای این واژه (حتی تکراری)
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

  if (parts.length !== 3 || parts[0] !== "leitner") {
    // داده‌ای که انتظارش را نداشتیم
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const questionId = Number(parts[1]);
  const chosenOption = parts[2]; // 'A' | 'B' | 'C' | 'D'

  if (!Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // باید حتماً کاربر و چت را داشته باشیم
  const tgUser = callbackQuery.from;
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;

  // کاربر از دیتابیس
  const user = await getOrCreateUser(env, tgUser);

  // سوال از دیتابیس
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
    await sendMessage(env, chatId, "این سوال دیگر در سیستم وجود ندارد.");
    return;
  }

  const isCorrect = chosenOption === question.correct_option;
  const now = new Date().toISOString();

  // به‌روزرسانی تاریخچه سوال
  await execute(
    env,
    `
      UPDATE user_word_question_history
      SET is_correct = ?, answered_at = ?
      WHERE user_id = ? AND question_id = ? AND context = 'leitner'
    `,
    [isCorrect ? 1 : 0, now, user.id, question.id]
  );

  // به‌روزرسانی SM2 و question_stage برای این واژه و کاربر
  await updateSm2AndStageAfterAnswer(env, user.id, question.word_id, isCorrect);
  
    // اضافه کردن XP بر اساس سطح واژه
  await addXpForLeitnerQuestion(env, user.id, question.word_id, question.level, isCorrect);


  // پاسخ به callback تا لودینگ تلگرام متوقف شود
  await answerCallbackQuery(env, callbackQuery.id);

  // متن گزینه‌ی درست را پیدا کنیم
  const getOptionText = (letter: string): string => {
    switch (letter) {
      case "A":
        return question.option_a;
      case "B":
        return question.option_b;
      case "C":
        return question.option_c;
      case "D":
        return question.option_d;
      default:
        return "";
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

  // برای راحتی، بلافاصله یک سوال دیگر هم می‌فرستیم
  await sendLeitnerQuestion(env, user, chatId);
}
