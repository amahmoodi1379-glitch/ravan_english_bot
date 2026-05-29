-- جدول تنظیمات سیستم
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- مقدار پیش‌فرض: تولید AI فعال است
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('ai_generation_enabled', '1');
