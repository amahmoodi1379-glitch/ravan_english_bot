-- 0033: Online competition — daily tournaments + weekly leagues
--
-- Why: add a social/competitive layer on top of the existing test content so
-- the ~500 daily users play together and stay engaged, without rewriting any
-- content.
--
-- Two features:
--  1) Daily tournament — a nightly, time-windowed quiz auto-built from the
--     existing word_questions bank. Modelled as a custom_quizzes row with
--     kind='tournament' so the whole battle-tested quiz-taking/leaderboard flow
--     is reused unchanged. New columns add the scheduling window; the partial
--     unique index guarantees at most one tournament per Iran-local day (and
--     makes the cron "open" job idempotent / safe to re-run).
--  2) Weekly leagues — Duolingo-style divisions. Standings are NOT a live
--     counter; they are computed from activity_log timestamps over a fixed
--     Iran-calendar week [Saturday 00:00, next Saturday 00:00). Tournament XP
--     flows through activity_log too, so it counts toward the league
--     automatically (integrated scoring).
--
-- Backfill note: existing custom_quizzes rows get kind='custom' (the DEFAULT),
-- which preserves admin-quiz behaviour exactly. No league rows exist yet; the
-- first week bootstraps lazily (ensureLeagueMembership) and/or at the first
-- Saturday-00:00 settlement.

-- ---- Tournament support on custom_quizzes ----
ALTER TABLE custom_quizzes ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom';   -- 'custom' | 'tournament'
ALTER TABLE custom_quizzes ADD COLUMN opens_at TEXT;                         -- UTC 'YYYY-MM-DD HH:MM:SS' — window open (tournament only)
ALTER TABLE custom_quizzes ADD COLUMN closes_at TEXT;                        -- UTC — hard close (tournament only)
ALTER TABLE custom_quizzes ADD COLUMN tournament_date TEXT;                  -- Iran-local 'YYYY-MM-DD' identity of the tournament

-- At most one tournament per Iran-local day; also makes the "open" cron idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cq_tournament_date
  ON custom_quizzes(tournament_date) WHERE kind = 'tournament';

-- ---- Weekly leagues ----

-- One row per league week. week_start is the Iran-local Saturday date that opens
-- the week; week_end is the (exclusive) next Saturday. status guards settlement
-- idempotency.
CREATE TABLE IF NOT EXISTS league_seasons (
  week_start TEXT PRIMARY KEY,                    -- Iran-local 'YYYY-MM-DD' (Saturday)
  week_end   TEXT NOT NULL,                       -- Iran-local 'YYYY-MM-DD' (next Saturday, exclusive)
  status     TEXT NOT NULL DEFAULT 'active',      -- active | settled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

-- A division groups up to DIVISION_SIZE users of one tier for one week.
CREATE TABLE IF NOT EXISTS league_divisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start      TEXT NOT NULL,                  -- FK league_seasons.week_start (app-enforced)
  tier            INTEGER NOT NULL,               -- 1..N (1 = lowest / bronze)
  division_number INTEGER NOT NULL,               -- 1-based within (week_start, tier)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_league_divisions_week
  ON league_divisions(week_start, tier, division_number);

-- Each user's division assignment for a given week. The standings query joins
-- this against activity_log within the week window.
CREATE TABLE IF NOT EXISTS league_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  division_id INTEGER NOT NULL,
  tier        INTEGER NOT NULL,
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (division_id) REFERENCES league_divisions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_league_members_week_user
  ON league_members(week_start, user_id);
CREATE INDEX IF NOT EXISTS idx_league_members_division
  ON league_members(division_id);

-- Frozen snapshot of each user's outcome for a settled week (for announcements
-- and audit). weekly_xp is the score at settlement time.
CREATE TABLE IF NOT EXISTS league_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start       TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  tier             INTEGER NOT NULL,               -- tier the user competed in
  division_id      INTEGER NOT NULL,
  rank_in_division INTEGER NOT NULL,
  weekly_xp        INTEGER NOT NULL,
  outcome          TEXT NOT NULL,                  -- promote | demote | stay | removed | champion
  new_tier         INTEGER NOT NULL,               -- tier for next week
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_league_results_week_user
  ON league_results(week_start, user_id);
CREATE INDEX IF NOT EXISTS idx_league_results_week
  ON league_results(week_start);
