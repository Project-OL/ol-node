-- Some databases renamed the unique index to a truncated name in an older
-- `20260412082101_` revision. `20260415120000_refactor_global_gift_gallery` expects
-- `gift_gallery_progress_host_user_id_gift_gallery_section_item_id_key`.
-- This brings the live index name in line with migration replay (fixes migrate dev drift).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind = 'i'
      AND c.relname = 'gift_gallery_progress_host_user_id_gift_gallery_section_ite_key'
  ) THEN
    ALTER INDEX "gift_gallery_progress_host_user_id_gift_gallery_section_ite_key"
      RENAME TO "gift_gallery_progress_host_user_id_gift_gallery_section_item_id_key";
  END IF;
END $$;
