-- 0029: Add rated_at to user_word_question_history for atomic, exactly-once XP/FSRS
--
-- Why: XP for a leitner answer is awarded when the user taps a rating button
-- (Good/Easy). The previous idempotency guard was a non-atomic check-then-act,
-- so a fast double-tap could race and award XP (and re-apply FSRS) twice.
--
-- This column lets us atomically CLAIM the rating slot with
--   UPDATE ... SET rated_at = ? WHERE ... AND rated_at IS NULL
-- and only proceed (XP + FSRS) when changes = 1 — the same safe pattern already
-- used for answered_at in handleAnswer.
--
-- Backfill note: existing already-rated rows keep rated_at = NULL. That is safe
-- because their inline keyboards were already removed (removeInlineKeyboard), so
-- their rating buttons are no longer tappable; there is no live double-award path
-- for historical rows.

ALTER TABLE user_word_question_history ADD COLUMN rated_at TEXT;

-- Partial-style index to make the atomic claim lookup fast.
CREATE INDEX IF NOT EXISTS idx_uwqh_user_question_context_rated
  ON user_word_question_history(user_id, question_id, context, rated_at);
