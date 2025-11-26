-- جدول متون برای درک مطلب
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

-- سوال‌های مربوط به هر متن
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

CREATE INDEX IF NOT EXISTS idx_text_questions_text ON text_questions(text_id);

-- سِت‌های تست درک مطلب برای هر کاربر
CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress / completed
  num_correct INTEGER NOT NULL DEFAULT 0,
  num_questions INTEGER NOT NULL DEFAULT 3,
  xp_gained INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (text_id) REFERENCES reading_texts(id)
);

CREATE INDEX IF NOT EXISTS idx_reading_sessions_user ON reading_sessions(user_id, text_id);

-- تاریخچه سوال‌های درک مطلب که هر کاربر دیده
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

-- تمرین "برداشت از متن" (reflection) بدون XP
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

-- داده نمونه: یک متن ساده و یک سوال چهارگزینه‌ای برای تست

INSERT OR IGNORE INTO reading_texts (id, title, body_en, level)
VALUES (
  1,
  'A short story about a morning routine',
  'Emma wakes up early every morning. She drinks a glass of water, makes a cup of coffee, and then goes for a short walk in the park before starting work.',
  1
);

INSERT OR IGNORE INTO text_questions (
  id,
  text_id,
  question_text,
  option_a,
  option_b,
  option_c,
  option_d,
  correct_option,
  explanation_text,
  source
)
VALUES (
  1,
  1,
  'What does Emma do first in the morning?',
  'She drinks a glass of water.',
  'She makes a cup of coffee.',
  'She goes for a walk.',
  'She starts work.',
  'A',
  'The text says she drinks a glass of water first.',
  'seed'
);
