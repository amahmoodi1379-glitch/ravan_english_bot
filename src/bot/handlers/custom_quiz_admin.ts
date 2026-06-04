import { Env } from "../../types";
import { TelegramUpdate } from "../router";
import { sendMessage, answerCallbackQuery, getBotUsername } from "../telegram-api";
import { getAdminSubMenuKeyboard, ADMIN_SUBMENU_BUTTON_BACK } from "../keyboards";
import { CB_PREFIX } from "../../config/constants";
import { getAdminByTelegramId } from "../../db/admin";
import {
  createQuiz, updateQuizTime, setQuizStatus, getQuizById,
  getDraftQuizzesByAdmin, addQuizQuestion, updateQuizQuestion,
  getQuizQuestions, getQuizQuestionById, getQuestionCount, createQuizLink,
} from "../../db/custom_quizzes";

interface QAState {
  action: string;
  quizId?: number;
  questionId?: number;
  questionText?: string;
  options?: string[];
  correctOption?: string;
}
const qaStates = new Map<number, QAState>();

function genToken(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 12; i++) r += c.charAt(Math.floor(Math.random() * c.length));
  return r;
}

export async function enterQuizAdminMenu(env: Env, chatId: number, tgId: number): Promise<void> {
  qaStates.set(tgId, { action: 'quiz_menu' });
  await sendMessage(env, chatId, `📝 <b>مدیریت آزمون‌ها</b>\n\nیکی از گزینه‌ها رو انتخاب کن:`, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([["➕ ساخت آزمون جدید"], ["📋 لیست آزمون‌های آماده"], [ADMIN_SUBMENU_BUTTON_BACK]])
  });
}

export async function handleQuizAdminMessage(env: Env, update: TelegramUpdate): Promise<boolean> {
  const msg = update.message; if (!msg || !msg.from) return false;
  const chatId = msg.chat.id; const tgId = msg.from.id; const text = msg.text || "";
  const s = qaStates.get(tgId); if (!s) return false;

  switch (s.action) {
    case 'quiz_menu':
      if (text === "➕ ساخت آزمون جدید") {
        qaStates.set(tgId, { action: 'quiz_await_title' });
        await sendMessage(env, chatId, "📝 عنوان آزمون را وارد کن:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      if (text === "📋 لیست آزمون‌های آماده") {
        qaStates.set(tgId, { action: 'quiz_list_ready' });
        await showReadyQuizzes(env, chatId, tgId); return true;
      }
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.delete(tgId); return false; }
      await sendMessage(env, chatId, "⚠️ لطفاً یکی از گزینه‌ها را انتخاب کن."); return true;

    case 'quiz_await_title':
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.delete(tgId); return false; }
      if (!text.trim()) { await sendMessage(env, chatId, "⚠️ عنوان آزمون را وارد کن:"); return true; }
      const adm = await getAdminByTelegramId(env, tgId); if (!adm) return false;
      const qid = await createQuiz(env, adm.id, text.trim(), 30);
      qaStates.set(tgId, { action: 'quiz_await_time', quizId: qid });
      await sendMessage(env, chatId, `✅ آزمون ساخته شد.\n⏱️ تایم کلی (دقیقه):`);
      return true;

    case 'quiz_await_time': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_await_title' }); await sendMessage(env, chatId, "عنوان:"); return true; }
      const m = parseInt(text); if (isNaN(m) || m < 1 || m > 300) { await sendMessage(env, chatId, "⚠️ عدد ۱ تا ۳۰۰:"); return true; }
      await updateQuizTime(env, s.quizId!, m);
      qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId });
      await sendMessage(env, chatId, `⏱️ ${m} دقیقه.\n❓ متن سوال ۱:`); return true;
    }

    case 'quiz_await_question_text':
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_await_time', quizId: s.quizId }); await sendMessage(env, chatId, "⏱️ تایم:"); return true; }
      if (!text.trim()) { await sendMessage(env, chatId, "⚠️ متن سوال:"); return true; }
      qaStates.set(tgId, { action: 'quiz_await_options', quizId: s.quizId, questionText: text.trim() });
      await sendMessage(env, chatId, `گزینه‌ها در ۴ خط وارد کن:\nA) ...\nB) ...\nC) ...\nD) ...`); return true;

    case 'quiz_await_options': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId }); await sendMessage(env, chatId, "متن سوال:"); return true; }
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length < 4) { await sendMessage(env, chatId, "⚠️ حداقل ۴ خط:"); return true; }
      const opts = lines.slice(0, 4).map(l => l.replace(/^[A-Da-d][\.\)\-]\s*/, '').trim());
      qaStates.set(tgId, { action: 'quiz_await_correct', quizId: s.quizId, questionText: s.questionText, options: opts });
      await sendMessage(env, chatId, `1) ${opts[0]}\n2) ${opts[1]}\n3) ${opts[2]}\n4) ${opts[3]}\n\nشماره درست (۱-۴):`); return true;
    }

    case 'quiz_await_correct': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_await_options', quizId: s.quizId, questionText: s.questionText }); await sendMessage(env, chatId, "گزینه‌ها:"); return true; }
      const c = text.trim(); if (!['1','2','3','4'].includes(c)) { await sendMessage(env, chatId, "⚠️ ۱ تا ۴:"); return true; }
      qaStates.set(tgId, { action: 'quiz_await_explanation', quizId: s.quizId, questionText: s.questionText, options: s.options, correctOption: c });
      await sendMessage(env, chatId, `✅ گزینه ${c}.\n📖 پاسخنامه تشریحی (اختیاری):`, { reply_markup: getAdminSubMenuKeyboard([["⏭️ رد شدن"], [ADMIN_SUBMENU_BUTTON_BACK]]) });
      return true;
    }

    case 'quiz_await_explanation': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_await_correct', quizId: s.quizId, questionText: s.questionText, options: s.options }); await sendMessage(env, chatId, "گزینه درست:"); return true; }
      const exp = text === "⏭️ رد شدن" ? undefined : text.trim() || undefined;
      const st = qaStates.get(tgId)!; const cnt = await getQuestionCount(env, st.quizId!);
      await addQuizQuestion(env, st.quizId!, cnt + 1, st.questionText!, st.options![0], st.options![1], st.options![2], st.options![3], st.correctOption!, exp);
      qaStates.set(tgId, { action: 'quiz_ask_next_or_finish', quizId: st.quizId });
      await sendMessage(env, chatId, `✅ سوال ${cnt + 1} ثبت شد. سوال بعدی؟`, { reply_markup: getAdminSubMenuKeyboard([["➕ سوال بعدی"], ["✅ تموم شد"]]) });
      return true;
    }

    case 'quiz_ask_next_or_finish':
      if (text === "➕ سوال بعدی") { qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId }); const c = await getQuestionCount(env, s.quizId!); await sendMessage(env, chatId, `❓ متن سوال ${c + 1}:`); return true; }
      if (text === "✅ تموم شد") { await setQuizStatus(env, s.quizId!, 'active'); qaStates.set(tgId, { action: 'quiz_list_ready' }); await showReadyQuizzes(env, chatId, tgId); return true; }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها:"); return true;

    case 'quiz_list_ready':
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_menu' }); await enterQuizAdminMenu(env, chatId, tgId); return true; }
      const idx = parseInt(text) - 1; const admin2 = await getAdminByTelegramId(env, tgId); if (!admin2) return false;
      const quizzes = await getDraftQuizzesByAdmin(env, admin2.id);
      if (isNaN(idx) || idx < 0 || idx >= quizzes.length) { await sendMessage(env, chatId, "⚠️ شماره نامعتبر."); return true; }
      qaStates.set(tgId, { action: 'quiz_view_detail', quizId: quizzes[idx].id });
      await showQuizDetail(env, chatId, quizzes[idx].id); return true;

    case 'quiz_view_detail':
      if (text === "🔗 دریافت لینک") { qaStates.set(tgId, { action: 'quiz_await_link_minutes', quizId: s.quizId }); await sendMessage(env, chatId, "⏳ لینک چند دقیقه معتبر باشه؟"); return true; }
      if (text === "📋 مشاهده سوالات") { await showQuestionsInline(env, chatId, s.quizId!); return true; }
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_list_ready' }); await showReadyQuizzes(env, chatId, tgId); return true; }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها:"); return true;

    case 'quiz_await_link_minutes': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId }); await showQuizDetail(env, chatId, s.quizId!); return true; }
      const lm = parseInt(text); if (isNaN(lm) || lm < 1 || lm > 10080) { await sendMessage(env, chatId, "⚠️ ۱ تا ۱۰۰۸۰:"); return true; }
      const token = genToken(); const expires = new Date(Date.now() + lm * 60 * 1000).toISOString();
      await createQuizLink(env, s.quizId!, token, expires); qaStates.delete(tgId);
      const botUsername = await getBotUsername(env);
      const username = botUsername || 'your_bot';
      await sendMessage(env, chatId, `🔗 لینک:\nt.me/${username}?start=quiz_${token}\n⏳ ${lm} دقیقه`); return true;
    }

    case 'quiz_edit_question': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId }); await showQuizDetail(env, chatId, s.quizId!); return true; }
      if (text === "✏️ متن سوال") { qaStates.set(tgId, { action: 'quiz_await_edit_question_text', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "❓ متن جدید سوال:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ گزینه‌ها") { qaStates.set(tgId, { action: 'quiz_await_edit_options', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "گزینه‌های جدید در ۴ خط:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ گزینه درست") { qaStates.set(tgId, { action: 'quiz_await_edit_correct', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "شماره درست (۱-۴):", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ پاسخنامه") { qaStates.set(tgId, { action: 'quiz_await_edit_explanation', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "📖 پاسخنامه جدید:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها:"); return true;
    }

    default: return false;
  }
}

async function showReadyQuizzes(env: Env, chatId: number, tgId: number): Promise<void> {
  const admin = await getAdminByTelegramId(env, tgId); if (!admin) return;
  const quizzes = await getDraftQuizzesByAdmin(env, admin.id);
  if (!quizzes.length) { await sendMessage(env, chatId, "📋 هیچ آزمونی. شروع کن:", { reply_markup: getAdminSubMenuKeyboard([["➕ ساخت آزمون"], [ADMIN_SUBMENU_BUTTON_BACK]]) }); return; }
  let msg = `📋 <b>آزمون‌ها (${quizzes.length})</b>\n\n`;
  for (let i = 0; i < quizzes.length; i++) { const q = quizzes[i]; const cnt = await getQuestionCount(env, q.id); msg += `${i+1}. <b>${q.title}</b> — ${cnt} سوال — ⏱️ ${q.total_time_minutes} دقیقه\n`; }
  msg += `\nشماره آزمون را وارد کن:`;
  await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
}

async function showQuizDetail(env: Env, chatId: number, quizId: number): Promise<void> {
  const q = await getQuizById(env, quizId); if (!q) return;
  const cnt = await getQuestionCount(env, quizId);
  await sendMessage(env, chatId, `📝 <b>${q.title}</b>\n📊 ${cnt} سوال — ⏱️ ${q.total_time_minutes} دقیقه`, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([["🔗 دریافت لینک"], ["📋 مشاهده سوالات"], [ADMIN_SUBMENU_BUTTON_BACK]])
  });
}

async function showQuestionsInline(env: Env, chatId: number, quizId: number): Promise<void> {
  const qs = await getQuizQuestions(env, quizId); if (!qs.length) { await sendMessage(env, chatId, "⚠️ بدون سوال."); return; }
  const rows: any[] = [];
  for (let i = 0; i < qs.length; i += 5) rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:admin_view:${q.id}` })));
  rows.push([{ text: ADMIN_SUBMENU_BUTTON_BACK, callback_data: `${CB_PREFIX.QUIZ}:admin_detail_back:${quizId}` }]);
  await sendMessage(env, chatId, `📋 روی شماره بزن:`, { reply_markup: { inline_keyboard: rows } });
}

export async function handleQuizAdminCallback(env: Env, callbackQuery: any): Promise<void> {
  const data = callbackQuery.data || ""; const parts = data.split(":"); const action = parts[1] || ""; const id = parts[2] ? parseInt(parts[2]) : undefined;
  const msg = callbackQuery.message; if (!msg) { await answerCallbackQuery(env, callbackQuery.id); return; }
  const chatId = msg.chat.id; await answerCallbackQuery(env, callbackQuery.id);
  if (action === "admin_view" && id) {
    const q = await getQuizQuestionById(env, id); if (!q) return;
    await sendMessage(env, chatId, `❓ <b>${q.question_text}</b>\n\n1️⃣ ${q.option_a}\n2️⃣ ${q.option_b}\n3️⃣ ${q.option_c}\n4️⃣ ${q.option_d}\n\n✅ درست: ${q.correct_option}\n📖 ${q.explanation || 'بدون پاسخنامه'}`, { parse_mode: "HTML" });
  } else if (action === "admin_detail_back" && id) {
    await showQuizDetail(env, chatId, id);
  } else if (action === "admin_edit_select" && id) {
    const qs = await getQuizQuestions(env, id); if (!qs.length) return;
    const rows: any[] = [];
    for (let i = 0; i < qs.length; i += 5) rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:admin_edit_q:${q.id}` })));
    rows.push([{ text: ADMIN_SUBMENU_BUTTON_BACK, callback_data: `${CB_PREFIX.QUIZ}:admin_detail_back:${id}` }]);
    await sendMessage(env, chatId, "✏️ کدوم سوال رو می‌خوای ویرایش کنی؟", { reply_markup: { inline_keyboard: rows } });
  } else if (action === "admin_edit_q" && id) {
    const tgId = callbackQuery.from.id;
    const q = await getQuizQuestionById(env, id);
    qaStates.set(tgId, { action: 'quiz_edit_question', quizId: q?.quiz_id || id, questionId: id });
    await showEditQuestionOptions(env, chatId, id);
  }
}

async function showEditQuestionOptions(env: Env, chatId: number, questionId: number): Promise<void> {
  const q = await getQuizQuestionById(env, questionId); if (!q) return;
  await sendMessage(env, chatId,
    `✏️ <b>ویرایش سوال ${q.question_index}</b>\n\n❓ ${q.question_text}\n\n1️⃣ ${q.option_a}\n2️⃣ ${q.option_b}\n3️⃣ ${q.option_c}\n4️⃣ ${q.option_d}\n\n✅ درست: ${q.correct_option}\n📖 ${q.explanation || 'بدون پاسخنامه'}`,
    {
      parse_mode: "HTML",
      reply_markup: getAdminSubMenuKeyboard([
        ["✏️ متن سوال", "✏️ گزینه‌ها"],
        ["✏️ گزینه درست", "✏️ پاسخنامه"],
        [ADMIN_SUBMENU_BUTTON_BACK]
      ])
    }
  );
}

export async function isInQuizAdminState(tgId: number): Promise<boolean> {
  const s = qaStates.get(tgId);
  return !!s;
}
