import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { getAllActiveReadingTexts, getReadingTextById } from "../../db/texts"; // getReadingTextById اضافه شد
import {
  createReadingSession,
  getReadingSessionById,
  getNextQuestionForSession,
  recordQuestionShown,
  recordAnswerAndUpdateSession,
  getSessionStats,
  markSessionCompleted,
  insertTextQuestions, // اضافه شد
  DbTextQuestion,
  ReadingSession
} from "../../db/reading";
import { queryAll, queryOne, execute } from "../../db/client";
import { addXpForReadingSession } from "../../db/xp";
import { generateReadingQuestionsWithGemini } from "../../ai/gemini"; // اضافه شد


interface SummaryQuestionRow {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  is_correct: number | null;
}

// شروع منوی انتخاب متن
export async function startReadingMenuForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  await getOrCreateUser(env, tgUser);

  const texts = await getAllActiveReadingTexts(env);
  if (texts.length === 0) {
    await sendMessage(env, chatId, "فعلاً هیچ متنی برای تست درک مطلب ثبت نشده ❗️");
    return;
  }

  const inlineRows = texts.map(t => {
    const title = t.title.length > 40 ? t.title.slice(0, 37) + "..." : t.title;
    return [{ text: title, callback_data: `reading:text:${t.id}` }];
  });

  const replyMarkup = { inline_keyboard: inlineRows };

  await sendMessage(
    env,
    chatId,
    "یک متن برای تست درک مطلب انتخاب کن:",
    { reply_markup: replyMarkup }
  );
}

// کاربر یک متن را انتخاب کرده
export async function handleReadingTextChosen(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); // reading:text:<id>
  if (parts.length !== 3) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const textId = Number(parts[2]);
  if (!Number.isFinite(textId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const tgUser = callbackQuery.from;
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;

  const user = await getOrCreateUser(env, tgUser);

  // ایجاد سشن جدید
  const session = await createReadingSession(env, user.id, textId);

  await answerCallbackQuery(env, callbackQuery.id);
  await sendMessage(env, chatId, "تست درک مطلب شروع شد. به سوال‌ها با دقت جواب بده ✍️");

  const sent = await sendNextReadingQuestion(env, user, session, chatId);
  if (!sent) {
    await sendMessage(env, chatId, "مشکلی در دریافت سوال پیش آمد ❗️");
  }
}

// کاربر به یک سوال جواب داده
export async function handleReadingAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  if (parts.length !== 5) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const sessionId = Number(parts[2]);
  const questionId = Number(parts[3]);
  const chosenOption = parts[4];

  if (!Number.isFinite(sessionId) || !Number.isFinite(questionId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const tgUser = callbackQuery.from;
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;

  const user = await getOrCreateUser(env, tgUser);
  const session = await getReadingSessionById(env, sessionId);
  if (!session) {
    await answerCallbackQuery(env, callbackQuery.id, "این تست دیگر در دسترس نیست.");
    return;
  }

  const question = await queryOne<DbTextQuestion>(
    env,
    `
    SELECT
      id,
      text_id,
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option,
      explanation_text
    FROM text_questions
    WHERE id = ?
    `,
    [questionId]
  );

  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد.");
    return;
  }

  const isCorrect = chosenOption === question.correct_option;

  await recordAnswerAndUpdateSession(env, session, user.id, questionId, isCorrect);

  await answerCallbackQuery(env, callbackQuery.id);

  const correctText = getOptionText(question, question.correct_option);
  const chosenText = getOptionText(question, chosenOption);

  let replyText: string;
  if (isCorrect) {
    replyText = `آفرین! ✅ جواب درست بود.\n\n✅ جواب صحیح: <b>${correctText}</b>`;
  } else {
    replyText =
      `جواب درست نبود ❌\n\n` +
      `جواب انتخابی تو: <b>${chosenText || "-"}</b>\n` +
      `✅ جواب صحیح: <b>${correctText}</b>`;
  }

  await sendMessage(env, chatId, replyText);

  const freshSession = await getReadingSessionById(env, sessionId);
  if (!freshSession) {
    return;
  }

  const sent = await sendNextReadingQuestion(env, user, freshSession, chatId);
  if (!sent) {
    await sendReadingSummary(env, user, freshSession, chatId);
  }
}

// ارسال سوال بعدی؛ اگر سوالی نبود، سعی می‌کند بسازد
async function sendNextReadingQuestion(
  env: Env,
  user: DbUser,
  session: ReadingSession,
  chatId: number
): Promise<boolean> {
  // ۱. تلاش اول برای گرفتن سوال
  let question = await getNextQuestionForSession(env, session, user.id);

  // ۲. اگر سوالی نبود (یا همه تکراری بودند)، باید بسازیم
  if (!question) {
    // چک کنیم که آیا سشن تمام شده؟ (یعنی کاربر ۳ تا سوالش رو جواب داده؟)
    const stats = await getSessionStats(env, session.id);
    if (stats.total >= (session.num_questions || 3)) {
      // سشن تمام شده، دیگر سوال نمی‌خواهیم
      return false;
    }

    // سشن تمام نشده ولی سوال نداریم → تولید خودکار
    await sendMessage(env, chatId, "⏳ در حال خواندن متن و طراحی سوالات جدید...");

    const textRow = await getReadingTextById(env, session.text_id);
    if (textRow && textRow.body_en) {
      try {
        const aiQuestions = await generateReadingQuestionsWithGemini(env, textRow.body_en, 3);
        if (aiQuestions.length > 0) {
          await insertTextQuestions(
            env,
            session.text_id,
            aiQuestions.map(q => ({
              questionText: q.question,
              options: q.options,
              correctIndex: q.correctIndex,
              explanation: q.explanation
            }))
          );
          // تلاش مجدد برای گرفتن سوال
          question = await getNextQuestionForSession(env, session, user.id);
        }
      } catch (e) {
        console.error("Error auto-generating reading questions", e);
      }
    }
  }

  if (!question) {
    return false;
  }

  await recordQuestionShown(env, session, user.id, question.id);

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: question.option_a, callback_data: `reading:ans:${session.id}:${question.id}:A` }
      ],
      [
        { text: question.option_b, callback_data: `reading:ans:${session.id}:${question.id}:B` }
      ],
      [
        { text: question.option_c, callback_data: `reading:ans:${session.id}:${question.id}:C` }
      ],
      [
        { text: question.option_d, callback_data: `reading:ans:${session.id}:${question.id}:D` }
      ]
    ]
  };

  await sendMessage(env, chatId, question.question_text, { reply_markup: replyMarkup });
  return true;
}

// خلاصه نتیجه و پاسخنامه
async function sendReadingSummary(
  env: Env,
  user: DbUser,
  session: ReadingSession,
  chatId: number
): Promise<void> {
  const stats = await getSessionStats(env, session.id);
  const total = stats.total;
  const correct = stats.correct;

  const rows = await queryAll<SummaryQuestionRow>(
    env,
    `
    SELECT
      q.question_text,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      h.is_correct
    FROM user_text_question_history h
    JOIN text_questions q ON q.id = h.question_id
    WHERE h.reading_session_id = ?
    ORDER BY h.id ASC
    `,
    [session.id]
  );

  const totalXp = await addXpForReadingSession(env, user.id, session.id, correct, total);

  if (totalXp > 0) {
    await execute(
      env,
      `
      UPDATE reading_sessions
      SET xp_gained = ?
      WHERE id = ?
      `,
      [totalXp, session.id]
    );
  }

  let text = `نتیجه‌ی این تست درک مطلب:\n\n`;
  text += `✅ تعداد پاسخ‌های درست: <b>${correct}</b> از <b>${total}</b>\n`;

  if (totalXp > 0) {
    text += `\n⭐️ XP این ست: <b>${totalXp}</b>\n`;
  } else {
    text += `\nدر این ست XPیی نگرفتی.\n`;
  }

  if (rows.length > 0) {
    text += `\nپاسخنامه:\n`;
    rows.forEach((r, idx) => {
      const qNum = idx + 1;
      const correctText = getOptionTextForRow(r, r.correct_option);
      const status = r.is_correct === 1 ? "✅" : "❌";
      text += `\n${qNum}) ${status} جواب صحیح: <b>${correctText}</b>`;
    });
  }

  await markSessionCompleted(env, session.id);

  await sendMessage(env, chatId, text);
}


function getOptionText(question: DbTextQuestion, letter: string): string {
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
}

function getOptionTextForRow(row: SummaryQuestionRow, letter: string): string {
  switch (letter) {
    case "A":
      return row.option_a;
    case "B":
      return row.option_b;
    case "C":
      return row.option_c;
    case "D":
      return row.option_d;
    default:
      return "";
  }
}
