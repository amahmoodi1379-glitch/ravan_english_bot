-- Migration 0026: Drop redundant indexes
-- These explicit indexes are redundant because each is either:
--   (a) a strict prefix of another compound index (SQLite uses the longer
--       index for prefix queries), or
--   (b) a duplicate of an implicit index auto-created by a UNIQUE / PRIMARY KEY
--       constraint, or
--   (c) an exact duplicate of another explicit index.
-- Dropping them reduces write overhead and storage. No data is affected.
-- DROP INDEX never touches table data and only removes the named explicit index
-- (implicit UNIQUE/PK indexes are managed by SQLite and are NOT affected).

-- (a) prefix-redundant
DROP INDEX IF EXISTS idx_history_check;             -- prefix of idx_uwqh_user_question_context_answered
DROP INDEX IF EXISTS idx_text_questions_text;        -- prefix of idx_text_questions_text_type
DROP INDEX IF EXISTS idx_cq_questions_quiz;          -- prefix of idx_cq_questions_quiz_index
DROP INDEX IF EXISTS idx_activity_created_at;        -- prefix of idx_activity_user_created_xp

-- (b) duplicate of an implicit UNIQUE index
DROP INDEX IF EXISTS idx_admin_sessions_token;       -- admin_sessions.token is UNIQUE
DROP INDEX IF EXISTS idx_admins_telegram_id;         -- admins.telegram_id is UNIQUE
DROP INDEX IF EXISTS idx_user_analytics_date_period; -- UNIQUE(date, period_type)
DROP INDEX IF EXISTS idx_cq_links_token;             -- custom_quiz_links.link_token is UNIQUE

-- (c) exact duplicate of another explicit index
DROP INDEX IF EXISTS idx_duel_questions_duel;            -- same as unique idx_unique_duel_questions
DROP INDEX IF EXISTS idx_sm2_user_ignored_active_review; -- same as idx_leitner_compound
