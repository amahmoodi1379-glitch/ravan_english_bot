import { Env } from "../types";

// روشن کردن بررسی ارتباط جداول برای هر درخواست
async function enableForeignKeys(env: Env) {
  await env.DB.prepare("PRAGMA foreign_keys = ON;").run();
}

export async function queryOne<T>(
  env: Env,
  sql: string,
  params: any[] = []
): Promise<T | null> {
  // await enableForeignKeys(env); // اگر سرعت خیلی مهم نیست این خط را فعال کن
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
  // برای دستورات حذف و آپدیت حتما باید فعال باشد
  await enableForeignKeys(env);
  const stmt = env.DB.prepare(sql);
  return await stmt.bind(...params).run();
}

export function prepare(
  env: Env,
  sql: string,
  params: any[] = []
): any {
  return env.DB.prepare(sql).bind(...params);
}
