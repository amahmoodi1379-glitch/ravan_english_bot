-- Migration 0039: exactly one answer row per (attempt, question)
--
-- WHY: custom_quiz_answers had no uniqueness on (attempt_id, question_id), and
-- saveAnswer() used to SELECT-then-INSERT. Two callbacks for the same question
-- arriving together (a double-tap on an option, or a Telegram webhook retry) both
-- saw "no row yet" and both inserted, leaving TWO rows for one question. The
-- scoring queries JOIN questions to answers, so a duplicate row fanned the join
-- out and inflated both the correct count and the attempt's question total —
-- that is how a 10-question tournament reported an attempt with "✅11 — 100%"
-- while everyone else was "✅10 — 100%", and how another attempt scored 27.27%
-- (= 3/11) instead of out of 10.
--
-- The code no longer writes duplicates (saveAnswer is now one atomic batch) and
-- scoring now counts DISTINCT questions, so this migration is about the rows
-- ALREADY stored: it removes them and makes the duplicate state unrepresentable.

-- ⚠️ DESTRUCTIVE (deletes rows) — but only ever surplus duplicates: for each
-- (attempt_id, question_id) it keeps the highest id, i.e. the most recently
-- written answer. That is the same "last write wins" rule the UPDATE path
-- applies, so the kept row is the option the user actually settled on. Attempts
-- WITHOUT duplicates are untouched (their single row is trivially the max).
--
-- Preview what it would remove before running it:
--   SELECT COUNT(*) FROM custom_quiz_answers
--   WHERE id NOT IN (SELECT MAX(id) FROM custom_quiz_answers GROUP BY attempt_id, question_id);
DELETE FROM custom_quiz_answers
WHERE id NOT IN (
  SELECT MAX(id) FROM custom_quiz_answers GROUP BY attempt_id, question_id
);

-- Now that the data is clean, let the database enforce the invariant: a second
-- row for the same question can no longer be inserted, whatever races the
-- application hits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cq_answers_attempt_question
  ON custom_quiz_answers(attempt_id, question_id);

-- Prefix-redundant now: attempt_id is the leading column of the unique index
-- above, which SQLite uses for attempt_id-only lookups (same reasoning as 0026).
-- DROP INDEX never touches table data.
DROP INDEX IF EXISTS idx_cq_answers_attempt;
