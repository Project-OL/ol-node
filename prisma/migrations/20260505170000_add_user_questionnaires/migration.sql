-- Create questionnaires
CREATE TABLE "questionnaires" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "require_all_correct" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  CONSTRAINT "questionnaires_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "questionnaire_questions" (
  "id" UUID NOT NULL,
  "questionnaire_id" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  CONSTRAINT "questionnaire_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "questionnaire_options" (
  "id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "label" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "is_correct" BOOLEAN NOT NULL DEFAULT false,
  "order" INTEGER NOT NULL,
  CONSTRAINT "questionnaire_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_questionnaire_attempts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "questionnaire_id" UUID NOT NULL,
  "questionnaire_version" INTEGER NOT NULL,
  "total_questions" INTEGER NOT NULL,
  "correct_count" INTEGER NOT NULL,
  "all_correct" BOOLEAN NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_questionnaire_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_questionnaire_answers" (
  "id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "selected_option_id" UUID,
  "selected_value" TEXT,
  "is_correct" BOOLEAN NOT NULL,
  CONSTRAINT "user_questionnaire_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "questionnaires_key_version_key" ON "questionnaires"("key", "version");
CREATE INDEX "questionnaires_key_is_active_idx" ON "questionnaires"("key", "is_active");
CREATE UNIQUE INDEX "questionnaire_questions_questionnaire_id_order_key" ON "questionnaire_questions"("questionnaire_id", "order");
CREATE UNIQUE INDEX "questionnaire_options_question_id_value_key" ON "questionnaire_options"("question_id", "value");
CREATE UNIQUE INDEX "questionnaire_options_question_id_order_key" ON "questionnaire_options"("question_id", "order");
CREATE INDEX "user_questionnaire_attempts_user_id_questionnaire_id_completed_at_idx" ON "user_questionnaire_attempts"("user_id", "questionnaire_id", "completed_at" DESC);
CREATE INDEX "user_questionnaire_attempts_user_id_questionnaire_id_questionnaire_version_all_correct_idx" ON "user_questionnaire_attempts"("user_id", "questionnaire_id", "questionnaire_version", "all_correct");
CREATE UNIQUE INDEX "user_questionnaire_answers_attempt_id_question_id_key" ON "user_questionnaire_answers"("attempt_id", "question_id");

ALTER TABLE "questionnaire_questions"
ADD CONSTRAINT "questionnaire_questions_questionnaire_id_fkey"
FOREIGN KEY ("questionnaire_id") REFERENCES "questionnaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "questionnaire_options"
ADD CONSTRAINT "questionnaire_options_question_id_fkey"
FOREIGN KEY ("question_id") REFERENCES "questionnaire_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_questionnaire_attempts"
ADD CONSTRAINT "user_questionnaire_attempts_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_questionnaire_attempts"
ADD CONSTRAINT "user_questionnaire_attempts_questionnaire_id_fkey"
FOREIGN KEY ("questionnaire_id") REFERENCES "questionnaires"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_questionnaire_answers"
ADD CONSTRAINT "user_questionnaire_answers_attempt_id_fkey"
FOREIGN KEY ("attempt_id") REFERENCES "user_questionnaire_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_questionnaire_answers"
ADD CONSTRAINT "user_questionnaire_answers_question_id_fkey"
FOREIGN KEY ("question_id") REFERENCES "questionnaire_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
