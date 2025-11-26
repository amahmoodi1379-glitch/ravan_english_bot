-- ایجاد جدول کاربران
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
  last_seen_at TEXT
);

-- جدول واژه‌ها
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

-- وضعیت SM2 برای هر کاربر-واژه
CREATE TABLE IF NOT EXISTS user_words_sm2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 1,
  repetitions INTEGER NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  next_review_date TEXT NOT NULL,
  last_reviewed_at TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  question_stage INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(user_id, word_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_user_words_next_review
  ON user_words_sm2(user_id, next_review_date);

-- جدول سوال‌های واژگان
CREATE TABLE IF NOT EXISTS word_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL,
  question_style TEXT NOT NULL,
  explanation_text TEXT,
  source TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_word_questions_word ON word_questions(word_id);

-- تاریخچه سوال‌هایی که هر کاربر دیده
CREATE TABLE IF NOT EXISTS user_word_question_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  context TEXT NOT NULL,
  is_correct INTEGER,
  shown_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE(user_id, question_id, context),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (question_id) REFERENCES word_questions(id)
);

CREATE INDEX IF NOT EXISTS idx_uwqh_user_word
  ON user_word_question_history(user_id, word_id);

-- لاگ فعالیت و XP
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL,
  ref_id INTEGER,
  xp_delta INTEGER NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_activity_user_created
  ON activity_log(user_id, created_at);

-- داده‌ی نمونه: یک واژه و یک سوال ابتدایی برای تست

INSERT OR IGNORE INTO words (id, english, persian, level, lesson_name, order_index)
VALUES (1, 'apple', 'سیب', 1, 'demo', 1);

INSERT OR IGNORE INTO word_questions (
  id,
  word_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_option,
  question_style,
  explanation_text,
  source
)
VALUES (
  1,
  1,
  'معنی کلمه "apple" چیست؟',
  'سیب',
  'موز',
  'کتاب',
  'ماشین',
  'A',
  'fa_meaning',
  'apple یعنی سیب.',
  'seed'
);
