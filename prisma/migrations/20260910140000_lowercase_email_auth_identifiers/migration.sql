-- Email login identifiers are now stored lower-case (see src/utils/auth-identifier.ts).
-- Bring existing rows into that form so lower-cased lookups still find them.
--
-- Skips any row whose lower-cased value already belongs to a different row: those are genuine
-- duplicate accounts that must be merged/removed by hand, and rewriting one of them would trip the
-- (provider, identifier) unique index and abort the whole deploy.
UPDATE "auth_identifiers" a
   SET "identifier" = lower(btrim(a."identifier"))
 WHERE a."provider" = 'email'
   AND a."identifier" <> lower(btrim(a."identifier"))
   AND NOT EXISTS (
         SELECT 1
           FROM "auth_identifiers" b
          WHERE b."provider" = 'email'
            AND b."id" <> a."id"
            AND b."identifier" = lower(btrim(a."identifier"))
       );

-- Same for pending OTP targets, which are matched exactly on verify.
UPDATE "otp_tokens"
   SET "target_identifier" = lower(btrim("target_identifier"))
 WHERE "target_identifier" LIKE '%@%'
   AND "target_identifier" <> lower(btrim("target_identifier"))
   AND "is_used" = false
   AND "expires_at" > now();
