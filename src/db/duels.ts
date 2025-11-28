import { Env } from "../types";
import { queryOne, queryAll, execute, prepare } from "./client";
import { addXpForDuelMatch, checkAndUpdateStreak } from "./xp";
import { generateWordQuestionsWithGemini } from "../ai/gemini";
import { insertWordQuestions } from "./word_questions";

export type DuelDifficulty = "easy" | "hard";

export interface DuelMatch {
  id: number;
  difficulty: string;
  status: string;
  player1_id: number;
  player2_id: number | null;
  winner_user_id: number | null;
  is_draw: number;
  player1_correct: number;
  player2_correct: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface DuelQuestionFull {
  duel_question_id: number;
  duel_id: number;
  question_index: number;
  word_id: number;
  word_question_id: number;
  english: string;
  persian: string;
  level: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
}

export interface DuelFinalizeResult {
  completed: boolean;
  totalQuestions: number;
  player1Correct: number;
  player2Correct: number;
  winnerUserId: number | null;
  isDraw: boolean;
  match: DuelMatch;
}

const QUESTION_COUNT = 5;

export async function getDuelMatchById(env: Env, id: number): Promise<DuelMatch | null> {
  return await queryOne<DuelMatch>(env, `SELECT * FROM duel_matches WHERE id = ?`, [id]);
}

export async function findWaitingMatch(env: Env, difficulty: DuelDifficulty, userId: number): Promise<DuelMatch | null> {
  return await queryOne<DuelMatch>(
    env,
    `SELECT * FROM duel_matches WHERE difficulty = ? AND status = 'waiting' AND player2_id IS NULL AND player1_id <> ? ORDER BY created_at ASC LIMIT 1`,
    [difficulty, userId]
  );
}

export async function createDuelMatch(env: Env, difficulty: DuelDifficulty, userId: number): Promise<DuelMatch> {
  const now = new Date().toISOString();
  await execute(
    env,
    `INSERT INTO duel_matches (difficulty, status, player1_id, created_at, started_at) VALUES (?, 'waiting', ?, ?, ?)`,
    [difficulty, userId, now, now]
  );
  const m = await queryOne<DuelMatch>(
    env,
    `SELECT * FROM duel_matches WHERE player1_id = ? AND difficulty = ? ORDER BY id DESC LIMIT 1`,
    [userId, difficulty]
  );
  if (!m) throw new Error("Failed to create duel match");
  return m;
}

export async function joinDuelMatch(env: Env, matchId: number, userId: number): Promise<DuelMatch | null> {
  const now = new Date().toISOString();
  // Atomic Update: فقط اگر player2_id خالی است، آن را پر کن
  const result = await execute(
    env,
    `UPDATE duel_matches SET player2_id = ?, status = 'in_progress', started_at = ? WHERE id = ? AND player2_id IS NULL`,
    [userId, now, matchId]
  );

  // اگر هیچ ردیفی تغییر نکرد، یعنی یک نفر دیگر زودتر جوین شده
  if (result?.meta?.changes === 0) {
    return null;
  }

  const m = await getDuelMatchById(env, matchId);
  if (!m) throw new Error("Failed to join duel match");
  return m;
}

export async function ensureDuelQuestions(env: Env, matchId: number, difficulty: DuelDifficulty): Promise<void> {
  const countRow = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_questions WHERE duel_id = ?`, [matchId]);
  if ((countRow?.cnt ?? 0) > 0) return;

  const levelCond = difficulty === "easy" ? "AND level IN (1, 2)" : "AND level BETWEEN 1 AND 4";

  for (let idx = 1; idx <= QUESTION_COUNT; idx++) {
    const wordRow = await queryOne<{ id: number; english: string; persian: string; level: number }>(
      env,
      `SELECT id, english, persian, level FROM words WHERE is_active = 1 ${levelCond} ORDER BY RANDOM() LIMIT 1`
    );

    if (!wordRow) break;

    let qRow = await queryOne<{ id: number }>(
      env,
      `SELECT id FROM word_questions WHERE word_id = ? ORDER BY RANDOM() LIMIT 1`,
      [wordRow.id]
    );

    if (!qRow) {
      try {
        const styles = ["fa_meaning", "en_definition", "synonym", "antonym"];
        const randomStyle = styles[Math.floor(Math.random() * styles.length)];

        const aiQuestions = await generateWordQuestionsWithGemini({
          env,
          english: wordRow.english,
          persian: wordRow.persian,
          level: wordRow.level,
          questionStyle: randomStyle,
          count: 1
        });

        if (aiQuestions.length > 0) {
          await insertWordQuestions(
            env,
            wordRow.id,
            aiQuestions.map((q) => ({
              wordId: wordRow.id,
              questionText: q.question,
              options: q.options,
              correctIndex: q.correctIndex,
              explanation: q.explanation,
              questionStyle: randomStyle
            }))
          );

          qRow = await queryOne<{ id: number }>(
            env,
            `SELECT id FROM word_questions WHERE word_id = ? ORDER BY id DESC LIMIT 1`,
            [wordRow.id]
          );
        }
      } catch (err) {
        console.error("Failed to auto-generate duel question:", err);
      }
    }

    if (!qRow) continue;

    await execute(
      env,
      `INSERT INTO duel_questions (duel_id, question_index, word_id, word_question_id) VALUES (?, ?, ?, ?)`,
      [matchId, idx, wordRow.id, qRow.id]
    );
  }
}

export async function getTotalQuestionsInMatch(env: Env, duelId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_questions WHERE duel_id = ?`, [duelId]);
  return row?.cnt ?? 0;
}

export async function getUserAnswerCountInMatch(env: Env, duelId: number, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_answers WHERE duel_id = ? AND user_id = ?`, [duelId, userId]);
  return row?.cnt ?? 0;
}

export async function getDuelQuestionByIndex(env: Env, duelId: number, questionIndex: number): Promise<DuelQuestionFull | null> {
  return await queryOne<DuelQuestionFull>(
    env,
    `SELECT dq.id AS duel_question_id, dq.duel_id, dq.question_index, w.id AS word_id, wq.id AS word_question_id, w.english, w.persian, w.level, wq.question_text, wq.option_a, wq.option_b, wq.option_c, wq.option_d, wq.correct_option FROM duel_questions dq JOIN word_questions wq ON dq.word_question_id = wq.id JOIN words w ON dq.word_id = w.id WHERE dq.duel_id = ? AND dq.question_index = ?`,
    [duelId, questionIndex]
  );
}

export async function getDuelQuestionById(env: Env, duelQuestionId: number): Promise<DuelQuestionFull | null> {
  return await queryOne<DuelQuestionFull>(
    env,
    `SELECT dq.id AS duel_question_id, dq.duel_id, dq.question_index, w.id AS word_id, wq.id AS word_question_id, w.english, w.persian, w.level, wq.question_text, wq.option_a, wq.option_b, wq.option_c, wq.option_d, wq.correct_option FROM duel_questions dq JOIN word_questions wq ON dq.word_question_id = wq.id JOIN words w ON dq.word_id = w.id WHERE dq.id = ?`,
    [duelQuestionId]
  );
}

export function prepareRecordDuelAnswer(
  env: Env,
  duelId: number,
  duelQuestionId: number,
  userId: number,
  chosenOption: string,
  isCorrect: boolean
): any {
  const now = new Date().toISOString();
  return prepare(
    env,
    `INSERT INTO duel_answers (duel_id, duel_question_id, user_id, chosen_option, is_correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [duelId, duelQuestionId, userId, chosenOption, isCorrect ? 1 : 0, now]
  );
}

export async function recordDuelAnswer(env: Env, duelId: number, duelQuestionId: number, userId: number, chosenOption: string, isCorrect: boolean): Promise<void> {
  const stmt = prepareRecordDuelAnswer(env, duelId, duelQuestionId, userId, chosenOption, isCorrect);
  await env.DB.batch([stmt]);
}

export async function getUserCorrectCountInMatch(env: Env, duelId: number, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_answers WHERE duel_id = ? AND user_id = ? AND is_correct = 1`, [duelId, userId]);
  return row?.cnt ?? 0;
}

export async function maybeFinalizeMatch(env: Env, duelId: number): Promise<DuelFinalizeResult | null> {
  let match = await getDuelMatchById(env, duelId);
  if (!match) return null;
  if (match.status === "completed") return null;
  if (!match.player1_id || !match.player2_id) return null;

  const totalQuestions = await getTotalQuestionsInMatch(env, duelId);
  if (totalQuestions === 0) return null;

  const p1Answers = await getUserAnswerCountInMatch(env, duelId, match.player1_id);
  const p2Answers = await getUserAnswerCountInMatch(env, duelId, match.player2_id);

  if (p1Answers < totalQuestions || p2Answers < totalQuestions) return null;

  const player1Correct = await getUserCorrectCountInMatch(env, duelId, match.player1_id);
  const player2Correct = await getUserCorrectCountInMatch(env, duelId, match.player2_id);

  let winnerUserId: number | null = null;
  let isDraw = 0;

  if (player1Correct > player2Correct) { winnerUserId = match.player1_id; isDraw = 0; }
  else if (player2Correct > player1Correct) { winnerUserId = match.player2_id; isDraw = 0; }
  else { winnerUserId = null; isDraw = 1; }

  const now = new Date().toISOString();

  const result = await execute(
    env,
    `UPDATE duel_matches SET status = 'completed', player1_correct = ?, player2_correct = ?, winner_user_id = ?, is_draw = ?, completed_at = ? WHERE id = ? AND status != 'completed'`,
    [player1Correct, player2Correct, winnerUserId, isDraw, now, duelId]
  );

  if (result?.meta?.changes === 0) return null;

  match = await getDuelMatchById(env, duelId);
  if (!match) throw new Error("Duel match disappeared after finalize");

  return {
    completed: true,
    totalQuestions,
    player1Correct,
    player2Correct,
    winnerUserId,
    isDraw: match.is_draw === 1,
    match
  };
}

// پاکسازی هوشمند: پایان دادن به دوئل‌های رها شده و دادن امتیاز
export async function cleanupOldMatches(env: Env): Promise<void> {
  // 1. پیدا کردن بازی‌هایی که بیش از ۱ ساعت در وضعیت in_progress مانده‌اند
  const stuckMatches = await queryAll<DuelMatch>(
    env,
    `SELECT * FROM duel_matches 
     WHERE status = 'in_progress' 
     AND started_at < datetime('now', '-1 hour')`
  );

  for (const match of stuckMatches) {
    // محاسبه امتیازات تا این لحظه
    const p1Correct = await getUserCorrectCountInMatch(env, match.id, match.player1_id);
    const p2Correct = match.player2_id ? await getUserCorrectCountInMatch(env, match.id, match.player2_id) : 0;
    
    let winnerUserId: number | null = null;
    let isDraw = 0;
    
    // تعیین برنده بر اساس امتیازات فعلی (کسی که جا زده احتمالا امتیاز کمتری دارد)
    if (p1Correct > p2Correct) {
       winnerUserId = match.player1_id;
       isDraw = 0;
    } else if (p2Correct > p1Correct) {
       winnerUserId = match.player2_id;
       isDraw = 0;
    } else {
       winnerUserId = null;
       isDraw = 1;
    }

    const now = new Date().toISOString();

    // وضعیت بازی را به 'completed' تغییر می‌دهیم
    await execute(
      env,
      `UPDATE duel_matches 
       SET status = 'completed', 
           player1_correct = ?, 
           player2_correct = ?, 
           winner_user_id = ?, 
           is_draw = ?, 
           completed_at = ? 
       WHERE id = ?`,
      [p1Correct, p2Correct, winnerUserId, isDraw, now, match.id]
    );

    // محاسبه و واریز XP برای بازیکن اول
    const totalQ = 5; // فرض بر ۵ سوال
    let p1Result: "win" | "draw" | "lose" = "lose";
    if (isDraw) p1Result = "draw";
    else if (winnerUserId === match.player1_id) p1Result = "win";
    
    await addXpForDuelMatch(env, match.player1_id, match.id, p1Correct, totalQ, p1Result);
    await checkAndUpdateStreak(env, match.player1_id); // حفظ زنجیره

    // محاسبه و واریز XP برای بازیکن دوم (اگر وجود داشته باشد)
    if (match.player2_id) {
       let p2Result: "win" | "draw" | "lose" = "lose";
       if (isDraw) p2Result = "draw";
       else if (winnerUserId === match.player2_id) p2Result = "win";
       
       await addXpForDuelMatch(env, match.player2_id, match.id, p2Correct, totalQ, p2Result);
       await checkAndUpdateStreak(env, match.player2_id); // حفظ زنجیره
    }
  }

  // 2. پاکسازی کامل دوئل‌های 'waiting' خیلی قدیمی (زباله‌روبی)
  // الف) حذف جواب‌ها
  await execute(
    env,
    `DELETE FROM duel_answers 
     WHERE duel_id IN (
       SELECT id FROM duel_matches 
       WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')
     )`
  );

  // ب) حذف سوالات
  await execute(
    env,
    `DELETE FROM duel_questions 
     WHERE duel_id IN (
       SELECT id FROM duel_matches 
       WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')
     )`
  );

  // ج) حذف خود مچ
  await execute(
    env,
    `DELETE FROM duel_matches 
     WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')`
  );
}
