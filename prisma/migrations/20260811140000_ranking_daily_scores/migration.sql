-- CreateEnum
CREATE TYPE "RankingBoard" AS ENUM ('HOST', 'GIFT', 'RICH', 'AGENCY');

-- CreateTable
CREATE TABLE IF NOT EXISTS "ranking_daily_scores" (
    "id" UUID NOT NULL,
    "board" "RankingBoard" NOT NULL,
    "entity_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "score" BIGINT NOT NULL DEFAULT 0,
    "country" VARCHAR(100),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranking_daily_scores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ranking_daily_scores_board_entity_id_day_key"
  ON "ranking_daily_scores"("board", "entity_id", "day");

CREATE INDEX IF NOT EXISTS "ranking_daily_scores_board_day_score_idx"
  ON "ranking_daily_scores"("board", "day", "score" DESC);

CREATE INDEX IF NOT EXISTS "ranking_daily_scores_board_day_country_score_idx"
  ON "ranking_daily_scores"("board", "day", "country", "score" DESC);
