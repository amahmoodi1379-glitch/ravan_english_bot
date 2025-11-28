import { Env } from "../../types";
import { pickNextWordForUser, getOrCreateUserWordState, prepareUpdateSm2 } from "../../db/leitner";
import { queryOne, prepare, execute } from "../../db/client";
import { prepareXpForLeitner, checkAndUpdateStreak } from "../../db/xp";

// تابع ۱: دریافت سوال بعدی (برای نمایش در مینی‌اپ)
export async function getNextLeitnerQuestionAPI(env: Env, userId: number): Promise<Response> {
  const word = await pickNextWordForUser(env, userId);

  if (!word) {
    return new Response(JSON.stringify({ status: 'empty' }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const question = await queryOne<{
    id: number; 
    question_text: string; 
    option_a: string; 
    option_b: string; 
    option_c: string; 
    option_d: string;
  }>(env, 
    `SELECT * FROM word_questions WHERE word_id = ? ORDER BY RANDOM() LIMIT 1`, 
    [word.id]
  );

  if (!question) {
     return new Response(JSON.stringify({ status: 'empty' }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({
    status: 'ok',
    id: question.id,
    word: word.english,
    question: question.question_text,
    options: [question.option_a, question.option_b, question.option_c, question.option_d]
  }), {
    headers: { "Content-Type": "application/json" }
  });
}

// تابع ۲: ثبت جواب کاربر (ذخیره در دیتابیس)
export async function submitAnswerAPI(env: Env, userId: number, questionId: number, selectedOption: string): Promise<Response> {
  // 1. پیدا کردن سوال و جواب درست
  const question = await queryOne<{
    id: number;
    word_id: number;
    correct_option: string;
    level: number;
  }>(env, `SELECT q.id, q.word_id, q.correct_option, w.level FROM word_questions q JOIN words w ON q.word_id = w.id WHERE q.id = ?`, [questionId]);

  if (!question) {
    return new Response(JSON.stringify({ error: "Question not found" }), { status: 404 });
  }

  // 2. بررسی درستی جواب
  const isCorrect = selectedOption === question.correct_option;
  const now = new Date().toISOString();

  // 3. آماده‌سازی عملیات دیتابیس
  const batchStatements: any[] = [];

  batchStatements.push(prepare(
    env,
    `INSERT INTO user_word_question_history (user_id, word_id, question_id, context, is_correct, shown_at, answered_at) VALUES (?, ?, ?, 'leitner_miniapp', ?, ?, ?)`,
    [userId, question.word_id, questionId, isCorrect ? 1 : 0, now, now]
  ));

  const sm2Stmts = await prepareUpdateSm2(env, userId, question.word_id, isCorrect);
  batchStatements.push(...sm2Stmts);

  let xpGained = 0;
  if (isCorrect) {
    const xpStmts = prepareXpForLeitner(env, userId, question.word_id, question.level, true);
    batchStatements.push(...xpStmts);
    xpGained = [5, 8, 12, 16][question.level - 1] || 5; 
  }

  if (batchStatements.length > 0) {
    await env.DB.batch(batchStatements);
  }

  let streakMessage = null;
  if (isCorrect) {
    streakMessage = await checkAndUpdateStreak(env, userId);
  }

  return new Response(JSON.stringify({
    status: 'ok',
    correct: isCorrect,
    correctOption: question.correct_option,
    xp: xpGained,
    streak: streakMessage
  }), {
    headers: { "Content-Type": "application/json" }
  });
}
