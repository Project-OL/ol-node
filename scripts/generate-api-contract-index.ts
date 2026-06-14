/**
 * Emit docs/api-contract/API_CONTRACT_INDEX.md from API_CONTRACT_LOCK.json
 * Run: npx tsx scripts/generate-api-contract-index.ts
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const LOCK = path.join(ROOT, "docs/api-contract/API_CONTRACT_LOCK.json");
const OUT = path.join(ROOT, "docs/api-contract/API_CONTRACT_INDEX.md");

type Ep = {
  method: string;
  fullPath: string;
  auth: string;
  bodySchema?: string | null;
  querySchema?: string | null;
  response?: Record<string, unknown>;
  query?: Record<string, unknown>;
  timing?: { serverTimeoutMs: number; rateLimit?: string };
};

const lock = JSON.parse(fs.readFileSync(LOCK, "utf8")) as {
  lockedAt: string;
  endpointCount: number;
  global: { connectionTimeoutMs: number };
  modules: { module: string; prefix: string; endpoints: Ep[] }[];
};

const lines: string[] = [
  "# API contract index",
  "",
  `**Locked at:** ${lock.lockedAt} · **Endpoints:** ${lock.endpointCount} · **Timeout:** ${lock.global.connectionTimeoutMs}ms (all routes)`,
  "",
  "Detailed field locks: [`API_CONTRACT_LOCK.json`](./API_CONTRACT_LOCK.json) · Policy: [`README.md`](./README.md)",
  "",
  "| Method | Full path | Auth | Query schema | Body schema | Response keys (locked/top) | Timeout |",
  "|--------|-----------|------|--------------|-------------|----------------------------|---------|",
];

for (const mod of lock.modules) {
  lines.push("", `## ${mod.module} (\`${mod.prefix}\`)`, "");
  for (const ep of mod.endpoints) {
    const respKeys = ep.response ? Object.keys(ep.response).join(", ") : "—";
    const qSchema = ep.querySchema ?? (ep.query ? Object.keys(ep.query).join(", ") : "—");
    const bSchema = ep.bodySchema ?? "—";
    const timeout = ep.timing?.serverTimeoutMs ?? lock.global.connectionTimeoutMs;
    lines.push(
      `| ${ep.method} | \`${ep.fullPath}\` | ${ep.auth} | ${qSchema} | ${bSchema} | ${respKeys} | ${timeout}ms |`,
    );
  }
}

lines.push(
  "",
  "## Notes",
  "",
  "- **Timing:** Only server timeout is contract-locked. Latency SLAs are not in this file.",
  "- **Regenerate:** `npx tsx scripts/generate-api-contract-lock.ts` then `npx tsx scripts/generate-api-contract-index.ts`",
  "- **Cursor rule:** `.cursor/rules/api-contract-lock.mdc`",
  "",
);

fs.writeFileSync(OUT, lines.join("\n"));
console.log(`Wrote ${OUT}`);
