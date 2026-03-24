-- Drop existing auth/profile tables (from previous schema) if present
DROP TABLE IF EXISTS "user_profiles";
DROP TABLE IF EXISTS "user_auth_identities";
DROP TABLE IF EXISTS "user_devices";
DROP TABLE IF EXISTS "user_sessions";
DROP TABLE IF EXISTS "otp_verifications";
DROP TABLE IF EXISTS "users";

-- CreateTable: users
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(255) NOT NULL,
    "public_id" BIGINT NOT NULL,
    "default_public_id" BIGINT NOT NULL,
    "first_name" VARCHAR(255),
    "last_name" VARCHAR(255),
    "date_of_birth" DATE,
    "country" VARCHAR(100),
    "gender" VARCHAR(50),
    "avatar_url" VARCHAR(500),
    "status" VARCHAR(50) NOT NULL DEFAULT 'new',
    "password_set" BOOLEAN NOT NULL DEFAULT false,
    "profile_completed_at" TIMESTAMP(3),
    "current_vip_public_id" BIGINT,
    "vip_public_id_expires_at" TIMESTAMP(3),
    "vip_purchase_at" TIMESTAMP(3),
    "last_ip_address" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable: auth_identifiers
CREATE TABLE "auth_identifiers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "auth_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: auth_passwords
CREATE TABLE "auth_passwords" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "previous_password_hashes" TEXT[],
    "last_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_passwords_pkey" PRIMARY KEY ("id")
);

-- CreateTable: otp_tokens
CREATE TABLE "otp_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "otp_hash" VARCHAR(255) NOT NULL,
    "otp_purpose" VARCHAR(50) NOT NULL,
    "target_identifier" VARCHAR(255) NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable: sessions
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_name" VARCHAR(255) NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "device_fingerprint" VARCHAR(500),
    "refresh_token_hash" VARCHAR(255) NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "user_agent" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "login_type" VARCHAR(50),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: device_registry
CREATE TABLE "device_registry" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "device_name" VARCHAR(255) NOT NULL,
    "device_type" VARCHAR(50),
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable: vip_public_ids
CREATE TABLE "vip_public_ids" (
    "id" UUID NOT NULL,
    "public_id" BIGINT NOT NULL,
    "rarity_score" INTEGER NOT NULL,
    "pattern_type" VARCHAR(50),
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "current_owner_id" UUID,
    "price_credits" INTEGER,
    "purchased_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_public_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable: audit_logs
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action_type" VARCHAR(100) NOT NULL,
    "action_status" VARCHAR(50) NOT NULL,
    "action_details" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "device_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: next_public_id_sequence
CREATE TABLE "next_public_id_sequence" (
    "id" INTEGER NOT NULL,
    "next_value" BIGINT NOT NULL,

    CONSTRAINT "next_public_id_sequence_pkey" PRIMARY KEY ("id")
);

-- Indexes: users
CREATE UNIQUE INDEX "users_public_id_key" ON "users"("public_id");
CREATE UNIQUE INDEX "users_default_public_id_key" ON "users"("default_public_id");
CREATE UNIQUE INDEX "users_current_vip_public_id_key" ON "users"("current_vip_public_id");
CREATE INDEX "users_public_id_idx" ON "users"("public_id");
CREATE INDEX "users_default_public_id_idx" ON "users"("default_public_id");
CREATE INDEX "users_username_idx" ON "users"("username");
CREATE INDEX "users_status_idx" ON "users"("status");
CREATE INDEX "users_created_at_idx" ON "users"("created_at" DESC);

-- Indexes: auth_identifiers
CREATE INDEX "auth_identifiers_user_id_idx" ON "auth_identifiers"("user_id");
CREATE INDEX "auth_identifiers_provider_idx" ON "auth_identifiers"("provider");
CREATE INDEX "auth_identifiers_identifier_idx" ON "auth_identifiers"("identifier");
CREATE UNIQUE INDEX "auth_identifiers_provider_identifier_key" ON "auth_identifiers"("provider", "identifier");
CREATE UNIQUE INDEX "auth_identifiers_user_id_provider_key" ON "auth_identifiers"("user_id", "provider");

-- Indexes: auth_passwords
CREATE UNIQUE INDEX "auth_passwords_user_id_key" ON "auth_passwords"("user_id");
CREATE INDEX "auth_passwords_user_id_idx" ON "auth_passwords"("user_id");

-- Indexes: otp_tokens
CREATE INDEX "otp_tokens_user_id_idx" ON "otp_tokens"("user_id");
CREATE INDEX "otp_tokens_expires_at_idx" ON "otp_tokens"("expires_at");
CREATE INDEX "otp_tokens_otp_purpose_idx" ON "otp_tokens"("otp_purpose");
CREATE INDEX "otp_tokens_target_identifier_otp_purpose_idx" ON "otp_tokens"("target_identifier", "otp_purpose");

-- Indexes: sessions
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_device_id_idx" ON "sessions"("device_id");
CREATE INDEX "sessions_is_active_idx" ON "sessions"("is_active");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
CREATE INDEX "sessions_user_id_device_id_idx" ON "sessions"("user_id", "device_id");

-- Indexes: device_registry
CREATE UNIQUE INDEX "device_registry_device_id_key" ON "device_registry"("device_id");
CREATE INDEX "device_registry_user_id_idx" ON "device_registry"("user_id");
CREATE INDEX "device_registry_device_id_idx" ON "device_registry"("device_id");

-- Indexes: vip_public_ids
CREATE UNIQUE INDEX "vip_public_ids_public_id_key" ON "vip_public_ids"("public_id");
CREATE INDEX "vip_public_ids_is_available_idx" ON "vip_public_ids"("is_available");
CREATE INDEX "vip_public_ids_current_owner_id_idx" ON "vip_public_ids"("current_owner_id");
CREATE INDEX "vip_public_ids_expires_at_idx" ON "vip_public_ids"("expires_at");

-- Indexes: audit_logs
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");
CREATE INDEX "audit_logs_action_type_idx" ON "audit_logs"("action_type");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- Foreign keys
ALTER TABLE "auth_identifiers" ADD CONSTRAINT "auth_identifiers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_passwords" ADD CONSTRAINT "auth_passwords_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "otp_tokens" ADD CONSTRAINT "otp_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_registry" ADD CONSTRAINT "device_registry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vip_public_ids" ADD CONSTRAINT "vip_public_ids_current_owner_id_fkey" FOREIGN KEY ("current_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: next public ID starts at 34216589
INSERT INTO "next_public_id_sequence" ("id", "next_value") VALUES (1, 34216589);
