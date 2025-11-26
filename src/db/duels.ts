import { Env } from "../types";
import { queryOne, queryAll, execute } from "./client";

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

// گرفتن یک مچ
export async function getDuelMatchById(env: Env, id: number): Promise<DuelMatch | null> {
  const m = await queryOne<DuelMatch>(
    env,
    `
    SELECT *
    FROM duel_matches
    WHERE id = ?
    `,
    [id]
  );
  return m ?? null;
}

// پیدا کردن مَچ منتظر حریف برای یک سختی مشخص
export async function findWaitingMatch(
  env: Env,
  difficulty: DuelDifficulty,
  userId: number
): Promise<DuelMatch | null> {
  const m = await queryOne<DuelMatch>(
    env,
    `
    SELECT *
    FROM duel_matches
    WHERE difficulty = ?
      AND status = 'waiting'
      AND player2_id IS NULL
      AND player1_id <> ?
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [difficulty, userId]
  );
  return m ?? null;
}

// ساخت مچ جدید با بازیکن ۱
export async function createDuelMatch(
  env: Env,
  difficulty: DuelDifficulty,
  userId: number
): Promise<DuelMatch> {
  const now = new Date().toISOString();

  await execute(
    env,
    `
    INSERT INTO duel_matches (difficulty, status, player1_id, created_at, started_at)
    VALUES (?, 'waiting', ?, ?, ?)
    `,
    [difficulty, userId, now, now]
  );

  const m = await queryOne<DuelMatch>(
    env,
    `
    SELECT *
    FROM duel_matches
    WHERE player1_id = ?
      AND difficulty = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [userId, difficulty]
  );

  if (!m) throw new Error("Failed to create duel match");

  return m;
}

// اضافه کردن بازیکن ۲ به مچ
export async function joinDuelMatch(
  env: Env,
  matchId: number,
  userId: number
): Promise<DuelMatch> {
  const now = new Date().toISOString();

  await execute(
    env,
    `
    UPDATE duel_matches
    SET player2_id = ?, status = 'in_progress', started_at = ?
    WHERE id = ?
    `,
    [userId, now, matchId]
  );

  const m = await getDuelMatchById(env, matchId);
  if (!m) throw new Error("Failed to join duel match");
  return m;
}

// ساخت سوال‌های مچ (اگر قبلاً ساخته نشده باشند)
export async function ensureDuelQuestions(
  env: Env,
  matchId: number,
  difficulty: DuelDifficulty
): Promise<void> {
  const countRow = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) AS cnt
    FROM duel_questions
    WHERE duel_id = ?
    `,
    [matchId]
  );

  const existing = countRow?.cnt ?? 0;
  if (existing > 0) {
    return; // قبلاً ساخته شده
  }

  const levelCond =
    difficulty === "easy"
      ? "AND level IN (1, 2)"
      : "AND level BETWEEN 1 AND 4";

  // برای سادگی، حتی اگر فقط یک واژه داریم، می‌توانیم چند بار از همان استفاده کنیم
  for (let idx = 1; idx <= QUESTION_COUNT; idx++) {
    const wordRow = await queryOne<{ id: number }>(
      env,
      `
      SELECT id
      FROM words
      WHERE is_active = 1
        ${levelCond}
      ORDER BY RANDOM()
      LIMIT 1
      `
    );

    if (!wordRow) {
      break;
    }

    const qRow = await queryOne<{ id: number }>(
      env,
      `
      SELECT id
      FROM word_questions
      WHERE word_id = ?
      ORDER BY RANDOM()
      LIMIT 1
      `,
      [wordRow.id]
    );

    if (!qRow) {
      break;
    }

    await execute(
      env,
      `
      INSERT INTO duel_questions (duel_id, question_index, word_id, word_question_id)
      VALUES (?, ?, ?, ?)
      `,
      [matchId, idx, wordRow.id, qRow.id]
    );
  }
}

// تعداد سوال‌های مچ
export async function getTotalQuestionsInMatch(env: Env, duelId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) AS cnt
    FROM duel_questions
    WHERE duel_id = ?
    `,
    [duelId]
  );

  return row?.cnt ?? 0;
}

// تعداد جواب‌هایی که این کاربر در این مچ داده
export async function getUserAnswerCountInMatch(
  env: Env,
  duelId: number,
  userId: number
): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) AS cnt
    FROM duel_answers
    WHERE duel_id = ?
      AND user_id = ?
    `,
    [duelId, userId]
  );

  return row?.cnt ?? 0;
}

// گرفتن سوال (با متن) بر اساس شماره سوال
export async function getDuelQuestionByIndex(
  env: Env,
  duelId: number,
  questionIndex: number
): Promise<DuelQuestionFull | null> {
  const row = await queryOne<DuelQuestionFull>(
    env,
    `
    SELECT
      dq.id AS duel_question_id,
      dq.duel_id,
      dq.question_index,
      w.id AS word_id,
      wq.id AS word_question_id,
      w.english,
      w.persian,
      w.level,
      wq.question_text,
      wq.option_a,
      wq.option_b,
      wq.option_c,
      wq.option_d,
      wq.correct_option
    FROM duel_questions dq
    JOIN word_questions wq ON dq.word_question_id = wq.id
    JOIN words w ON dq.word_id = w.id
    WHERE dq.duel_id = ?
      AND dq.question_index = ?
    `,
    [duelId, questionIndex]
  );

  return row ?? null;
}

// گرفتن سوال مچ بر اساس id خود duel_question
export async function getDuelQuestionById(
  env: Env,
  duelQuestionId: number
): Promise<DuelQuestionFull | null> {
  const row = await queryOne<DuelQuestionFull>(
    env,
    `
    SELECT
      dq.id AS duel_question_id,
      dq.duel_id,
      dq.question_index,
      w.id AS word_id,
      wq.id AS word_question_id,
      w.english,
      w.persian,
      w.level,
      wq.question_text,
      wq.option_a,
      wq.option_b,
      wq.option_c,
      wq.option_d,
      wq.correct_option
    FROM duel_questions dq
    JOIN word_questions wq ON dq.word_question_id = wq.id
    JOIN words w ON dq.word_id = w.id
    WHERE dq.id = ?
    `,
    [duelQuestionId]
  );

  return row ?? null;
}

// ثبت جواب یک سوال در دوئل
export async function recordDuelAnswer(
  env: Env,
  duelId: number,
  duelQuestionId: number,
  userId: number,
  chosenOption: string,
  isCorrect: boolean
): Promise<void> {
  const now = new Date().toISOString();

  await execute(
    env,
    `
    INSERT INTO duel_answers (duel_id, duel_question_id, user_id, chosen_option, is_correct, answered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [duelId, duelQuestionId, userId, chosenOption, isCorrect ? 1 : 0, now]
  );
}

// تعداد پاسخ‌های درست کاربر در این مچ
export async function getUserCorrectCountInMatch(
  env: Env,
  duelId: number,
  userId: number
): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) AS cnt
    FROM duel_answers
    WHERE duel_id = ?
      AND user_id = ?
      AND is_correct = 1
    `,
    [duelId, userId]
  );

  return row?.cnt ?? 0;
}

// اگر هر دو بازیکن همه سوال‌ها را پاسخ داده باشند، مچ را نهایی کن
export async function maybeFinalizeMatch(env: Env, duelId: number): Promise<DuelFinalizeResult | null> {
  let match = await getDuelMatchById(env, duelId);
  if (!match) return null;

  if (match.status === "completed") {
    return null;
  }

  if (!match.player1_id || !match.player2_id) {
    return null;
  }

  const totalQuestions = await getTotalQuestionsInMatch(env, duelId);
  if (totalQuestions === 0) return null;

  const p1Answers = await getUserAnswerCountInMatch(env, duelId, match.player1_id);
  const p2Answers = await getUserAnswerCountInMatch(env, duelId, match.player2_id);

  if (p1Answers < totalQuestions || p2Answers < totalQuestions) {
    return null;
  }

  const player1Correct = await getUserCorrectCountInMatch(env, duelId, match.player1_id);
  const player2Correct = await getUserCorrectCountInMatch(env, duelId, match.player2_id);

  let winnerUserId: number | null = null;
  let isDraw = 0;

  if (player1Correct > player2Correct) {
    winnerUserId = match.player1_id;
    isDraw = 0;
  } else if (player2Correct > player1Correct) {
    winnerUserId = match.player2_id;
    isDraw = 0;
  } else {
    winnerUserId = null;
    isDraw = 1;
  }

  const now = new Date().toISOString();

  await execute(
    env,
    `
    UPDATE duel_matches
    SET
      status = 'completed',
      player1_correct = ?,
      player2_correct = ?,
      winner_user_id = ?,
      is_draw = ?,
      completed_at = ?
    WHERE id = ?
    `,
    [player1Correct, player2Correct, winnerUserId, isDraw, now, duelId]
  );

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

