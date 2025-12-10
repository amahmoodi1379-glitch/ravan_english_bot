import { Env } from "../types";
import { queryOne, execute, prepare } from "./client"; 
import { sm2 } from "../utils/sm2";
// TIME_ZONE_OFFSET را حذف کردیم چون برای دقت ۱۰ دقیقه، باید از ساعت جهانی استفاده کنیم

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
  // 1) اولویت مرور (واژه‌هایی که زمان مرورشان رسیده است)
  // تغییر: استفاده از datetime('now') برای مقایسه دقیق زمانی (پشتیبانی از مرور ۱۰ دقیقه‌ای)
  const dueRow = await queryOne<{ word_id: number }>(
    env,
    `
    SELECT s.word_id
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ?
      AND s.ignored = 0
      AND w.is_active = 1
      AND s.next_review_date <= datetime('now')
    ORDER BY s.next_review_date ASC, w.order_index ASC
    LIMIT 1
    `,
    [userId]
  );

  let wordId: number | null = null;

  if (dueRow) {
    wordId = dueRow.word_id;
  } else {
    // 2) واژه‌های جدید (که هنوز وارد لایتنر نشده‌اند)
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
      // 3) پیش‌خوانی (اگر همه چیز تمام شده، واژه‌های آینده را بیار)
      // تغییر مهم: اضافه کردن شرط last_reviewed_at برای جلوگیری از تکرار واژه‌ای که همین الان دیدیم
      const anyRow = await queryOne<{ word_id: number }>(
        env,
        `
        SELECT s.word_id
        FROM user_words_sm2 s
        JOIN words w ON w.id = s.word_id
        WHERE s.user_id = ?
          AND s.ignored = 0
          AND w.is_active = 1
          AND (s.last_reviewed_at IS NULL OR s.last_reviewed_at < datetime('now', '-1 hour'))
        ORDER BY s.next_review_date ASC, w.order_index ASC
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
  // 1. تلاش اول: آیا قبلاً وضعیت لایتنر برای این کلمه وجود دارد؟
  let state = await queryOne<UserWordState>(
    env,
    `SELECT * FROM user_words_sm2 WHERE user_id = ? AND word_id = ?`,
    [userId, wordId]
  );

  // اگر بود، همونو برگردون و تمام.
  if (state) return state;

  const nowIso = new Date().toISOString();

  // 2. تلاش برای ساختن رکورد جدید
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

  // 3. تلاش دوم
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
  // استفاده از UTC برای دقت بیشتر
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// تابع اصلی که منطق آن اصلاح شده است
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
  const quality = isCorrect ? 5 : 2;

  // محاسبه بازه فعلی
  let usedInterval = state.interval_days || 1;

  // اگر کاربر واژه را زودتر از موعد دیده، بازه را خراب نمی‌کنیم
  // اما اگر دیرتر دیده، بازه واقعی را حساب می‌کنیم
  if (state.last_reviewed_at) {
    const lastReviewDate = new Date(state.last_reviewed_at);
    const diffMs = now.getTime() - lastReviewDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays > state.interval_days) {
      usedInterval = diffDays;
    } else {
      usedInterval = state.interval_days;
    }
    if (usedInterval < 1) usedInterval = 1;
  }

  // اجرای الگوریتم SM2
  const sm2Result = sm2(
    {
      interval: usedInterval,
      repetition: state.repetitions || 0,
      ef: state.ease_factor || 2.5
    },
    quality
  );

  let nextReviewIso: string;
  let finalInterval = sm2Result.interval;
  let finalRepetition = sm2Result.repetition;
  let newStage = state.question_stage || 1;
  let newCorrectStreak = state.correct_streak || 0;

  if (!isCorrect) {
    // === منطق جدید برای پاسخ غلط ===
    // ۱. مرور بعدی: ۱۰ دقیقه دیگر (به جای فردا)
    const tenMinutesLater = new Date(now.getTime() + 10 * 60000); // 10 minutes in ms
    nextReviewIso = tenMinutesLater.toISOString();
    
    // ۲. بازه را صفر می‌کنیم تا سیستم بفهمد این واژه در حال یادگیری مجدد است
    finalInterval = 0; 
    
    // ۳. ریست کردن پیشرفت
    newStage = 1;
    newCorrectStreak = 0;
    finalRepetition = 0;
  } else {
    // === منطق برای پاسخ درست ===
    // اگر بازه قبلی ۰ بود (یعنی تازه از غلط درآمده)، حالا باید بشود ۱ روز
    if (state.interval_days === 0) {
        finalInterval = 1;
    }
    
    nextReviewIso = addDaysToIso(nowIso, finalInterval);
    
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
      finalInterval,
      finalRepetition,
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
