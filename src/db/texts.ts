import { Env } from "../types";
import { queryAll, queryOne } from "./client";

export interface DbReadingText {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

// همه‌ی متن‌های فعال برای درک مطلب
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

// گرفتن یک متن بر اساس id
export async function getReadingTextById(env: Env, id: number): Promise<DbReadingText | null> {
  const row = await queryOne<DbReadingText>(
    env,
    `
    SELECT id, title, body_en, level, is_active
    FROM reading_texts
    WHERE id = ?
    `,
    [id]
  );

  return row ?? null;
}
