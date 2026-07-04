-- ============================================================================
-- schema.sql — SINGLE SOURCE OF TRUTH for the database
-- ============================================================================
-- This file represents the FULL, CURRENT state of the Cloudflare D1 database,
-- consolidated from migrations 0001–0025.
--
-- • Read THIS file to understand the database. Do NOT read the archived
--   migrations (migrations/archive/) for understanding — they are history only.
-- • The live D1 database already has all of this applied (plus real data).
-- • This file is idempotent (IF NOT EXISTS) and safe to run on a fresh D1
--   database to recreate the full structure. It does NOT drop or delete anything.
-- • When you change the schema: add a new migration in migrations/ AND update
--   this file to match. They must never disagree. See .kiro/steering/database.md
--
-- Last consolidated: migration 0030 (word-question reports).
-- ============================================================================


-- ========================= USERS =========================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  avatar_code TEXT,
  name_change_count INTEGER NOT NULL DEFAULT 0,
  xp_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  last_seen_at TEXT,
  -- access control (0006, 0018)
  is_approved INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  banned_until TEXT,
  banned_by_admin_id INTEGER,
  ban_reason TEXT,
  -- streak (0007, 0019)
  streak_count INTEGER DEFAULT 0,
  last_streak_date TEXT,
  max_streak_record INTEGER NOT NULL DEFAULT 0,
  -- inactivity return-reminder stage (0027): 0=none 1=2d 2=5d 3=10d; reset on interaction
  inactivity_reminder_stage INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp_total DESC);
CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned);
CREATE INDEX IF NOT EXISTS idx_users_banned_until ON users(banned_until);
CREATE INDEX IF NOT EXISTS idx_users_streak_live
  ON users(is_approved, is_banned, last_streak_date, streak_count DESC);
CREATE INDEX IF NOT EXISTS idx_users_streak_record
  ON users(is_approved, is_banned, max_streak_record DESC);


-- ========================= WORDS =========================
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  english TEXT NOT NULL,
  persian TEXT NOT NULL,
  level INTEGER NOT NULL,
  lesson_name TEXT,
  synonyms TEXT,
  antonyms TEXT,
  order_index INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_words_level ON words(level);
CREATE INDEX IF NOT EXISTS idx_words_active_order ON words(is_active, order_index);


-- ============== PER-USER SPACED-REPETITION STATE (FSRS) ==============
-- NOTE: table name is "user_words_sm2" for backwards compatibility, but it
-- stores FSRS-5 state (see src/utils/fsrs.ts). Do NOT rename it.
CREATE TABLE IF NOT EXISTS user_words_sm2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  -- legacy SM2 columns (kept; ease_factor no longer used by FSRS)
  interval_days INTEGER NOT NULL DEFAULT 1,
  repetitions INTEGER NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  -- scheduling
  next_review_date TEXT NOT NULL,
  last_reviewed_at TEXT,
  -- flags / progression
  ignored INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  question_stage INTEGER NOT NULL DEFAULT 1,   -- 1..5 question-type difficulty
  -- FSRS-5 fields (0025)
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  card_state INTEGER NOT NULL DEFAULT 0,       -- 0=New 1=Learning 2=Review 3=Relearning
  lapses INTEGER NOT NULL DEFAULT 0,           -- failure count; >=LEECH_THRESHOLD => "hard word"
  reps INTEGER NOT NULL DEFAULT 0,
  -- timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(user_id, word_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_user_words_next_review
  ON user_words_sm2(user_id, next_review_date);
CREATE INDEX IF NOT EXISTS idx_leitner_compound
  ON user_words_sm2(user_id, ignored, next_review_date);
CREATE INDEX IF NOT EXISTS idx_user_words_fsrs_schedule
  ON user_words_sm2(user_id, ignored, card_state, next_review_date);


-- ========================= WORD QUESTIONS =========================
CREATE TABLE IF NOT EXISTS word_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,                -- 'A' / 'B' / 'C' / 'D'
  question_style TEXT NOT NULL,                -- en_to_fa, fa_to_en, definition_to_word, word_to_definition, cloze
  explanation_text TEXT,
  source TEXT NOT NULL DEFAULT 'ai',           -- ai / manual / seed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,                            -- set when pulled into a QC review batch; NULL = not yet reviewed (0032)
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_word_questions_word ON word_questions(word_id);
CREATE INDEX IF NOT EXISTS idx_word_questions_reviewed_at ON word_questions(reviewed_at, id);


-- ============== USER REPORTS FOR WORD-TEST QUESTIONS (0030) ==============
-- Users flag a buggy Leitner word-test question after answering it. The
-- UNIQUE(question_id, user_id) constraint makes the report "counter" equal the
-- number of distinct reporters (a single user can't inflate it). Admins reset a
-- question's counter (after fixing) by deleting its rows here.
CREATE TABLE IF NOT EXISTS word_question_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(question_id, user_id),
  FOREIGN KEY (question_id) REFERENCES word_questions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_wqr_question ON word_question_reports(question_id);
CREATE INDEX IF NOT EXISTS idx_wqr_created ON word_question_reports(created_at);


-- ========== HISTORY OF WORD QUESTIONS SHOWN/ANSWERED PER USER ==========
CREATE TABLE IF NOT EXISTS user_word_question_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  context TEXT NOT NULL,                        -- e.g. 'leitner', 'duel'
  is_correct INTEGER,
  first_is_correct INTEGER,                     -- (0028) preserved FIRST answer; never overwritten on re-show
  shown_at TEXT NOT NULL,
  answered_at TEXT,
  rated_at TEXT,                                -- (0029) set atomically when XP/FSRS applied; guards against double-award
  UNIQUE(user_id, question_id, context),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (question_id) REFERENCES word_questions(id)
);

CREATE INDEX IF NOT EXISTS idx_uwqh_user_word
  ON user_word_question_history(user_id, word_id);
CREATE INDEX IF NOT EXISTS idx_uwqh_user_question_context_answered
  ON user_word_question_history(user_id, question_id, context, answered_at);
CREATE INDEX IF NOT EXISTS idx_uwqh_question
  ON user_word_question_history(question_id);


-- ========================= ACTIVITY / XP LOG =========================
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL,                  -- leitner_question / reading_session
  ref_id INTEGER,
  xp_delta INTEGER NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_created_xp ON activity_log(created_at, xp_delta);
CREATE INDEX IF NOT EXISTS idx_activity_user_created_xp
  ON activity_log(created_at, user_id, xp_delta);


-- ========================= READING (COMPREHENSION) =========================
CREATE TABLE IF NOT EXISTS reading_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body_en TEXT NOT NULL,
  level INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reading_texts_active ON reading_texts(is_active);

CREATE TABLE IF NOT EXISTS text_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  explanation_text TEXT,
  source TEXT NOT NULL DEFAULT 'ai',
  question_type TEXT NOT NULL DEFAULT 'reading', -- (0015) main_idea, detail, inference, vocabulary_in_context, title, reading
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

CREATE INDEX IF NOT EXISTS idx_text_questions_text_type ON text_questions(text_id, question_type);

CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress / completed / cancelled
  num_correct INTEGER NOT NULL DEFAULT 0,
  num_questions INTEGER NOT NULL DEFAULT 3,
  xp_gained INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

CREATE INDEX IF NOT EXISTS idx_reading_sessions_user ON reading_sessions(user_id, text_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_status_started
  ON reading_sessions(status, started_at);

CREATE TABLE IF NOT EXISTS user_text_question_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  reading_session_id INTEGER,
  is_correct INTEGER,
  shown_at TEXT NOT NULL,
  answered_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id),
  FOREIGN KEY (question_id) REFERENCES text_questions(id),
  FOREIGN KEY (reading_session_id) REFERENCES reading_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_utqh_user_text ON user_text_question_history(user_id, text_id);
CREATE INDEX IF NOT EXISTS idx_utqh_session_question
  ON user_text_question_history(reading_session_id, question_id);
CREATE INDEX IF NOT EXISTS idx_utqh_question
  ON user_text_question_history(question_id);

-- free-form reflection practice (no XP)
CREATE TABLE IF NOT EXISTS reflection_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source_paragraph TEXT NOT NULL,
  user_answer TEXT NOT NULL,
  ai_score INTEGER,
  ai_feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_reflection_user ON reflection_sessions(user_id, created_at);


-- ========================= DUELS =========================
CREATE TABLE IF NOT EXISTS duel_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  difficulty TEXT NOT NULL,                     -- 'easy' / 'hard'
  status TEXT NOT NULL DEFAULT 'waiting',       -- waiting / in_progress / completed
  player1_id INTEGER NOT NULL,
  player2_id INTEGER,
  winner_user_id INTEGER,
  is_draw INTEGER NOT NULL DEFAULT 0,
  player1_correct INTEGER NOT NULL DEFAULT 0,
  player2_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (player1_id) REFERENCES users(id),
  FOREIGN KEY (player2_id) REFERENCES users(id),
  FOREIGN KEY (winner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_duel_matches_status
  ON duel_matches(status, difficulty, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_duel_per_user
  ON duel_matches(player1_id) WHERE status IN ('waiting', 'in_progress');

CREATE TABLE IF NOT EXISTS duel_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duel_id INTEGER NOT NULL,
  question_index INTEGER NOT NULL,              -- 1..5
  word_id INTEGER NOT NULL,
  word_question_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (duel_id) REFERENCES duel_matches(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (word_question_id) REFERENCES word_questions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_duel_questions
  ON duel_questions(duel_id, question_index);

CREATE TABLE IF NOT EXISTS duel_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duel_id INTEGER NOT NULL,
  duel_question_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  chosen_option TEXT NOT NULL,                  -- 'A' / 'B' / 'C' / 'D'
  is_correct INTEGER,
  answered_at TEXT NOT NULL,
  FOREIGN KEY (duel_id) REFERENCES duel_matches(id),
  FOREIGN KEY (duel_question_id) REFERENCES duel_questions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_duel_answers_main
  ON duel_answers(duel_id, user_id, duel_question_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_duel_answer
  ON duel_answers(duel_id, duel_question_id, user_id);


-- ========================= ACCESS CODES =========================
CREATE TABLE IF NOT EXISTS access_codes (
  code TEXT PRIMARY KEY,
  used_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  expiration_days INTEGER DEFAULT NULL,         -- (0018)
  created_by_admin_id INTEGER,                  -- (0018)
  FOREIGN KEY (used_by_user_id) REFERENCES users(id)
);


-- ========================= ADMIN SESSIONS (token) =========================
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);


-- ========================= AI GENERATION LOG =========================
CREATE TABLE IF NOT EXISTS ai_generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  word_english TEXT NOT NULL,
  generated_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending / success / error
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_gen_log_word ON ai_generation_log(word_id);
CREATE INDEX IF NOT EXISTS idx_ai_gen_log_status ON ai_generation_log(status);
CREATE INDEX IF NOT EXISTS idx_ai_gen_log_created ON ai_generation_log(created_at);


-- ========================= SYSTEM SETTINGS =========================
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ========================= ADMINS / ANNOUNCEMENTS / ANALYTICS =========================
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_admin_id INTEGER,
  FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft / confirmed / sending / completed / failed
  total_users INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_by_admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  started_sending_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (created_by_admin_id) REFERENCES admins(id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status);
CREATE INDEX IF NOT EXISTS idx_announcements_created_by ON announcements(created_by_admin_id);

CREATE TABLE IF NOT EXISTS announcement_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,                           -- sent / failed / skipped
  error_message TEXT,
  sent_at TEXT,
  FOREIGN KEY (announcement_id) REFERENCES announcements(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_logs_announcement ON announcement_logs(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_logs_status ON announcement_logs(status);

CREATE TABLE IF NOT EXISTS user_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                             -- YYYY-MM-DD
  period_type TEXT NOT NULL,                      -- daily / weekly / monthly / yearly
  active_users INTEGER NOT NULL DEFAULT 0,
  new_users INTEGER NOT NULL DEFAULT 0,
  total_words_learned INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  avg_session_duration REAL DEFAULT 0,            -- minutes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, period_type)
);

CREATE INDEX IF NOT EXISTS idx_user_analytics_period_type ON user_analytics(period_type);


-- ========================= CUSTOM QUIZZES =========================
CREATE TABLE IF NOT EXISTS custom_quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  total_time_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft',           -- draft / active / published / completed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- daily tournament support (0033): a tournament is a custom_quizzes row with
  -- kind='tournament' and a scheduling window; kind='custom' = admin-built quiz.
  kind TEXT NOT NULL DEFAULT 'custom',            -- 'custom' | 'tournament'
  opens_at TEXT,                                  -- UTC 'YYYY-MM-DD HH:MM:SS' window open (tournament only)
  closes_at TEXT,                                 -- UTC hard close (tournament only)
  tournament_date TEXT,                           -- Iran-local 'YYYY-MM-DD' identity (tournament only)
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);

-- At most one tournament per Iran-local day; makes the "open" cron idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cq_tournament_date
  ON custom_quizzes(tournament_date) WHERE kind = 'tournament';

CREATE TABLE IF NOT EXISTS custom_quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  question_index INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,                   -- '1','2','3','4'
  explanation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  link_token TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',     -- in_progress / finished / auto_ended
  current_question_index INTEGER NOT NULL DEFAULT 1,
  chat_id INTEGER,                                -- (0021)
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  chosen_option TEXT,                             -- NULL = unanswered, '1','2','3','4'
  answered_at TEXT,
  FOREIGN KEY (attempt_id) REFERENCES custom_quiz_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES custom_quiz_questions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cq_questions_quiz_index ON custom_quiz_questions(quiz_id, question_index);
CREATE INDEX IF NOT EXISTS idx_cq_attempts_quiz_user ON custom_quiz_attempts(quiz_id, user_id);
CREATE INDEX IF NOT EXISTS idx_cq_attempts_user ON custom_quiz_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_cq_answers_attempt ON custom_quiz_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_cq_answers_question ON custom_quiz_answers(question_id);


-- ========================= WEEKLY LEAGUES (0033) =========================
-- Duolingo-style divisions. Standings are computed from activity_log over a
-- fixed Iran-calendar week [Saturday 00:00, next Saturday 00:00); they are NOT
-- a live counter, so activity in the final Friday-night hours counts fully for
-- that week (no gap). Settlement (promote/demote + next-week divisions) runs at
-- the Saturday-00:00 cron tick; results are announced Saturday morning.
CREATE TABLE IF NOT EXISTS league_seasons (
  week_start TEXT PRIMARY KEY,                    -- Iran-local 'YYYY-MM-DD' (Saturday)
  week_end   TEXT NOT NULL,                       -- Iran-local 'YYYY-MM-DD' (next Saturday, exclusive)
  status     TEXT NOT NULL DEFAULT 'active',      -- active | settled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS league_divisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start      TEXT NOT NULL,                  -- FK league_seasons.week_start (app-enforced)
  tier            INTEGER NOT NULL,               -- 1..N (1 = lowest / bronze)
  division_number INTEGER NOT NULL,               -- 1-based within (week_start, tier)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_league_divisions_week
  ON league_divisions(week_start, tier, division_number);

CREATE TABLE IF NOT EXISTS league_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  division_id INTEGER NOT NULL,
  tier        INTEGER NOT NULL,
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (division_id) REFERENCES league_divisions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_league_members_week_user
  ON league_members(week_start, user_id);
CREATE INDEX IF NOT EXISTS idx_league_members_division
  ON league_members(division_id);

CREATE TABLE IF NOT EXISTS league_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start       TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  tier             INTEGER NOT NULL,
  division_id      INTEGER NOT NULL,
  rank_in_division INTEGER NOT NULL,
  weekly_xp        INTEGER NOT NULL,
  outcome          TEXT NOT NULL,                  -- promote | demote | stay | removed | champion
  new_tier         INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_league_results_week_user
  ON league_results(week_start, user_id);
CREATE INDEX IF NOT EXISTS idx_league_results_week
  ON league_results(week_start);


-- ========================= ADMIN BOT CONVERSATION STATE =========================
-- Persists multi-step admin conversation state (Workers are stateless).
CREATE TABLE IF NOT EXISTS admin_bot_state (
  telegram_id INTEGER NOT NULL,
  scope       TEXT NOT NULL,                      -- 'admin' / 'quiz'
  state_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_admin_bot_state_updated ON admin_bot_state(updated_at);


-- ============================== LETTERS (نامه‌ها) ===============================
-- Standalone anonymous letters between subscribers. A new letter fans out to up
-- to 5 eligible recipients, each becoming an independent 1:1 thread. Recipients
-- can reply (unlimited) or block the sender. Identity is never revealed — only
-- the nickname snapshot stored on each message. See migrations/0031_letters.sql.

-- Per-user letters settings + onboarding marker. No row = not yet onboarded.
CREATE TABLE IF NOT EXISTS letter_users (
  user_id               INTEGER PRIMARY KEY,        -- FK users.id (app-enforced)
  nickname              TEXT NOT NULL,
  notif_enabled         INTEGER NOT NULL DEFAULT 1, -- 1 = send separate notif on new letter/reply
  receiving_disabled_at TEXT,                       -- NULL = receiving enabled; set = disabled (7-day lock from this ts)
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (sender, recipient) 1:1 conversation. A new-letter fan-out makes up to 5.
CREATE TABLE IF NOT EXISTS letter_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id       INTEGER NOT NULL,                 -- the original letter SENDER
  user_b_id       INTEGER NOT NULL,                 -- the RECIPIENT
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_letter_threads_a ON letter_threads(user_a_id);
CREATE INDEX IF NOT EXISTS idx_letter_threads_b ON letter_threads(user_b_id);

-- One row per actual message (original letter or reply). This row IS the delivery record.
CREATE TABLE IF NOT EXISTS letter_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id         INTEGER NOT NULL,
  sender_user_id    INTEGER NOT NULL,
  recipient_user_id INTEGER NOT NULL,
  sender_nickname   TEXT NOT NULL,                  -- SNAPSHOT at send time (never joined live)
  body              TEXT NOT NULL,
  is_reply          INTEGER NOT NULL DEFAULT 0,     -- 0 = original letter, 1 = reply
  ref_message_id    INTEGER,                        -- the message this replies to (for quote); NULL for originals
  is_read           INTEGER NOT NULL DEFAULT 0,
  replied_at        TEXT,                           -- set when the recipient has replied to THIS message
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_letter_msg_recipient ON letter_messages(recipient_user_id, is_reply, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_sender ON letter_messages(sender_user_id, is_reply, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_thread ON letter_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_created ON letter_messages(created_at);

-- Two-way block on REAL account ids (survives nickname changes).
CREATE TABLE IF NOT EXISTS letter_blocks (
  blocker_user_id INTEGER NOT NULL,
  blocked_user_id INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_letter_blocks_blocked ON letter_blocks(blocked_user_id);
