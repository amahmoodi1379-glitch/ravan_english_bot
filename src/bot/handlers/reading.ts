import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import {
  getReadingTextsCount,
  getPaginatedReadingTexts,
  getReadingTextByTitle
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
import { queryAll, queryOne, prepare, execute } from "../../db/client";
import { calculateAndPrepareXpForReading, checkAndUpdateStreak } from "../../db/xp";
import { CB_PREFIX, GAME_CONFIG } from "../../config/constants";
import { getPaginatedReadingKeyboard, getMainMenuKeyboard } from "../keyboards";

interface SummaryQuestionRow {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  is_correct: number | null;
}

const ITEMS_PER_PAGE = 6; // تعداد متن‌ها در هر صفحه

// نمایش منوی انتخاب متن (با قابلیت صفحه‌بندی)
export async function startReadingMenuForUser(env: Env, update: TelegramUpdate, page: number = 1): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  await getOrCreateUser(env, tgUser);

  // ۱. محاسبه تعداد کل و صفحات
  const totalCount = await getReadingTextsCount(env);
  if (totalCount === 0) {
    await sendMessage(env, chatId, "فعلاً هیچ متنی برای تست درک مطلب ثبت نشده ❗️");
    return;
  }
  
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
  
  // اصلاح شماره صفحه اگر خارج از محدوده بود
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const offset = (page - 1) * ITEMS_PER_PAGE;

  // ۲. گرفتن متن‌های این صفحه
  const texts = await getPaginatedReadingTexts(env, ITEMS_PER_PAGE, offset);
  const titles = texts.map(t => t.title);

  // ۳. ارسال پیام با کیبورد جدید
  await sendMessage(
    env,
    chatId,
    `📚 لیست متون درک مطلب (صفحه ${page} از ${totalPages})\n\nیکی از متن‌های زیر را انتخاب کن:`,
    { 
      reply_markup: getPaginatedReadingKeyboard(titles, page, totalPages) 
    }
  );
}

// هندلر جدید: وقتی کاربر روی یک "عنوان" کلیک می‌کند
export async function handleReadingTitleSelection(env: Env, update: TelegramUpdate, title: string): Promise<boolean> {
  const message = update.message;
  if (!message || !message.from) return false;
  const chatId = message.chat.id;
  
  // ۱. پیدا کردن متن از روی عنوان
  const textRow = await getReadingTextByTitle(env, title);
  if (!textRow) {
    // شاید کاربر متن الکی فرستاده یا دکمه قدیمی بوده
    return false; 
  }

  const user = await getOrCreateUser(env, message.from);

  // ۲. اگه کاربر قبلاً یه تست ناتمام داره، اون رو کنسل کن
  const activeSession = await queryOne<ReadingSession>(
    env,
    `SELECT * FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeSession) {
    await execute(
      env,
      `UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`,
      [activeSession.id]
    );
  }

  // ۳. شروع سشن جدید
  const session = await createReadingSession(env, user.id, textRow.id, GAME_CONFIG.READING_QUESTION_COUNT);

  // ۳. شروع سوالات
  // برای اینکه کیبورد قبلی حذف شود، یک پیام ساده می‌فرستیم که کیبورد را بردارد (یا کیبورد خالی می‌فرستیم)
  // در اینجا فرض می‌کنیم کاربر وارد مود سوال شده و سوالات به صورت Inline می‌آیند.
  await sendMessage(env, chatId, `متن "<b>${textRow.title}</b>" انتخاب شد ✅\nتست شروع شد... 👇`, {
      reply_markup: { remove_keyboard: true } // حذف کیبورد متنی برای تمرکز روی سوالات
  });

  const sent = await sendNextReadingQuestion(env, user, session, chatId);
  
  if (!sent) {
    await sendMessage(env, chatId, "برای این متن هنوز سوالی ثبت نشده است ❗️");
  }
  return true;
}

// این تابع برای دکمه‌های شیشه‌ای قدیمی بود، اما شاید هنوز لازم شود (اگر جایی لینک مستقیم دادید)
// فعلاً نگهش می‌داریم ولی در منوی اصلی استفاده نمی‌شود.
export async function handleReadingTextChosen(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); 
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
    await sendMessage(env, chatId, "برای این متن هنوز سوالی ثبت نشده است ❗️");
  }
}

export async function handleReadingAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");
  // فرمت: ra:sessionId:questionId:option
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

  // === تغییر جدید: مدیریت دکمه انصراف ===
  if (chosenOption === 'CANCEL') {
    await answerCallbackQuery(env, callbackQuery.id, "آزمون لغو شد 🚫");
    
    // سشن را کنسل می‌کنیم تا در لیست کارهای نیمه‌کاره نماند
    await env.DB.prepare("UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?").bind(sessionId).run();

    // بازگشت به منوی اصلی
    await sendMessage(env, chatId, "تست متوقف شد. به منوی اصلی برگشتی 👇", {
        reply_markup: getMainMenuKeyboard()
    });
    return;
  }
  // =====================================

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

  const now = new Date().toISOString();

  // فیکس امنیتی: جلوگیری از دوبار حساب شدن امتیاز
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

  const getOptionNumber = (letter: string): string => {
    switch (letter) {
      case "A": return "1";
      case "B": return "2";
      case "C": return "3";
      case "D": return "4";
      default: return "";
    }
  };
  const correctNum = getOptionNumber(question.correct_option);

  let replyText: string;
  if (isCorrect) {
    replyText = `آفرین! ✅ جواب درست بود.\n\n✅ گزینه صحیح: <b>${correctNum}</b>`;
  } else {
    const chosenNum = getOptionNumber(chosenOption);
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
      // سوال کافی نیست — تست رو تکمیل کن و خلاصه نشون بده
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
  // انتخاب سوال
  let question = await getNextQuestionForSession(env, session, user.id);

  if (!question) {
    return false;
  }

  // 3. ثبت نمایش سوال
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
      // دکمه انصراف جدید
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

  // دریافت جزئیات پاسخ‌ها برای نمایش
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

  // === رفع باگ XP ===
  // فقط بابت سوالاتی XP می‌دهیم که قبلاً درست جواب نداده باشد
  const newCorrectCount = await getNewCorrectCount(env, session.id, user.id);
  
  // محاسبه XP بر اساس تعداد جدید
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
      const correctOptionNum = r.correct_option === "A" ? "1" : r.correct_option === "B" ? "2" : r.correct_option === "C" ? "3" : "4";
      const correctText = getOptionTextForRow(r, r.correct_option);
      const status = r.is_correct === 1 ? "✅" : "❌";
      text += `\n${qNum}) ${status} گزینه ${correctOptionNum}: <b>${correctText}</b>`;
    });
  }

  // ارسال خلاصه نتیجه به کاربر
  await sendMessage(env, chatId, text);

  // برگرداندن کیبورد اصلی (Main Menu)
  await sendMessage(env, chatId, "خسته نباشی! چه کار دیگه‌ای می‌خوای انجام بدی؟", {
      reply_markup: getMainMenuKeyboard()
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
