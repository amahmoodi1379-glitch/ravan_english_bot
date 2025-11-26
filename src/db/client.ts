import { Env } from "../types";

// برگرداندن یک ردیف (یا null)
export async function queryOne<T>(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<T | null> {
  const stmt = env.DB.prepare(sql);
  const res = await stmt.bind(...params).first();
  if (!res) return null;
  return res as unknown as T;
}

// برگرداندن چند ردیف
export async function queryAll<T>(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  const res = await stmt.bind(...params).all();
  const rows = (res?.results ?? []) as unknown as T[];
  return rows;
}

// اجرای کوئری بدون برگشت نتیجه
export async function execute(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<void> {
  const stmt = env.DB.prepare(sql);
  await stmt.bind(...params).run();
}
