import { Env } from "../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, answerCallbackQuery, editMessageText, editMessageReplyMarkup } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import {
  getReadingTextsCount,
  getPaginatedReadingTexts,
} from "../../db/texts";
import { pe } from "../premium-emojis";
import {
  createReadingSession,
  getReadingSessionById,
  getNextQuestionForSession,
  recordQuestionShown,
  getSessionStats,
  prepareUpdateSessionXp,
  getNewCorrectCount,
  getTextQuestionCount,
  DbTextQuestion,
  ReadingSession
} from "../../db/reading";
import { queryAll, queryOne, execute, prepare, SqlGuard, batch } from "../../db/client";
import { calculateAndPrepareXpForReading, checkAndUpdateStreak } from "../../db/xp";
import { evaluateThresholdBadges } from "../../db/badges";
import { notifyNewBadges } from "./medals";
import { CB_PREFIX, STALE_SESSION_HOURS } from "../../config/constants";
import { getMainMenuKeyboard, getTrainingMenuKeyboard } from "../keyboards";
import { optionLetterToNumber } from "../../utils/options";

interface SummaryQuestionRow {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  explanation_text: string | null;
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
): { inline_keyboard: InlineKeyboardButton[][] } {
  const keyboard: InlineKeyboardButton[][] = [];

  // Each text gets its own row as an inline button
  for (const t of texts) {
    keyboard.push([{ text: `📄 ${t.title}`, callback_data: `${CB_PREFIX.READING_TEXT}:${t.id}` }]);
  }

  // Navigation row (◀️ = back/previous, ▶️ = forward/next)
  const navRow: InlineKeyboardButton[] = [];
  if (currentPage > 1) {
    navRow.push({ text: "◀️ صفحه قبل", callback_data: `${CB_PREFIX.READING_TEXT}:page_${currentPage - 1}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: "صفحه بعد ▶️", callback_data: `${CB_PREFIX.READING_TEXT}:page_${currentPage + 1}` });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  // Back button
  keyboard.push([{ text: "🏠 بازگشت به منوی تمرین", callback_data: `${CB_PREFIX.READING_TEXT}:back` }]);

  return { inline_keyboard: keyboard };
}

/**
 * Show the reading text selection menu with paginated inline buttons.
 * @param env - The worker environment containing the D1 database binding
 * @param chatId - The Telegram chat ID to send the menu to
 * @param page - The page number to display (defaults to 1)
 * @returns void
 */
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
    `${pe("📚")} <b>متون درک مطلب</b>\n<i>صفحه ${page} از ${totalPages}</i>\n\nیکی از متن‌ها رو انتخاب کن 👇`,
    {
      reply_markup: buildReadingInlineKeyboard(textItems, page, totalPages)
    }
  );
}

/**
 * Check if user has a stale active reading session and handle it.
 * - If session is older than STALE_SESSION_HOURS: auto-cancel it, return false (no message sent).
 * - If session is active and fresh: send "you have an active session" message, return true.
 * - If no active session: return false.
 *
 * Returns `true` if a message was sent (caller should return early), `false` otherwise.
 */
export async function checkAndCancelStaleSession(env: Env, user: DbUser, chatId: number): Promise<boolean> {
  const activeReadingSession = await queryOne<{ id: number; started_at: string }>(
    env,
    `SELECT id, started_at FROM reading_sessions WHERE user_id = ? AND status = 'in_progress'`,
    [user.id]
  );
  if (activeReadingSession) {
    const sessionAgeHours = (Date.now() - new Date(activeReadingSession.started_at).getTime()) / (1000 * 60 * 60);

    if (sessionAgeHours > STALE_SESSION_HOURS) {
      // Auto-cancel stale sessions
      await execute(
        env,
        `UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`,
        [activeReadingSession.id]
      );
    } else {
      await sendMessage(
        env,
        chatId,
        "📖 یک تست درک مطلب فعال داری! روی دکمه‌های سوالات کلیک کن.\nاگه می‌خوای لغوش کنی، دکمه «❌ انصراف و خروج» رو بزن.",
        { reply_markup: getMainMenuKeyboard() }
      );
      return true;
    }
  }

  return false;
}

/**
 * Handle the callback when a user selects a reading text (or pagination/back action).
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query from the inline button press
 * @returns void
 */
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
    const page = parseInt(value.replace("page_", ""), 10);
    if (!isNaN(page) && page >= 1) {
      await answerCallbackQuery(env, callbackQuery.id);

      // Re-render the text list on the same message
      const totalCount = await getReadingTextsCount(env);
      if (totalCount === 0) {
        await editMessageText(env, chatId, messageId, "فعلاً هیچ متنی برای تست درک مطلب ثبت نشده ❗️");
        return;
      }
      const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
      const safePage = Math.min(Math.max(page, 1), totalPages);
      const offset = (safePage - 1) * ITEMS_PER_PAGE;
      const texts = await getPaginatedReadingTexts(env, ITEMS_PER_PAGE, offset);
      const textItems = texts.map(t => ({ id: t.id, title: t.title }));

      await editMessageText(
        env,
        chatId,
        messageId,
        `${pe("📚")} <b>متون درک مطلب</b>\n<i>صفحه ${safePage} از ${totalPages}</i>\n\nیکی از متن‌ها رو انتخاب کن 👇`,
        { reply_markup: buildReadingInlineKeyboard(textItems, safePage, totalPages) }
      );
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  // Handle "start_<id>": user confirmed the prompt and wants to begin the exam.
  if (value.startsWith("start_")) {
    const startTextId = Number(value.replace("start_", ""));
    if (!Number.isFinite(startTextId)) {
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
      await execute(env, `UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?`, [activeSession.id]);
    }

    // Size the session to the FULL set of questions for this text, so the user
    // is asked every question (in random order), exam-style.
    const questionCount = await getTextQuestionCount(env, startTextId);
    if (questionCount === 0) {
      await answerCallbackQuery(env, callbackQuery.id);
      await editMessageText(env, chatId, messageId, "برای این متن هنوز سوالی ثبت نشده است ❗️");
      await sendMessage(env, chatId, "به منوی تمرین‌ها برمی‌گردی 👇", {
        reply_markup: getTrainingMenuKeyboard()
      });
      return;
    }

    const session = await createReadingSession(env, user.id, startTextId, questionCount);

    await answerCallbackQuery(env, callbackQuery.id, "آزمون شروع شد ✏️", false);

    await editMessageText(
      env,
      chatId,
      messageId,
      `${pe("📖")} <b>آزمون درک مطلب شروع شد</b>\n` +
        `این آزمون <b>${questionCount}</b> سوال داره.\n` +
        `وسط آزمون درست/غلط رو نمی‌گیم؛ آخرش نتیجه و پاسخنامه‌ی کامل رو می‌بینی. موفق باشی ✍️`
    );

    const sent = await sendNextReadingQuestion(env, user, session, chatId);
    if (!sent) {
      await sendMessage(env, chatId, "برای این متن هنوز سوالی ثبت نشده است ❗️\nبه منوی تمرین‌ها برمی‌گردی 👇", {
        reply_markup: getTrainingMenuKeyboard()
      });
    }
    return;
  }

  // Handle text selection: numeric text ID -> show a "ready to start?" prompt.
  const textId = Number(value);
  if (!Number.isFinite(textId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const questionCount = await getTextQuestionCount(env, textId);
  await answerCallbackQuery(env, callbackQuery.id);

  if (questionCount === 0) {
    await editMessageText(env, chatId, messageId, "برای این متن هنوز سوالی ثبت نشده است ❗️");
    await sendMessage(env, chatId, "به منوی تمرین‌ها برمی‌گردی 👇", {
      reply_markup: getTrainingMenuKeyboard()
    });
    return;
  }

  await editMessageText(
    env,
    chatId,
    messageId,
    `${pe("📖")} <b>تست درک مطلب</b>\n\n` +
      `این متن <b>${questionCount}</b> سوال داره.\n` +
      `سوال‌ها به‌صورت رندوم پشت‌سرهم میان و وسط آزمون جواب درست/غلط رو نشون نمی‌دیم؛ ` +
      `آخرش نتیجه و پاسخنامه‌ی کامل رو می‌گیری.\n\nآماده‌ای شروع کنی؟ 👇`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ شروع آزمون", callback_data: `${CB_PREFIX.READING_TEXT}:start_${textId}` }],
          [{ text: "◀️ بازگشت به منوی تمرین", callback_data: `${CB_PREFIX.READING_TEXT}:back` }]
        ]
      }
    }
  );
}

/**
 * Handle the callback when a user selects an answer for a reading comprehension question.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query from the answer button press
 * @returns void
 */
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
    await answerCallbackQuery(env, callbackQuery.id, "آزمون لغو شد 🚫", false);

    await execute(env, "UPDATE reading_sessions SET status = 'cancelled' WHERE id = ?", [sessionId]);

    await sendMessage(env, chatId, "تست متوقف شد. به منوی تمرین‌ها برگشتی 👇", {
      reply_markup: getTrainingMenuKeyboard()
    });
    return;
  }

  // Skip: the user chose to leave this question unanswered and move on.
  // We mark the history row as processed (answered_at set) but keep is_correct
  // NULL so it counts as "بدون پاسخ" in the summary, never as correct/wrong.
  // No extra reads/writes beyond the single guarded UPDATE the answer path uses.
  if (chosenOption === 'SKIP') {
    const [skipUser, skipSession] = await Promise.all([
      getOrCreateUser(env, callbackQuery.from),
      getReadingSessionById(env, sessionId),
    ]);
    if (!skipSession) {
      await answerCallbackQuery(env, callbackQuery.id, "این تست دیگر در دسترس نیست.");
      return;
    }

    const skipResult = await execute(
      env,
      `UPDATE user_text_question_history
       SET answered_at = ?
       WHERE reading_session_id = ?
         AND user_id = ?
         AND question_id = ?
         AND answered_at IS NULL`,
      [new Date().toISOString(), skipSession.id, skipUser.id, questionId]
    );

    if (skipResult.meta.changes === 0) {
      await answerCallbackQuery(env, callbackQuery.id, "⛔️ قبلاً به این سوال رسیدگی شده!");
      return;
    }

    await Promise.all([
      answerCallbackQuery(env, callbackQuery.id, "⏭ بدون پاسخ رد شد", false),
      editMessageReplyMarkup(env, chatId, message.message_id),
    ]);

    const sent = await sendNextReadingQuestion(env, skipUser, skipSession, chatId);
    if (!sent) {
      await sendReadingSummary(env, skipUser, skipSession, chatId);
    }
    return;
  }

  // These three reads are independent (user by tg-id, session by id, question by
  // id) — fetch them in one round-trip instead of three sequential ones.
  const [user, session, question] = await Promise.all([
    getOrCreateUser(env, callbackQuery.from),
    getReadingSessionById(env, sessionId),
    queryOne<DbTextQuestion>(
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
    ),
  ]);
  if (!session) {
    await answerCallbackQuery(env, callbackQuery.id, "این تست دیگر در دسترس نیست.");
    return;
  }
  if (!question) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد.");
    return;
  }

  const isCorrect = chosenOption === question.correct_option;

  const now = new Date().toISOString();

  const updateResult = await execute(
    env,
    `UPDATE user_text_question_history
     SET is_correct = ?, answered_at = ?
     WHERE reading_session_id = ?
       AND user_id = ?
       AND question_id = ?
       AND answered_at IS NULL`,
    [isCorrect ? 1 : 0, now, session.id, user.id, questionId]
  );

  if (updateResult.meta.changes === 0) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔️ قبلاً پاسخ دادی!");
    return;
  }

  // The correct-count bump, the confirmation toast, and disabling this
  // question's buttons are all independent — run them together. The num_correct
  // UPDATE must land before we re-read the session below, so it's awaited here.
  // Exam-style: no per-question feedback, just confirm + lock the buttons.
  await Promise.all([
    isCorrect
      ? execute(
          env,
          `UPDATE reading_sessions SET num_correct = num_correct + 1 WHERE id = ?`,
          [session.id]
        )
      : Promise.resolve(),
    answerCallbackQuery(env, callbackQuery.id, "✅ پاسخت ثبت شد", false),
    editMessageReplyMarkup(env, chatId, message.message_id),
  ]);

  const freshSession = await getReadingSessionById(env, sessionId);
  if (!freshSession) {
    return;
  }

  const sent = await sendNextReadingQuestion(env, user, freshSession, chatId);
  if (!sent) {
    // All questions answered -> show the results and full answer key.
    await sendReadingSummary(env, user, freshSession, chatId);
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

  // Progress indicator ("سوال X از N"). After recordQuestionShown, the history
  // row count equals the index of the question we're about to show.
  const shown = await getSessionStats(env, session.id);
  const totalQuestions = session.num_questions || shown.total;
  const progress = `<i>سوال ${shown.total} از ${totalQuestions}</i>`;

  const messageText =
    `${progress}\n${pe("📖")} <b>${question.question_text}</b>\n\n` +
    `1️⃣  ${question.option_a}\n` +
    `2️⃣  ${question.option_b}\n` +
    `3️⃣  ${question.option_c}\n` +
    `4️⃣  ${question.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1️⃣", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:A`, style: "primary" },
        { text: "2️⃣", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:B`, style: "primary" },
        { text: "3️⃣", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:C`, style: "primary" },
        { text: "4️⃣", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:D`, style: "primary" }
      ],
      [
        { text: "⏭ بی‌جواب رد کن", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:SKIP` }
      ],
      [
        { text: "❌ انصراف و خروج", callback_data: `${CB_PREFIX.READING_ANSWER}:${session.id}:${question.id}:CANCEL`, style: "danger" }
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
  // Read everything needed for XP + the summary first (side-effect-free).
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
      q.explanation_text,
      h.is_correct
    FROM user_text_question_history h
    JOIN text_questions q ON q.id = h.question_id
    WHERE h.reading_session_id = ?
    ORDER BY h.id ASC
    `,
    [session.id]
  );

  const newCorrectCount = await getNewCorrectCount(env, session.id, user.id);

  // Exactly-once + fully atomic: award XP and flip the session
  // in_progress -> completed as ONE DB.batch() (single transaction). The XP
  // statements are gated on the session still being in_progress and the
  // completion runs LAST, so the winning transaction awards XP and completes
  // together (all-or-nothing), while any duplicate finish becomes a no-op. There
  // is no partial-failure window where the session is marked completed but XP is
  // lost (Gemini's concern), nor one where XP is granted twice.
  const completedAt = new Date().toISOString();
  const guard: SqlGuard = {
    sql: `EXISTS (SELECT 1 FROM reading_sessions WHERE id = ? AND status = 'in_progress')`,
    params: [session.id],
  };

  const { totalXp, stmts: xpStmts } = calculateAndPrepareXpForReading(env, user.id, session.id, newCorrectCount, total, guard);

  const batchStatements: D1PreparedStatement[] = [...xpStmts];
  if (totalXp > 0) {
    batchStatements.push(prepareUpdateSessionXp(env, session.id, totalXp, guard));
  }
  // Completion LAST so the gates above evaluate against the pre-completion state.
  batchStatements.push(prepare(
    env,
    `UPDATE reading_sessions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_progress'`,
    [completedAt, session.id]
  ));

  const results = await batch(env, batchStatements);
  const completionResult = results[results.length - 1];
  if (!completionResult || completionResult.meta.changes === 0) {
    // Already completed by a concurrent/duplicate finish — XP not double-awarded.
    return;
  }

  const streakMsg = await checkAndUpdateStreak(env, user.id);
  if (streakMsg) {
    await sendMessage(env, chatId, streakMsg);
  }

  // Reading session completed (runs once, guarded above) — evaluate medals.
  const freshBadges = await evaluateThresholdBadges(env, user.id);
  await notifyNewBadges(env, chatId, freshBadges);

  // Skipped = processed history rows the user chose to leave blank (is_correct NULL).
  const skipped = rows.filter((r) => r.is_correct === null).length;

  let text = `${pe("📊")} <b>نتیجه‌ی تست درک مطلب</b>\n`;
  text += `━━━━━━━━━━━━━━\n`;
  text += `✅ پاسخ‌های درست: <b>${correct}</b> از <b>${total}</b>\n`;
  if (skipped > 0) {
    text += `⬜️ بدون پاسخ: <b>${skipped}</b>\n`;
  }

  if (totalXp > 0) {
    text += `${pe("⭐️")} XP دریافتی: <b>+${totalXp}</b>\n`;
  } else if (correct > 0) {
    text += `${pe("⭐️")} XP دریافتی: <b>0</b> <i>(تکراری)</i>\n`;
  }

  await sendMessage(env, chatId, text);

  // Answer key (پاسخنامه): for each question show whether the user got it right,
  // the correct option, and the descriptive explanation when the question has one.
  // Sent in chunks because a full-text exam can have many questions and long
  // explanations that exceed Telegram's per-message size limit.
  if (rows.length > 0) {
    const blocks = rows.map((r, idx) => {
      const qNum = idx + 1;
      const correctOptionNum = optionLetterToNumber(r.correct_option);
      const correctText = getOptionTextForRow(r, r.correct_option);
      const status = r.is_correct === 1 ? "✅" : r.is_correct === 0 ? "❌" : "⬜️";
      let block = `${qNum}) ${status} گزینه ${correctOptionNum}: <b>${correctText}</b>`;
      const explanation = (r.explanation_text ?? "").trim();
      if (explanation) {
        block += `\n   📝 ${explanation}`;
      }
      return block;
    });

    const MAX_LEN = 3500;
    let chunk = `📋 <b>پاسخنامه:</b>\n`;
    for (const block of blocks) {
      const piece = `\n${block}\n`;
      if (chunk.length + piece.length > MAX_LEN) {
        await sendMessage(env, chatId, chunk);
        chunk = "";
      }
      chunk += piece;
    }
    if (chunk.trim().length > 0) {
      await sendMessage(env, chatId, chunk);
    }
  }

  await sendMessage(env, chatId, `${pe("💪")} خسته نباشی! چه کار دیگه‌ای می‌خوای انجام بدی؟`, {
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
