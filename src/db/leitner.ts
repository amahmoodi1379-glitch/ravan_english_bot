import { Env } from "../types";
import { queryOne, execute, prepare } from "./client"; // Import prepare
import { sm2 } from "../utils/sm2";

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
  // 1) اولویت مرور
  const dueRow = await queryOne<{ word_id: number }>(
    env,
    `
    SELECT s.word_id
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND date(s.next_review_date) <= date('now')
    ORDER BY date(s.next_review_date) ASC, w.order_index ASC
    LIMIT 1
    `,
    [userId]
  );

  let wordId: number | null = null;

  if (dueRow) {
    wordId = dueRow.word_id;
  } else {
    // 2) واژه‌های جدید
    const newRow = await queryOne<{ id: number }>(
      env,
      `
      SELECT w.id
      FROM words w
      WHERE w.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM user_words_sm2 s
          WHERE s.user_id = ? AND s.word_id = w.id
        )
      ORDER BY w.order_index ASC, w.id ASC
      LIMIT 1
      `,
      [userId]
    );

    if (newRow) {
      wordId = newRow.id;
    } else {
      // 3) پیش‌خوانی
      const anyRow = await queryOne<{ word_id: number }>(
        env,
        `
        SELECT s.word_id
        FROM user_words_sm2 s
        JOIN words w ON w.id = s.word_id
        WHERE s.user_id = ?
          AND s.ignored = 0
          AND w.is_active = 1
        ORDER BY date(s.next_review_date) ASC, w.order_index ASC
        LIMIT 1
        `,
        [userId]
      );
      if (anyRow) wordId = anyRow.word_id;
    }
  }

  if (!wordId) return null;

  return await queryOne<DbWord>(
    env,
    `SELECT * FROM words WHERE id = ?`,
    [wordId]
  );
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
  await execute(
    env,
    `
    INSERT INTO user_words_sm2
      (user_id, word_id, interval_days, repetitions, ease_factor, next_review_date, question_stage, created_at)
    VALUES (?, ?, 1, 0, 2.5, ?, 1, ?)
    `,
    [userId, wordId, nowIso, nowIso]
  );

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

// NEW: نسخه‌ی آماده‌ساز (Prepare) برای Batch
export async function prepareUpdateSm2(
  env: Env,
  userId: number,
  wordId: number,
  isCorrect: boolean
): Promise<any[]> {
  // چون state را باید بخوانیم، نمی‌توانیم این بخش را کاملاً خالص کنیم،
  // اما خواندن اشکالی ندارد، نوشتن مهم است که batch شود.
  
  let state = await queryOne<UserWordState>(
    env,
    `SELECT * FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );

  // اگر استیت نبود، باید بسازیمش. اینجا مجبوریم یک execute داشته باشیم 
  // (چون id رکورد جدید را برای آپدیت نیاز داریم).
  // اما چون این حالت نادره (معمولا getOrCreate قبلش صدا شده)، ریسک کمی داره.
  if (!state) {
    state = await getOrCreateUserWordState(env, userId, wordId);
  }

  const nowIso = new Date().toISOString();
  const quality = isCorrect ? 5 : 2;

  const sm2Result = sm2(
    {
      interval: state.interval_days || 1,
      repetition: state.repetitions || 0,
      ef: state.ease_factor || 2.5
    },
    quality
  );

  const nextReviewIso = addDaysToIso(nowIso, sm2Result.interval);

  let newStage = state.question_stage || 1;
  let newCorrectStreak = state.correct_streak || 0;

  if (!isCorrect) {
    newStage = 1;
    newCorrectStreak = 0;
  } else {
    newCorrectStreak += 1;
    if (newStage < 4) newStage++;
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

// تابع قدیمی برای سازگاری
export async function updateSm2AndStageAfterAnswer(env: Env, userId: number, wordId: number, isCorrect: boolean): Promise<void> {
  const stmts = await prepareUpdateSm2(env, userId, wordId, isCorrect);
  if (stmts.length > 0) await env.DB.batch(stmts);
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
