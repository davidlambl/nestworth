ALTER TABLE transaction_splits DROP COLUMN IF EXISTS category_id;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE categories;
EXCEPTION WHEN undefined_object THEN
  NULL;
END;
$$;

DROP TABLE IF EXISTS categories;
