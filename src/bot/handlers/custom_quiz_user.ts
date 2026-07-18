import { Env } from "../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, editMessageText, answerCallbackQuery } from "../telegram-api";
import { CB_PREFIX } from "../../config/constants";
import { parseUtcStamp } from "../../utils/iran_time";
import { getOrCreateUser, DbUser } from "../../db/users";
import {
  getQuizLinkByToken, getQuizById, getQuizQuestions,
  createAttempt, getAttemptByQuizAndUser,
  getAttempt, finishAttempt, saveAnswer, updateCurrentQuestionIndex,
  getAnswerForQuestion, getAnsweredCount,
  getLeaderboardWithNegative, getLeaderboardWithoutNegative,
  getUserRankWithNegative, getUserRankWithoutNegative,
  getFinishedAttemptsWithChatId,
  CustomQuizQuestion,
  CustomQuiz,
} from "../../db/custom_quizzes";

function formatTime(d: Date): string {
  // Iran is UTC+3:30
  const iranMs = d.getTime() + (3.5 * 60 * 60 * 1000);
  const iranDate = new Date(iranMs);
  const hh = iranDate.getUTCHours().toString().padStart(2, '0');
  const mm = iranDate.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Start a quiz attempt for a user from a deep-link token.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record starting the quiz
 * @param chatId - The Telegram chat ID to send quiz messages to
 * @param token - The quiz link token from the deep-link URL
 * @returns void
 */
export async function handleQuizStart(env: Env, user: DbUser, chatId: number, token: string): Promise<void> {
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

  await beginOrResumeQuiz(env, user, chatId, quiz);
}

/**
 * Begin, resume, or show results for a quiz the caller has already resolved and
 * authorised (a token link OR today's tournament). Reuses the whole quiz-taking
 * UI. For tournaments the per-user timer is additionally capped by `closes_at`.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @param quiz - The resolved quiz row (custom or tournament)
 * @returns void
 */
export async function beginOrResumeQuiz(env: Env, user: DbUser, chatId: number, quiz: CustomQuiz): Promise<void> {
  // Parallel: fetch questions and existing attempt together
  const [questions, existing] = await Promise.all([
    getQuizQuestions(env, quiz.id),
    getAttemptByQuizAndUser(env, quiz.id, user.id),
  ]);
  if (!questions.length) { await sendMessage(env, chatId, "⚠️ آزمون هنوز سوالی ندارد."); return; }

  // Check for existing attempt

  const pending = tournamentResultsPending(quiz);

  if (existing && existing.status === 'in_progress') {
    // Check if time expired
    if (isQuizExpired(existing, quiz)) {
      await finishAttempt(env, existing.id, 'auto_ended');
      await sendMessage(env, chatId, "⏰ زمان آزمون شما تمام شده بود. نتایج:");
      await sendResults(env, chatId, user.id, quiz.id, existing.id, { tournamentPending: pending });
      return;
    }
    // Resume
    const resumeIndex = existing.current_question_index || 1;
    const endTime = new Date(attemptEndMs(quiz, parseUtcStamp(existing.started_at).getTime()));
    await sendMessage(env, chatId, `⏱️ <b>ادامه آزمون "${quiz.title}"</b>\n🕐 پایان: ${formatTime(endTime)}\n\nاز دکمه‌های زیر استفاده کن 👇`, { parse_mode: "HTML" });
    await sendQuizQuestion(env, chatId, quiz.id, existing.id, resumeIndex);
    return;
  }

  if (existing && (existing.status === 'finished' || existing.status === 'auto_ended')) {
    // Already finished — show results directly. For a still-open tournament the
    // standings are provisional; make clear the final result is still coming.
    const header = pending
      ? `✅ <b>تو توی مسابقه‌ی امشب شرکت کردی.</b>\nنتیجه‌ی نهایی بعد از پایان مسابقه برات ارسال میشه. وضعیت لحظه‌ای:`
      : `✅ شما قبلاً آزمون <b>"${quiz.title}"</b> را داده‌اید. نتایج:`;
    await sendMessage(env, chatId, header, { parse_mode: "HTML" });
    await sendResults(env, chatId, user.id, quiz.id, existing.id, { tournamentPending: pending });
    return;
  }

  // Create new attempt
  const attemptId = await createAttempt(env, quiz.id, user.id, chatId);
  const endTime = new Date(attemptEndMs(quiz, Date.now()));

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

/**
 * The effective end time (ms) of an attempt: start + per-user limit, but never
 * later than the quiz's hard `closes_at` (tournaments). Custom quizzes have no
 * closes_at, so their timing is unchanged.
 */
function attemptEndMs(quiz: { total_time_minutes: number; closes_at?: string | null }, startedMs: number): number {
  let end = startedMs + quiz.total_time_minutes * 60 * 1000;
  if (quiz.closes_at) {
    const closeMs = parseUtcStamp(quiz.closes_at).getTime();
    if (!Number.isNaN(closeMs) && closeMs < end) end = closeMs;
  }
  return end;
}

function isQuizExpired(attempt: { started_at: string }, quiz: { total_time_minutes: number; closes_at?: string | null }): boolean {
  return Date.now() > attemptEndMs(quiz, parseUtcStamp(attempt.started_at).getTime());
}

/**
 * True when `quiz` is a tournament whose window is still open, so the standings a
 * user sees right now are provisional: not everyone has played yet, and the final
 * ranked results will be broadcast to all participants at close. Custom quizzes
 * (no closes_at) and already-closed tournaments are never "pending". Time-based on
 * closes_at so it's correct regardless of the quiz row's (possibly stale) status.
 */
function tournamentResultsPending(quiz: { kind?: string; closes_at?: string | null }): boolean {
  if (quiz.kind !== "tournament" || !quiz.closes_at) return false;
  const closeMs = parseUtcStamp(quiz.closes_at).getTime();
  return !Number.isNaN(closeMs) && Date.now() < closeMs;
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
  messageId?: number,
  opts?: { questions?: CustomQuizQuestion[]; chosenOverride?: string | null }
): Promise<void> {
  const questions = opts?.questions ?? await getQuizQuestions(env, quizId);
  if (!questions.length) return;

  const currentQuestion = questions[questionIndex - 1];
  if (!currentQuestion) return;

  // Use explicit chosen override when provided (avoids D1 read-after-write lag);
  // otherwise read the saved answer from DB.
  let chosen: string | null | undefined;
  if (opts && 'chosenOverride' in opts) {
    chosen = opts.chosenOverride;
  } else {
    const ans = await getAnswerForQuestion(env, attemptId, currentQuestion.id);
    chosen = ans?.chosen_option;
  }

  const text =
    `❓ <b>سوال ${questionIndex} از ${questions.length}</b>\n\n` +
    `${currentQuestion.question_text}\n\n` +
    `1️⃣ ${currentQuestion.option_a}\n` +
    `2️⃣ ${currentQuestion.option_b}\n` +
    `3️⃣ ${currentQuestion.option_c}\n` +
    `4️⃣ ${currentQuestion.option_d}` +
    (chosen ? `\n\n✅ انتخاب شما: گزینه ${chosen}` : ``);

  const rows: InlineKeyboardButton[][] = [];

  // Option buttons
  const optButtons = ['1', '2', '3', '4'].map(opt => ({
    text: chosen === opt ? `✅ ${opt}` : opt,
    callback_data: `${CB_PREFIX.QUIZ}:ans:${attemptId}:${currentQuestion.id}:${opt}`
  }));
  rows.push(optButtons);

  // Navigation
  const navRow: InlineKeyboardButton[] = [];
  if (questionIndex > 1) {
    navRow.push({ text: "سوال قبلی ◀️", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex - 1}` });
  }
  if (questionIndex < questions.length) {
    navRow.push({ text: "▶️ سوال بعدی", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  // Unanswer + Finish
  const actionRow: InlineKeyboardButton[] = [];
  if (chosen) {
    actionRow.push({ text: "❌ حذف جواب", callback_data: `${CB_PREFIX.QUIZ}:unans:${attemptId}:${currentQuestion.id}` });
  }
  actionRow.push({ text: "🏁 پایان آزمون", callback_data: `${CB_PREFIX.QUIZ}:finish:${attemptId}` });
  rows.push(actionRow);

  const markup = { inline_keyboard: rows };

  if (messageId) {
    const result = await editMessageText(env, chatId, messageId, text, { reply_markup: markup });
    // If edit didn't succeed for any reason, send a new message as fallback.
    // "message is not modified" means UI is already correct, so skip fallback.
    // result is unknown — Telegram API response shape accessed dynamically
    const apiResult = result as { ok?: boolean; description?: string } | null;
    const ok = apiResult?.ok === true;
    if (!ok) {
      const desc: string = apiResult?.description || "";
      if (!desc.includes("message is not modified")) {
        await sendMessage(env, chatId, text, { reply_markup: markup });
      }
    }
  } else {
    await sendMessage(env, chatId, text, { reply_markup: markup });
  }
}

async function autoFinish(env: Env, chatId: number, userId: number, attemptId: number, quizId: number, messageId?: number, quizKind?: string, tournamentPending = false): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) return;
  if (attempt.status === 'auto_ended' || attempt.status === 'finished') {
    await sendMessage(env, chatId, "⏰ آزمون قبلاً تمام شده. نتایج:");
    await sendResults(env, chatId, userId, quizId, attemptId, { tournamentPending });
    return;
  }
  await finishAttempt(env, attemptId, 'auto_ended');

  if (messageId) {
    try {
      await editMessageText(env, chatId, messageId, "⏰ <b>زمان آزمون تمام شد!</b>", { reply_markup: { inline_keyboard: [] } });
    } catch {}
  }

  await sendMessage(env, chatId, "⏰ <b>زمان آزمون تمام شد!</b>\n\nنتایج شما:", { parse_mode: "HTML" });
  await sendResults(env, chatId, userId, quizId, attemptId, { tournamentPending });

  // Push "results ready" to other finished participants — for admin link-quizzes
  // only. Tournaments broadcast their own results at settlement (and have no link
  // to re-open), so this cross-notification must not fire for them.
  if (quizKind !== 'tournament') {
    await pushResultsToAllFinished(env, quizId, userId);
  }
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

/**
 * Handle inline button callbacks for quiz user actions (answer, next, results, explain).
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query from the quiz inline button
 * @returns void
 */
export async function handleQuizUserCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
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

  // Check if already finished. Tournaments have no re-openable link, so point the
  // user at the tournament menu (or the pending final broadcast) instead.
  if (attempt.status === 'finished' || attempt.status === 'auto_ended') {
    await answerCallbackQuery(env, callbackQuery.id, "آزمون تمام شده است.");
    const doneMsg =
      quiz.kind === 'tournament'
        ? (tournamentResultsPending(quiz)
            ? "✅ این آزمون رو دادی. نتیجه‌ی نهایی بعد از پایان مسابقه برات ارسال میشه."
            : "✅ مسابقه تمام شده. برای دیدن نتایج، دوباره وارد بخش مسابقه شو.")
        : "✅ این آزمون تمام شده. برای دیدن نتایج، لینک آزمون رو دوباره باز کن.";
    try {
      await editMessageText(env, chatId, messageId, doneMsg, { reply_markup: { inline_keyboard: [] } });
    } catch {}
    return;
  }

  // Check time expiry
  if (isQuizExpired(attempt, quiz)) {
    await answerCallbackQuery(env, callbackQuery.id, "⏰ زمان تمام شد!");
    await autoFinish(env, chatId, user.id, attemptId, quiz.id, messageId, quiz.kind, tournamentResultsPending(quiz));
    return;
  }

  // --- Handle quiz actions ---

  if (action === "ans") {
    // Save answer, acknowledge callback, and fetch questions — all in parallel
    const [, , questions] = await Promise.all([
      saveAnswer(env, attemptId, id, extra),
      answerCallbackQuery(env, callbackQuery.id, `گزینه ${extra} ثبت شد ✅`, false),
      getQuizQuestions(env, quiz.id),
    ]);

    const qIndex = questions.findIndex(q => q.id === id);
    const currentIndex = qIndex >= 0 ? qIndex + 1 : (attempt.current_question_index || 1);

    await updateCurrentQuestionIndex(env, attemptId, currentIndex);
    await sendQuizQuestion(env, chatId, quiz.id, attemptId, currentIndex, messageId, {
      questions,
      chosenOverride: extra,
    });
    return;
  }

  if (action === "unans") {
    // Remove answer, acknowledge callback, and fetch questions — all in parallel
    const [, , questions] = await Promise.all([
      saveAnswer(env, attemptId, id, null),
      answerCallbackQuery(env, callbackQuery.id, "جواب حذف شد ❌", false),
      getQuizQuestions(env, quiz.id),
    ]);

    const qIndex = questions.findIndex(q => q.id === id);
    const currentIndex = qIndex >= 0 ? qIndex + 1 : (attempt.current_question_index || 1);

    await sendQuizQuestion(env, chatId, quiz.id, attemptId, currentIndex, messageId, {
      questions,
      chosenOverride: null,
    });
    return;
  }

  if (action === "nav") {
    const navIndex = id;
    await Promise.all([
      answerCallbackQuery(env, callbackQuery.id),
      updateCurrentQuestionIndex(env, attemptId, navIndex),
    ]);
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

    const pending = tournamentResultsPending(quiz);
    const finishMsg = pending
      ? "✅ <b>آزمونت ثبت شد!</b>\n\n⏳ صبر کن تا بقیه هم شرکت کنن؛ نتیجه‌ی نهایی و رتبه‌ی قطعی‌ات بعد از پایان مسابقه برات ارسال میشه."
      : "✅ <b>آزمون شما با موفقیت ثبت شد!</b>\n\nنتایج:";
    await editMessageText(env, chatId, messageId, finishMsg, { reply_markup: { inline_keyboard: [] } });

    await sendResults(env, chatId, user.id, quiz.id, attemptId, { tournamentPending: pending });
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
  const rows: InlineKeyboardButton[][] = [];
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

export async function sendResults(env: Env, chatId: number, userId: number, quizId: number, attemptId: number, opts?: { tournamentPending?: boolean }): Promise<void> {
  // For a still-open tournament, lead with a clear "this is provisional, the final
  // result is still coming" banner so the live standings aren't mistaken for the
  // final ranking (which is broadcast to everyone at close).
  if (opts?.tournamentPending) {
    await sendMessage(
      env,
      chatId,
      "⏳ <b>صبر کن تا بقیه هم شرکت کنن</b>\n\n" +
        "این رتبه‌بندی فعلاً موقتیه و فقط بین کسانیه که تا این لحظه آزمون دادن. " +
        "رتبه‌ی نهایی و قطعی‌ات بعد از پایان مسابقه همین‌جا برات ارسال میشه. 🏁",
      { parse_mode: "HTML" }
    );
  }

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
  const rows: InlineKeyboardButton[][] = [];
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
