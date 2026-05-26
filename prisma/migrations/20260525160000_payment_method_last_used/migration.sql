ALTER TABLE "user_payment_methods" ADD COLUMN "last_used_at" TIMESTAMP(3);

UPDATE "user_payment_methods" SET "last_used_at" = "updated_at" WHERE "last_used_at" IS NULL;
