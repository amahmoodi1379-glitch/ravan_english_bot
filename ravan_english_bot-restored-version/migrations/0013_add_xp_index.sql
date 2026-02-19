-- ایندکس روی ستون امتیاز کل کاربران برای افزایش سرعت لیدربورد جهانی
CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp_total DESC);
