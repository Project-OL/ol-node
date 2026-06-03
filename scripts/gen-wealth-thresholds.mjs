import fs from "fs";

const raw = fs.readFileSync(
  new URL("./wealth-levels-input.tsv", import.meta.url),
  "utf8",
);

const rows = raw
  .trim()
  .split(/\n/)
  .map((line) => {
    const [l, v] = line.split("\t");
    const level = parseInt(l.replace(/\s*MAX.*/i, "").trim(), 10);
    const threshold = BigInt(v.replace(/,/g, "").trim());
    return { level, threshold };
  });

function fmtBigInt(n) {
  const s = n.toString();
  const parts = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join("_");
}

const tsBody = rows
  .map((r) => `  { level: ${r.level}, threshold: ${fmtBigInt(r.threshold)}n },`)
  .join("\n");

const sqlVals = rows
  .map((r) => `  (${r.level}, ${r.threshold}::bigint)`)
  .join(",\n");

const migration = `-- WEALTH wallet levels: 200-tier curve (max Lv200).

INSERT INTO "wallet_level_configs" ("id", "level_type", "level", "threshold", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), 'WEALTH'::"LevelType", v.level, v.threshold, true, NOW(), NOW()
FROM (
  VALUES
${sqlVals}
) AS v(level, threshold)
ON CONFLICT ("level_type", "level") DO UPDATE SET
  "threshold" = EXCLUDED."threshold",
  "is_active" = true,
  "updated_at" = NOW();

UPDATE "wallet_level_configs"
SET "is_active" = false, "updated_at" = NOW()
WHERE "level_type" = 'WEALTH' AND "level" > 200;

UPDATE "wallet_user_levels" AS wul
SET
  "current_level" = COALESCE(
    (
      SELECT MAX(wlc."level")
      FROM "wallet_level_configs" wlc
      WHERE wlc."level_type" = 'WEALTH'
        AND wlc."is_active" = true
        AND wlc."threshold" <= wul."cumulative_total"
    ),
    1
  ),
  "updated_at" = NOW()
WHERE wul."level_type" = 'WEALTH';
`;

import { mkdirSync } from "fs";
const migDir = new URL(
  "../prisma/migrations/20260604120000_wealth_level_thresholds_200/",
  import.meta.url,
);
mkdirSync(migDir, { recursive: true });
fs.writeFileSync(new URL("migration.sql", migDir), migration);

const defaultsPath = new URL(
  "../src/config/wallet-level-thresholds.defaults.ts",
  import.meta.url,
);
const livestream = fs.readFileSync(defaultsPath, "utf8").split(
  "/** LIVESTREAM — point ledger credits",
)[1];
const header = `/**
 * Cumulative credit thresholds for wallet ledger levels (\`wallet_level_configs\`).
 * Level N applies when cumulativeTotal >= threshold for level N (highest matching wins).
 */

export type WalletLevelThreshold = { level: number; threshold: bigint };

/** WEALTH — coin ledger credits (200 levels, max Lv200). */
export const DEFAULT_WEALTH_LEVEL_THRESHOLDS: WalletLevelThreshold[] = [
`;
const footer = `];

export const WEALTH_MAX_LEVEL = 200;

/** LIVESTREAM — point ledger credits`;
fs.writeFileSync(
  defaultsPath,
  header + tsBody + "\n" + footer + livestream,
);

console.log(`Generated ${rows.length} wealth tiers`);
