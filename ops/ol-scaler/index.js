/**
 * INF-23: ol-scaler, a tiny Cloud Run service that is the ONLY thing allowed to change production
 * capacity. ol-node-rest's admin API calls it (OIDC, `roles/run.invoker` for the API service account
 * only); it holds the GCP permissions itself, under its own service account, limited by IAM condition
 * to the two resources below. The hard caps live here, outside ol-node-rest, so a compromised API
 * still can't scale past them or touch anything else (in particular the main MIG, which runs the
 * single Live-server and must stay at exactly one VM).
 *
 *   GET  /status                 current API-group autoscaler + size, Redis tier/size/usage
 *   POST /scale                  { kind: "api", minReplicas, maxReplicas } | { kind: "redis", sizeGb }
 *   GET  /operations?ref=...     poll a GCP operation returned by /scale
 *
 * No dependencies: Node 22 fetch + the metadata server for the access token.
 */
import http from "node:http";

const PROJECT = process.env.GCP_PROJECT || "offoo-prod";
const REGION = process.env.GCP_REGION || "asia-south1";
const API_MIG = process.env.API_MIG || "ol-node-rest-api-mig";
const REDIS = process.env.REDIS_INSTANCE || "ol-node-rest-redis-std";
// Hard caps (env can only tighten them, never loosen past these constants).
const ABS_API_MAX = 8;
const API_MAX_CAP = Math.min(ABS_API_MAX, Number(process.env.API_MAX_CAP || 6));
const API_MIN_CAP = Math.min(API_MAX_CAP, Number(process.env.API_MIN_CAP || 4));
const REDIS_SIZES = [2, 3, 4, 5, 6, 8];
const REDIS_HEADROOM = 1.5; // a downsize must leave >= 1.5x the current used memory

const META = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
let cached = { token: null, exp: 0 };
async function token() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const r = await fetch(META, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error(`metadata token ${r.status}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}
async function gcp(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || `GCP ${r.status}`), { status: r.status });
  return j;
}

const C = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/regions/${REGION}`;
const R = `https://redis.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/instances/${REDIS}`;
const M = `https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries`;

async function apiGroup() {
  const mig = await gcp("GET", `${C}/instanceGroupManagers/${API_MIG}`);
  const asName = (mig.status?.autoscaler || "").split("/").pop();
  if (!asName) throw new Error(`${API_MIG} has no autoscaler`);
  const as = await gcp("GET", `${C}/autoscalers/${asName}`);
  return {
    autoscaler: asName,
    targetSize: mig.targetSize,
    isStable: Boolean(mig.status?.isStable),
    minReplicas: as.autoscalingPolicy?.minNumReplicas,
    maxReplicas: as.autoscalingPolicy?.maxNumReplicas,
    cpuTarget: as.autoscalingPolicy?.cpuUtilization?.utilizationTarget,
    caps: { minMax: API_MIN_CAP, maxMax: API_MAX_CAP },
  };
}

async function redisUsageRatio() {
  const end = new Date(), start = new Date(end.getTime() - 15 * 60_000);
  const q = new URLSearchParams({
    filter: `metric.type="redis.googleapis.com/stats/memory/usage_ratio" AND resource.labels.instance_id="projects/${PROJECT}/locations/${REGION}/instances/${REDIS}"`,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
  });
  const j = await gcp("GET", `${M}?${q}`);
  const pts = (j.timeSeries || []).flatMap((s) => s.points || []).map((p) => p.value.doubleValue);
  return pts.length ? Math.max(...pts) : null;
}

async function redis() {
  const i = await gcp("GET", R);
  const ratio = await redisUsageRatio();
  return {
    name: REDIS,
    tier: i.tier,
    state: i.state,
    sizeGb: i.memorySizeGb,
    usedRatio: ratio,
    usedGb: ratio === null ? null : Math.round(ratio * i.memorySizeGb * 1000) / 1000,
    allowedSizes: REDIS_SIZES,
  };
}

/** Validates a request against the caps; returns an error string or null. Exported for tests. */
export function checkScale(req, current) {
  if (req.kind === "api") {
    const { minReplicas: mn, maxReplicas: mx } = req;
    if (!Number.isInteger(mn) || !Number.isInteger(mx)) return "minReplicas and maxReplicas must be integers";
    if (mn < 1) return "minReplicas must be at least 1";
    if (mx < mn) return "maxReplicas must be >= minReplicas";
    if (mn > API_MIN_CAP) return `minReplicas is capped at ${API_MIN_CAP}`;
    if (mx > API_MAX_CAP) return `maxReplicas is capped at ${API_MAX_CAP}`;
    return null;
  }
  if (req.kind === "redis") {
    if (!REDIS_SIZES.includes(req.sizeGb)) return `sizeGb must be one of ${REDIS_SIZES.join(", ")}`;
    if (current?.tier !== "STANDARD_HA") return "resizing is allowed only on the Standard (HA) tier";
    if (current?.state !== "READY") return `Redis is ${current?.state}, not READY`;
    if (req.sizeGb < current.sizeGb) {
      if (current.usedGb === null) return "refusing a downsize: current memory usage is unknown";
      if (req.sizeGb < current.usedGb * REDIS_HEADROOM) return `refusing a downsize: ${req.sizeGb} GB is under ${REDIS_HEADROOM}x the ${current.usedGb} GB in use`;
    }
    if (req.sizeGb === current.sizeGb) return "already that size";
    return null;
  }
  return "kind must be api or redis";
}

async function scale(req) {
  if (req.kind === "api") {
    const g = await apiGroup();
    const err = checkScale(req, g);
    if (err) return { status: 400, body: { error: err } };
    const op = await gcp("PATCH", `${C}/autoscalers?autoscaler=${encodeURIComponent(g.autoscaler)}`, {
      name: g.autoscaler,
      autoscalingPolicy: { minNumReplicas: req.minReplicas, maxNumReplicas: req.maxReplicas },
    });
    return { status: 200, body: { before: { minReplicas: g.minReplicas, maxReplicas: g.maxReplicas }, operation: { kind: "compute", ref: op.name } } };
  }
  if (req.kind === "redis") {
    const cur = await redis();
    const err = checkScale(req, cur);
    if (err) return { status: 400, body: { error: err } };
    const op = await gcp("PATCH", `${R}?updateMask=memory_size_gb`, { memorySizeGb: req.sizeGb });
    return { status: 200, body: { before: { sizeGb: cur.sizeGb }, operation: { kind: "redis", ref: op.name } } };
  }
  return { status: 400, body: { error: "kind must be api or redis" } };
}

async function operation(ref) {
  if (!/^[A-Za-z0-9_./-]{1,300}$/.test(ref || "")) return { status: 400, body: { error: "bad ref" } };
  if (ref.startsWith("projects/")) {
    const o = await gcp("GET", `https://redis.googleapis.com/v1/${ref}`);
    return { status: 200, body: { done: Boolean(o.done), error: o.error?.message || null } };
  }
  const o = await gcp("GET", `${C}/operations/${encodeURIComponent(ref)}`);
  return { status: 200, body: { done: o.status === "DONE", error: o.error?.errors?.[0]?.message || null } };
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/status") {
      const [api, r] = await Promise.all([apiGroup(), redis()]);
      return send(res, 200, { api, redis: r });
    }
    if (req.method === "POST" && url.pathname === "/scale") {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, { error: "too large" }); }
      const body = JSON.parse(raw || "{}");
      const out = await scale(body);
      console.log(JSON.stringify({ msg: "scale", request: body, status: out.status, result: out.body }));
      return send(res, out.status, out.body);
    }
    if (req.method === "GET" && url.pathname === "/operations") return send(res, ...Object.values(await operation(url.searchParams.get("ref"))));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(JSON.stringify({ msg: "error", error: e.message }));
    return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
  }
});

if (process.env.K_SERVICE || process.env.PORT) server.listen(Number(process.env.PORT || 8080));
