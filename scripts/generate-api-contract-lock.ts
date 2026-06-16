/**
 * Scan registered route modules and emit docs/api-contract/API_CONTRACT_LOCK.json
 * Run: npx tsx scripts/generate-api-contract-lock.ts
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const ROUTES_DIR = path.join(ROOT, "src/routes/v1");
const OUT_DIR = path.join(ROOT, "docs/api-contract");
const OUT_JSON = path.join(OUT_DIR, "API_CONTRACT_LOCK.json");

/** Mirrors src/app.ts registration (prefix relative to server root). */
const MODULE_PREFIXES: Record<string, string> = {
  "health.routes.ts": "/health",
  "auth.routes.ts": "/api/v1/auth",
  "security-password.routes.ts": "/api/v1/security",
  "device.routes.ts": "/api/v1/devices",
  "privacy.routes.ts": "/api/v1/privacy",
  "account-deletion.routes.ts": "/api/v1/account",
  "upload.routes.ts": "/api/v1/upload",
  "social.routes.ts": "/api/v1/social",
  "users.routes.ts": "/api/v1/users",
  "settings.routes.ts": "/api/v1/settings",
  "post.routes.ts": "/api/v1/posts",
  "conversation.routes.ts": "/api/v1/conversations",
  "message.routes.ts": "/api/v1/messages",
  "block.routes.ts": "/api/v1/blocks",
  "report.routes.ts": "/api/v1/reports",
  "reminder.routes.ts": "/api/v1/reminders",
  "wallet-coins.routes.ts": "/api/v1/wallet/coins",
  "wallet-points.routes.ts": "/api/v1/wallet/points",
  "wallet-levels.routes.ts": "/api/v1/wallet/levels",
  "call.routes.ts": "/api/v1/call",
  "gift.routes.ts": "/api/v1/gifts",
  "gift-gallery.routes.ts": "/api/v1/gift-gallery",
  "fan-ranking.routes.ts": "/api/v1/fan-ranking",
  "subscription.routes.ts": "/api/v1/subscriptions",
  "guardian.routes.ts": "/api/v1/guardian",
  "super-host.routes.ts": "/api/v1/admin",
  "store-admin.routes.ts": "/api/v1/admin",
  "support.routes.ts": "/api/v1/support",
  "store.routes.ts": "/api/v1/store",
  "rich-tier.routes.ts": "/api/v1/rich-tier",
  "vip-membership.routes.ts": "/api/v1/vip-membership",
  "agency.routes.ts": "/api/v1/agency",
  "agency-kyc.routes.ts": "/api/v1/agency/kyc",
  "agency-coinseller.routes.ts": "/api/v1/agency/coinseller",
  "coin-trading.routes.ts": "/api/v1/coin-trading",
  "payment-method.routes.ts": "/api/v1/payment-methods",
  "withdrawal.routes.ts": "/api/v1/withdrawal",
  "webhooks.routes.ts": "/api/v1/webhooks",
  "questionnaire.routes.ts": "/api/v1/questionnaires",
  "face-verification.routes.ts": "/api/v1/face-verification",
  "face-registration.routes.ts": "/api/v1/face-registration",
  "live-photo.routes.ts": "/api/v1/live-photo",
  "agency-admin.routes.ts": "/api/v1/admin/agency",
  "questionnaire-admin.routes.ts": "/api/v1/admin/questionnaires",
};

const ROUTE_RE =
  /app\.(get|post|put|patch|delete)\s*(?:<[^>]+>\s*)?\(\s*['"`]([^'"`]+)['"`]/gi;

const AUTH_RE =
  /preHandler:\s*\[([^\]]+)\]|preHandler:\s*(\w+)/g;
const SCHEMA_PARSE_RE = /(\w+Schema|\w+BodySchema)\.parse/g;
const ZOD_OBJECT_RE = /const\s+(\w+Schema)\s*=\s*z\./g;

type LockedField = {
  type: string;
  required?: boolean;
  optional?: boolean;
  values?: string[];
  description?: string;
};

type EndpointLock = {
  id: string;
  method: string;
  path: string;
  fullPath: string;
  auth: string;
  sourceFile: string;
  bodySchema?: string | null;
  querySchema?: string | null;
  headers?: Record<string, LockedField>;
  query?: Record<string, LockedField>;
  body?: Record<string, LockedField>;
  response?: Record<string, LockedField | { type: string; items?: Record<string, LockedField> }>;
  timing?: {
    serverTimeoutMs: number;
    rateLimit?: string;
    notes?: string;
  };
};

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function detectAuth(block: string): string {
  if (/requireAdmin/.test(block)) return "admin-jwt";
  if (/requireAgent|preAgent/.test(block)) return "agent-jwt";
  if (/authenticate/.test(block)) return "jwt";
  if (/verifyLiveWebhookSecret|webhook/i.test(block)) return "webhook-secret";
  if (/epay|signature/i.test(block)) return "webhook-hmac";
  return "public";
}

function extractSchemas(content: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const re1 = new RegExp(ZOD_OBJECT_RE.source, "g");
  while ((m = re1.exec(content)) !== null) names.add(m[1]!);
  return [...names];
}

function parseRouteFile(fileName: string, prefix: string): EndpointLock[] {
  const filePath = path.join(ROUTES_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const schemaNames = extractSchemas(content);
  const endpoints: EndpointLock[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ROUTE_RE.source, "gi");
  while ((match = re.exec(content)) !== null) {
    const method = match[1]!.toUpperCase();
    const routePath = match[2]!;
    const start = Math.max(0, match.index - 200);
    const end = Math.min(content.length, match.index + 800);
    const block = content.slice(start, end);
    const auth = detectAuth(block);
    const schemaParse = [...block.matchAll(/(\w+Schema)\.parse/g)].map((x) => x[1]);
    const bodySchema = schemaParse.find((s) => /body|Body|Schema/i.test(s)) ?? null;
    const querySchema =
      schemaParse.find((s) => /Query|query/i.test(s)) ??
      (block.includes("request.query") ? "inline-query" : null);
    const id = `${slug(fileName.replace(".routes.ts", ""))}.${slug(routePath)}.${method.toLowerCase()}`;
    const fullPath = `${prefix}${routePath === "/" ? "" : routePath}`.replace(/\/+/g, "/") || prefix;
    endpoints.push({
      id,
      method,
      path: routePath,
      fullPath,
      auth,
      sourceFile: `src/routes/v1/${fileName}`,
      bodySchema: bodySchema ?? null,
      querySchema: typeof querySchema === "string" ? querySchema : null,
      timing: {
        serverTimeoutMs: 30_000,
        notes: "Per-endpoint latency not locked; global connection timeout 30s",
      },
    });
  }
  if (schemaNames.length && endpoints.length) {
    for (const ep of endpoints) {
      if (!ep.bodySchema && schemaNames.length === 1) ep.bodySchema = schemaNames[0] ?? null;
    }
  }
  return endpoints;
}

/** Hand-maintained locked field shapes (override / enrich generator output). */
const FIELD_OVERRIDES: Record<string, Partial<EndpointLock>> = {
  "coin-trading.transfers.get": {
    query: {
      direction: { type: "enum", optional: true, values: ["credit", "debit"] },
      role: {
        type: "enum",
        optional: true,
        deprecated: true,
        values: ["sent", "received"],
        description: "Ignored; use direction instead",
      },
      fromDate: { type: "string", optional: true, description: "ISO-8601 datetime" },
      toDate: { type: "string", optional: true, description: "ISO-8601 datetime" },
      limit: { type: "integer", optional: true, description: "1-50, default 20" },
      cursor: { type: "string", optional: true, description: "UUID ledger entry id" },
    },
    response: {
      items: {
        type: "array",
        items: {
          id: { type: "string", description: "UUID ledger entry id" },
          direction: { type: "enum", values: ["credit", "debit"] },
          txType: { type: "string", description: "CoinTxType" },
          amount: { type: "string", description: "BigInt serialized" },
          balanceAfter: { type: "string", description: "BigInt serialized" },
          description: { type: "string", optional: true },
          refId: { type: "string", optional: true },
          createdAt: { type: "string", description: "ISO-8601" },
          counterparty: {
            type: "object",
            optional: true,
            description: "null when not a peer transfer",
          },
          transferId: {
            type: "string",
            optional: true,
            deprecated: true,
            description: "coin_trading_transfers.id when txType is TRADING_TRANSFER_IN|OUT",
          },
          tradingCoinsDebited: {
            type: "string",
            optional: true,
            deprecated: true,
            description: "Present on TRADING_TRANSFER_* rows; prefer amount on debits",
          },
          coinsCredited: {
            type: "string",
            optional: true,
            deprecated: true,
            description: "Present on TRADING_TRANSFER_* rows; prefer amount on credits",
          },
          recipientWalletType: {
            type: "string",
            optional: true,
            deprecated: true,
            description: "PERSONAL|TRADING on peer transfer rows",
          },
        },
      },
      nextCursor: { type: "string", optional: true, description: "UUID or null" },
    },
  },
  "coin-trading.history.get": {
    query: {
      direction: { type: "enum", optional: true, values: ["credit", "debit"] },
      types: {
        type: "string",
        optional: true,
        description: "Comma-separated CoinTxType; default includes ADJUSTMENT",
      },
      fromDate: { type: "string", optional: true, description: "ISO-8601 datetime" },
      toDate: { type: "string", optional: true, description: "ISO-8601 datetime" },
      limit: { type: "integer", optional: true, description: "1-50, default 20" },
      cursor: { type: "string", optional: true, description: "UUID ledger entry id" },
    },
    response: {
      items: {
        type: "array",
        items: {
          id: { type: "string", description: "UUID ledger entry id" },
          direction: { type: "enum", values: ["credit", "debit"] },
          txType: { type: "string", description: "CoinTxType incl. ADJUSTMENT" },
          amount: { type: "string", description: "BigInt serialized" },
          balanceAfter: { type: "string", description: "BigInt serialized" },
          description: { type: "string", optional: true },
          refId: { type: "string", optional: true },
          counterpartyId: { type: "string", optional: true, description: "UUID or null" },
          createdAt: { type: "string", description: "ISO-8601" },
        },
      },
      nextCursor: { type: "string", optional: true, description: "UUID or null" },
    },
  },
  "coin-trading.balance.get": {
    response: {
      balance: { type: "string", description: "BigInt serialized TRADING_COIN balance" },
    },
  },
  "payment-methods.get": {
    response: {
      methods: {
        type: "array",
        description: "Owner-only full details; each item includes feeRateBp, feePercent, arrivalTime",
      },
    },
  },
  "withdrawal.payout-rails.get": {
    response: {
      epay: { type: "object" },
      bank: { type: "object" },
      updatedAt: { type: "string", description: "ISO-8601" },
    },
  },
  "users.resolve-publicid.get": {
    response: {
      userId: { type: "string", description: "UUID" },
      username: { type: "string", description: "username" },
      name: { type: "string", description: "Display name (firstName lastName, or username fallback)" },
      publicId: { type: "string", description: "Base public_id (decimal string)" },
      displayPublicId: { type: "string", description: "Visible ID (VIP overlay or base)" },
      isAgency: { type: "boolean", description: "users.is_agent" },
      avatarUrl: { type: "string", optional: true, description: "CDN URL or null" },
    },
  },
  "auth.signup-complete-profile.post": {
    body: {
      firstName: { type: "string", required: true, description: "User first name, 1-255 chars" },
      lastName: { type: "string", optional: true, description: "User last name, 0-255 chars; empty string or omitted stores null" },
      dateOfBirth: { type: "string", optional: true, description: "YYYY-MM-DD format" },
      country: { type: "string", required: true, description: "Country code or name, 1-100 chars" },
      gender: { type: "enum", required: true, values: ["male", "female", "other"] },
      avatarUrl: { type: "string", optional: true, description: "Full URL; omit, null, or empty string when no avatar" },
      deviceId: { type: "string", optional: true, description: "Stable app install UUID; required with deviceName" },
      deviceName: { type: "string", optional: true, description: "Device display name; required with deviceId" },
    },
  },
};

function applyOverrides(endpoints: EndpointLock[]): EndpointLock[] {
  return endpoints.map((ep) => {
    const key = `${slug(ep.sourceFile.replace("src/routes/v1/", "").replace(".routes.ts", ""))}.${slug(ep.path.replace(/^\//, "") || "root")}.${ep.method.toLowerCase()}`;
    const altKey = ep.id;
    const override = FIELD_OVERRIDES[key] ?? FIELD_OVERRIDES[altKey];
    if (!override) return ep;
    return { ...ep, ...override, query: { ...ep.query, ...override.query }, response: { ...ep.response, ...override.response } };
  });
}

function main() {
  const modules: { module: string; prefix: string; endpoints: EndpointLock[] }[] = [];
  let total = 0;
  for (const [file, prefix] of Object.entries(MODULE_PREFIXES)) {
    const endpoints = applyOverrides(parseRouteFile(file, prefix));
    if (endpoints.length === 0) continue;
    modules.push({
      module: file.replace(".routes.ts", ""),
      prefix,
      endpoints,
    });
    total += endpoints.length;
  }

  // agency-commission + dashboard mounted inside agency.routes.ts
  for (const sub of ["agency-commission.routes.ts", "agency-dashboard.routes.ts"]) {
    const endpoints = applyOverrides(parseRouteFile(sub, "/api/v1/agency"));
    if (endpoints.length) {
      modules.push({ module: sub.replace(".routes.ts", ""), prefix: "/api/v1/agency", endpoints });
      total += endpoints.length;
    }
  }

  const unregistered = ["room.routes.ts", "user.routes.ts", "contact.routes.ts"].filter((f) =>
    fs.existsSync(path.join(ROUTES_DIR, f)),
  );

  const lock = {
    $schema: "./API_CONTRACT_LOCK.schema.json",
    version: "1.0.0",
    lockedAt: new Date().toISOString().slice(0, 10),
    policy: {
      summary:
        "Locked request/response fields MUST NOT be removed, renamed, or change type. Only additive optional query/body/response fields allowed.",
      breakingChangesForbidden: [
        "remove response field",
        "rename response field",
        "change field type",
        "make optional field required",
        "remove query/body parameter",
        "change enum values (removal or rename)",
        "change HTTP status for same success path",
      ],
      allowedChanges: [
        "add optional query parameter",
        "add optional request body field",
        "add new response field (clients must ignore unknown fields)",
        "add new endpoint",
        "add new enum value at end (document in lock file)",
      ],
    },
    global: {
      apiVersion: "v1",
      apiPrefix: "/api/v1",
      connectionTimeoutMs: 30_000,
      bigintJson: "decimal string",
      datetimeJson: "ISO-8601 string",
      errorBody: {
        statusCode: "number",
        error: "string",
        code: "string",
        message: "string",
        details: "object (optional)",
      },
    },
    websocket: {
      path: "/ws",
      note: "Not under /api/v1; see docs/flow-md/messaging-flow.md",
    },
    moduleCount: modules.length,
    endpointCount: total,
    modules,
    unregisteredRouteFiles: unregistered.map((f) => ({
      file: `src/routes/v1/${f}`,
      note: "Not registered in src/app.ts",
    })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(lock, null, 2));
  console.log(`Wrote ${OUT_JSON} (${total} endpoints, ${modules.length} modules)`);
}

main();
