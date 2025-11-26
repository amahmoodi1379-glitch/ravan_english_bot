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

// اجرای کوئری و بازگرداندن نتیجه (برای گرفتن تعداد تغییرات)
export async function execute(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<any> {
  const stmt = env.DB.prepare(sql);
  // متد run خروجی شامل meta.changes دارد
  return await stmt.bind(...params).run();
}
