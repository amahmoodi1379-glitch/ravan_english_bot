-- 0027: Track which inactivity-reminder stage was last sent to each user.
-- Stages: 0 = none sent, 1 = 2-day reminder, 2 = 5-day reminder, 3 = 10-day reminder.
-- Reset to 0 on any user interaction (see src/db/users.ts touchExistingUser).
ALTER TABLE users ADD COLUMN inactivity_reminder_stage INTEGER NOT NULL DEFAULT 0;
