-- Historical fix-up for an index name generated differently across environments.
-- On clean replay (shadow DB), the source index may not exist yet, so make this safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind = 'i'
      AND c.relname = 'gift_gallery_progress_host_user_id_gift_gallery_section_item_id'
  ) THEN
    ALTER INDEX "gift_gallery_progress_host_user_id_gift_gallery_section_item_id"
      RENAME TO "gift_gallery_progress_host_user_id_gift_gallery_section_ite_key";
  END IF;
END $$;
