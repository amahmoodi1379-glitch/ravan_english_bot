import { Env } from "../types";
import { queryAll, queryOne } from "./client";

export interface DbReadingText {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

/**
 * Get the total count of active reading texts.
 * @param env - The worker environment containing the D1 database binding
 * @returns The number of active reading texts
 */
export async function getReadingTextsCount(env: Env): Promise<number> {
  const row = await queryOne<{ cnt: number }>(
    env,
    `SELECT COUNT(*) as cnt FROM reading_texts WHERE is_active = 1`
  );
  return row?.cnt ?? 0;
}

/**
 * Retrieve a paginated list of active reading texts.
 * @param env - The worker environment containing the D1 database binding
 * @param limit - Maximum number of texts to return
 * @param offset - Number of texts to skip before returning results
 * @returns An array of DbReadingText records
 */
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

/**
 * Find an active reading text by its exact title.
 * @param env - The worker environment containing the D1 database binding
 * @param title - The title to search for
 * @returns The matching DbReadingText, or null if not found
 */
export async function getReadingTextByTitle(env: Env, title: string): Promise<DbReadingText | null> {
  const row = await queryOne<DbReadingText>(
    env,
    `SELECT * FROM reading_texts WHERE title = ? AND is_active = 1 LIMIT 1`,
    [title]
  );
  return row ?? null;
}
