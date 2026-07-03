import { Env } from "../types";

/**
 * A reusable SQL boolean fragment (plus its bound params) used to gate a
 * statement's side-effect on some external condition — e.g. "only apply this
 * FSRS/XP update if the claim row is still unclaimed". Appended to a statement's
 * WHERE clause so that claim + side-effects can live in one atomic DB.batch():
 * the gate makes losing/duplicate requests no-ops without a partial-failure
 * window. Example: { sql: "EXISTS (SELECT 1 FROM t WHERE id = ? AND done IS NULL)", params: [id] }.
 */
export interface SqlGuard {
  sql: string;
  params: unknown[];
}

/**
 * Cloudflare D1 occasionally throws transient, infrastructure-level errors that
 * are safe to retry: the underlying storage object gets reset (e.g. when the
 * backing Durable Object is relocated or its code is updated) or the network
 * connection to it is briefly lost. These surface as `D1_ERROR: ...` messages
 * and are NOT caused by our SQL — a plain retry a few hundred ms later succeeds.
 * Matching on the message text is the only signal D1 gives us here.
 */
const TRANSIENT_D1_PATTERNS = [
  "caused object to be reset",
  "internal error while starting up d1",
  "network connection lost",
  "storage caused object to be reset"
];

function isTransientD1Error(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return TRANSIENT_D1_PATTERNS.some((p) => lower.includes(p));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a D1 operation, retrying a few times on transient D1 errors with a short
 * exponential backoff. Non-transient errors (real SQL/constraint failures) are
 * rethrown immediately so we never mask genuine bugs or silently double-apply a
 * write that actually succeeded. Only use this for operations that are safe to
 * re-run — the reads and single-statement writes going through these wrappers
 * are idempotent from D1's perspective when the first attempt never landed.
 */
async function withD1Retry<T>(op: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!isTransientD1Error(err) || attempt === attempts - 1) throw err;
      lastErr = err;
      // 100ms, 200ms, 400ms, ...
      await sleep(100 * 2 ** attempt);
    }
  }
  // Unreachable: the loop either returns or throws, but satisfies the type checker.
  throw lastErr;
}

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
  const res = await withD1Retry(() => stmt.bind(...params).first());
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
  const res = await withD1Retry(() => stmt.bind(...params).all());
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
  return await withD1Retry(() => stmt.run());
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
