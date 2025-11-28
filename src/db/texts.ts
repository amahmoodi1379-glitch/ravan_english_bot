import { Env } from "../types";
import { queryAll, queryOne } from "./client";

export interface DbReadingText {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

// ۱. گرفتن تعداد کل متن‌ها (برای اینکه بفهمیم چند صفحه داریم)
export async function getReadingTextsCount(env: Env): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(*) as cnt FROM reading_texts WHERE is_active = 1`
  );
  return row?.cnt ?? 0;
}

// ۲. گرفتن متن‌ها به صورت صفحه‌بندی شده (مثلاً ۵ تا ۵ تا)
export async function getPaginatedReadingTexts(env: Env, limit: number, offset: number): Promise<DbReadingText[]> {
  const rows = await queryAll<DbReadingText>(
    env,
    `
    SELECT id, title, body_en, level, is_active
    FROM reading_texts
    WHERE is_active = 1
    ORDER BY id ASC
    LIMIT ? OFFSET ?
    `,
    [limit, offset]
  );
  return rows;
}

// ۳. پیدا کردن متن بر اساس "عنوان" (چون کاربر روی دکمه‌ی اسم متن کلیک می‌کند)
export async function getReadingTextByTitle(env: Env, title: string): Promise<DbReadingText | null> {
  const row = await queryOne<DbReadingText>(
    env,
    `SELECT * FROM reading_texts WHERE title = ? AND is_active = 1 LIMIT 1`,
    [title]
  );
  return row ?? null;
}

// ۴. گرفتن یک متن بر اساس آیدی (از قبل بود، نگهش می‌داریم)
export async function getReadingTextById(env: Env, id: number): Promise<DbReadingText | null> {
  return await queryOne<DbReadingText>(env, `SELECT * FROM reading_texts WHERE id = ?`, [id]);
}

// ۵. گرفتن همه متن‌ها (این را هم محض اطمینان نگه می‌داریم)
export async function getAllActiveReadingTexts(env: Env): Promise<DbReadingText[]> {
  const rows = await queryAll<DbReadingText>(
    env,
    `
    SELECT id, title, body_en, level, is_active
    FROM reading_texts
    WHERE is_active = 1
    ORDER BY id ASC
    `
  );
  return rows;
}
