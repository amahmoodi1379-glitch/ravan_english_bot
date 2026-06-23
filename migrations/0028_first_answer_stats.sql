-- 0028: First-answer stats support + indexes for per-question answer aggregation.
--
-- first_is_correct preserves a user's FIRST answer to a leitner question (the
-- normal is_correct column is reset every time the question is re-shown). It is
-- set once on the first answer and never overwritten (see handlers/leitner).
-- Reading uses a window function over its per-attempt rows instead (no column).
--
-- The two indexes keep getQuestionAnswerStats / getTextQuestionAnswerStats cheap,
-- since they run after every answer and filter by question_id.

ALTER TABLE user_word_question_history ADD COLUMN first_is_correct INTEGER;

-- Backfill so historical answer stats are not wiped on rollout. NOTE: the original
-- FIRST answer is no longer recoverable (the row is overwritten on each re-show),
-- so we seed with the latest recorded answer (is_correct) as the best available
-- approximation. Only touches already-answered rows; the guard makes it idempotent.
UPDATE user_word_question_history
SET first_is_correct = is_correct
WHERE first_is_correct IS NULL AND is_correct IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uwqh_question ON user_word_question_history(question_id);
CREATE INDEX IF NOT EXISTS idx_utqh_question ON user_text_question_history(question_id);
