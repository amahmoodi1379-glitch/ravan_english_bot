import { Env } from "../../types";
import { TelegramUpdate } from "../router";
import { sendMessage, answerCallbackQuery, getBotUsername } from "../telegram-api";
import { getAdminSubMenuKeyboard, ADMIN_SUBMENU_BUTTON_BACK } from "../keyboards";
import { CB_PREFIX } from "../../config/constants";
import { getAdminByTelegramId } from "../../db/admin";
import {
  createQuiz, updateQuizTitle, updateQuizTime, setQuizStatus, getQuizById,
  getActiveQuizzesByAdmin, getPublishedQuizzesByAdmin,
  deleteQuiz, addQuizQuestion, updateQuizQuestion,
  getQuizQuestions, getQuizQuestionById, getQuestionCount, createQuizLink,
  getParticipantCount, getLeaderboardWithNegative, getLatestQuizLink,
} from "../../db/custom_quizzes";

interface QAState {
  action: string;
  quizId?: number;
  questionId?: number;
  questionText?: string;
  options?: string[];
  correctOption?: string;
  fromAction?: string;
}
const qaStates = new Map<number, QAState>();

function genToken(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 12; i++) r += c.charAt(Math.floor(Math.random() * c.length));
  return r;
}

function normalizeDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (w) => String.fromCharCode(w.charCodeAt(0) - 1728))
    .replace(/[٠-٩]/g, (w) => String.fromCharCode(w.charCodeAt(0) - 1584));
}

export async function enterQuizAdminMenu(env: Env, chatId: number, tgId: number): Promise<void> {
  qaStates.set(tgId, { action: 'quiz_menu' });
  await sendMessage(env, chatId, `📝 <b>مدیریت آزمون‌ها</b>\n\nیکی از گزینه‌ها رو انتخاب کن:`, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([
      ["➕ ساخت آزمون جدید"],
      ["📋 لیست آزمون‌های آماده"],
      ["📊 نتایج آزمون‌ها"],
      [ADMIN_SUBMENU_BUTTON_BACK]
    ])
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
      if (text === "📊 نتایج آزمون‌ها") {
        qaStates.set(tgId, { action: 'quiz_results_list' });
        await showPublishedQuizzes(env, chatId, tgId); return true;
      }
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.delete(tgId); return false; }
      await sendMessage(env, chatId, "⚠️ لطفاً یکی از گزینه‌ها را انتخاب کن."); return true;

    case 'quiz_await_title': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.delete(tgId);
        return false;
      }
      if (!text.trim()) { await sendMessage(env, chatId, "⚠️ عنوان آزمون را وارد کن:"); return true; }
      const adm = await getAdminByTelegramId(env, tgId); if (!adm) return false;
      let qid: number;
      if (s.quizId) {
        await updateQuizTitle(env, s.quizId, text.trim());
        qid = s.quizId;
      } else {
        qid = await createQuiz(env, adm.id, text.trim(), 30);
      }
      qaStates.set(tgId, { action: 'quiz_await_time', quizId: qid });
      await sendMessage(env, chatId, `✅ عنوان ثبت شد.\n⏱️ تایم کلی آزمون (دقیقه):`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;
    }

    case 'quiz_await_time': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_await_title', quizId: s.quizId });
        await sendMessage(env, chatId, "📝 عنوان آزمون را وارد کن:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      const m = parseInt(normalizeDigits(text.trim()));
      if (isNaN(m) || m < 1 || m > 300) { await sendMessage(env, chatId, "⚠️ لطفاً یک عدد بین ۱ تا ۳۰۰ وارد کن:"); return true; }
      await updateQuizTime(env, s.quizId!, m);
      qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId });
      await sendMessage(env, chatId, `⏱️ ${m} دقیقه ثبت شد.\n\n❓ متن سوال ۱ را وارد کن:`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;
    }

    case 'quiz_await_question_text':
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_await_time', quizId: s.quizId });
        await sendMessage(env, chatId, "⏱️ تایم کلی آزمون (دقیقه):", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      if (!text.trim()) { await sendMessage(env, chatId, "⚠️ متن سوال را وارد کن:"); return true; }
      qaStates.set(tgId, { action: 'quiz_await_options', quizId: s.quizId, questionText: text.trim() });
      await sendMessage(env, chatId, `گزینه‌ها را در ۴ خط وارد کن:\nA) ...\nB) ...\nC) ...\nD) ...`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;

    case 'quiz_await_options': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId });
        await sendMessage(env, chatId, "❓ متن سوال را وارد کن:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      if (lines.length < 4) { await sendMessage(env, chatId, "⚠️ حداقل ۴ خط لازم است:"); return true; }
      const opts = lines.slice(0, 4).map(l => l.replace(/^[A-Da-d][\.\)\-]\s*/, '').trim());
      qaStates.set(tgId, { action: 'quiz_await_correct', quizId: s.quizId, questionText: s.questionText, options: opts });
      await sendMessage(env, chatId, `1) ${opts[0]}\n2) ${opts[1]}\n3) ${opts[2]}\n4) ${opts[3]}\n\nشماره گزینه درست را وارد کن (۱-۴):`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;
    }

    case 'quiz_await_correct': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_await_options', quizId: s.quizId, questionText: s.questionText });
        await sendMessage(env, chatId, "گزینه‌ها را وارد کن:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      const c = normalizeDigits(text.trim());
      if (!['1','2','3','4'].includes(c)) { await sendMessage(env, chatId, "⚠️ عدد ۱ تا ۴ وارد کن:"); return true; }
      qaStates.set(tgId, { action: 'quiz_await_explanation', quizId: s.quizId, questionText: s.questionText, options: s.options, correctOption: c });
      await sendMessage(env, chatId, `✅ گزینه ${c} به عنوان پاسخ درست ثبت شد.\n\n📖 پاسخنامه تشریحی را وارد کن (اختیاری):`, {
        reply_markup: getAdminSubMenuKeyboard([["⏭️ رد شدن"], [ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;
    }

    case 'quiz_await_explanation': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_await_correct', quizId: s.quizId, questionText: s.questionText, options: s.options });
        await sendMessage(env, chatId, "شماره گزینه درست (۱-۴):", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      const exp = text === "⏭️ رد شدن" ? undefined : text.trim() || undefined;
      const cnt = await getQuestionCount(env, s.quizId!);
      await addQuizQuestion(env, s.quizId!, cnt + 1, s.questionText!, s.options![0], s.options![1], s.options![2], s.options![3], s.correctOption!, exp);
      qaStates.set(tgId, { action: 'quiz_ask_next_or_finish', quizId: s.quizId });
      await sendMessage(env, chatId, `✅ سوال ${cnt + 1} ثبت شد.\n\nسوال بعدی اضافه می‌کنی یا آزمون آماده است؟`, {
        reply_markup: getAdminSubMenuKeyboard([["➕ سوال بعدی"], ["✅ تموم شد"]])
      });
      return true;
    }

    case 'quiz_ask_next_or_finish':
      if (text === "➕ سوال بعدی") {
        qaStates.set(tgId, { action: 'quiz_await_question_text', quizId: s.quizId });
        const c = await getQuestionCount(env, s.quizId!);
        await sendMessage(env, chatId, `❓ متن سوال ${c + 1} را وارد کن:`, { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      if (text === "✅ تموم شد") {
        const cnt = await getQuestionCount(env, s.quizId!);
        if (cnt === 0) { await sendMessage(env, chatId, "⚠️ آزمون باید حداقل ۱ سوال داشته باشد."); return true; }
        await setQuizStatus(env, s.quizId!, 'active');
        qaStates.set(tgId, { action: 'quiz_list_ready' });
        await showReadyQuizzes(env, chatId, tgId);
        return true;
      }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;

    case 'quiz_list_ready': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_menu' }); await enterQuizAdminMenu(env, chatId, tgId); return true; }
      if (text === "➕ ساخت آزمون جدید") {
        qaStates.set(tgId, { action: 'quiz_await_title' });
        await sendMessage(env, chatId, "📝 عنوان آزمون را وارد کن:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      const admin2 = await getAdminByTelegramId(env, tgId); if (!admin2) return false;
      const quizzes = await getActiveQuizzesByAdmin(env, admin2.id);
      const idx = parseInt(normalizeDigits(text.trim())) - 1;
      if (isNaN(idx) || idx < 0 || idx >= quizzes.length) { await sendMessage(env, chatId, "⚠️ شماره نامعتبر است. یک عدد از لیست وارد کن."); return true; }
      qaStates.set(tgId, { action: 'quiz_view_detail', quizId: quizzes[idx].id });
      await showQuizDetail(env, chatId, quizzes[idx].id);
      return true;
    }

    case 'quiz_view_detail': {
      if (text === "🔗 دریافت لینک") {
        qaStates.set(tgId, { action: 'quiz_await_link_confirm', quizId: s.quizId });
        await sendMessage(env, chatId, "⚠️ بعد از گرفتن لینک، آزمون از لیست آماده حذف می‌شود و به منتشرشده منتقل می‌شود.\nادامه می‌دهید؟", {
          reply_markup: getAdminSubMenuKeyboard([["✅ بله، ادامه"], [ADMIN_SUBMENU_BUTTON_BACK]])
        });
        return true;
      }
      if (text === "📋 مشاهده سوالات") { await showQuestionsInline(env, chatId, s.quizId!); return true; }
      if (text === "🗑 حذف آزمون") {
        qaStates.set(tgId, { action: 'quiz_delete_confirm', quizId: s.quizId, fromAction: 'quiz_view_detail' });
        await sendMessage(env, chatId, "⚠️ آیا مطمئنی می‌خوای این آزمون را حذف کنی؟\nاین عمل برگشت‌پذیر نیست.", {
          reply_markup: getAdminSubMenuKeyboard([["🗑 بله، حذف کن"], [ADMIN_SUBMENU_BUTTON_BACK]])
        });
        return true;
      }
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_list_ready' }); await showReadyQuizzes(env, chatId, tgId); return true; }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_delete_confirm': {
      if (text === "🗑 بله، حذف کن") {
        await deleteQuiz(env, s.quizId!);
        await sendMessage(env, chatId, "✅ آزمون با موفقیت حذف شد.");
        if (s.fromAction === 'quiz_results_view') {
          qaStates.set(tgId, { action: 'quiz_results_list' });
          await showPublishedQuizzes(env, chatId, tgId);
        } else {
          qaStates.set(tgId, { action: 'quiz_list_ready' });
          await showReadyQuizzes(env, chatId, tgId);
        }
        return true;
      }
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        if (s.fromAction === 'quiz_results_view') {
          qaStates.set(tgId, { action: 'quiz_results_view', quizId: s.quizId });
          await showQuizLeaderboardAdmin(env, chatId, s.quizId!);
        } else {
          qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId });
          await showQuizDetail(env, chatId, s.quizId!);
        }
        return true;
      }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_await_link_confirm': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId }); await showQuizDetail(env, chatId, s.quizId!); return true; }
      if (text === "✅ بله، ادامه") {
        qaStates.set(tgId, { action: 'quiz_await_link_minutes', quizId: s.quizId });
        await sendMessage(env, chatId, "⏳ لینک چند دقیقه معتبر باشه؟", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) });
        return true;
      }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_await_link_minutes': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId }); await showQuizDetail(env, chatId, s.quizId!); return true; }
      const lm = parseInt(normalizeDigits(text.trim()));
      if (isNaN(lm) || lm < 1 || lm > 10080) { await sendMessage(env, chatId, "⚠️ عدد ۱ تا ۱۰۰۸۰ وارد کن:"); return true; }
      const token = genToken();
      const expires = new Date(Date.now() + lm * 60 * 1000).toISOString();
      await createQuizLink(env, s.quizId!, token, expires);
      await setQuizStatus(env, s.quizId!, 'published');
      const botUsername = await getBotUsername(env);
      const username = botUsername || 'your_bot';
      await sendMessage(env, chatId,
        `✅ <b>لینک آزمون:</b>\n<code>https://t.me/${username}?start=quiz_${token}</code>\n\n⏳ اعتبار: ${lm} دقیقه\n\nلینک را برای شرکت‌کنندگان ارسال کن.`,
        { parse_mode: "HTML" }
      );
      await enterQuizAdminMenu(env, chatId, tgId);
      return true;
    }

    case 'quiz_results_list': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_menu' }); await enterQuizAdminMenu(env, chatId, tgId); return true; }
      const admin3 = await getAdminByTelegramId(env, tgId); if (!admin3) return false;
      const pubQuizzes = await getPublishedQuizzesByAdmin(env, admin3.id);
      const pidx = parseInt(normalizeDigits(text.trim())) - 1;
      if (isNaN(pidx) || pidx < 0 || pidx >= pubQuizzes.length) { await sendMessage(env, chatId, "⚠️ شماره نامعتبر است."); return true; }
      qaStates.set(tgId, { action: 'quiz_results_view', quizId: pubQuizzes[pidx].id });
      await showQuizLeaderboardAdmin(env, chatId, pubQuizzes[pidx].id);
      return true;
    }

    case 'quiz_results_view': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_results_list' });
        await showPublishedQuizzes(env, chatId, tgId);
        return true;
      }
      if (text === "🔗 مشاهده لینک") {
        const linkRow = await getLatestQuizLink(env, s.quizId!);
        const botUsername = await getBotUsername(env);
        const username = botUsername || 'your_bot';
        if (linkRow) {
          const expiredAt = linkRow.expires_at ? new Date(linkRow.expires_at) : null;
          const now = new Date();
          const isExpired = expiredAt ? expiredAt <= now : false;
          const expInfo = expiredAt
            ? (isExpired ? `❌ منقضی‌شده (${expiredAt.toISOString().slice(0,16).replace('T',' ')})` : `✅ تا ${expiredAt.toISOString().slice(0,16).replace('T',' ')} UTC`)
            : "⏳ بدون انقضا";
          await sendMessage(env, chatId,
            `🔗 <b>لینک آزمون:</b>\n<code>https://t.me/${username}?start=quiz_${linkRow.link_token}</code>\n\n${expInfo}`,
            { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([["🔗 لینک جدید"], [ADMIN_SUBMENU_BUTTON_BACK]]) }
          );
        } else {
          await sendMessage(env, chatId, "⚠️ هیچ لینکی برای این آزمون وجود ندارد.", {
            reply_markup: getAdminSubMenuKeyboard([["🔗 لینک جدید"], [ADMIN_SUBMENU_BUTTON_BACK]])
          });
        }
        qaStates.set(tgId, { action: 'quiz_show_link', quizId: s.quizId });
        return true;
      }
      if (text === "🗑 حذف آزمون") {
        qaStates.set(tgId, { action: 'quiz_delete_confirm', quizId: s.quizId, fromAction: 'quiz_results_view' });
        await sendMessage(env, chatId, "⚠️ آیا مطمئنی می‌خوای این آزمون را حذف کنی؟\nاین عمل برگشت‌پذیر نیست.", {
          reply_markup: getAdminSubMenuKeyboard([["🗑 بله، حذف کن"], [ADMIN_SUBMENU_BUTTON_BACK]])
        });
        return true;
      }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_show_link': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_results_view', quizId: s.quizId });
        await showQuizLeaderboardAdmin(env, chatId, s.quizId!);
        return true;
      }
      if (text === "🔗 لینک جدید") {
        qaStates.set(tgId, { action: 'quiz_await_relink_minutes', quizId: s.quizId });
        await sendMessage(env, chatId, "⏳ لینک جدید چند دقیقه معتبر باشه؟", {
          reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
        });
        return true;
      }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_await_relink_minutes': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        qaStates.set(tgId, { action: 'quiz_show_link', quizId: s.quizId });
        const linkRow2 = await getLatestQuizLink(env, s.quizId!);
        const botUsername2 = await getBotUsername(env);
        const username2 = botUsername2 || 'your_bot';
        if (linkRow2) {
          const expiredAt2 = linkRow2.expires_at ? new Date(linkRow2.expires_at) : null;
          const now2 = new Date();
          const isExpired2 = expiredAt2 ? expiredAt2 <= now2 : false;
          const expInfo2 = expiredAt2
            ? (isExpired2 ? `❌ منقضی‌شده (${expiredAt2.toISOString().slice(0,16).replace('T',' ')})` : `✅ تا ${expiredAt2.toISOString().slice(0,16).replace('T',' ')} UTC`)
            : "⏳ بدون انقضا";
          await sendMessage(env, chatId,
            `🔗 <b>لینک آزمون:</b>\n<code>https://t.me/${username2}?start=quiz_${linkRow2.link_token}</code>\n\n${expInfo2}`,
            { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([["🔗 لینک جدید"], [ADMIN_SUBMENU_BUTTON_BACK]]) }
          );
        } else {
          await sendMessage(env, chatId, "⚠️ هیچ لینکی وجود ندارد.", {
            reply_markup: getAdminSubMenuKeyboard([["🔗 لینک جدید"], [ADMIN_SUBMENU_BUTTON_BACK]])
          });
        }
        return true;
      }
      const rlm = parseInt(normalizeDigits(text.trim()));
      if (isNaN(rlm) || rlm < 1 || rlm > 10080) { await sendMessage(env, chatId, "⚠️ عدد ۱ تا ۱۰۰۸۰ وارد کن:"); return true; }
      const rtoken = genToken();
      const rexpires = new Date(Date.now() + rlm * 60 * 1000).toISOString();
      await createQuizLink(env, s.quizId!, rtoken, rexpires);
      const botUsername3 = await getBotUsername(env);
      const username3 = botUsername3 || 'your_bot';
      await sendMessage(env, chatId,
        `✅ <b>لینک جدید آزمون:</b>\n<code>https://t.me/${username3}?start=quiz_${rtoken}</code>\n\n⏳ اعتبار: ${rlm} دقیقه`,
        { parse_mode: "HTML" }
      );
      qaStates.set(tgId, { action: 'quiz_results_view', quizId: s.quizId });
      await showQuizLeaderboardAdmin(env, chatId, s.quizId!);
      return true;
    }

    case 'quiz_edit_question': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_view_detail', quizId: s.quizId }); await showQuizDetail(env, chatId, s.quizId!); return true; }
      if (text === "✏️ متن سوال") { qaStates.set(tgId, { action: 'quiz_await_edit_question_text', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "❓ متن جدید سوال:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ گزینه‌ها") { qaStates.set(tgId, { action: 'quiz_await_edit_options', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "گزینه‌های جدید در ۴ خط:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ گزینه درست") { qaStates.set(tgId, { action: 'quiz_await_edit_correct', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "شماره درست (۱-۴):", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      if (text === "✏️ پاسخنامه") { qaStates.set(tgId, { action: 'quiz_await_edit_explanation', quizId: s.quizId, questionId: s.questionId }); await sendMessage(env, chatId, "📖 پاسخنامه جدید:", { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }); return true; }
      await sendMessage(env, chatId, "⚠️ یکی از دکمه‌ها را انتخاب کن."); return true;
    }

    case 'quiz_await_edit_question_text': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId }); await showEditQuestionOptions(env, chatId, s.questionId!); return true; }
      if (!text.trim()) { await sendMessage(env, chatId, "⚠️ متن سوال را وارد کن:"); return true; }
      const qEdit = await getQuizQuestionById(env, s.questionId!); if (!qEdit) return true;
      await updateQuizQuestion(env, s.questionId!, text.trim(), qEdit.option_a, qEdit.option_b, qEdit.option_c, qEdit.option_d, qEdit.correct_option, qEdit.explanation || undefined);
      qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId });
      await sendMessage(env, chatId, "✅ متن سوال ویرایش شد.");
      await showEditQuestionOptions(env, chatId, s.questionId!); return true;
    }

    case 'quiz_await_edit_options': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId }); await showEditQuestionOptions(env, chatId, s.questionId!); return true; }
      const editLines = text.split('\n').map(l => l.trim()).filter(l => l);
      if (editLines.length < 4) { await sendMessage(env, chatId, "⚠️ حداقل ۴ خط:"); return true; }
      const editOpts = editLines.slice(0, 4).map(l => l.replace(/^[A-Da-d][\.\)\-]\s*/, '').trim());
      const qEditOpts = await getQuizQuestionById(env, s.questionId!); if (!qEditOpts) return true;
      await updateQuizQuestion(env, s.questionId!, qEditOpts.question_text, editOpts[0], editOpts[1], editOpts[2], editOpts[3], qEditOpts.correct_option, qEditOpts.explanation || undefined);
      qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId });
      await sendMessage(env, chatId, "✅ گزینه‌ها ویرایش شدند.");
      await showEditQuestionOptions(env, chatId, s.questionId!); return true;
    }

    case 'quiz_await_edit_correct': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId }); await showEditQuestionOptions(env, chatId, s.questionId!); return true; }
      const editCorrect = normalizeDigits(text.trim());
      if (!['1','2','3','4'].includes(editCorrect)) { await sendMessage(env, chatId, "⚠️ ۱ تا ۴:"); return true; }
      const qEditCorrect = await getQuizQuestionById(env, s.questionId!); if (!qEditCorrect) return true;
      await updateQuizQuestion(env, s.questionId!, qEditCorrect.question_text, qEditCorrect.option_a, qEditCorrect.option_b, qEditCorrect.option_c, qEditCorrect.option_d, editCorrect, qEditCorrect.explanation || undefined);
      qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId });
      await sendMessage(env, chatId, `✅ گزینه ${editCorrect} به عنوان درست ثبت شد.`);
      await showEditQuestionOptions(env, chatId, s.questionId!); return true;
    }

    case 'quiz_await_edit_explanation': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) { qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId }); await showEditQuestionOptions(env, chatId, s.questionId!); return true; }
      const editExp = text.trim() || undefined;
      const qEditExp = await getQuizQuestionById(env, s.questionId!); if (!qEditExp) return true;
      await updateQuizQuestion(env, s.questionId!, qEditExp.question_text, qEditExp.option_a, qEditExp.option_b, qEditExp.option_c, qEditExp.option_d, qEditExp.correct_option, editExp);
      qaStates.set(tgId, { action: 'quiz_edit_question', quizId: s.quizId, questionId: s.questionId });
      await sendMessage(env, chatId, "✅ پاسخنامه تشریحی ویرایش شد.");
      await showEditQuestionOptions(env, chatId, s.questionId!); return true;
    }

    default: return false;
  }
}

async function showReadyQuizzes(env: Env, chatId: number, tgId: number): Promise<void> {
  const admin = await getAdminByTelegramId(env, tgId); if (!admin) return;
  const quizzes = await getActiveQuizzesByAdmin(env, admin.id);
  if (!quizzes.length) {
    await sendMessage(env, chatId, "📋 هیچ آزمون آماده‌ای وجود ندارد.\nیه آزمون جدید بساز:", {
      reply_markup: getAdminSubMenuKeyboard([["➕ ساخت آزمون جدید"], [ADMIN_SUBMENU_BUTTON_BACK]])
    });
    return;
  }
  let msg = `📋 <b>آزمون‌های آماده (${quizzes.length})</b>\n\n`;
  for (let i = 0; i < quizzes.length; i++) {
    const q = quizzes[i];
    const cnt = await getQuestionCount(env, q.id);
    msg += `${i+1}. <b>${q.title}</b> — ${cnt} سوال — ⏱️ ${q.total_time_minutes} دقیقه\n`;
  }
  msg += `\nشماره آزمون مورد نظر را وارد کن:`;
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([["➕ ساخت آزمون جدید"], [ADMIN_SUBMENU_BUTTON_BACK]])
  });
}

async function showPublishedQuizzes(env: Env, chatId: number, tgId: number): Promise<void> {
  const admin = await getAdminByTelegramId(env, tgId); if (!admin) return;
  const quizzes = await getPublishedQuizzesByAdmin(env, admin.id);
  if (!quizzes.length) {
    await sendMessage(env, chatId, "📊 هنوز هیچ آزمون منتشرشده‌ای وجود ندارد.", {
      reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
    });
    return;
  }
  let msg = `📊 <b>آزمون‌های منتشرشده (${quizzes.length})</b>\n\n`;
  for (let i = 0; i < quizzes.length; i++) {
    const q = quizzes[i];
    const cnt = await getQuestionCount(env, q.id);
    const participants = await getParticipantCount(env, q.id);
    msg += `${i+1}. <b>${q.title}</b> — ${cnt} سوال — 👥 ${participants} نفر\n`;
  }
  msg += `\nشماره آزمون را وارد کن تا نتایج را ببینی:`;
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
  });
}

async function showQuizLeaderboardAdmin(env: Env, chatId: number, quizId: number): Promise<void> {
  const quiz = await getQuizById(env, quizId); if (!quiz) return;
  const lb = await getLeaderboardWithNegative(env, quizId, 20);
  const participants = await getParticipantCount(env, quizId);
  let msg = `📊 <b>نتایج: ${quiz.title}</b>\n👥 شرکت‌کنندگان: ${participants} نفر\n\n`;
  if (!lb.length) {
    msg += "🙈 هنوز کسی آزمون را تمام نکرده.";
  } else {
    for (const e of lb) {
      const medal = e.rank <= 3 ? ['🥇','🥈','🥉'][e.rank-1] : `${e.rank}.`;
      msg += `${medal} <b>${e.display_name}</b> — ${e.percentage}% — ✅${e.correct} ❌${e.wrong} ⬜${e.unanswered}\n`;
    }
  }
  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([["🔗 مشاهده لینک"], ["🗑 حذف آزمون"], [ADMIN_SUBMENU_BUTTON_BACK]])
  });
}

async function showQuizDetail(env: Env, chatId: number, quizId: number): Promise<void> {
  const q = await getQuizById(env, quizId); if (!q) return;
  const cnt = await getQuestionCount(env, quizId);
  await sendMessage(env, chatId,
    `📝 <b>${q.title}</b>\n📊 ${cnt} سوال — ⏱️ ${q.total_time_minutes} دقیقه`,
    {
      parse_mode: "HTML",
      reply_markup: getAdminSubMenuKeyboard([
        ["🔗 دریافت لینک"],
        ["📋 مشاهده سوالات"],
        ["🗑 حذف آزمون"],
        [ADMIN_SUBMENU_BUTTON_BACK]
      ])
    }
  );
}

async function showQuestionsInline(env: Env, chatId: number, quizId: number): Promise<void> {
  const qs = await getQuizQuestions(env, quizId);
  if (!qs.length) { await sendMessage(env, chatId, "⚠️ این آزمون سوالی ندارد."); return; }
  const rows: any[] = [];
  for (let i = 0; i < qs.length; i += 5) {
    rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:admin_view:${q.id}` })));
  }
  rows.push([{ text: "✏️ ادیت سوال", callback_data: `${CB_PREFIX.QUIZ}:admin_edit_select:${quizId}` }]);
  rows.push([{ text: ADMIN_SUBMENU_BUTTON_BACK, callback_data: `${CB_PREFIX.QUIZ}:admin_detail_back:${quizId}` }]);
  await sendMessage(env, chatId, `📋 روی شماره سوال بزن تا ببینی:`, { reply_markup: { inline_keyboard: rows } });
}

export async function handleQuizAdminCallback(env: Env, callbackQuery: any): Promise<void> {
  const data = callbackQuery.data || "";
  const parts = data.split(":");
  const action = parts[1] || "";
  const id = parts[2] ? parseInt(parts[2]) : undefined;
  const msg = callbackQuery.message;
  if (!msg) { await answerCallbackQuery(env, callbackQuery.id); return; }
  const chatId = msg.chat.id;
  await answerCallbackQuery(env, callbackQuery.id);

  if (action === "admin_view" && id) {
    const q = await getQuizQuestionById(env, id); if (!q) return;
    await sendMessage(env, chatId,
      `❓ <b>${q.question_text}</b>\n\n1️⃣ ${q.option_a}\n2️⃣ ${q.option_b}\n3️⃣ ${q.option_c}\n4️⃣ ${q.option_d}\n\n✅ درست: ${q.correct_option}\n📖 ${q.explanation || 'بدون پاسخنامه'}`,
      { parse_mode: "HTML" }
    );
  } else if (action === "admin_detail_back" && id) {
    await showQuizDetail(env, chatId, id);
  } else if (action === "admin_edit_select" && id) {
    const qs = await getQuizQuestions(env, id); if (!qs.length) return;
    const rows: any[] = [];
    for (let i = 0; i < qs.length; i += 5) {
      rows.push(qs.slice(i, i + 5).map(q => ({ text: String(q.question_index), callback_data: `${CB_PREFIX.QUIZ}:admin_edit_q:${q.id}` })));
    }
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
