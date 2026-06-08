-- Migration: Move from SM2 to FSRS-5 algorithm
-- This adds FSRS columns to user_words_sm2 while preserving all existing data.

-- Add FSRS-specific columns
ALTER TABLE user_words_sm2 ADD COLUMN stability REAL NOT NULL DEFAULT 0;
ALTER TABLE user_words_sm2 ADD COLUMN difficulty REAL NOT NULL DEFAULT 0;
ALTER TABLE user_words_sm2 ADD COLUMN card_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_words_sm2 ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_words_sm2 ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;

-- Migrate existing SM2 data to approximate FSRS values:
-- stability ≈ interval_days (reasonable approximation for cards already in review)
-- difficulty: map ease_factor to FSRS difficulty range [1..10]
--   EF 2.5 → D ~5 (mid), EF 1.3 → D ~9 (hard), EF 3.0+ → D ~3 (easy)
-- card_state: 0=New, 1=Learning, 2=Review, 3=Relearning
-- reps: use repetitions column

UPDATE user_words_sm2
SET
  stability = CASE
    WHEN interval_days > 0 THEN interval_days * 1.0
    ELSE 1.0
  END,
  difficulty = CASE
    WHEN ease_factor >= 2.5 THEN ROUND(MAX(1, MIN(10, 11 - (ease_factor * 2.5))), 2)
    ELSE ROUND(MAX(1, MIN(10, 11 - (ease_factor * 2.5))), 2)
  END,
  card_state = CASE
    WHEN repetitions = 0 THEN 0
    WHEN repetitions >= 1 AND interval_days >= 1 THEN 2
    ELSE 1
  END,
  reps = repetitions,
  lapses = CASE
    WHEN correct_streak = 0 AND repetitions > 0 THEN 1
    ELSE 0
  END
WHERE ignored = 0;

-- Add index for FSRS scheduling queries
CREATE INDEX IF NOT EXISTS idx_user_words_fsrs_schedule
  ON user_words_sm2(user_id, ignored, card_state, next_review_date);
