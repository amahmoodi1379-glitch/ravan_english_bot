-- جدول ادمین‌ها
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

CREATE INDEX IF NOT EXISTS idx_admins_telegram_id ON admins(telegram_id);

-- جدول اطلاعیه‌ها
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, confirmed, sending, completed, failed
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

-- جدول لاگ ارسال اطلاعیه به کاربران
CREATE TABLE IF NOT EXISTS announcement_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL, -- sent, failed, skipped
  error_message TEXT,
  sent_at TEXT,
  FOREIGN KEY (announcement_id) REFERENCES announcements(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_logs_announcement ON announcement_logs(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_logs_status ON announcement_logs(status);

-- جدول آمار کاربران
CREATE TABLE IF NOT EXISTS user_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, -- YYYY-MM-DD format
  period_type TEXT NOT NULL, -- daily, weekly, monthly, yearly
  active_users INTEGER NOT NULL DEFAULT 0,
  new_users INTEGER NOT NULL DEFAULT 0,
  total_words_learned INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  avg_session_duration REAL DEFAULT 0, -- in minutes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, period_type)
);

CREATE INDEX IF NOT EXISTS idx_user_analytics_date_period ON user_analytics(date, period_type);
CREATE INDEX IF NOT EXISTS idx_user_analytics_period_type ON user_analytics(period_type);

-- اضافه کردن فیلدهای جدید به جدول access_codes
-- نکته: created_at قبلا در migration 0006 اضافه شده است
ALTER TABLE access_codes ADD COLUMN expiration_days INTEGER DEFAULT NULL;
ALTER TABLE access_codes ADD COLUMN created_by_admin_id INTEGER;

-- اضافه کردن فیلدهای جدید به جدول users
ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN banned_until TEXT;
ALTER TABLE users ADD COLUMN banned_by_admin_id INTEGER;
ALTER TABLE users ADD COLUMN ban_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_users_banned ON users(is_banned);
CREATE INDEX IF NOT EXISTS idx_users_banned_until ON users(banned_until);

-- درج ادمین اصلی
INSERT OR IGNORE INTO admins (telegram_id, is_super_admin, first_name) 
VALUES (1487748829, 1, 'Super Admin');
