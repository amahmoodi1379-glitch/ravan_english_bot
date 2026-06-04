-- Migration: Leaderboard system
-- Adds max_streak_record column to users table

ALTER TABLE users ADD COLUMN max_streak_record INTEGER NOT NULL DEFAULT 0;

-- Initialize max_streak_record with current streak_count values
UPDATE users SET max_streak_record = streak_count WHERE max_streak_record < streak_count;
