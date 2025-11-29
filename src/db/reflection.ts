import { Env } from "../types";
import { execute, queryOne, queryAll } from "./client";

export interface ReflectionSession {
  id: number;
  user_id: number;
  source_paragraph: string;
  user_answer: string;
  ai_score: number | null;
  ai_feedback: string | null;
  created_at: string;
}

// ایجاد یک سشن جدید (با استفاده از RETURNING برای امنیت و سرعت بیشتر)
export async function createReflectionSession(
  env: Env,
  userId: number,
  paragraph: string
): Promise<ReflectionSession> {
  const now = new Date().toISOString();
  
  // اصلاح: استفاده از RETURNING * برای دریافت رکورد ساخته شده در همان لحظه
  // این کار مشکل همزمانی (Race Condition) را کاملاً حل می‌کند
  const session = await queryOne<ReflectionSession>(
    env,
    `
    INSERT INTO reflection_sessions (user_id, source_paragraph, user_answer, created_at)
    VALUES (?, ?, '', ?)
    RETURNING *
    `,
    [userId, paragraph, now]
  );

  if (!session) throw new Error("Failed to create reflection session");
  return session;
}

// پیدا کردن آخرین سشن باز (که هنوز نمره نگرفته)
export async function getPendingReflectionSession(
  env: Env,
  userId: number
): Promise<ReflectionSession | null> {
  return await queryOne<ReflectionSession>(
    env,
    `
    SELECT * FROM reflection_sessions
    WHERE user_id = ? AND ai_score IS NULL
    ORDER BY id DESC
    LIMIT 1
    `,
    [userId]
  );
}

// ثبت پاسخ کاربر و نمره هوش مصنوعی
export async function updateReflectionResult(
  env: Env,
  sessionId: number,
  userAnswer: string,
  score: number,
  feedback: string
): Promise<void> {
  await execute(
    env,
    `
    UPDATE reflection_sessions
    SET user_answer = ?, ai_score = ?, ai_feedback = ?
    WHERE id = ?
    `,
    [userAnswer, score, feedback, sessionId]
  );
}

// گرفتن کلمات یاد گرفته شده کاربر برای ساخت متن
export async function getUserLearnedWords(
  env: Env,
  userId: number,
  limit: number = 5
): Promise<string[]> {
  const rows = await queryAll<{ english: string }>(
    env,
    `
    SELECT w.english
    FROM user_words_sm2 s
    JOIN words w ON w.id = s.word_id
    WHERE s.user_id = ? 
      AND s.correct_streak > 0
      AND s.ignored = 0
    ORDER BY RANDOM()
    LIMIT ?
    `,
    [userId, limit]
  );

  return rows.map(r => r.english);
}

// حذف تمرین ناتمام
export async function deletePendingReflectionSession(env: Env, userId: number): Promise<void> {
  await execute(
    env,
    `DELETE FROM reflection_sessions WHERE user_id = ? AND ai_score IS NULL`,
    [userId]
  );
}
