import { Env } from "../types";

/**
 * Execute a SQL query and return the first matching row, or null if none found.
 * @param env - The worker environment containing the D1 database binding
 * @param sql - The SQL query string to execute
 * @param params - Bound parameters for the prepared statement
 * @returns The first result row cast to T, or null if no rows match
 */
export async function queryOne<T>(
  env: Env,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const stmt = env.DB.prepare(sql);
  const res = await stmt.bind(...params).first();
  if (!res) return null;
  return res as unknown as T;
}

/**
 * Execute a SQL query and return all matching rows.
 * @param env - The worker environment containing the D1 database binding
 * @param sql - The SQL query string to execute
 * @param params - Bound parameters for the prepared statement
 * @returns An array of result rows cast to T
 */
export async function queryAll<T>(
  env: Env,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  const res = await stmt.bind(...params).all();
  const rows = (res?.results ?? []) as unknown as T[];
  return rows;
}

/**
 * Execute a SQL statement (INSERT, UPDATE, DELETE) and return the result metadata.
 * @param env - The worker environment containing the D1 database binding
 * @param sql - The SQL statement to execute
 * @param params - Bound parameters for the prepared statement
 * @returns The D1Result containing metadata such as rows affected
 */
export async function execute(
  env: Env,
  sql: string,
  params: unknown[] = []
): Promise<D1Result> {
  const stmt = env.DB.prepare(sql).bind(...params);
  return await stmt.run();
}

/**
 * Create a prepared statement with bound parameters without executing it.
 * @param env - The worker environment containing the D1 database binding
 * @param sql - The SQL statement to prepare
 * @param params - Bound parameters for the prepared statement
 * @returns A D1PreparedStatement ready for batching or deferred execution
 */
export function prepare(
  env: Env,
  sql: string,
  params: unknown[] = []
): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...params);
}
