import { Env } from "../../types";
import { TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery, editMessageText } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import {
  getReadingTextsCount,
  getPaginatedReadingTexts,
} from "../../db/texts";
import {
  createReadingSession,
  getReadingSessionById,
  getNextQuestionForSession,
  recordQuestionShown,
  getSessionStats,
  prepareUpdateSessionXp,
  getNewCorrectCount,
  DbTextQuestion,
  ReadingSession
} from "../../db/reading";
import { queryAll, queryOne, prepare } from "../../db/client";
import { calculateAndPrepareXpForReading, checkAndUpdateStreak } from "../../db/xp";
import { CB_PREFIX, GAME_CONFIG } from "../../config/constants";
import { getMainMenuKeyboard, getTrainingMenuKeyboard } from "../keyboards";
import { optionLetterToNumber } from "../../utils/options";

interface SummaryQuestionRow {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  is_correct: number | null;
}

const ITEMS_PER_PAGE = 20;

/**
 * Build inline keyboard for reading text list with pagination.
 */
function buildReadingInlineKeyboard(
  texts: { id: number; title: string }[],
  currentPage: number,
  totalPages: number
): any {
  const keyboard: any[][] = [];

  // Each text gets its own row as an inline button
  for (const t of texts) {
    keyboard.push([{ text: `📄 ${t.title}`, callback_data: `${CB_PREFIX.READING_TEXT}:${t.id}` }]);
  }

  // Navigation row
  const navRow: any[] = [];
  if (currentPage > 1) {
    navRow.push({ text: "▶️ صفحه قبل", callback_data: `${CB_PREFIX.READING_TEXT}:page_${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: "◀️ صفحه بعد", callback_data: `${CB_PREFIX.READING_TEXT}:page_${currentPage + 1}` });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  // Back button
  keyboard.push([{ text: "⬅️ بازگشت به منوی تمرین", callback_data: `${CB_PREFIX.READING_TEXT}:back` }]);

  return { inline_keyboard: keyboard };
}

export async function startReadingMenuForUser(env: Env, chatId: number, page: number = 1): Promise<void> {
  const totalCount = await getReadingTextsCount(env);
  if (totalCount === 0) {
    await sendMessage(env, chatId, "فعلاً هیچ متنی برای تست درک مطلب ثبت نشده ❗️", {
      reply_markup: getTrainingMenuKeyboard()
    });
    return;
  }

  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const offset = (page - 1) * ITEMS_PER_PAGE;

  const texts = await getPaginatedReadingTexts(env, ITEMS_PER_PAGE, offset);
  const textItems = texts.map(t => ({ id: t.id, title: t.title }));

  await sendMessage(
    env,
    chatId,
    `📚 <b>متون درک مطلب</b> (صفحه ${page} از ${totalPages})\n\nیکی از متن‌ها رو انتخاب کن:`,
    {
      reply_markup: buildReadingInlineKeyboard(textItems, page, totalPages)
    }
  );
}

/**
 * @deprecated No longer used — reading uses inline keyboard now.
 */
export async function handleReadingTitleSelection(_env: Env, _user: DbUser, _chatId: number, _title: string): Promise<boolean> {
  return false;
}

export async function handleReadingTextChosen(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  if (parts.length !== 2 || parts[0] !== CB_PREFIX.READING_TEXT) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const value = parts[1];
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;

  // Handle "back to training menu"
  if (value === "back") {
    await answerCallbackQuery(env, callbackQuery.id);
    await editMessageText(env, chatId, messageId, "به منوی تمرین‌ها برگشتی 👇");
    await sendMessage(env, chatId, "یکی از گزینه‌ها رو انتخاب کن:", {
      reply_markup: getTrainingMenuKeyboard()
    });
    return;
  }

  // Handle pagination: page_N
  if (value.startsWith("page_")) {
    const page = parseInt(value.replace("page_", ""));
    if (!isNaN(page) && page >= 1) {
      await answerCallbackQuery(env, callbackQuery.id);

      // Re-render the text list on the same message
      const totalCount = await getReadingTextsCount(env);
      const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
      const safePage = Math.min(Math.max(page, 1), totalPages);
      const offset = (safePage - 1) * ITEMS_PER_PAGE;
      const texts = await getPaginatedReadingTexts(env, ITEMS_PER_PAGE, offset);
      const textItems = texts.map(t => ({ id: t.id, title: t.title }));

      await editMessageText(
        env,
        chatId,
        messageId,
        `📚 <b>متون درک مطلب</b> (صفحه ${safePage} از ${totalPages})\n\nیکی از متن‌ها رو انتخاب کن:`,
        { reply_markup: buildReadingInlineKeyboard(textItems, safePage, totalPages) }
      );
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // Handle text selection: numeric text ID
  const textId = Number(value);
  if (!Number.isFinite(textId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const user = await getOrCreateUser(env, callbackQuery.from);

  // Cancel any existing active reading session for this user
  const activeSession = await queryOne<ReadingSession>(
    env,
    `SELECT * FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeSession) {
    await env.DB.prepare(`UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`).bind(activeSession.id).run();
  }

  const session = await createReadingSession(env, user.id, textId, GAME_CONFIG.READING_QUESTION_COUNT);

  await answerCallbackQuery(env, callbackQuery.id);

  // Update the text list message to indicate selection
  await editMessageText(env, chatId, messageId, "📖 تست درک مطلب شروع شد. به سوال‌ها با دقت جواب بده ✍️");

  const sent = await sendNextReadingQuestion(env, user, session, chatId);
  if (!sent) {
    await sendMessage(env, chatId, "برای این متن هنوز سوالی ثبت نشده است ❗️\nبه منوی تمرین‌ها برمی‌گردی 👇", {
      reply_markup: getTrainingMenuKeyboard()
    });
  }
}

export async function handleReadingAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
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

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;

  if (chosenOption === 'CANCEL') {
    await answerCallbackQuery(env, callbackQuery.id, "آزمون لغو شد 🚫");

    await env.DB.prepare("UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?").bind(sessionId).run();

    await sendMessage(env, chatId, "تست متوقف شد. به منوی تمرین‌ها برگشتی 👇", {
      reply_markup: getTrainingMenuKeyboard()
    });
    return;
  }

  const user = await getOrCreateUser(env, callbackQuery.from);
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

  const now = new Date().toISOString();

  const updateResult = await env.DB.prepare(
    `UPDATE user_text_question_history
     SET is_correct = ?, answered_at = ?
     WHERE reading_session_id = ?
       AND user_id = ?
       AND question_id = ?
       AND answered_at IS NULL`
  )
    .bind(isCorrect ? 1 : 0, now, session.id, user.id, questionId)
    .run();

  if (updateResult.meta.changes === 0) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔️ قبلاً پاسخ دادی!");
    return;
  }

  if (isCorrect) {
    await env.DB.prepare(
      `UPDATE reading_sessions SET num_correct = num_correct + 1 WHERE id = ?`
    ).bind(session.id).run();
  }

  await answerCallbackQuery(env, callbackQuery.id);

  const correctNum = optionLetterToNumber(question.correct_option);

  let replyText: string;
  if (isCorrect) {
    replyText = `آفرین! ✅ جواب درست بود.\n\n✅ گزینه صحیح: <b>${correctNum}</b>`;
  } else {
    const chosenNum = optionLetterToNumber(chosenOption);
    replyText =
      `جواب درست نبود ❌\n\n` +
      `جواب تو: <b>${chosenNum}</b>\n` +
      `✅ جواب صحیح: <b>${correctNum}</b>`;
  }

  await sendMessage(env, chatId, replyText);

  const freshSession = await getReadingSessionById(env, sessionId);
  if (!freshSession) {
    return;
  }

  const sent = await sendNextReadingQuestion(env, user, freshSession, chatId);
  if (!sent) {
    const stats = await getSessionStats(env, freshSession.id);
    const limit = freshSession.num_questions || 3;

    if (stats.total >= limit) {
      await sendReadingSummary(env, user, freshSession, chatId);
    } else {
      await sendMessage(env, chatId, "✅ تست به پایان رسید. نتیجه رو ببین 👇");
      await sendReadingSummary(env, user, freshSession, chatId);
    }
  }
}

async function sendNextReadingQuestion(
  env: Env,
  user: DbUser,
  session: ReadingSession,
  chatId: number
): Promise<boolean> {
  const question = await getNextQuestionForSession(env, session, user.id);

  if (!question) {
    return false;
  }

  const success = await recordQuestionShown(env, session, user.id, question.id);

  if (!success) {
    console.warn("Duplicate question show detected. Skipping...");
    return false;
  }

  const messageText =
    `❓ <b>${question.question_text}</b>\n\n` +
    `1️⃣ ${question.option_a}\n` +
    `2️⃣ ${question.option_b}\n` +
    `3️⃣ ${question.option_c}\n` +
    `4️⃣ ${question.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:A` },
        { text: "2", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:B` },
        { text: "3", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:C` },
        { text: "4", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:D` }
      ],
      [
        { text: "❌ انصراف و خروج", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:CANCEL` }
      ]
    ]
  };

  await sendMessage(env, chatId, messageText, { reply_markup: replyMarkup });
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

  const newCorrectCount = await getNewCorrectCount(env, session.id, user.id);

  const { totalXp, stmts: xpStmts } = calculateAndPrepareXpForReading(env, user.id, session.id, newCorrectCount, total);

  const batchStatements: any[] = [...xpStmts];

  if (totalXp > 0) {
    batchStatements.push(prepareUpdateSessionXp(env, session.id, totalXp));
  }

  const now = new Date().toISOString();

  batchStatements.push(prepare(env, `UPDATE reading_sessions SET status = 'completed', completed_at = ? WHERE id = ?`, [now, session.id]));

  if (batchStatements.length > 0) {
    await env.DB.batch(batchStatements);
  }

  const streakMsg = await checkAndUpdateStreak(env, user.id);
  if (streakMsg) {
    await sendMessage(env, chatId, streakMsg);
  }

  let text = `نتیجه‌ی این تست درک مطلب:\n\n`;
  text += `✅ تعداد پاسخ‌های درست: <b>${correct}</b> از <b>${total}</b>\n`;

  if (totalXp > 0) {
    text += `\n⭐️ XP دریافتی: <b>${totalXp}</b>\n`;
  } else if (correct > 0) {
    text += `\n⭐️ XP دریافتی: <b>0</b> (تکراری)\n`;
  }

  if (rows.length > 0) {
    text += `\nپاسخنامه:\n`;
    rows.forEach((r, idx) => {
      const qNum = idx + 1;
      const correctOptionNum = optionLetterToNumber(r.correct_option);
      const correctText = getOptionTextForRow(r, r.correct_option);
      const status = r.is_correct === 1 ? "✅" : "❌";
      text += `\n${qNum}) ${status} گزینه ${correctOptionNum}: <b>${correctText}</b>`;
    });
  }

  await sendMessage(env, chatId, text);

  await sendMessage(env, chatId, "خسته نباشی! چه کار دیگه‌ای می‌خوای انجام بدی؟", {
    reply_markup: getTrainingMenuKeyboard()
  });
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
