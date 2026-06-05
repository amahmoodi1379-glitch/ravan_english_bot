import { Env } from "../types";
import { queryOne, execute, prepare } from "./client";
import { sm2 } from "../utils/sm2";
import { TIME_ZONE_OFFSET } from "../config/constants";

export interface DbWord {
  id: number;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
  synonyms: string | null;
  antonyms: string | null;
  order_index: number;
}

export interface UserWordState {
  id: number;
  user_id: number;
  word_id: number;
  interval_days: number;
  repetitions: number;
  ease_factor: number;
  next_review_date: string;
  last_reviewed_at: string | null;
  ignored: number;
  correct_streak: number;
  question_stage: number;
}

export async function pickNextWordForUser(env: Env, userId: number): Promise<DbWord | null> {
  const wordRow = await queryOne<DbWord>(
    env,
    `
    SELECT w.id, w.english, w.persian, w.level, w.lesson_name, w.synonyms, w.antonyms, w.order_index
    FROM (
      SELECT wid, priority FROM (
        SELECT s.word_id as wid, 1 as priority
        FROM user_words_sm2 s
        JOIN words w2 ON w2.id = s.word_id
        WHERE s.user_id = ?
          AND s.ignored = 0
          AND w2.is_active = 1
          AND date(s.next_review_date) <= date('now', '${TIME_ZONE_OFFSET}')
        ORDER BY date(s.next_review_date) ASC, w2.order_index ASC
        LIMIT 1
      )

      UNION ALL

      SELECT wid, priority FROM (
        SELECT w3.id as wid, 2 as priority
        FROM words w3
        WHERE w3.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_words_sm2 s2
            WHERE s2.user_id = ? AND s2.word_id = w3.id
          )
        ORDER BY w3.order_index ASC, w3.id ASC
        LIMIT 1
      )

      UNION ALL

      SELECT wid, priority FROM (
        SELECT s3.word_id as wid, 3 as priority
        FROM user_words_sm2 s3
        JOIN words w4 ON w4.id = s3.word_id
        WHERE s3.user_id = ?
          AND s3.ignored = 0
          AND w4.is_active = 1
          AND (
            s3.last_reviewed_at IS NULL
            OR julianday('now', '${TIME_ZONE_OFFSET}') - julianday(s3.last_reviewed_at) >= s3.interval_days * 0.5
          )
        ORDER BY date(s3.next_review_date) ASC, w4.order_index ASC
        LIMIT 1
      )
    ) candidates
    JOIN words w ON w.id = candidates.wid
    ORDER BY candidates.priority ASC
    LIMIT 1
    `,
    [userId, userId, userId]
  );

  return wordRow ?? null;
}

export async function getOrCreateUserWordState(
  env: Env,
  userId: number,
  wordId: number
): Promise<UserWordState> {
  let state = await queryOne<UserWordState>(
    env,
    `SELECT * FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );

  if (state) return state;

  const nowIso = new Date().toISOString();

  try {
    await execute(
      env,
      `
      INSERT INTO user_words_sm2
        (user_id, word_id, interval_days, repetitions, ease_factor, next_review_date, question_stage, created_at)
      VALUES (?, ?, 1, 0, 2.5, ?, 1, ?)
      `,
      [userId, wordId, nowIso, nowIso]
    );
  } catch (e) {
    console.warn("Race condition caught in getOrCreateUserWordState (duplicate insert avoided).");
  }

  state = await queryOne<UserWordState>(
    env,
    `SELECT * FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );

  if (!state) throw new Error("Failed to create user_words_sm2 state");
  return state;
}

function addDaysToIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function normalizeQuestionStage(stage: number | null | undefined): number {
  if (!stage || stage < 1) return 1;
  if (stage > 5) return 5;
  return stage;
}

export async function prepareUpdateSm2(
  env: Env,
  userId: number,
  wordId: number,
  isCorrect: boolean
): Promise<any[]> {
  let state = await queryOne<UserWordState>(
    env,
    `SELECT * FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );

  if (!state) {
    state = await getOrCreateUserWordState(env, userId, wordId);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const quality = isCorrect ? 4 : 2;

  let usedInterval = state.interval_days || 1;

  if (state.last_reviewed_at) {
    const lastReviewDate = new Date(state.last_reviewed_at);
    const diffMs = now.getTime() - lastReviewDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    usedInterval = diffDays;
    if (usedInterval < 1) usedInterval = 1;
  }

  const STAGE_MAX_INTERVAL: Record<number, number> = {
    1: 3,
    2: 7,
    3: 14,
    4: 30,
    5: 60,
  };
  const maxInterval = STAGE_MAX_INTERVAL[state.question_stage || 1] || 60;

  const sm2Result = sm2(
    {
      interval: usedInterval,
      repetition: state.repetitions || 0,
      ef: state.ease_factor || 2.5
    },
    quality,
    maxInterval
  );

  const nextReviewIso = addDaysToIso(nowIso, sm2Result.interval);

  let newStage = normalizeQuestionStage(state.question_stage);
  let newCorrectStreak = state.correct_streak || 0;

  if (!isCorrect) {
    newStage = Math.max(1, (state.question_stage || 1) - 2);
    newCorrectStreak = 0;
  } else {
    newCorrectStreak += 1;
    if (newStage < 5) newStage++;
  }

  const stmt = prepare(
    env,
    `
    UPDATE user_words_sm2
    SET interval_days = ?,
        repetitions = ?,
        ease_factor = ?,
        next_review_date = ?,
        last_reviewed_at = ?,
        correct_streak = ?,
        question_stage = ?,
        updated_at = ?
    WHERE id = ?
    `,
    [
      sm2Result.interval,
      sm2Result.repetition,
      sm2Result.ef,
      nextReviewIso,
      nowIso,
      newCorrectStreak,
      newStage,
      nowIso,
      state.id
    ]
  );

  return [stmt];
}

export async function markWordAsIgnored(env: Env, userId: number, wordId: number): Promise<void> {
  const now = new Date().toISOString();
  const row = await queryOne<{ id: number }>(
    env,
    "SELECT id FROM user_words_sm2 WHERE user_id = ? AND word_id = ?",
    [userId, wordId]
  );

  if (row) {
    await execute(
      env,
      "UPDATE user_words_sm2 SET ignored = 1, updated_at = ? WHERE id = ?",
      [now, row.id]
    );
  } else {
    await execute(
      env,
      `
      INSERT INTO user_words_sm2
        (user_id, word_id, interval_days, repetitions, ease_factor, next_review_date, question_stage, ignored, created_at)
      VALUES (?, ?, 1, 0, 2.5, ?, 1, 1, ?)
      `,
      [userId, wordId, now, now]
    );
  }
}
