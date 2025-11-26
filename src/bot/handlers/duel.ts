import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, getUserById, DbUser } from "../../db/users";
import {
  DuelDifficulty,
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
import { addXpForDuelMatch } from "../../db/xp";
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

  let match = await findWaitingMatch(env, difficulty, user.id);

  if (!match) {
    // ... (کد ساخت مچ جدید بدون تغییر) ...
    match = await createDuelMatch(env, difficulty, user.id);
    await ensureDuelQuestions(env, match.id, difficulty);

    const totalQ = await getTotalQuestionsInMatch(env, match.id);
    if (totalQ === 0) {
        // ... (ارسال پیام خطا) ...
        await sendMessage(env, chatId, "فعلاً سوال کافی برای دوئل در این سطح وجود ندارد ❗️");
        return;
    }
    // ... (پیام شروع و ارسال سوال اول) ...
    const introText = difficulty === "easy" ? "یک دوئل آسان..." : "یک دوئل سخت..."; // متن کامل رو بذارید
    await sendMessage(env, chatId, introText);
    await sendNextDuelQuestion(env, match.id, user, chatId);
    return;
  }

  // --- تغییر اصلی اینجاست ---
  if (!match.player2_id) {
    // تلاش برای جوین شدن
    const joinedMatch = await joinDuelMatch(env, match.id, user.id);
    
    if (!joinedMatch) {
      // اگر نال برگشت، یعنی در همین لحظه کس دیگری جوین شد (Race Condition)
      // پس دوباره تلاش می‌کنیم (بازگشتی) تا یک مچ دیگر پیدا کنیم یا بسازیم
      return startDuelForUser(env, update, difficulty);
    }
    
    match = joinedMatch;
  }
  // ---------------------------

  await ensureDuelQuestions(env, match.id, difficulty);

  // ... (بقیه کد بدون تغییر: چک کردن سوالات و شروع بازی) ...
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

  // تغییر UI: گزینه‌ها در متن
  const messageText = 
    `❓ <b>${q.question_text}</b>\n\n` +
    `1️⃣ ${q.option_a}\n` +
    `2️⃣ ${q.option_b}\n` +
    `3️⃣ ${q.option_c}\n` +
    `4️⃣ ${q.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1", callback_data: `${CB_PREFIX.DUEL}:${duelId}:${q.duel_question_id}:A` },
        { text: "2", callback_data: `${CB_PREFIX.DUEL}:${duelId}:${q.duel_question_id}:B` },
        { text: "3", callback_data: `${CB_PREFIX.DUEL}:${duelId}:${q.duel_question_id}:C` },
        { text: "4", callback_data: `${CB_PREFIX.DUEL}:${duelId}:${q.duel_question_id}:D` }
      ]
    ]
  };

  await sendMessage(env, chatId, messageText, { reply_markup: replyMarkup });
  return true;
}

export async function handleDuelAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":"); 
  
  if (parts.length !== 4 || parts[0] !== CB_PREFIX.DUEL) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const duelId = Number(parts[1]);
  const duelQuestionId = Number(parts[2]);
  const chosenOption = parts[3];

  if (!Number.isFinite(duelId) || !Number.isFinite(duelQuestionId)) {
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

  const match = await getDuelMatchById(env, duelId);
  if (!match) {
    await answerCallbackQuery(env, callbackQuery.id, "این دوئل پیدا نشد ❗️");
    return;
  }

  if (match.player1_id !== user.id && match.player2_id !== user.id) {
    await answerCallbackQuery(env, callbackQuery.id, "این دوئل مربوط به تو نیست.");
    return;
  }

  const q = await getDuelQuestionById(env, duelQuestionId);
  if (!q) {
    await answerCallbackQuery(env, callbackQuery.id, "سوال این دوئل پیدا نشد ❗️");
    return;
  }

  const isCorrect = chosenOption === q.correct_option;

  await recordDuelAnswer(env, duelId, duelQuestionId, user.id, chosenOption, isCorrect);

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
  const correctText = q[`option_${q.correct_option.toLowerCase()}` as keyof typeof q]; // trick to get text

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

  const userCorrect = await getUserCorrectCountInMatch(env, duelId, user.id);
  const finalizeResult = await maybeFinalizeMatch(env, duelId);

  if (!finalizeResult) {
    const msg =
      `تو دوئل رو تموم کردی ✅\n` +
      `تعداد پاسخ‌های درست تو: <b>${userCorrect}</b> از <b>${totalQ}</b>\n` +
      `منتظر بمون تا حریف هم سوال‌هاش رو جواب بده؛ بعد نتیجه و XP نهایی برات میاد.`;
    await sendMessage(env, chatId, msg);
    return;
  }

  const { totalQuestions, player1Correct, player2Correct, winnerUserId, isDraw, match: finalMatch } = finalizeResult;

  const player1 = await getUserById(env, finalMatch.player1_id);
  const player2 = finalMatch.player2_id ? await getUserById(env, finalMatch.player2_id) : null;

  if (player1) {
    let result: "win" | "draw" | "lose" = "draw";
    if (isDraw === 1) result = "draw";
    else if (winnerUserId === player1.id) result = "win";
    else result = "lose";

    const xp = await addXpForDuelMatch(env, player1.id, finalMatch.id, player1Correct, totalQuestions, result);
    const text = buildDuelSummaryText(result, player1Correct, player2Correct, totalQuestions, xp, player2);
    await sendMessage(env, player1.telegram_id, text);
  }

  if (player2) {
    let result: "win" | "draw" | "lose" = "draw";
    if (isDraw === 1) result = "draw";
    else if (winnerUserId === player2.id) result = "win";
    else result = "lose";

    const xp = await addXpForDuelMatch(env, player2.id, finalMatch.id, player2Correct, totalQuestions, result);
    const text = buildDuelSummaryText(result, player2Correct, player1Correct, totalQuestions, xp, player1);
    await sendMessage(env, player2.telegram_id, text);
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
