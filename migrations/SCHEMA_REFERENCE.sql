-- ============================================================
-- SCHEMA REFERENCE FILE (DO NOT RUN AS MIGRATION)
-- This file documents the final state of the database schema
-- after all migrations have been applied.
-- Last updated: 2026-06-07 (after migration 0025)
-- ============================================================

-- === کاربران ===
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  avatar_code TEXT,
  name_change_count INTEGER NOT NULL DEFAULT 0,
  xp_total INTEGER NOT NULL DEFAULT 0,
  is_approved INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  banned_until TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  last_streak_date TEXT,
  max_streak_record INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  last_seen_at TEXT
);

-- === واژه‌ها ===
CREATE TABLE words (
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

CREATE INDEX idx_words_level ON words(level);
CREATE INDEX idx_words_active_order ON words(is_active, order_index);

-- === وضعیت FSRS (مرور فاصله‌دار) برای هر کاربر-واژه ===
-- Note: table name kept as user_words_sm2 for backward compatibility
CREATE TABLE user_words_sm2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  -- Legacy SM2 fields (kept for data continuity)
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  -- Scheduling
  next_review_date TEXT NOT NULL,
  last_reviewed_at TEXT,
  -- Flags
  ignored INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  question_stage INTEGER NOT NULL DEFAULT 1, -- 1-5, determines question difficulty
  -- FSRS-5 fields
  stability REAL NOT NULL DEFAULT 0,      -- S: time for R to decay to 90%
  difficulty REAL NOT NULL DEFAULT 0,     -- D: [1..10]
  card_state INTEGER NOT NULL DEFAULT 0,  -- 0=New, 1=Learning, 2=Review, 3=Relearning
  lapses INTEGER NOT NULL DEFAULT 0,      -- number of times forgot
  reps INTEGER NOT NULL DEFAULT 0,        -- total review count
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(user_id, word_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX idx_user_words_next_review ON user_words_sm2(user_id, next_review_date);
CREATE INDEX idx_user_words_fsrs_schedule ON user_words_sm2(user_id, ignored, card_state, next_review_date);

-- === سوال‌های واژگان ===
CREATE TABLE word_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL, -- A/B/C/D
  question_style TEXT NOT NULL, -- en_to_fa, fa_to_en, definition_to_word, word_to_definition, cloze
  explanation_text TEXT,
  source TEXT NOT NULL DEFAULT 'ai', -- ai, manual, seed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX idx_word_questions_word ON word_questions(word_id);

-- === تاریخچه سوال‌های دیده‌شده ===
CREATE TABLE user_word_question_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  context TEXT NOT NULL, -- 'leitner', 'reading', etc.
  is_correct INTEGER,
  shown_at TEXT NOT NULL,
  answered_at TEXT,
  chat_id INTEGER,
  UNIQUE(user_id, question_id, context),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (question_id) REFERENCES word_questions(id)
);

CREATE INDEX idx_uwqh_user_word ON user_word_question_history(user_id, word_id);

-- === لاگ فعالیت و XP ===
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL, -- leitner_question, reading_session
  ref_id INTEGER,
  xp_delta INTEGER NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_activity_user_created ON activity_log(user_id, created_at);

-- === متن‌های ریدینگ ===
CREATE TABLE reading_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reading_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  question_type TEXT NOT NULL,
  explanation_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

CREATE TABLE reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress, completed, cancelled
  correct_count INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

-- === کدهای دسترسی ===
CREATE TABLE access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  expiration_days INTEGER,
  used_by_user_id INTEGER,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

-- === آزمون‌های سفارشی ===
CREATE TABLE custom_quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  token TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_admin TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE custom_quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id)
);

CREATE TABLE custom_quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress',
  chat_id INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- === ادمین ===
CREATE TABLE admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  state_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE admin_bot_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER,
  prompt TEXT,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
