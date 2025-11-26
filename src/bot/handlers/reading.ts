import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { getAllActiveReadingTexts, getReadingTextById } from "../../db/texts";
import {
  createReadingSession,
  getReadingSessionById,
  getNextQuestionForSession,
  recordQuestionShown,
  recordAnswerAndUpdateSession,
  getSessionStats,
  markSessionCompleted,
  insertTextQuestions,
  DbTextQuestion,
  ReadingSession
} from "../../db/reading";
import { queryAll, queryOne, execute } from "../../db/client";
import { addXpForReadingSession } from "../../db/xp";
import { generateReadingQuestionsWithGemini } from "../../ai/gemini";
import { CB_PREFIX, GAME_CONFIG } from "../../config/constants"; // Import added

interface SummaryQuestionRow {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  is_correct: number | null;
}

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
    // rt:<id>
    return [{ text: title, callback_data: `${CB_PREFIX.READING_TEXT}:${t.id}` }];
  });

  const replyMarkup = { inline_keyboard: inlineRows };

  await sendMessage(
    env,
    chatId,
    "یک متن برای تست درک مطلب انتخاب کن:",
    { reply_markup: replyMarkup }
  );
}

export async function handleReadingTextChosen(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); 
  // rt:<id>
  if (parts.length !== 2 || parts[0] !== CB_PREFIX.READING_TEXT) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const textId = Number(parts[1]);
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

  const session = await createReadingSession(env, user.id, textId, GAME_CONFIG.READING_QUESTION_COUNT);

  await answerCallbackQuery(env, callbackQuery.id);
  await sendMessage(env, chatId, "تست درک مطلب شروع شد. به سوال‌ها با دقت جواب بده ✍️");

  const sent = await sendNextReadingQuestion(env, user, session, chatId);
  if (!sent) {
    await sendMessage(env, chatId, "مشکلی در دریافت سوال پیش آمد ❗️");
  }
}

export async function handleReadingAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  // ra:<sessionId>:<questionId>:<option>
  if (parts.length !== 4 || parts[0] !== CB_PREFIX.READING_ANSWER) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const sessionId = Number(parts[1]);
  const questionId = Number(parts[2]);
  const chosenOption = parts[3];

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

async function sendNextReadingQuestion(
  env: Env,
  user: DbUser,
  session: ReadingSession,
  chatId: number
): Promise<boolean> {
  let question = await getNextQuestionForSession(env, session, user.id);

  if (!question) {
    const stats = await getSessionStats(env, session.id);
    if (stats.total >= (session.num_questions || 3)) {
      return false;
    }

    await sendMessage(env, chatId, "⏳ در حال خواندن متن و طراحی سوالات جدید...");

    const textRow = await getReadingTextById(env, session.text_id);
    if (textRow && textRow.body_en) {
      try {
        const aiQuestions = await generateReadingQuestionsWithGemini(env, textRow.body_en, GAME_CONFIG.READING_QUESTION_COUNT);
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
        // ra:<sessionId>:<questionId>:A
        { text: question.option_a, callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:A` }
      ],
      [
        { text: question.option_b, callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:B` }
      ],
      [
        { text: question.option_c, callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:C` }
      ],
      [
        { text: question.option_d, callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:D` }
      ]
    ]
  };

  await sendMessage(env, chatId, question.question_text, { reply_markup: replyMarkup });
  return true;
}

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
    case "A": return question.option_a;
    case "B": return question.option_b;
    case "C": return question.option_c;
    case "D": return question.option_d;
    default: return "";
  }
}

function getOptionTextForRow(row: SummaryQuestionRow, letter: string): string {
  switch (letter) {
    case "A": return row.option_a;
    case "B": return row.option_b;
    case "C": return row.option_c;
    case "D": return row.option_d;
    default: return "";
  }
}
