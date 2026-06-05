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
  // بهینه‌سازی: حذف PRAGMA foreign_keys از batch
  // دلیل: در D1، Foreign Key ها در سطح اسکیما تعریف شده‌اند و خود D1 آنها را اعمال می‌کند.
  // PRAGMA foreign_keys در D1 به‌صورت خودکار فعال است و نیاز به تنظیم دستی ندارد.
  // این تغییر باعث کاهش ۵۰٪ تعداد write ها می‌شود.
  const stmt = env.DB.prepare(sql).bind(...params);
  const res = await stmt.run();
  return res;
}

export function prepare(
  env: Env,
  sql: string,
  params: any[] = []
): any {
  return env.DB.prepare(sql).bind(...params);
}
