-- این دستور به دیتابیس می‌گوید:
-- روی جدول بازی‌ها (duel_matches)، یک قانون یکتا (Unique) بساز.
-- قانون: هر بازیکن (player1_id) فقط می‌تواند یک بازی داشته باشد
-- شرط: اگر وضعیت بازی 'waiting' (منتظر حریف) یا 'in_progress' (در حال بازی) باشد.

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_duel_per_user 
ON duel_matches(player1_id) 
WHERE status IN ('waiting', 'in_progress');
