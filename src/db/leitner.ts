import { Env } from "../types";
import { queryOne, execute, prepare } from "./client";
import { schedule, Rating, CardState, FsrsCard } from "../utils/fsrs";
import { TIME_ZONE_OFFSET, LEITNER_LEECH_THRESHOLD } from "../config/constants";

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
  // FSRS fields
  stability: number;
  difficulty: number;
  card_state: number;
  lapses: number;
  reps: number;
}

export interface ReviewStats {
  correct: number;
  incorrect: number;
  total: number;
}

/**
 * Count words due for review today (FSRS scheduling).
 * Only counts words that actually have at least one question.
 */
export async function countDueWords(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND s.card_state != 0
      AND date(s.next_review_date) <= date('now', '${TIME_ZONE_OFFSET}')
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    `,
    [userId]
  );
  return row?.cnt ?? 0;
}

/**
 * Count new words available (never seen by user) that have at least one question.
 */
export async function countNewWords(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt
    FROM words w
    WHERE w.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM user_words_sm2 s
        WHERE s.user_id = ? AND s.word_id = w.id
      )
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    `,
    [userId]
  );
  return row?.cnt ?? 0;
}

/**
 * Pick the next word due for review (only words the user has already seen).
 * Priority: most overdue first. Only words with at least one question.
 */
export async function pickNextReviewWord(env: Env, userId: number): Promise<DbWord | null> {
  const row = await queryOne<DbWord>(
    env,
    `
    SELECT w.id, w.english, w.persian, w.level, w.lesson_name, w.synonyms, w.antonyms, w.order_index
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND s.card_state != 0
      AND date(s.next_review_date) <= date('now', '${TIME_ZONE_OFFSET}')
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    ORDER BY date(s.next_review_date) ASC, w.order_index ASC
    LIMIT 1
    `,
    [userId]
  );
  return row ?? null;
}

/**
 * Pick the next new word for the user to learn.
 * Skips words with the same English spelling as the most recently shown word
 * to avoid boring repetition of homographs.
 */
export async function pickNextNewWord(env: Env, userId: number): Promise<DbWord | null> {
  // Get the last word this user was shown in leitner context
  const lastWord = await queryOne<{ english: string }>(
    env,
    `SELECT w.english FROM user_word_question_history h
     JOIN words w ON w.id = h.word_id
     WHERE h.user_id = ? AND h.context = 'leitner'
     ORDER BY h.shown_at DESC LIMIT 1`,
    [userId]
  );

  const lastEnglish = lastWord?.english ?? null;

  // If we have a last word, try to exclude words with same english text
  if (lastEnglish) {
    const row = await queryOne<DbWord>(
      env,
      `
      SELECT w.id, w.english, w.persian, w.level, w.lesson_name, w.synonyms, w.antonyms, w.order_index
      FROM words w
      WHERE w.is_active = 1
        AND LOWER(w.english) != LOWER(?)
        AND NOT EXISTS (
          SELECT 1 FROM user_words_sm2 s
          WHERE s.user_id = ? AND s.word_id = w.id
        )
        AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
      ORDER BY w.order_index ASC, w.id ASC
      LIMIT 1
      `,
      [lastEnglish, userId]
    );

    if (row) return row;
  }

  // Fallback: just pick the next one in order (even if same english)
  const row = await queryOne<DbWord>(
    env,
    `
    SELECT w.id, w.english, w.persian, w.level, w.lesson_name, w.synonyms, w.antonyms, w.order_index
    FROM words w
    WHERE w.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM user_words_sm2 s
        WHERE s.user_id = ? AND s.word_id = w.id
      )
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    ORDER BY w.order_index ASC, w.id ASC
    LIMIT 1
    `,
    [userId]
  );
  return row ?? null;
}

/**
 * Get or create the user's FSRS state for a word.
 */
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
        (user_id, word_id, interval_days, repetitions, ease_factor, next_review_date,
         question_stage, stability, difficulty, card_state, lapses, reps, created_at)
      VALUES (?, ?, 0, 0, 2.5, ?, 1, 0, 0, 0, 0, 0, ?)
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

/**
 * Prepare the DB statements to update a card's FSRS state after a review.
 */
export async function prepareUpdateFsrs(
  env: Env,
  userId: number,
  wordId: number,
  rating: Rating
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

  // Build FSRS card from DB state
  const card: FsrsCard = {
    stability: state.stability || 0,
    difficulty: state.difficulty || 0,
    state: (state.card_state || 0) as CardState,
    lastReview: state.last_reviewed_at,
    reps: state.reps || 0,
    lapses: state.lapses || 0,
  };

  // Run FSRS scheduling
  const result = schedule(card, rating, now);

  // Lapses (Again) become due again immediately (same day) so the user can
  // relearn them within the session; successful ratings are scheduled forward.
  const nextReviewIso = rating === Rating.Again
    ? nowIso
    : addDaysToIso(nowIso, result.interval);

  // Update question stage based on rating (preserve stage system for question variety)
  let newStage = state.question_stage || 1;
  let newCorrectStreak = state.correct_streak || 0;

  if (rating === Rating.Again) {
    newStage = Math.max(1, newStage - 2);
    newCorrectStreak = 0;
  } else if (rating === Rating.Hard) {
    newStage = Math.max(1, newStage - 1);
    newCorrectStreak = 0;
  } else {
    newCorrectStreak += 1;
    if (rating === Rating.Easy && newStage < 5) {
      newStage = Math.min(5, newStage + 2);
    } else if (newStage < 5) {
      newStage += 1;
    }
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
        stability = ?,
        difficulty = ?,
        card_state = ?,
        lapses = ?,
        reps = ?,
        updated_at = ?
    WHERE id = ?
    `,
    [
      result.interval,
      result.reps,
      2.5, // keep ease_factor for legacy compat (not used by FSRS)
      nextReviewIso,
      nowIso,
      newCorrectStreak,
      newStage,
      result.stability,
      result.difficulty,
      result.state,
      result.lapses,
      result.reps,
      nowIso,
      state.id
    ]
  );

  return [stmt];
}

/**
 * Mark a word as ignored (remove from review cycle).
 */
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
        (user_id, word_id, interval_days, repetitions, ease_factor, next_review_date,
         question_stage, ignored, stability, difficulty, card_state, lapses, reps, created_at)
      VALUES (?, ?, 0, 0, 2.5, ?, 1, 1, 0, 0, 0, 0, 0, ?)
      `,
      [userId, wordId, now, now]
    );
  }
}

/**
 * Get review stats for a user in the last N hours.
 */
export async function getReviewStats(env: Env, userId: number, hours: number = 24): Promise<ReviewStats> {
  const row = await queryOne<{ correct: number; incorrect: number; total: number }>(
    env,
    `
    SELECT
      COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) as correct,
      COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) as incorrect,
      COUNT(*) as total
    FROM user_word_question_history
    WHERE user_id = ?
      AND context = 'leitner'
      AND answered_at IS NOT NULL
      AND datetime(answered_at) >= datetime('now', '-${hours} hours')
    `,
    [userId]
  );
  return row ?? { correct: 0, incorrect: 0, total: 0 };
}

/**
 * Read a word's question_stage WITHOUT creating a state row.
 * Returns 1 (default) if the user has no state for this word yet.
 * This is important so that merely *showing* a new-word question does not
 * create a half-initialized row that would orphan the word.
 */
export async function getWordStage(env: Env, userId: number, wordId: number): Promise<number> {
  const row = await queryOne<{ question_stage: number }>(
    env,
    `SELECT question_stage FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );
  return row?.question_stage || 1;
}

/**
 * Count "leech" words: words the user has failed (lapsed) at least
 * LEITNER_LEECH_THRESHOLD times. These are the hardest words.
 */
export async function countLeechWords(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `
    SELECT COUNT(*) as cnt
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND s.lapses >= ?
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    `,
    [userId, LEITNER_LEECH_THRESHOLD]
  );
  return row?.cnt ?? 0;
}

/**
 * Pick the next leech word to practice. Rotates by least-recently-reviewed
 * so the user cycles through all their hard words rather than getting stuck.
 */
export async function pickNextLeechWord(env: Env, userId: number): Promise<DbWord | null> {
  const row = await queryOne<DbWord>(
    env,
    `
    SELECT w.id, w.english, w.persian, w.level, w.lesson_name, w.synonyms, w.antonyms, w.order_index
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND s.lapses >= ?
      AND EXISTS (SELECT 1 FROM word_questions q WHERE q.word_id = w.id)
    ORDER BY (s.last_reviewed_at IS NULL) DESC, s.last_reviewed_at ASC, w.order_index ASC
    LIMIT 1
    `,
    [userId, LEITNER_LEECH_THRESHOLD]
  );
  return row ?? null;
}

/**
 * Remove a word from the "hard words" list by resetting its lapse counter.
 * The word stays in the normal review cycle (it just isn't a leech anymore).
 */
export async function clearLeech(env: Env, userId: number, wordId: number): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    env,
    `UPDATE user_words_sm2 SET lapses = 0, updated_at = ? WHERE user_id = ? AND word_id = ?`,
    [now, userId, wordId]
  );
}
