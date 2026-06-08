CREATE INDEX IF NOT EXISTS idx_words_active_order
ON words(is_active, order_index);
