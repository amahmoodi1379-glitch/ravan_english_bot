import { Env } from "../types";

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

export async function execute(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<any> {
  const stmt = env.DB.prepare(sql);
  return await stmt.bind(...params).run();
}

// NEW: آماده‌سازی دستور برای Batch
export function prepare(
  env: Env,
  sql: string,
  params: any[] = []
): any {
  return env.DB.prepare(sql).bind(...params);
}
