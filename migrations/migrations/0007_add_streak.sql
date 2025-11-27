-- اضافه کردن ستون‌های مربوط به زنجیره (Streak)
ALTER TABLE users ADD COLUMN streak_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_streak_date TEXT;
