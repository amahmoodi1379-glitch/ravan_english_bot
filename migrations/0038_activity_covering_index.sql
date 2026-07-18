-- 0038: Make the per-user windowed XP sum a COVERING index.
--
-- Why: the weekly/monthly leaderboards, the league division standings, the user
-- rank, and the windowed profile stats all run
--   SELECT SUM(xp_delta) FROM activity_log WHERE user_id = ? AND created_at >= ?
-- (and GROUP BY user_id variants). The old idx_activity_user_created
-- (user_id, created_at) can seek the right rows but must then fetch xp_delta from
-- the table for each one. Adding xp_delta as a trailing column makes the read
-- index-only (covering), so these hot aggregations never touch the table heap.
--
-- No extra write cost: the new index has the SAME leading columns as the one it
-- replaces, so every query that used idx_activity_user_created uses this one
-- equally well — the index COUNT stays the same, only its width grows by one
-- integer column. DROP INDEX never touches table data.
DROP INDEX IF EXISTS idx_activity_user_created;
CREATE INDEX IF NOT EXISTS idx_activity_user_created_xpdelta
  ON activity_log(user_id, created_at, xp_delta);
