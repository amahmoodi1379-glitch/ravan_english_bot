import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute, prepare, queryAll } from "../../db/client";
import {
  pickNextWordForUser,
  getOrCreateUserWordState,
  updateSm2AndStageAfterAnswer,
  prepareUpdateSm2,
  markWordAsIgnored,
  DbWord
} from "../../db/leitner";
import { addXpForLeitnerQuestion, prepareXpForLeitner, checkAndUpdateStreak } from "../../db/xp";
import { generateWordQuestionsWithGemini } from "../../ai/gemini";
import { insertWordQuestions } from "../../db/word_questions";
import { CB_PREFIX } from "../../config/constants";

interface LeitnerQuestionRow {
  id: number;
  word_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  english: string;
  persian: string;
  level: number;
}

// تعیین نوع سوال بر اساس مرحله
function getQuestionStyleForStage(stage: number): string | null {
  // مرحله ۱: معنی فارسی
  if (stage <= 1) return "fa_meaning";
  
  // مرحله ۲: تعریف ساده انگلیسی
  if (stage === 2) return "en_definition";
  
  // مرحله ۳: تشخیص کلمه از روی تعریف
  if (stage === 3) return "word_from_definition";

  // مرحله ۴ و بالاتر: 
  // نال برمی‌گرداند تا سیستم به صورت خودکار از تابع pickRandomUnseenQuestion استفاده کند
  // که باعث می‌شود سوالات از همه انواع (شامل مراحل قبل + مترادف/متضاد اگر باشد) شافل شوند.
  return null; 
}

export async function startLeitnerForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;
  const chatId = message.chat.id;
  const tgUser = message.from;
  const user = await getOrCreateUser(env, tgUser);
  await sendLeitnerQuestion(env, user, chatId);
}

async function sendLeitnerQuestion(env: Env, user: DbUser, chatId: number): Promise<void> {
  // ۱. انتخاب واژه
  const word = await pickNextWordForUser(env, user.id);

  if (!word) {
    await sendMessage(env, chatId, "فعلاً هیچ واژه‌ای برای تمرین در سیستم ثبت نشده (یا همه رو بلدی!) 👏");
    return;
  }

  // ۲. تعیین نیاز (آیا باید سوال بسازیم؟)
  // سهمیه‌ها افزایش یافت:
  // fa_meaning: 3
  // en_definition: 3
  // word_from_definition: 4
  // synonym: 2 (اگر کلمه مترادف داشت)
  // antonym: 2 (اگر کلمه متضاد داشت)

  const countsRows = await queryAll<{ question_style: string; cnt: number }>(
    env,
    `SELECT question_style, COUNT(*) as cnt FROM word_questions WHERE word_id = ? GROUP BY question_style`,
    [word.id]
  );
  
  const counts: Record<string, number> = {};
  countsRows.forEach(r => counts[r.question_style] = r.cnt);

  let styleToGenerate: string | null = null;
  let neededCount = 0;

  // اولویت‌ها و سقف‌های جدید
  if ((counts["fa_meaning"] || 0) < 3) {
      styleToGenerate = "fa_meaning";
      neededCount = 3 - (counts["fa_meaning"] || 0);
  } 
  else if ((counts["en_definition"] || 0) < 3) {
      styleToGenerate = "en_definition";
      neededCount = 3 - (counts["en_definition"] || 0);
  }
  else if ((counts["word_from_definition"] || 0) < 4) {
      styleToGenerate = "word_from_definition";
      neededCount = 4 - (counts["word_from_definition"] || 0);
  }
  // شرط هوشمند: فقط اگر در دیتابیس مترادف داشت بساز
  else if (word.synonyms && word.synonyms.trim().length > 1 && (counts["synonym"] || 0) < 2) {
      styleToGenerate = "synonym";
      neededCount = 2 - (counts["synonym"] || 0);
  }
  // شرط هوشمند: فقط اگر در دیتابیس متضاد داشت بساز
  else if (word.antonyms && word.antonyms.trim().length > 1 && (counts["antonym"] || 0) < 2) {
      styleToGenerate = "antonym";
      neededCount = 2 - (counts["antonym"] || 0);
  }

  // ۳. اگر نیاز به ساخت بود، بساز
  if (styleToGenerate) {
    await sendMessage(env, chatId, "⏳ در حال طراحی سوال جدید با هوش مصنوعی...");
    try {
      const aiQuestions = await generateWordQuestionsWithGemini({
        env,
        english: word.english,
        persian: word.persian,
        level: word.level,
        questionStyle: styleToGenerate,
        count: neededCount
      });

      if (aiQuestions.length > 0) {
        await insertWordQuestions(
          env,
          word.id,
          aiQuestions.map((q) => ({
            wordId: word.id,
            questionText: q.question,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation,
            questionStyle: styleToGenerate!
          }))
        );
      }
    } catch (error) {
      console.error("Error generating questions:", error);
    }
  }

  // ۴. انتخاب سوال برای نمایش به کاربر
  const state = await getOrCreateUserWordState(env, user.id, word.id);
  const stage = state.question_stage || 1;
  
  // استایل ترجیحی بر اساس مرحله
  const preferredStyle = getQuestionStyleForStage(stage);

  let question: LeitnerQuestionRow | null = null;

  if (preferredStyle) {
    // تلاش برای پیدا کردن سوال با استایل مشخص که کاربر ندیده باشد
    question = await pickQuestionForUserWord(env, user, word, preferredStyle);
  }

  // اگر مرحله ۴ به بالا بود (preferredStyle == null) یا سوال ترجیحی پیدا نشد:
  // یک سوال تصادفی از "هر نوعی" که کاربر ندیده انتخاب کن.
  // این یعنی شافل کردن همه سوالات موجود (شامل مترادف/متضاد اگر موجود باشند، وگرنه بقیه انواع).
  if (!question) {
     question = await pickRandomUnseenQuestion(env, user, word);
  }

  // اگر باز هم پیدا نشد (یعنی همه سوالات موجود رو دیده)، یک سوال تصادفی از کل سوالات انتخاب کن (تکراری)
  if (!question) {
    question = await pickRandomQuestionAny(env, word);
  }

  if (!question) {
    await sendMessage(
      env,
      chatId,
      `برای واژه‌ی <b>${word.english}</b> سوالی پیدا نشد و ساخت خودکار هم ناموفق بود ❗️`
    );
    return;
  }

  // ثبت نمایش (برای جلوگیری از تکرار پشت سر هم در کوتاه مدت)
  const now = new Date().toISOString();
  await execute(
    env,
    `
      INSERT OR IGNORE INTO user_word_question_history
        (user_id, word_id, question_id, context, shown_at)
      VALUES (?, ?, ?, 'leitner', ?)
    `,
    [user.id, question.word_id, question.id, now]
  );

  const messageText = 
    `❓ <b>${question.question_text}</b>\n\n` +
    `1️⃣ ${question.option_a}\n` +
    `2️⃣ ${question.option_b}\n` +
    `3️⃣ ${question.option_c}\n` +
    `4️⃣ ${question.option_d}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "1", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:A` },
        { text: "2", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:B` },
        { text: "3", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:C` },
        { text: "4", callback_data: `${CB_PREFIX.LEITNER}:${question.id}:D` }
      ],
      [{ text: "✅ بلدم (حذف از مرور)", callback_data: `${CB_PREFIX.LEITNER_IGNORE}:${question.id}` }]
    ]
  };

  await sendMessage(env, chatId, messageText, {
    reply_markup: replyMarkup
  });
}

// انتخاب سوال با استایل خاص که کاربر ندیده
async function pickQuestionForUserWord(
  env: Env,
  user: DbUser,
  word: DbWord,
  style: string
): Promise<LeitnerQuestionRow | null> {
  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND q.question_style = ?
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY RANDOM()
    LIMIT 1
    `,
    [word.id, style, user.id]
  );
}

// انتخاب هر سوالی که کاربر ندیده (بدون توجه به استایل - برای شافل کردن)
async function pickRandomUnseenQuestion(
  env: Env,
  user: DbUser,
  word: DbWord
): Promise<LeitnerQuestionRow | null> {
  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM user_word_question_history h
        WHERE h.user_id = ? AND h.question_id = q.id AND h.context = 'leitner'
      )
    ORDER BY RANDOM()
    LIMIT 1
    `,
    [word.id, user.id]
  );
}

// انتخاب هر سوالی (تکراری هم باشد اشکال ندارد - فال‌بک نهایی)
async function pickRandomQuestionAny(
  env: Env,
  word: DbWord
): Promise<LeitnerQuestionRow | null> {
  return await queryOne<LeitnerQuestionRow>(
    env,
    `
    SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
    FROM word_questions q
    JOIN words w ON q.word_id = w.id
    WHERE q.word_id = ?
    ORDER BY RANDOM()
    LIMIT 1
    `,
    [word.id]
  );
}

export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts[0] === CB_PREFIX.LEITNER_IGNORE) {
    const questionId = Number(parts[1]);
    if (!Number.isFinite(questionId)) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const message = callbackQuery.message;
    if (!message) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const chatId = message.chat.id;
    const tgUser = callbackQuery.from;
    const user = await getOrCreateUser(env, tgUser);

    const question = await queryOne<{ word_id: number; english: string }>(
      env,
      `SELECT q.word_id, w.english FROM word_questions q JOIN words w ON w.id = q.word_id WHERE q.id = ?`,
      [questionId]
    );

    if (question) {
      await markWordAsIgnored(env, user.id, question.word_id);
      await answerCallbackQuery(env, callbackQuery.id, "واژه حذف شد 👌");
      await sendMessage(env, chatId, `واژه‌ی <b>${question.english}</b> از چرخه مرور حذف شد ✅`);
    } else {
      await answerCallbackQuery(env, callbackQuery.id, "خطا در یافتن واژه");
    }

    await sendLeitnerQuestion(env, user, chatId);
    return;
  }

  if (parts[0] === CB_PREFIX.LEITNER) {
    const questionId = Number(parts[1]);
    const chosenOption = parts[2];

    if (!Number.isFinite(questionId)) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }

    const message = callbackQuery.message;
    if (!message) {
      await answerCallbackQuery(env, callbackQuery.id);
      return;
    }
    const chatId = message.chat.id;
    const tgUser = callbackQuery.from;
    const user = await getOrCreateUser(env, tgUser);

    const question = await queryOne<LeitnerQuestionRow>(
      env,
      `
      SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level
      FROM word_questions q
      JOIN words w ON q.word_id = w.id
      WHERE q.id = ?
      `,
      [questionId]
    );

    if (!question) {
      await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد ❗️");
      return;
    }

    const isCorrect = chosenOption === question.correct_option;
    const now = new Date().toISOString();

    const updateResult = await env.DB.prepare(
      `UPDATE user_word_question_history 
       SET is_correct = ?, answered_at = ? 
       WHERE user_id = ? AND question_id = ? AND context = 'leitner' AND answered_at IS NULL`
    )
    .bind(isCorrect ? 1 : 0, now, user.id, question.id)
    .run();

    if (updateResult.meta.changes === 0) {
       await answerCallbackQuery(env, callbackQuery.id, "⛔️ قبلاً پاسخ دادی!");
       return; 
    }

    const batchStatements: any[] = [];
    const sm2Stmts = await prepareUpdateSm2(env, user.id, question.word_id, isCorrect);
    batchStatements.push(...sm2Stmts);
    const xpStmts = prepareXpForLeitner(env, user.id, question.word_id, question.level, isCorrect);
    batchStatements.push(...xpStmts);

    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
    }

    if (isCorrect) {
      const streakMsg = await checkAndUpdateStreak(env, user.id);
      if (streakMsg) {
        await sendMessage(env, chatId, streakMsg);
      }
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

    let correctText = "";
    if (question.correct_option === "A") correctText = question.option_a;
    else if (question.correct_option === "B") correctText = question.option_b;
    else if (question.correct_option === "C") correctText = question.option_c;
    else if (question.correct_option === "D") correctText = question.option_d;

    const correctNum = getOptionNumber(question.correct_option);
    let replyText: string;
    if (isCorrect) {
      replyText = `آفرین! ✅ جواب درست بود.\n\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    } else {
      replyText = `جوابت درست نبود ❌\n\nجواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`;
    }

    await sendMessage(env, chatId, replyText);
    await sendLeitnerQuestion(env, user, chatId);
  }
}
