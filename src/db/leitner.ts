import { Env } from "../types";
import { queryOne, execute } from "./client";
import { sm2 } from "../utils/sm2";

// شکل واژه در دیتابیس
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

// وضعیت SM2 و stage برای هر user-word
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

// انتخاب واژه‌ی بعدی برای یک کاربر (بر اساس SM2 و واژه‌های جدید)
export async function pickNextWordForUser(env: Env, userId: number): Promise<DbWord | null> {
  // 1) اول واژه‌هایی که موعد مرورشان رسیده
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
    // 2) اگر چیزی برای مرور نیست، واژه‌ی جدیدی که هنوز برای این کاربر وارد SM2 نشده
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
      // 3) اگر نه واژه‌ی جدید هست و نه چیزی موعدش رسیده، کم‌کم زودترین موعد آینده را مرور می‌کنیم
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

      if (anyRow) {
        wordId = anyRow.word_id;
      }
    }
  }

  if (!wordId) {
    return null;
  }

  const word = await queryOne<DbWord>(
    env,
    `
    SELECT id, english, persian, level, lesson_name, synonyms, antonyms, order_index
    FROM words
    WHERE id = ?
    `,
    [wordId]
  );

  return word ?? null;
}

// گرفتن یا ساختن رکورد SM2 برای یک user-word
export async function getOrCreateUserWordState(
  env: Env,
  userId: number,
  wordId: number
): Promise<UserWordState> {
  let state = await queryOne<UserWordState>(
    env,
    `
    SELECT *
    FROM user_words_sm2
    WHERE user_id = ? AND word_id = ?
    `,
    [userId, wordId]
  );

  if (state) return state;

  const nowIso = new Date().toISOString();

  // اگر وجود نداشت، یک رکورد جدید می‌سازیم
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
    `
    SELECT *
    FROM user_words_sm2
    WHERE user_id = ? AND word_id = ?
    `,
    [userId, wordId]
  );

  if (!state) {
    throw new Error("Failed to create user_words_sm2 state");
  }

  return state;
}

// تابع کمکی برای اضافه کردن روز به یک تاریخ ISO
function addDaysToIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// آپدیت SM2 و question_stage بعد از جواب
export async function updateSm2AndStageAfterAnswer(
  env: Env,
  userId: number,
  wordId: number,
  isCorrect: boolean
): Promise<void> {
  let state = await queryOne<UserWordState>(
    env,
    `
    SELECT *
    FROM user_words_sm2
    WHERE user_id = ? AND word_id = ?
    `,
    [userId, wordId]
  );

  if (!state) {
    state = await getOrCreateUserWordState(env, userId, wordId);
  }

  const nowIso = new Date().toISOString();

  // SM2: کیفیت را بر اساس درست/غلط تعیین می‌کنیم
  const quality = isCorrect ? 5 : 2;

  const sm2Result = sm2(
    {
      interval: state.interval_days || 1,
      repetition: state.repetitions || 0,
      ef: state.ease_factor || 2.5
    },
    quality
  );

  const newInterval = sm2Result.interval;
  const newReps = sm2Result.repetition;
  const newEf = sm2Result.ef;
  const nextReviewIso = addDaysToIso(nowIso, newInterval);

  // به‌روزرسانی question_stage طبق قانون تو
  let newStage = state.question_stage || 1;
  let newCorrectStreak = state.correct_streak || 0;

  if (!isCorrect) {
    // هرجا غلط → stage = 1
    newStage = 1;
    newCorrectStreak = 0;
  } else {
    newCorrectStreak += 1;
    if (newStage === 1) {
      newStage = 2;
    } else if (newStage === 2) {
      newStage = 3;
    } else if (newStage === 3) {
      newStage = 4;
    } else {
      // stage 4 → همون 4 می‌مونه
      newStage = 4;
    }
  }

  await execute(
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
      newInterval,
      newReps,
      newEf,
      nextReviewIso,
      nowIso,
      newCorrectStreak,
      newStage,
      nowIso,
      state.id
    ]
  );
}

// NEW: نادیده گرفتن واژه (بلدم)
export async function markWordAsIgnored(env: Env, userId: number, wordId: number): Promise<void> {
  const now = new Date().toISOString();

  // چک می‌کنیم رکورد هست یا نه
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
    // اگر هنوز رکوردی ساخته نشده بود، می‌سازیم و مستقیم ignored=1 می‌کنیم
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
