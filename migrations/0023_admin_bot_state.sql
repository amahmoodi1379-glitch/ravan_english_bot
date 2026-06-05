-- نگهداری وضعیت مکالمه ادمین در ربات (به جای Map درون حافظه Worker)
--
-- مشکل: Cloudflare Workers بدون state است. متغیرهای سراسری (مثل Map)
-- مخصوص هر isolate هستند و بین درخواست‌ها به‌صورت قابل‌اعتماد باقی نمی‌مانند.
-- در نتیجه فرآیندهای چندمرحله‌ای ادمین (مثل ساخت لایسنس) نیمه‌کاره می‌ماندند و
-- ربات پیام‌های بی‌ربط می‌داد. این جدول وضعیت را در D1 پایدار می‌کند.
--
-- این مایگریشن هیچ داده‌ای را حذف نمی‌کند.

CREATE TABLE IF NOT EXISTS admin_bot_state (
  telegram_id INTEGER NOT NULL,
  scope       TEXT NOT NULL,            -- 'admin' یا 'quiz'
  state_json  TEXT NOT NULL,            -- وضعیت سریالایز شده به صورت JSON
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, scope)
);

-- برای پاکسازی احتمالی وضعیت‌های قدیمی
CREATE INDEX IF NOT EXISTS idx_admin_bot_state_updated ON admin_bot_state(updated_at);
