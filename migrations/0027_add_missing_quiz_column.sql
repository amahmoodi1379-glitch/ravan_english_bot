-- Migration 0027: Add current_question_index to custom_quiz_attempts if missing
-- This column was part of the original CREATE TABLE in 0020 but may be absent
-- if the table was created by an earlier version of the schema.

ALTER TABLE custom_quiz_attempts ADD COLUMN current_question_index INTEGER NOT NULL DEFAULT 1;
