import { Env } from "../types";
import { queryAll, queryOne } from "./client";

export interface DbReadingText {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

export async function getReadingTextsCount(env: Env): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(*) as cnt FROM reading_texts WHERE is_active = 1`
  );
  return row?.cnt ?? 0;
}

export async function getPaginatedReadingTexts(env: Env, limit: number, offset: number): Promise<DbReadingText[]> {
  return await queryAll<DbReadingText>(
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
}

export async function getReadingTextByTitle(env: Env, title: string): Promise<DbReadingText | null> {
  const row = await queryOne<DbReadingText>(
    env,
    `SELECT * FROM reading_texts WHERE title = ? AND is_active = 1 LIMIT 1`,
    [title]
  );
  return row ?? null;
}
