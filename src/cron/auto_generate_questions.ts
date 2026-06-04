// Cron job: Auto-generate questions for words without questions using OpenAI GPT-5.4-mini

import { Env } from "../types";
import { queryAll, queryOne, execute } from "../db/client";
import { generateWordQuestions, GeneratedQuestion } from "../ai/openai";
import { insertWordQuestions } from "../db/word_questions";

interface WordWithoutQuestions {
  id: number;
  english: string;
  persian: string;
  level: number;
}


const BATCH_SIZE = 30; // تعداد واژه در هر اجرا
const PARALLEL_SIZE = 5; // تعداد واژه‌های موازی در هر گروه
const MAX_RETRIES = 2;

// پیدا کردن واژگان فعال بدون سوال
async function findWordsWithoutQuestions(env: Env): Promise<WordWithoutQuestions[]> {
  const words = await queryAll<WordWithoutQuestions>(
    env,
    `
    SELECT w.id, w.english, w.persian, w.level
    FROM words w
    LEFT JOIN word_questions wq ON wq.word_id = w.id
    WHERE w.is_active = 1
      AND wq.id IS NULL
    ORDER BY w.id ASC
    LIMIT ?
    `,
    [BATCH_SIZE]
  );
  return words;
}

// ثبت شروع پردازش
async function logStart(env: Env, wordId: number, english: string): Promise<void> {
  await execute(
    env,
    `
    INSERT INTO ai_generation_log (word_id, word_english, status, generated_count, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, datetime('now'), datetime('now'))
    `,
    [wordId, english]
  );
}

// به‌روزرسانی لاگ به success
async function logSuccess(
  env: Env,
  wordId: number,
  count: number,
  inputTokens?: number,
  outputTokens?: number
): Promise<void> {
  await execute(
    env,
    `
    UPDATE ai_generation_log
    SET status = 'success',
        generated_count = ?,
        input_tokens = ?,
        output_tokens = ?,
        updated_at = datetime('now')
    WHERE word_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [count, inputTokens ?? null, outputTokens ?? null, wordId]
  );
}

// به‌روزرسانی لاگ به error
async function logError(env: Env, wordId: number, errorMessage: string): Promise<void> {
  await execute(
    env,
    `
    UPDATE ai_generation_log
    SET status = 'error',
        error_message = ?,
        updated_at = datetime('now')
    WHERE word_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [errorMessage.substring(0, 500), wordId] // محدود کردن طول خطا
  );
}

// تولید سوالات برای یک واژه با retry
async function generateWithRetry(
  env: Env,
  apiKey: string,
  word: WordWithoutQuestions
): Promise<{ questions: GeneratedQuestion[]; tokenUsage?: { input: number; output: number } } | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await generateWordQuestions(
        apiKey,
        word.english,
        word.persian,
        word.level
      );
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Attempt ${attempt} failed for word "${word.english}": ${errorMsg}`);
      
      if (attempt === MAX_RETRIES) {
        await logError(env, word.id, `Failed after ${MAX_RETRIES} attempts: ${errorMsg}`);
        return null;
      }
      // کمی صبر بین retry
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

// پردازش یک واژه
async function processWord(
  env: Env,
  apiKey: string,
  word: WordWithoutQuestions
): Promise<boolean> {
  // ثبت شروع
  await logStart(env, word.id, word.english);

  // تولید سوالات
  const result = await generateWithRetry(env, apiKey, word);
  if (!result) {
    return false;
  }

  // تبدیل به فرمت مورد نیاز insertWordQuestions
  const questionsForInsert = result.questions.map(q => ({
    wordId: word.id,
    questionText: q.questionText,
    options: q.options,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    questionStyle: q.questionStyle,
    source: "ai" as const,
  }));

  // ذخیره در دیتابیس
  try {
    await insertWordQuestions(env, word.id, questionsForInsert);
    await logSuccess(env, word.id, result.questions.length, result.tokenUsage?.input, result.tokenUsage?.output);
    console.log(`Successfully generated ${result.questions.length} questions for "${word.english}"`);
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await logError(env, word.id, `Failed to insert questions: ${errorMsg}`);
    return false;
  }
}

// چک کردن circuit breaker (اگر ۵ خطا در ۳۰ دقیقه اخیر)
async function shouldPause(env: Env): Promise<boolean> {
  const recentErrors = await queryOne<{ count: number }>(
    env,
    `
    SELECT COUNT(*) as count
    FROM ai_generation_log
    WHERE status = 'error'
      AND updated_at > datetime('now', '-30 minutes')
    `
  );
  
  if (recentErrors && recentErrors.count >= 5) {
    console.warn(`Circuit breaker triggered: ${recentErrors.count} recent errors. Pausing for 30 minutes...`);
    return true;
  }
  return false;
}

// چک کردن وضعیت فعال/غیرفعال از دیتابیس
async function isAiGenerationEnabled(env: Env): Promise<boolean> {
  try {
    const row = await queryOne<{ value: string }>(
      env,
      "SELECT value FROM system_settings WHERE key = 'ai_generation_enabled'"
    );
    return row?.value === "1";
  } catch {
    return true; // در صورت خطا، پیش‌فرض فعال
  }
}

// تابع اصلی cron job
export async function runAutoQuestionGeneration(env: Env): Promise<{ processed: number; success: number; errors: number }> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY not configured");
    return { processed: 0, success: 0, errors: 0 };
  }

  // چک کردن وضعیت فعال/غیرفعال
  if (!(await isAiGenerationEnabled(env))) {
    return { processed: 0, success: 0, errors: 0 };
  }

  // چک کردن circuit breaker
  if (await shouldPause(env)) {
    return { processed: 0, success: 0, errors: 0 };
  }

  // expire کردن pending‌هایی که بیشتر از ۵ دقیقه قدیمی‌اند (timeout شده‌اند)
  await execute(
    env,
    `UPDATE ai_generation_log
     SET status = 'error', error_message = 'Timeout: worker expired before completion', updated_at = datetime('now')
     WHERE status = 'pending' AND created_at < datetime('now', '-5 minutes')`
  );

  // پیدا کردن واژگان بدون سوال
  const words = await findWordsWithoutQuestions(env);
  if (words.length === 0) {
    console.log("No words without questions found");
    return { processed: 0, success: 0, errors: 0 };
  }

  console.log(`Found ${words.length} words without questions`);

  let success = 0;
  let errors = 0;

  // پردازش موازی گروه‌های PARALLEL_SIZE تایی
  for (let i = 0; i < words.length; i += PARALLEL_SIZE) {
    const group = words.slice(i, i + PARALLEL_SIZE);
    const results = await Promise.all(group.map(word => processWord(env, apiKey, word)));
    for (const r of results) {
      if (r) success++; else errors++;
    }
  }

  console.log(`Batch complete: ${success} success, ${errors} errors out of ${words.length} words`);
  return { processed: words.length, success, errors };
}
