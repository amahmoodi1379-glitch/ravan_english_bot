// ... (ایمپورت‌ها، شامل prepareRecordAnswer) ...
import { prepareRecordAnswer } from "../../db/reading";

// ...

export async function handleReadingAnswerCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  // ... (بخش‌های اولیه بدون تغییر) ...
  // ... (گرفتن question و user و session) ...

  const isCorrect = chosenOption === question.correct_option;

  // ⚡️ BATCH ⚡️
  const stmts = prepareRecordAnswer(env, session, user.id, questionId, isCorrect);
  await env.DB.batch(stmts);
  // ⚡️

  await answerCallbackQuery(env, callbackQuery.id);

  // ... (بقیه کد) ...
}

async function sendReadingSummary(env: Env, user: DbUser, session: ReadingSession, chatId: number): Promise<void> {
  // ... (محاسبه آمار) ...
  
  const { totalXp, stmts: xpStmts } = calculateAndPrepareXpForReading(env, user.id, session.id, correct, total);
  
  const batchStatements: any[] = [...xpStmts];

  if (totalXp > 0) {
    batchStatements.push(prepareUpdateSessionXp(env, session.id, totalXp));
  }
  
  // Mark as completed
  const now = new Date().toISOString();
  batchStatements.push(prepare(env, `UPDATE reading_sessions SET status = 'completed', completed_at = ? WHERE id = ?`, [now, session.id]));

  await env.DB.batch(batchStatements);

  // ... (ارسال پیام) ...
}
