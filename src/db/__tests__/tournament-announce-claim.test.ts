import { describe, it, expect } from "vitest";
import { claimTournamentAnnounce, clearTournamentAnnounceClaim } from "../tournaments";
import { Env } from "../../types";

/**
 * Minimal in-memory stand-in for the one custom_quizzes row a tournament uses,
 * modelling exactly the two columns the announce-claim touches. It emulates the
 * D1 UPDATE semantics that claimTournamentAnnounce/clearTournamentAnnounceClaim
 * rely on — importantly, meta.changes reflecting whether the guarded WHERE
 * matched — so we can assert the "broadcast fires exactly once" guarantee that
 * decouples the announce from settlement (the fix for the missing-results bug).
 */
function makeFakeEnv(initial: { id: number; results_announced_at: string | null }): {
  env: Env;
  row: { id: number; results_announced_at: string | null };
} {
  const row = { ...initial };
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const norm = sql.replace(/\s+/g, " ").trim();
              // claim: set to now() only if currently NULL (and id/kind match)
              if (norm.includes("SET results_announced_at = datetime('now')")) {
                const id = params[0] as number;
                const matches = row.id === id && row.results_announced_at === null;
                if (matches) row.results_announced_at = "2026-07-18 18:30:00";
                return { meta: { changes: matches ? 1 : 0 } } as unknown;
              }
              // clear: set back to NULL if id/kind match
              if (norm.includes("SET results_announced_at = NULL")) {
                const id = params[0] as number;
                const matches = row.id === id;
                if (matches) row.results_announced_at = null;
                return { meta: { changes: matches ? 1 : 0 } } as unknown;
              }
              throw new Error("unexpected SQL in fake DB: " + norm);
            },
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, row };
}

describe("tournament announce claim (once-only broadcast guard)", () => {
  it("first claim wins, every later claim loses", async () => {
    const { env } = makeFakeEnv({ id: 42, results_announced_at: null });

    // Whoever runs first (cron OR a backstop tick) gets the single broadcast...
    expect(await claimTournamentAnnounce(env, 42)).toBe(true);
    // ...and no subsequent caller ever broadcasts again.
    expect(await claimTournamentAnnounce(env, 42)).toBe(false);
    expect(await claimTournamentAnnounce(env, 42)).toBe(false);
  });

  it("a quiz already marked announced never re-broadcasts", async () => {
    // Simulates the CLOSE_HOUR cron running after the results already went out.
    const { env } = makeFakeEnv({ id: 7, results_announced_at: "2026-07-18 18:30:00" });
    expect(await claimTournamentAnnounce(env, 7)).toBe(false);
  });

  it("clearing the claim (broadcast failed) lets a later tick retry exactly once", async () => {
    const { env, row } = makeFakeEnv({ id: 99, results_announced_at: null });

    expect(await claimTournamentAnnounce(env, 99)).toBe(true); // won, then broadcast throws
    await clearTournamentAnnounceClaim(env, 99); // release for retry
    expect(row.results_announced_at).toBeNull();

    expect(await claimTournamentAnnounce(env, 99)).toBe(true); // backstop tick re-wins
    expect(await claimTournamentAnnounce(env, 99)).toBe(false); // and only once more
  });
});
