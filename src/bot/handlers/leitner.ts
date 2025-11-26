// ... (ایمپورت‌ها مثل قبل، فقط توابع زیر تغییر می‌کنند) ...
// ایمپورت‌ها باید شامل prepareUpdateSm2 و prepareXpForLeitner باشند.
// فرض کنید که prepare از client ایمپورت شده است.
import { prepare } from "../../db/client";
import { prepareUpdateSm2 } from "../../db/leitner";
import { prepareXpForLeitner } from "../../db/xp";
// ... بقیه ایمپورت‌ها ...

// ... (startLeitnerForUser, sendLeitnerQuestion, pickQuestionForUserWord بدون تغییر) ...

export async function handleLeitnerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  // ... (بخش ignore بدون تغییر) ...

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
      `SELECT q.id, q.word_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.question_style, w.english, w.persian, w.level FROM word_questions q JOIN words w ON q.word_id = w.id WHERE q.id = ?`,
      [questionId]
    );

    if (!question) {
      await answerCallbackQuery(env, callbackQuery.id, "سوال پیدا نشد ❗️");
      return;
    }

    const isCorrect = chosenOption === question.correct_option;
    const now = new Date().toISOString();

    // ⚡️ BATCH EXECUTION STARTS HERE ⚡️
    const batchStatements: any[] = [];

    // 1. ثبت تاریخچه سوال
    batchStatements.push(prepare(
      env,
      `UPDATE user_word_question_history SET is_correct = ?, answered_at = ? WHERE user_id = ? AND question_id = ? AND context = 'leitner'`,
      [isCorrect ? 1 : 0, now, user.id, question.id]
    ));

    // 2. آپدیت SM2
    const sm2Stmts = await prepareUpdateSm2(env, user.id, question.word_id, isCorrect);
    batchStatements.push(...sm2Stmts);

    // 3. امتیازدهی
    const xpStmts = prepareXpForLeitner(env, user.id, question.word_id, question.level, isCorrect);
    batchStatements.push(...xpStmts);

    // اجرای همه با هم
    if (batchStatements.length > 0) {
      await env.DB.batch(batchStatements);
    }
    // ⚡️ BATCH EXECUTION ENDS ⚡️

    await answerCallbackQuery(env, callbackQuery.id);

    // ... (بقیه کد: نمایش نتیجه و ارسال سوال بعدی) ...
    const getOptionNumber = (letter: string): string => { switch (letter) { case "A": return "1"; case "B": return "2"; case "C": return "3"; case "D": return "4"; default: return ""; } };
    const getOptionText = (letter: string): string => { switch (letter) { case "A": return question.option_a; case "B": return question.option_b; case "C": return question.option_c; case "D": return question.option_d; default: return ""; } };
    const correctNum = getOptionNumber(question.correct_option);
    const correctText = getOptionText(question.correct_option);
    let replyText: string;
    if (isCorrect) { replyText = `آفرین! ✅ جواب درست بود.\n\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`; } else { replyText = `جوابت درست نبود ❌\n\nجواب صحیح: گزینه <b>${correctNum}</b> (${correctText})\nکلمه: <b>${question.english}</b>\nمعنی: <b>${question.persian}</b>`; }
    await sendMessage(env, chatId, replyText);
    await sendLeitnerQuestion(env, user, chatId);
  }
}
