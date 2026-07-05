-- 0034: Medals (badges) + tournament reminder opt-in
--
-- Why:
--  1) Medals — an honorary (no-XP) achievement layer across the app (streak, XP,
--     words, reading, tournament, league). A badge is awarded once per user; the
--     catalog lives in code (src/config/badges.ts), so only awarded rows are
--     stored. UNIQUE(user_id, badge_code) + INSERT OR IGNORE makes awarding
--     idempotent (no double-award, safe to re-evaluate).
--  2) Tournament reminder — an opt-in flag so users who tap "🔔 یادم بنداز" get a
--     nightly push when the tournament opens, instead of broadcasting to everyone.
--
-- Backfill note: existing users get tournament_reminder = 0 (opt-out by default);
-- no user_badges rows exist yet (badges are evaluated lazily on first view / event).

CREATE TABLE IF NOT EXISTS user_badges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  badge_code TEXT NOT NULL,                    -- matches a code in the code-side catalog
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  meta_json  TEXT,                             -- optional context (e.g. tournament id, tier)
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_user_code ON user_badges(user_id, badge_code);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- Opt-in flag for the nightly tournament reminder push.
ALTER TABLE users ADD COLUMN tournament_reminder INTEGER NOT NULL DEFAULT 0;
