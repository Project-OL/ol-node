-- AlterTable
ALTER TABLE "gift_galleries" ALTER COLUMN "updated_at" DROP DEFAULT;

-- Note: the original `RenameIndex` was removed. On a clean replay the source index name
-- never existed before the gallery refactor (`20260415120000_*`), so it broke the shadow DB.
-- Production DBs that already ran the old rename keep their current index names; Prisma does
-- not require this rename for application behavior.
