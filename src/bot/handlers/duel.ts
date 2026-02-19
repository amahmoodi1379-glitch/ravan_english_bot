import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, getUserById, DbUser } from "../../db/users";
import {
  DuelDifficulty,
  DuelMatch,
  getDuelMatchById,
  findWaitingMatch,
  createDuelMatch,
  joinDuelMatch,
  ensureDuelQuestions,
  getDuelQuestionByIndex,
  getDuelQuestionById,
  getUserAnswerCountInMatch,
  getTotalQuestionsInMatch,
  recordDuelAnswer,
  getUserCorrectCountInMatch,
  maybeFinalizeMatch
} from "../../db/duels";
import { addXpForDuelMatch, checkAndUpdateStreak } from "../../db/xp"; 
import { queryOne } from "../../db/client";
import { CB_PREFIX } from "../../config/constants";

export async function startDuelEasyForUser(env: Env, update: TelegramUpdate): Promise<void> {
  await startDuelForUser(env, update, "easy");
}

export async function startDuelHardForUser(env: Env, update: TelegramUpdate): Promise<void> {
  await startDuelForUser(env, update, "hard");
}

async function startDuelForUser(env: Env, update: TelegramUpdate, difficulty: DuelDifficulty): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const tgUser = message.from;

  const user = await getOrCreateUser(env, tgUser);
  // === فیکس: جلوگیری از شروع بازی تکراری ===
  // چک می‌کنیم آیا کاربر همین الان بازی باز دارد؟
  const existingMatch = await queryOne<{ id: number }>(
      env, 
      "SELECT id FROM duel_matches WHERE (player1_id = ? OR player2_id = ?) AND status IN ('waiting', 'in_progress')",
      [user.id, user.id]
  );
  
  if (existingMatch) {
      await sendMessage(env, chatId, "⚠️ تو همین الان یک بازی فعال (یا در انتظار) داری! اول اون رو تموم کن یا از دکمه 'بازگشت' استفاده کن.");
      return;
  }
  // ===========================================
  await sendMessage(env, chatId, "⏳ در حال بررسی و آماده‌سازی دوئل... (ممکن است چند ثانیه طول بکشد)");

  const MAX_JOIN_RETRIES = 3;
  let match: DuelMatch | null = null;
  let joined = false;

  for (let attempt = 0; attempt < MAX_JOIN_RETRIES; attempt++) {
    match = await findWaitingMatch(env, difficulty, user.id);

    if (!match) {
      // هیچ بازی منتظری نیست، یک بازی جدید بساز
      match = await createDuelMatch(env, difficulty, user.id);
      
      await ensureDuelQuestions(env, match.id, difficulty);

      const totalQ = await getTotalQuestionsInMatch(env, match.id);
      
      if (totalQ === 0) {
          await env.DB.prepare("DELETE FROM duel_matches WHERE id = ?").bind(match.id).run();
          await sendMessage(env, chatId, "متاسفانه نتوانستیم سوالات دوئل را آماده کنیم. لطفاً چند لحظه دیگر دوباره تلاش کنید ❗️");
          return;
      }
      
      const introText = difficulty === "easy" ? "یک دوئل آسان ساخته شد. منتظر حریف..." : "یک دوئل سخت ساخته شد. منتظر حریف...";
      await sendMessage(env, chatId, introText);
      await sendNextDuelQuestion(env, match.id, user, chatId);
      return;
    }

    if (!match.player2_id) {
      const joinedMatch = await joinDuelMatch(env, match.id, user.id);
      
      if (!joinedMatch) {
        // کسی زودتر جوین شده، دوباره تلاش کن
        continue;
      }
      
      match = joinedMatch;
      joined = true;
      break;
    }

    joined = true;
    break;
  }

  if (!joined || !match) {
    await sendMessage(env, chatId, "⚠️ ترافیک بالاست، لطفاً چند لحظه دیگر مجدداً تلاش کنید.");
    return;
  }

  await ensureDuelQuestions(env, match.id, difficulty);

  const totalQ = await getTotalQuestionsInMatch(env, match.id);
  if (totalQ === 0) {
      await sendMessage(env, chatId, "برای این دوئل هنوز سوالی ساخته نشده ❗️");
      return;
  }
  
  const introText2 = difficulty === "easy" ? "یک حریف برای دوئل آسان پیدا شد..." : "یک حریف برای دوئل سخت پیدا شد...";
  await sendMessage(env, chatId, introText2);

  const opponentId = match.player1_id === user.id ? match.player2_id : match.player1_id;
  if (opponentId) {
    const opp = await getUserById(env, opponentId);
    if (opp) {
      await sendMessage(env, opp.telegram_id, "حریف به دوئل تو پیوست!...");
      await sendNextDuelQuestion(env, match.id, opp, opp.telegram_id);
    }
  }

  await sendNextDuelQuestion(env, match.id, user, chatId);
}

async function sendNextDuelQuestion(
  env: Env,
  duelId: number,
  user: DbUser,
  chatId: number
): Promise<boolean> {
  const answered = await getUserAnswerCountInMatch(env, duelId, user.id);
  const totalQ = await getTotalQuestionsInMatch(env, duelId);

  if (totalQ === 0) {
    await sendMessage(env, chatId, "برای این دوئل هیچ سوالی ثبت نشده ❗️");
    return false;
  }

  if (answered >= totalQ) {
    await sendMessage(env, chatId, "همه‌ی سوال‌های این دوئل رو قبلاً جواب دادی ✅");
    return false;
  }

  const nextIndex = answered + 1;
  const q = await getDuelQuestionByIndex(env, duelId, nextIndex);
  if (!q) {
    await sendMessage(env, chatId, "سوال بعدی این دوئل پیدا نشد ❗️");
    return false;
  }

  const messageText = 
    `❓ <b>${q.question_text}</b>\n\n` +
    `1️⃣ ${q.option_a}\n` +
    `2️⃣ ${q.option_b}\n` +
    `3️⃣ ${q.option_c}\n` +
    `4️⃣ ${q.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1", callback_data: `${CB_PREFIX.DUEL}:${q.duel_question_id}:A` },
        { text: "2", callback_data: `${CB_PREFIX.DUEL}:${q.duel_question_id}:B` },
        { text: "3", callback_data: `${CB_PREFIX.DUEL}:${q.duel_question_id}:C` },
        { text: "4", callback_data: `${CB_PREFIX.DUEL}:${q.duel_question_id}:D` }
      ]
    ]
  };

  await sendMessage(env, chatId, messageText, { reply_markup: replyMarkup });
  return true;
}

export async function handleDuelAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); 
  
  if (parts.length !== 3 || parts[0] !== CB_PREFIX.DUEL) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const duelQuestionId = Number(parts[1]);
  const chosenOption = parts[2];

  if (!Number.isFinite(duelQuestionId)) {
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

  const q = await getDuelQuestionById(env, duelQuestionId);
  if (!q) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال این دوئل پیدا نشد ❗️");
    return;
  }

  const duelId = q.duel_id; 
  
  const existingAnswer = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM duel_answers WHERE duel_id = ? AND duel_question_id = ? AND user_id = ?`,
    [duelId, duelQuestionId, user.id]
  );

  if (existingAnswer) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔️ قبلاً پاسخ دادی!");
    return;
  }

  const match = await getDuelMatchById(env, duelId);
  if (!match) {
    await answerCallbackQuery(env, callbackQuery.id, "این دوئل پیدا نشد ❗️");
    return;
  }

  if (match.player1_id !== user.id && match.player2_id !== user.id) {
    await answerCallbackQuery(env, callbackQuery.id, "این دوئل مربوط به تو نیست.");
    return;
  }

  const isCorrect = chosenOption === q.correct_option;

  try {
    await recordDuelAnswer(env, duelId, duelQuestionId, user.id, chosenOption, isCorrect);
  } catch (e) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
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
  const correctNum = getOptionNumber(q.correct_option);
  
  let correctText = "";
  if (q.correct_option === "A") correctText = q.option_a;
  else if (q.correct_option === "B") correctText = q.option_b;
  else if (q.correct_option === "C") correctText = q.option_c;
  else if (q.correct_option === "D") correctText = q.option_d;

  let replyText: string;
  if (isCorrect) {
    replyText =
      `آفرین! ✅ جواب درست بود.\n\n` +
      `کلمه: <b>${q.english}</b>\n` +
      `معنی: <b>${q.persian}</b>`;
  } else {
    const chosenNum = getOptionNumber(chosenOption);
    replyText =
      `جوابت درست نبود ❌\n\n` +
      `جواب تو: <b>${chosenNum}</b>\n` +
      `✅ جواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\n` +
      `کلمه: <b>${q.english}</b>\n` +
      `معنی: <b>${q.persian}</b>`;
  }

  await sendMessage(env, chatId, replyText);

  const totalQ = await getTotalQuestionsInMatch(env, duelId);
  const answeredCount = await getUserAnswerCountInMatch(env, duelId, user.id);

  if (answeredCount < totalQ) {
    await sendNextDuelQuestion(env, duelId, user, chatId);
    return;
  }

  // --- محاسبه نتیجه نهایی ---
  const userCorrect = await getUserCorrectCountInMatch(env, duelId, user.id);
  
  // تلاش برای نهایی کردن بازی (حالت عادی: دو نفر تمام می‌کنند)
  const finalizeResult = await maybeFinalizeMatch(env, duelId);

  // حالت ۱: بازی همین الان به صورت نرمال تمام شد
  if (finalizeResult) {
    const { totalQuestions, player1Correct, player2Correct, winnerUserId, isDraw, match: finalMatch } = finalizeResult;
    await processAndNotifyEndGame(env, finalMatch, player1Correct, player2Correct, isDraw, winnerUserId, totalQuestions);
    return;
  }

  // حالت ۲: بازی قبلاً "Completed" شده (یعنی حریف انصراف داده یا زودتر تمام شده و باگ خورده بود)
  // اینجا باگ اصلی فیکس می‌شود: اگر finalizeResult نال بود، چک می‌کنیم شاید بازی تمام شده است.
  const freshMatch = await getDuelMatchById(env, duelId);
  if (freshMatch && freshMatch.status === 'completed') {
    // بازی تمام شده است، پس باید نتیجه را برای "این کاربر" محاسبه و ارسال کنیم.
    let result: "win" | "draw" | "lose" = "lose";
    if (freshMatch.is_draw === 1) result = "draw";
    else if (freshMatch.winner_user_id === user.id) result = "win";
    else result = "lose"; // یا باخته یا حریف برده

    const xp = await addXpForDuelMatch(env, user.id, freshMatch.id, userCorrect, totalQ, result);
    const sMsg = await checkAndUpdateStreak(env, user.id);
    if (sMsg) await sendMessage(env, chatId, sMsg);

    let endText = "";
    if (result === "win") endText = "🎉 بازی تمام شده (احتمالاً حریف انصراف داده). تو بردی!";
    else if (result === "lose") endText = "بازی تمام شده و تو باختی.";
    else endText = "بازی مساوی شد.";

    endText += `\n\nامتیاز تو: <b>${userCorrect}</b> از <b>${totalQ}</b>`;
    endText += `\n⭐️ XP دریافتی: <b>${xp}</b>`;

    await sendMessage(env, chatId, endText);
    return;
  }

  // حالت ۳: هنوز منتظر حریف هستیم
  const msg =
    `تو دوئل رو تموم کردی ✅\n` +
    `تعداد پاسخ‌های درست تو: <b>${userCorrect}</b> از <b>${totalQ}</b>\n` +
    `منتظر بمون تا حریف هم سوال‌هاش رو جواب بده؛ بعد نتیجه و XP نهایی برات میاد.`;
  await sendMessage(env, chatId, msg);
}

// تابع کمکی برای ارسال پیام‌های پایان بازی (جلوگیری از تکرار کد)
async function processAndNotifyEndGame(
    env: Env, 
    match: any, 
    p1Correct: number, 
    p2Correct: number, 
    isDraw: boolean, 
    winnerId: number | null, 
    total: number
) {
    const player1 = await getUserById(env, match.player1_id);
    const player2 = match.player2_id ? await getUserById(env, match.player2_id) : null;

    if (player1) {
        let res: "win" | "draw" | "lose" = "lose";
        if (isDraw) res = "draw";
        else if (winnerId === player1.id) res = "win";
        
        const xp = await addXpForDuelMatch(env, player1.id, match.id, p1Correct, total, res);
        const s = await checkAndUpdateStreak(env, player1.id);
        if (s) await sendMessage(env, player1.telegram_id, s);
        
        const txt = buildDuelSummaryText(res, p1Correct, p2Correct, total, xp, player2);
        await sendMessage(env, player1.telegram_id, txt);
    }

    if (player2) {
        let res: "win" | "draw" | "lose" = "lose";
        if (isDraw) res = "draw";
        else if (winnerId === player2.id) res = "win";
        
        const xp = await addXpForDuelMatch(env, player2.id, match.id, p2Correct, total, res);
        const s = await checkAndUpdateStreak(env, player2.id);
        if (s) await sendMessage(env, player2.telegram_id, s);
        
        const txt = buildDuelSummaryText(res, p2Correct, p1Correct, total, xp, player1);
        await sendMessage(env, player2.telegram_id, txt);
    }
}

function buildDuelSummaryText(
  result: "win" | "draw" | "lose",
  myCorrect: number,
  oppCorrect: number,
  total: number,
  xp: number,
  opponent: DbUser | null
): string {
  let statusText = "";
  if (result === "win") statusText = "🎉 تو این دوئل رو بردی!";
  else if (result === "lose") statusText = "😅 این دوئل رو باختی.";
  else statusText = "🤝 دوئل مساوی شد.";

  const oppName = opponent?.display_name ?? "حریف";

  let text =
    `${statusText}\n\n` +
    `تو: <b>${myCorrect}</b> از <b>${total}</b>\n` +
    `${oppName}: <b>${oppCorrect}</b> از <b>${total}</b>\n`;

  if (xp > 0) {
    text += `\n⭐️ XP این دوئل: <b>${xp}</b>`;
  }

  return text;
}
