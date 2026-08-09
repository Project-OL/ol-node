-- Normalize free-text country casing to Title Case (PostgreSQL INITCAP)
-- so India / india / INDIA collapse for assignment and filtering.
-- Do NOT touch otp_delivery_audits.country (may hold ISO alpha-2 from phone).

UPDATE "users"
SET "country" = INITCAP(TRIM("country"))
WHERE "country" IS NOT NULL AND BTRIM("country") <> '';

UPDATE "system_admins"
SET "country" = INITCAP(TRIM("country"))
WHERE "country" IS NOT NULL AND BTRIM("country") <> '';

-- Collapse case-duplicate country_language_mappings before unique INITCAP.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(country))
      ORDER BY id
    ) AS rn
  FROM "country_language_mappings"
)
DELETE FROM "country_language_mappings"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

UPDATE "country_language_mappings"
SET "country" = INITCAP(TRIM("country"))
WHERE "country" IS NOT NULL AND BTRIM("country") <> '';
