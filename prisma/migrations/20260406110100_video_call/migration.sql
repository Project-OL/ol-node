-- AlterEnum
ALTER TYPE "CoinTxType" ADD VALUE 'VIDEO_CALL';

-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'VIDEO_CALL';

-- CreateTable
CREATE TABLE "video_call_settings" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "price_per_min" INTEGER NOT NULL DEFAULT 1800,
    "block_lv5" BOOLEAN NOT NULL DEFAULT false,
    "block_lv10" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_call_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_call_sessions" (
    "id" TEXT NOT NULL,
    "caller_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "livekit_room" VARCHAR(255) NOT NULL,
    "price_per_min" INTEGER NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    "mins_charged" INTEGER NOT NULL DEFAULT 0,
    "coins_deducted" BIGINT NOT NULL DEFAULT 0,
    "points_awarded" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "end_reason" VARCHAR(100),

    CONSTRAINT "video_call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_call_settings_user_id_key" ON "video_call_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_call_sessions_livekit_room_key" ON "video_call_sessions"("livekit_room");

-- CreateIndex
CREATE INDEX "video_call_sessions_caller_id_status_idx" ON "video_call_sessions"("caller_id", "status");

-- CreateIndex
CREATE INDEX "video_call_sessions_creator_id_status_idx" ON "video_call_sessions"("creator_id", "status");

-- CreateIndex
CREATE INDEX "video_call_sessions_livekit_room_idx" ON "video_call_sessions"("livekit_room");

-- AddForeignKey
ALTER TABLE "video_call_settings" ADD CONSTRAINT "video_call_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_call_sessions" ADD CONSTRAINT "video_call_sessions_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_call_sessions" ADD CONSTRAINT "video_call_sessions_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
