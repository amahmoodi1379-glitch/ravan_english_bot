-- افزودن سوپر ادمین جدید با آیدی عددی 7907045821
-- idempotent: اگر این ادمین از قبل وجود داشته باشد چیزی درج نمی‌شود، و اگر
-- به‌عنوان ادمین عادی وجود داشته باشد به سوپر ادمین ارتقا پیدا می‌کند.

INSERT INTO admins (telegram_id, is_super_admin, first_name)
VALUES (7907045821, 1, 'Super Admin')
ON CONFLICT(telegram_id) DO UPDATE SET is_super_admin = 1;
