-- جدول کدهای دسترسی
CREATE TABLE IF NOT EXISTS access_codes (
  code TEXT PRIMARY KEY,
  used_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id)
);

-- اضافه کردن ستون وضعیت تایید به کاربران
-- نکته: چون SQLite در D1 محدودیت‌هایی در ALTER TABLE دارد، ما فرض می‌کنیم
-- این ستون را اضافه می‌کنیم. اگر ارور داد باید دیتابیس را ریست کنی یا روش دیگری برویم.
-- اما معمولا دستور زیر کار می‌کند:
ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 0;
