import { Env } from "../../types";
import { sendMessage, editMessageText, answerCallbackQuery } from "../telegram-api";
import { CB_PREFIX } from "../../config/constants";
import { getOrCreateUser } from "../../db/users";
import {
  getQuizLinkByToken, getQuizById, getQuizQuestions,
  createAttempt, getAttemptByQuizAndUser,
  getAttempt, finishAttempt, saveAnswer, updateCurrentQuestionIndex,
  getAnswerForQuestion, getInProgressAttemptsCount,
  getLeaderboardWithNegative, getLeaderboardWithoutNegative,
  getUserRankWithNegative, getUserRankWithoutNegative,
  getFinishedAttemptsWithChatId,
} from "../../db/custom_quizzes";

interface QuizUserState {
  attemptId: number;
  quizId: number;
  currentIndex: number;
}
const quizUserStates = new Map<number, QuizUserState>();

function formatTime(d: Date): string {
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

export async function handleQuizStart(env: Env, user: any, chatId: number, token: string): Promise<void> {
  quizUserStates.delete(user.id);

  const link = await getQuizLinkByToken(env, token);
  if (!link) { await sendMessage(env, chatId, "❌ لینک نامعتبر."); return; }
  if (link.expires_at && new Date(link.expires_at) < new Date()) { await sendMessage(env, chatId, "⏳ لینک منقضی شده."); return; }
  const quiz = await getQuizById(env, link.quiz_id);
  if (!quiz) { await sendMessage(env, chatId, "❌ آزمون یافت نشد."); return; }
  if (quiz.status !== 'active' && quiz.status !== 'published') { await sendMessage(env, chatId, "⚠️ این آزمون هنوز فعال نشده یا تمام شده."); return; }
  const questions = await getQuizQuestions(env, quiz.id);
  if (!questions.length) { await sendMessage(env, chatId, "⚠️ آزمون هنوز سوالی ندارد."); return; }

  const existing = await getAttemptByQuizAndUser(env, quiz.id, user.id);
  if (existing && existing.status === 'in_progress') {
    const resumeIndex = existing.current_question_index || 1;
    quizUserStates.set(user.id, { attemptId: existing.id, quizId: quiz.id, currentIndex: resumeIndex });
    const endTime = new Date(new Date(existing.started_at).getTime() + quiz.total_time_minutes * 60 * 1000);
    await sendMessage(env, chatId, `⏱️ <b>ادامه آزمون</b>\n🕐 پایان: ${formatTime(endTime)}`, { parse_mode: "HTML" });
    await sendQuizQuestion(env, chatId, user.id, quiz.id, existing.id, resumeIndex);
    return;
  }
  if (existing && existing.status !== 'in_progress') {
    const remaining = await getInProgressAttemptsCount(env, quiz.id);
    if (remaining > 0) {
      await sendMessage(env, chatId, `⏳ آزمون <b>${quiz.title}</b> هنوز در حال برگزاری است.\nلطفاً تا اتمام زمان آزمون یا پایان شرکت همه شرکت‌کنندگان صبر کنید. نتایج پس از آن ارسال خواهد شد.`, { parse_mode: "HTML" });
    } else {
      await sendMessage(env, chatId, `✅ شما قبلاً آزمون <b>${quiz.title}</b> را داده‌اید. نتایج:`, { parse_mode: "HTML" });
      await sendResults(env, chatId, user.id, quiz.id, existing.id);
    }
    return;
  }

  const attemptId = await createAttempt(env, quiz.id, user.id, chatId);
  quizUserStates.set(user.id, { attemptId, quizId: quiz.id, currentIndex: 1 });
  const endTime = new Date(Date.now() + quiz.total_time_minutes * 60 * 1000);
  await sendMessage(env, chatId, `⏱️ <b>زمان آزمون:</b> ${quiz.total_time_minutes} دقیقه\n🕐 <b>پایان:</b> ${formatTime(endTime)}`, { parse_mode: "HTML" });
  await sendQuizQuestion(env, chatId, user.id, quiz.id, attemptId, 1);
}

function isQuizExpired(attempt: any, quiz: any): boolean {
  const started = new Date(attempt.started_at).getTime();
  const limitMs = quiz.total_time_minutes * 60 * 1000;
  return Date.now() > started + limitMs;
}

async function sendQuizQuestion(
  env: Env,
  chatId: number,
  userId: number,
  quizId: number,
  attemptId: number,
  questionIndex: number,
  messageId?: number
): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  const quiz = await getQuizById(env, quizId);
  if (!attempt || !quiz) {
    await sendMessage(env, chatId, "⚠️ آزمون یافت نشد.");
    return;
  }
  if (attempt.status !== 'in_progress') {
    await sendMessage(env, chatId, "⚠️ این آزمون قبلاً تمام شده. برای دیدن نتایج، لینک را دوباره باز کنید.");
    return;
  }
  if (isQuizExpired(attempt, quiz)) {
    await autoFinish(env, chatId, userId, attemptId);
    return;
  }

  const questions = await getQuizQuestions(env, quizId);
  const q = questions[questionIndex - 1];
  if (!q) return;
  const ans = await getAnswerForQuestion(env, attemptId, q.id);
  const chosen = ans?.chosen_option;

  const remainingMs = new Date(attempt.started_at).getTime() + quiz.total_time_minutes * 60 * 1000 - Date.now();
  const remMins = Math.max(0, Math.floor(remainingMs / 60000));
  const remSecs = Math.max(0, Math.floor((remainingMs % 60000) / 1000));

  const text = `❓ <b>سوال ${questionIndex} از ${questions.length}</b>\n\n${q.question_text}\n\n1️⃣ ${q.option_a}\n2️⃣ ${q.option_b}\n3️⃣ ${q.option_c}\n4️⃣ ${q.option_d}\n\n⏱️ ${remMins}:${remSecs.toString().padStart(2, '0')}`;
  const rows: any[] = [];
  const opts = ['1', '2', '3', '4'].map(opt => ({
    text: chosen === opt ? `✅ ${opt}` : opt,
    callback_data: `${CB_PREFIX.QUIZ}:ans:${attemptId}:${q.id}:${opt}`
  }));
  rows.push(opts);

  const navRow: any[] = [];
  if (questionIndex > 1) navRow.push({ text: "◀️ قبلی", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex - 1}` });
  if (questionIndex < questions.length) navRow.push({ text: "بعدی ▶️", callback_data: `${CB_PREFIX.QUIZ}:nav:${attemptId}:${questionIndex + 1}` });
  if (navRow.length) rows.push(navRow);

  rows.push([
    { text: "❌ نزده", callback_data: `${CB_PREFIX.QUIZ}:unans:${attemptId}:${q.id}` },
    { text: "🏁 پایان آزمون", callback_data: `${CB_PREFIX.QUIZ}:finish:${attemptId}` }
  ]);

  if (messageId) {
    await editMessageText(env, chatId, messageId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
  } else {
    await sendMessage(env, chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
  }
}

async function autoFinish(env: Env, chatId: number, userId: number, attemptId: number): Promise<void> {
  const attempt = await getAttempt(env, attemptId);
  if (!attempt) return;
  if (attempt.status === 'auto_ended' || attempt.status === 'finished') {
    await sendMessage(env, chatId, "⏰ زمان آزمون قبلاً تمام شده. برای دیدن نتایج، لینک را دوباره باز کنید.");
    return;
  }
  await finishAttempt(env, attemptId, 'auto_ended');
  quizUserStates.delete(userId);
  const remaining = await getInProgressAttemptsCount(env, attempt.quiz_id);
  if (remaining > 0) {
    await sendMessage(env, chatId, "⏰ <b>زمان آزمون تمام شد!</b>\n\n⏳ لطفاً صبر کنید. نتایج پس از اتمام آزمون برای همه شرکت‌کنندگان ارسال خواهد شد.", { parse_mode: "HTML" });
  } else {
    await sendMessage(env, chatId, "⏰ <b>زمان آزمون تمام شد!</b>\n\n🎉 همه شرکت‌کنندگان پاسخ دادند! نتایج:", { parse_mode: "HTML" });
    await sendResults(env, chatId, userId, attempt.quiz_id, attemptId);
    await pushResultsToAllFinishedParticipants(env, attempt.quiz_id, userId);
  }
}

async function pushResultsToAllFinishedParticipants(env: Env, quizId: number, excludeUserId: number): Promise<void> {
  const finishedAttempts = await getFinishedAttemptsWithChatId(env, quizId);
  for (const a of finishedAttempts) {
    if (a.user_id === excludeUserId) continue;
    try {
      await sendMessage(env, a.chat_id, "🎉 همه شرکت‌کنندگان پاسخ دادند! نتایج:", { parse_mode: "HTML" });
      await sendResults(env, a.chat_id, a.user_id, quizId, a.id);
    } catch (_) {}
  }
}

export async function handleQuizUserCallback(env: Env, callbackQuery: any): Promise<void> {
  const data = callbackQuery.data || "";
  const parts = data.split(":");
  const action = parts[1] || "";
  const attemptId = parts[2] ? parseInt(parts[2]) : 0;
  const id = parts[3] ? parseInt(parts[3]) : 0;
  const extra = parts[4] || "";

  const msg = callbackQuery.message;
  if (!msg) { await answerCallbackQuery(env, callbackQuery.id); return; }
  const chatId = msg.chat.id;
  const user = await getOrCreateUser(env, callbackQuery.from);
  const messageId = msg.message_id;
  await answerCallbackQuery(env, callbackQuery.id);

  // Handle explain — no active state required
  if (action === "explain") {
    const attemptRecord = await getAttempt(env, attemptId);
    const quizId = attemptRecord?.quiz_id;
    if (!quizId) { await sendMessage(env, chatId, "⚠️ آزمون یافت نشد."); return; }
    const q = await getQuizQuestions(env, quizId);
    const question = q.find(qx => qx.id === id);
    if (!question) return;
    const explainText =
      `❓ <b>${question.question_text}</b>\n\n` +
      `1️⃣ ${question.option_a}\n2️⃣ ${question.option_b}\n3️⃣ ${question.option_c}\n4️⃣ ${question.option_d}\n\n` +
      `✅ <b>گزینه درست:</b> ${question.correct_option}\n` +
      `📖 <b>پاسخنامه:</b> ${question.explanation || 'ندارد'}`;
    const backKeyboard = { inline_keyboard: [[{ text: "◀️ بازگشت به پاسخنامه", callback_data: `${CB_PREFIX.QUIZ}:return_results:${attemptId}` }]] };
    if (messageId) {
      await editMessageText(env, chatId, messageId, explainText, { parse_mode: "HTML", reply_markup: backKeyboard });
    } else {
      await sendMessage(env, chatId, explainText, { parse_mode: "HTML", reply_markup: backKeyboard });
    }
    return;
  }

  // Handle back to explain list — no active state required
  if (action === "return_results") {
    const attemptRecord = await getAttempt(env, attemptId);
    if (!attemptRecord) { await sendMessage(env, chatId, "⚠️ آزمون یافت نشد."); return; }
    const qs = await getQuizQuestions(env, attemptRecord.quiz_id);
    const rows: any[] = [];
    for (let i = 0; i < qs.length; i += 5) {
      rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:explain:${attemptId}:${q.id}` })));
    }
    if (messageId) {
      await editMessageText(env, chatId, messageId, "📖 برای دیدن پاسخنامه تشریحی، روی شماره سوال بزن:", { reply_markup: { inline_keyboard: rows } });
    } else {
      await sendMessage(env, chatId, "📖 برای دیدن پاسخنامه تشریحی، روی شماره سوال بزن:", { reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  // For all other actions, get or recover state from DB on Worker restart
  let state = quizUserStates.get(user.id);
  if (!state || state.attemptId !== attemptId) {
    const recoveredAttempt = await getAttempt(env, attemptId);
    if (!recoveredAttempt) { await sendMessage(env, chatId, "⚠️ آزمون یافت نشد."); return; }
    if (recoveredAttempt.status === 'finished' || recoveredAttempt.status === 'auto_ended') {
      await sendMessage(env, chatId, "✅ آزمون شما قبلاً ثبت شده است. برای دیدن نتایج، لینک آزمون را دوباره باز کنید.");
      return;
    }
    if (recoveredAttempt.status === 'in_progress') {
      state = { attemptId, quizId: recoveredAttempt.quiz_id, currentIndex: recoveredAttempt.current_question_index || 1 };
      quizUserStates.set(user.id, state);
    } else {
      await sendMessage(env, chatId, "⚠️ سشن آزمون نامعتبر است.");
      return;
    }
  }

  // Check expiry on every interaction
  const attempt = await getAttempt(env, attemptId);
  const quiz = await getQuizById(env, state.quizId);
  if (attempt && quiz && isQuizExpired(attempt, quiz)) {
    await autoFinish(env, chatId, user.id, attemptId);
    return;
  }

  if (action === "ans") {
    await saveAnswer(env, attemptId, id, extra);
    const questions = await getQuizQuestions(env, state.quizId);
    const nextIndex = state.currentIndex < questions.length ? state.currentIndex + 1 : state.currentIndex;
    if (nextIndex !== state.currentIndex) {
      await updateCurrentQuestionIndex(env, attemptId, nextIndex);
      quizUserStates.set(user.id, { ...state, currentIndex: nextIndex });
    }
    await sendQuizQuestion(env, chatId, user.id, state.quizId, attemptId, nextIndex, messageId);
    return;
  }

  if (action === "unans") {
    await saveAnswer(env, attemptId, id, null);
    await sendQuizQuestion(env, chatId, user.id, state.quizId, attemptId, state.currentIndex, messageId);
    return;
  }

  if (action === "nav") {
    const idx = id;
    await updateCurrentQuestionIndex(env, attemptId, idx);
    quizUserStates.set(user.id, { ...state, currentIndex: idx });
    await sendQuizQuestion(env, chatId, user.id, state.quizId, attemptId, idx, messageId);
    return;
  }

  if (action === "finish") {
    await editMessageText(env, chatId, messageId, "🏁 آیا مطمئن هستی می‌خوای آزمون رو تموم کنی؟", {
      reply_markup: { inline_keyboard: [[{ text: "✅ بله، پایان", callback_data: `${CB_PREFIX.QUIZ}:confirm_finish:${attemptId}` }, { text: "❌ خیر، ادامه", callback_data: `${CB_PREFIX.QUIZ}:cancel:${attemptId}` }]] }
    });
    return;
  }

  if (action === "confirm_finish") {
    const currentAttempt = await getAttempt(env, attemptId);
    if (!currentAttempt) { await sendMessage(env, chatId, "⚠️ آزمون یافت نشد."); return; }
    if (currentAttempt.status === 'finished' || currentAttempt.status === 'auto_ended') {
      await editMessageText(env, chatId, messageId, "✅ آزمون شما قبلاً ثبت شده است. برای دیدن نتایج، لینک آزمون را دوباره باز کنید.", { reply_markup: { inline_keyboard: [] } });
      return;
    }
    await finishAttempt(env, attemptId, 'finished');
    quizUserStates.delete(user.id);
    const remaining = await getInProgressAttemptsCount(env, state.quizId);
    if (remaining > 0) {
      await editMessageText(env, chatId, messageId, "✅ آزمون شما ثبت شد.\n\n⏳ لطفاً تا پایان زمان آزمون یا اتمام شرکت همه شرکت‌کنندگان صبر کنید. نتایج پس از آن ارسال خواهد شد.", { reply_markup: { inline_keyboard: [] } });
    } else {
      await editMessageText(env, chatId, messageId, "✅ آزمون شما ثبت شد.\n\n🎉 همه شرکت‌کنندگان پاسخ دادند! نتایج:", { reply_markup: { inline_keyboard: [] } });
      await sendResults(env, chatId, user.id, state.quizId, attemptId);
      await pushResultsToAllFinishedParticipants(env, state.quizId, user.id);
    }
    return;
  }

  if (action === "cancel") {
    await sendQuizQuestion(env, chatId, user.id, state.quizId, attemptId, state.currentIndex, messageId);
    return;
  }
}

async function sendResults(env: Env, chatId: number, userId: number, quizId: number, attemptId: number): Promise<void> {
  const lbNeg = await getLeaderboardWithNegative(env, quizId, 50);
  const userRankNeg = await getUserRankWithNegative(env, quizId, userId);
  let negText = `📊 <b>لیدربورد آزمون (با نمره منفی)</b>\n\n`;
  if (!lbNeg.length) { negText += "🙈 هنوز کسی امتیازی ندارد.\n"; }
  else {
    for (const e of lbNeg) {
      negText += `${e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : `${e.rank}.`} <b>${e.display_name}</b> — ${e.percentage}% — ✅${e.correct} ❌${e.wrong} ⬜${e.unanswered}\n`;
    }
  }
  if (userRankNeg) {
    const inTop = lbNeg.some(e => e.user_id === userId);
    if (!inTop) negText += `\n📍 <b>شما:</b> رتبه ${userRankNeg.rank} — ${userRankNeg.percentage}% — ✅${userRankNeg.correct} ❌${userRankNeg.wrong} ⬜${userRankNeg.unanswered}`;
  }
  await sendMessage(env, chatId, negText, { parse_mode: "HTML" });

  const lbPos = await getLeaderboardWithoutNegative(env, quizId, 50);
  const userRankPos = await getUserRankWithoutNegative(env, quizId, userId);
  let posText = `📊 <b>لیدربورد آزمون (بدون نمره منفی)</b>\n\n`;
  if (!lbPos.length) { posText += "🙈 هنوز کسی امتیازی ندارد.\n"; }
  else {
    for (const e of lbPos) {
      posText += `${e.rank <= 3 ? ['🥇', '🥈', '🥉'][e.rank - 1] : `${e.rank}.`} <b>${e.display_name}</b> — ${e.percentage}% — ✅${e.correct}\n`;
    }
  }
  if (userRankPos) {
    const inTop2 = lbPos.some(e => e.user_id === userId);
    if (!inTop2) posText += `\n📍 <b>شما:</b> رتبه ${userRankPos.rank} — ${userRankPos.percentage}% — ✅${userRankPos.correct}`;
  }
  await sendMessage(env, chatId, posText, { parse_mode: "HTML" });

  const qs = await getQuizQuestions(env, quizId);
  const rows: any[] = [];
  for (let i = 0; i < qs.length; i += 5) {
    rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:explain:${attemptId}:${q.id}` })));
  }
  await sendMessage(env, chatId, "📖 برای دیدن پاسخنامه تشریحی، روی شماره سوال بزن:", { reply_markup: { inline_keyboard: rows } });
}
