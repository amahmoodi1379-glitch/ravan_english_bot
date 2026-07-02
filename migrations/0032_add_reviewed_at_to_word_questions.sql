-- 0032: Add reviewed_at to word_questions for batch quality-control review
--
-- Why: Admins download a batch of 500-1000 word-test questions as a JSON file,
-- hand it to a Claude chat for scientific review (multiple correct options, a
-- wrong answer key marked correct, the target word/meaning missing from the
-- options, etc.), then paste the corrections back to be applied in place.
--   
-- This column tracks which questions have already been pulled into a review
-- batch so each download returns only not-yet-reviewed rows (WHERE reviewed_at
-- IS NULL), avoiding re-reviewing the same questions. It is set at download
-- time and can be cleared again from the admin "review" page (reset) to re-pull.
--
-- Backfill note: existing rows keep reviewed_at = NULL, i.e. treated as
-- not-yet-reviewed, which is correct — none of them have been reviewed yet.

ALTER TABLE word_questions ADD COLUMN reviewed_at TEXT;

-- Serves the batch-selection query WHERE reviewed_at IS NULL ORDER BY id.
CREATE INDEX IF NOT EXISTS idx_word_questions_reviewed_at ON word_questions(reviewed_at, id);
