-- ایندکس برای افزایش سرعت لیدربورد هفتگی و ماهانه
-- بدون این ایندکس، محاسبه برترین‌ها نیاز به اسکن کل جدول دارد
CREATE INDEX IF NOT EXISTS idx_activity_created_at 
ON activity_log(created_at);

-- ایندکس ترکیبی برای جستجوی سریعتر XP در بازه‌های زمانی
CREATE INDEX IF NOT EXISTS idx_activity_created_xp 
ON activity_log(created_at, xp_delta);
