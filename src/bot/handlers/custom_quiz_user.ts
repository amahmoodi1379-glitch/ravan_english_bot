import { Env } from "../../types";
import { sendMessage, editMessageText, answerCallbackQuery } from "../telegram-api";
import { CB_PREFIX } from "../../config/constants";
import { getOrCreateUser } from "../../db/users";
import {
  getQuizLinkByToken, getQuizById, getQuizQuestions,
  createAttempt, getAttemptByQuizAndUser,
  getAttempt, finishAttempt, saveAnswer, updateCurrentQuestionIndex,
  getAnswerForQuestion, getAnsweredCount,
  getLeaderboardWithNegative, getLeaderboardWithoutNegative,
  getUserRankWithNegative, getUserRankWithoutNegative,
  getFinishedAttemptsWithChatId,
} from "../../db/custom_quizzes";

function formatTime(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

export async function handleQuizStart(env: Env, user: any, chatId: number, token: string): Promise<void> {
  const link = await getQuizLinkByToken(env, token);
  if (!link) { await sendMessage(env, chatId, "❌ لینک آزمون نامعتبر است."); return; }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    await sendMessage(env, chatId, "⏳ لینک آزمون منقضی شده است.");
    return;
  }
  const quiz = await getQuizById(env, link.quiz_id);
  if (!quiz) { await sendMessage(env, chatId, "❌ آزمون یافت نشد."); return; }
  if (quiz.status !== 'active' && quiz.status !== 'published') {
    await sendMessage(env, chatId, "⚠️ این آزمون فعال نیست.");
    return;
  }

  // Parallel: fetch questions and existing attempt together
  const [questions, existing] = await Promise.all([
    getQuizQuestions(env, quiz.id),
    getAttemptByQuizAndUser(env, quiz.id, user.id),
  ]);
  if (!questions.length) { await sendMessage(env, chatId, "⚠️ آزمون هنوز سوالی ندارد."); return; }

  // Check for existing attempt

  if (existing && existing.status === 'in_progress') {
    // Check if time expired
    if (isQuizExpired(existing, quiz)) {
      await finishAttempt(env, existing.id, 'auto_ended');
      await sendMessage(env, chatId, "⏰ زمان آزمون شما تمام شده بود. نتایج:");
      await sendResults(env, chatId, user.id, quiz.id, existing.id);
      return;
    }
    // Resume
    const resumeIndex = existing.current_question_index || 1;
    const endTime = new Date(new Date(existing.started_at).getTime() + quiz.total_time_minutes * 60 * 1000);
    await sendMessage(env, chatId, `⏱️ <b>ادامه آزمون "${quiz.title}"</b>\n🕐 پایان: ${formatTime(endTime)}\n\nاز دکمه‌های زیر استفاده کن 👇`, { parse_mode: "HTML" });
    await sendQuizQuestion(env, chatId, quiz.id, existing.id, resumeIndex);
    return;
  }

  if (existing && (existing.status === 'finished' || existing.status === 'auto_ended')) {
    // Already finished — show results directly
    await sendMessage(env, chatId, `✅ شما قبلاً آزمون <b>"${quiz.title}"</b> را داده‌اید. نتایج:`, { parse_mode: "HTML" });
    await sendResults(env, chatId, user.id, quiz.id, existing.id);
    return;
  }

  // Create new attempt
  const attemptId = await createAttempt(env, quiz.id, user.id, chatId);
  const endTime = new Date(Date.now() + quiz.total_time_minutes * 60 * 1000);

  await sendMessage(env, chatId,
    `📝 <b>آزمون: ${quiz.title}</b>\n\n` +
    `📊 تعداد سوالات: ${questions.length}\n` +
    `⏱️ زمان: ${quiz.total_time_minutes} دقیقه\n` +
    `🕐 پایان: ${formatTime(endTime)}\n\n` +
    `✅ گزینه مورد نظرت رو بزن\n` +
    `◀️▶️ بین سوالات جابجا شو\n` +
    `❌ برای حذف جواب "نزده" رو بزن\n` +
    `🏁 وقتی تموم شد "پایان آزمون" رو بزن\n\n` +
    `موفق باشی! 🍀`,
    { parse_mode: "HTML" }
  );
  await sendQuizQuestion(env, chatId, quiz.id, attemptId, 1);
}

function isQuizExpired(attempt: any, quiz: any): boolean {
  const started = new Date(attempt.started_at).getTime();
  const limitMs = quiz.total_time_minutes * 60 * 1000;
  return Date.now() > started + limitMs;
}

/**
 * Build and send (or edit) a quiz question message with inline keyboard.
 * This is the core UI function. It always shows:
 * - Question text with options
 * - Option buttons (with ✅ on selected)
 * - Navigation (prev/next)
 * - Unanswer + Finish buttons
 */
async function sendQuizQuestion(
  env: Env,
  chatId: number,
  quizId: number,
  attemptId: number,
  questionIndex: number,
  messageId?: number
): Promise<void> {
  const questions = await getQuizQuestions(env, quizId);
  if (!questions.length) return;

  const q = questions[questionIndex - 1];
  if (!q) return;

  const ans = await getAnswerForQuestion(env, attemptId, q.id);
  const chosen = ans?.chosen_option;

  const text =
    `❓ <b>سوال ${questionIndex} از ${questions.length}</b>\n\n` +
    `${q.question_text}\n\n` +
    `1️⃣ ${q.option_a}\n` +
    `2️⃣ ${q.option_b}\n` +
    `3️⃣ ${q.option_c}\n` +
    `4️⃣ ${q.option_d}` +
    (chosen ? `\n\n✅ انتخاب شما: گزینه ${chosen}` : ``);

  const rows: any[][] = [];

  // Option buttons
  const opts = ['1', '2', '3', '4'].map(opt => ({
    text: chosen === opt ? `✅ ${opt}` : opt,
    callback_data: `${CB_PREFIX.QUIZ}:ans:${attemptId}:${q.id}:${opt}`
  }));
  rows.push(opts);

  // Navigation
  const navRow: any[] = [];
  if (questionIndex > 1) {
    navRow.push({ text: "سوال قبلی ▶️", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex - 1}` });
  }
  if (questionIndex < questions.length) {
    navRow.push({ text: "◀️ سوال بعدی", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  // Unanswer + Finish
  const actionRow: any[] = [];
  if (chosen) {
    actionRow.push({ text: "❌ حذف جواب", callback_data: `${CB_PREFIX.QUIZ}:unans:${attemptId}:${q.id}` });
  }
  actionRow.push({ text: "🏁 پایان آزمون", callback_data: `${CB_PREFIX.QUIZ}:finish:${attemptId}` });
  rows.push(actionRow);

  const markup = { inline_keyboard: rows };

  if (messageId) {
    try {
      await editMessageText(env, chatId, messageId, text, { reply_markup: markup });
    } catch {
      // If edit fails (message unchanged or too old), send new message
      await sendMessage(env, chatId, text, { reply_markup: markup });
    }
  } else {
    await sendMessage(env, chatId, text, { reply_markup: markup });
  }
}

async function autoFinish(env: Env, chatId: number, userId: number, attemptId: number, quizId: number, messageId?: number): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) return;
  if (attempt.status === 'auto_ended' || attempt.status === 'finished') {
    await sendMessage(env, chatId, "⏰ آزمون قبلاً تمام شده. نتایج:");
    await sendResults(env, chatId, userId, quizId, attemptId);
    return;
  }
  await finishAttempt(env, attemptId, 'auto_ended');

  if (messageId) {
    try {
      await editMessageText(env, chatId, messageId, "⏰ <b>زمان آزمون تمام شد!</b>", { reply_markup: { inline_keyboard: [] } });
    } catch {}
  }

  await sendMessage(env, chatId, "⏰ <b>زمان آزمون تمام شد!</b>\n\nنتایج شما:", { parse_mode: "HTML" });
  await sendResults(env, chatId, userId, quizId, attemptId);

  // Push results to other finished participants
  await pushResultsToAllFinished(env, quizId, userId);
}

async function pushResultsToAllFinished(env: Env, quizId: number, excludeUserId: number): Promise<void> {
  const finishedAttempts = await getFinishedAttemptsWithChatId(env, quizId);
  const notifications = finishedAttempts
    .filter(a => a.user_id !== excludeUserId && a.chat_id)
    .map(a =>
      sendMessage(env, a.chat_id,
        "📊 <b>نتایج نهایی آزمون آماده شد!</b>\n\nبرای مشاهده نتایج، لینک آزمون رو دوباره باز کن.",
        { parse_mode: "HTML" }
      ).catch(() => {})
    );
  await Promise.all(notifications);
}

export async function handleQuizUserCallback(env: Env, callbackQuery: any): Promise<void> {
  const data = callbackQuery.data || "";
  const parts = data.split(":");
  const action = parts[1] || "";
  const attemptId = parts[2] ? parseInt(parts[2], 10) : 0;
  const id = parts[3] ? parseInt(parts[3], 10) : 0;
  const extra = parts[4] || "";

  const msg = callbackQuery.message;
  if (!msg) { await answerCallbackQuery(env, callbackQuery.id); return; }
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  // Handle post-quiz actions (explain, return_results) — no attempt validation needed
  if (action === "explain") {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleExplain(env, chatId, messageId, user.id, attemptId, id);
    return;
  }
  if (action === "return_results") {
    await answerCallbackQuery(env, callbackQuery.id);
    await handleReturnResults(env, chatId, messageId, user.id, attemptId);
    return;
  }

  // Validate attempt exists and belongs to user
  if (!attemptId) {
    await answerCallbackQuery(env, callbackQuery.id, "⚠️ آزمون نامعتبر.");
    return;
  }

  const attempt = await getAttempt(env, attemptId);
  if (!attempt) {
    await answerCallbackQuery(env, callbackQuery.id, "⚠️ آزمون یافت نشد.");
    return;
  }
  if (attempt.user_id !== user.id) {
    await answerCallbackQuery(env, callbackQuery.id, "⚠️ این آزمون متعلق به شما نیست.");
    return;
  }

  const quiz = await getQuizById(env, attempt.quiz_id);
  if (!quiz) {
    await answerCallbackQuery(env, callbackQuery.id, "⚠️ آزمون یافت نشد.");
    return;
  }

  // Check if already finished
  if (attempt.status === 'finished' || attempt.status === 'auto_ended') {
    await answerCallbackQuery(env, callbackQuery.id, "آزمون تمام شده است.");
    try {
      await editMessageText(env, chatId, messageId,
        "✅ این آزمون تمام شده. برای دیدن نتایج، لینک آزمون رو دوباره باز کن.",
        { reply_markup: { inline_keyboard: [] } });
    } catch {}
    return;
  }

  // Check time expiry
  if (isQuizExpired(attempt, quiz)) {
    await answerCallbackQuery(env, callbackQuery.id, "⏰ زمان تمام شد!");
    await autoFinish(env, chatId, user.id, attemptId, quiz.id, messageId);
    return;
  }

  // --- Handle quiz actions ---

  if (action === "ans") {
    // Save answer and refresh the SAME question (showing the selection)
    await saveAnswer(env, attemptId, id, extra);
    await answerCallbackQuery(env, callbackQuery.id, `✅ گزینه ${extra} ثبت شد`);

    // Find which question index this is
    const questions = await getQuizQuestions(env, quiz.id);
    const qIndex = questions.findIndex(q => q.id === id);
    const currentIndex = qIndex >= 0 ? qIndex + 1 : (attempt.current_question_index || 1);

    await updateCurrentQuestionIndex(env, attemptId, currentIndex);
    await sendQuizQuestion(env, chatId, quiz.id, attemptId, currentIndex, messageId);
    return;
  }

  if (action === "unans") {
    // Remove answer (set to null)
    await saveAnswer(env, attemptId, id, null);
    await answerCallbackQuery(env, callbackQuery.id, "❌ جواب حذف شد");

    const questions = await getQuizQuestions(env, quiz.id);
    const qIndex = questions.findIndex(q => q.id === id);
    const currentIndex = qIndex >= 0 ? qIndex + 1 : (attempt.current_question_index || 1);

    await sendQuizQuestion(env, chatId, quiz.id, attemptId, currentIndex, messageId);
    return;
  }

  if (action === "nav") {
    const navIndex = id; // id here is the target question index
    await answerCallbackQuery(env, callbackQuery.id);
    await updateCurrentQuestionIndex(env, attemptId, navIndex);
    await sendQuizQuestion(env, chatId, quiz.id, attemptId, navIndex, messageId);
    return;
  }

  if (action === "finish") {
    await answerCallbackQuery(env, callbackQuery.id);

    // Single query to count answered questions
    const [questions, answeredCount] = await Promise.all([
      getQuizQuestions(env, quiz.id),
      getAnsweredCount(env, attemptId),
    ]);
    const unansweredCount = questions.length - answeredCount;

    let confirmText = "🏁 <b>آیا مطمئنی میخوای آزمون رو تموم کنی؟</b>\n\n";
    confirmText += `✅ پاسخ داده: ${answeredCount} سوال\n`;
    if (unansweredCount > 0) {
      confirmText += `⬜ بدون پاسخ: ${unansweredCount} سوال\n`;
      confirmText += `\n⚠️ سوالات بدون پاسخ نمره‌ای ندارند.`;
    }

    await editMessageText(env, chatId, messageId, confirmText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ بله، ثبت نهایی", callback_data: `${CB_PREFIX.QUIZ}:confirm_finish:${attemptId}` },
            { text: "↩️ برگشت به آزمون", callback_data: `${CB_PREFIX.QUIZ}:cancel:${attemptId}` }
          ]
        ]
      }
    });
    return;
  }

  if (action === "confirm_finish") {
    await answerCallbackQuery(env, callbackQuery.id, "✅ آزمون ثبت شد!");
    await finishAttempt(env, attemptId, 'finished');

    await editMessageText(env, chatId, messageId,
      "✅ <b>آزمون شما با موفقیت ثبت شد!</b>\n\nنتایج:",
      { reply_markup: { inline_keyboard: [] } });

    await sendResults(env, chatId, user.id, quiz.id, attemptId);
    return;
  }

  if (action === "cancel") {
    // Return to current question
    await answerCallbackQuery(env, callbackQuery.id);
    const currentIndex = attempt.current_question_index || 1;
    await sendQuizQuestion(env, chatId, quiz.id, attemptId, currentIndex, messageId);
    return;
  }

  // Unknown action
  await answerCallbackQuery(env, callbackQuery.id);
}

// --- Post-quiz handlers ---

async function handleExplain(env: Env, chatId: number, messageId: number, userId: number, attemptId: number, questionId: number): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt || attempt.user_id !== userId) return;

  // Parallel: fetch questions and user's answer together
  const [questions, ans] = await Promise.all([
    getQuizQuestions(env, attempt.quiz_id),
    getAnswerForQuestion(env, attemptId, questionId),
  ]);
  const question = questions.find(q => q.id === questionId);
  if (!question) return;
  const userAnswer = ans?.chosen_option || "نزده";
  const isCorrect = ans?.chosen_option === question.correct_option;

  const explainText =
    `❓ <b>سوال ${question.question_index}:</b>\n${question.question_text}\n\n` +
    `1️⃣ ${question.option_a}\n2️⃣ ${question.option_b}\n3️⃣ ${question.option_c}\n4️⃣ ${question.option_d}\n\n` +
    `👤 جواب شما: <b>${userAnswer}</b> ${isCorrect ? '✅' : (userAnswer === 'نزده' ? '⬜' : '❌')}\n` +
    `✅ گزینه درست: <b>${question.correct_option}</b>\n` +
    `📖 توضیح: ${question.explanation || 'ندارد'}`;

  const backKeyboard = {
    inline_keyboard: [[
      { text: "◀️ بازگشت به پاسخنامه", callback_data: `${CB_PREFIX.QUIZ}:return_results:${attemptId}` }
    ]]
  };

  try {
    await editMessageText(env, chatId, messageId, explainText, { reply_markup: backKeyboard });
  } catch {
    await sendMessage(env, chatId, explainText, { reply_markup: backKeyboard });
  }
}

async function handleReturnResults(env: Env, chatId: number, messageId: number, userId: number, attemptId: number): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt || attempt.user_id !== userId) return;

  const questions = await getQuizQuestions(env, attempt.quiz_id);
  const rows: any[][] = [];
  for (let i = 0; i < questions.length; i += 5) {
    rows.push(questions.slice(i, i + 5).map(q => ({
      text: String(q.question_index),
      callback_data: `${CB_PREFIX.QUIZ}:explain:${attemptId}:${q.id}`
    })));
  }

  const text = "📖 برای دیدن پاسخنامه تشریحی، روی شماره سوال بزن:";
  try {
    await editMessageText(env, chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
  } catch {
    await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: rows } });
  }
}

// --- Results ---

async function sendResults(env: Env, chatId: number, userId: number, quizId: number, attemptId: number): Promise<void> {
  // Parallel: fetch all leaderboard data at once
  const [lbNeg, userRankNeg, lbPos, userRankPos, questions] = await Promise.all([
    getLeaderboardWithNegative(env, quizId, 50),
    getUserRankWithNegative(env, quizId, userId),
    getLeaderboardWithoutNegative(env, quizId, 50),
    getUserRankWithoutNegative(env, quizId, userId),
    getQuizQuestions(env, quizId),
  ]);

  let negText = `📊 <b>رتبه‌بندی (با نمره منفی)</b>\n\n`;
  if (!lbNeg.length) {
    negText += "🙈 هنوز کسی امتیازی ندارد.\n";
  } else {
    for (const e of lbNeg) {
      const medal = e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : `${e.rank}.`;
      const isYou = e.user_id === userId ? ' 👈' : '';
      negText += `${medal} <b>${e.display_name}</b> — ${e.percentage}% — ✅${e.correct} ❌${e.wrong} ⬜${e.unanswered}${isYou}\n`;
    }
  }
  if (userRankNeg) {
    const inTop = lbNeg.some(e => e.user_id === userId);
    if (!inTop) {
      negText += `\n📍 <b>شما:</b> رتبه ${userRankNeg.rank} — ${userRankNeg.percentage}% — ✅${userRankNeg.correct} ❌${userRankNeg.wrong} ⬜${userRankNeg.unanswered}`;
    }
  }
  await sendMessage(env, chatId, negText, { parse_mode: "HTML" });

  let posText = `📊 <b>رتبه‌بندی (بدون نمره منفی)</b>\n\n`;
  if (!lbPos.length) {
    posText += "🙈 هنوز کسی امتیازی ندارد.\n";
  } else {
    for (const e of lbPos) {
      const medal = e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : `${e.rank}.`;
      const isYou = e.user_id === userId ? ' 👈' : '';
      posText += `${medal} <b>${e.display_name}</b> — ${e.percentage}% — ✅${e.correct}${isYou}\n`;
    }
  }
  if (userRankPos) {
    const inTop2 = lbPos.some(e => e.user_id === userId);
    if (!inTop2) {
      posText += `\n📍 <b>شما:</b> رتبه ${userRankPos.rank} — ${userRankPos.percentage}% — ✅${userRankPos.correct}`;
    }
  }
  await sendMessage(env, chatId, posText, { parse_mode: "HTML" });

  // Answer key buttons (questions already fetched above)
  const rows: any[][] = [];
  for (let i = 0; i < questions.length; i += 5) {
    rows.push(questions.slice(i, i + 5).map(q => ({
      text: String(q.question_index),
      callback_data: `${CB_PREFIX.QUIZ}:explain:${attemptId}:${q.id}`
    })));
  }
  await sendMessage(env, chatId, "📖 برای دیدن پاسخنامه تشریحی، روی شماره سوال بزن:", {
    reply_markup: { inline_keyboard: rows }
  });
}
