# AWS prodv2 → GCP cutover runbook

Five scripts plus an orchestrator, two operators. Target: **~8 minutes of write downtime.**

`00-run-cutover.sh` drives steps 2–5 on the GCE VM and stops at a DNS prompt that
requires you to type `dns done` before it verifies over the real hostname. Only
step 1 is run by hand, by the prodv2 operator. `DRY_RUN=1` rehearses everything
up to the prompt and never touches DNS.

Installed on the VM at **`/opt/ol/cutover/`**.

| Step | Where | Who | Time |
|---|---|---|---|
| `01-dump-prodv2.sh` | prodv2 EC2 (SSM) | **prodv2 operator** | ~90s |
| `02-restore-gcp.sh` | GCE VM | GCP operator | ~3 min |
| `03-rclone-delta.sh` | GCE VM | GCP operator | ~2 min — **runs in parallel with 01/02** |
| `04-post-restore.sh` | GCE VM | GCP operator | ~2 min |
| `05-smoke-test.sh` | anywhere / GCE VM | GCP operator | ~1 min — **gate before DNS** |

## Facts this plan is built on

Measured 2026-09-08, not assumed:

- Database is **231 MB**, PostgreSQL 16.14 → a full dump/restore is faster than engineering an incremental path.
- **54,856 stored absolute URLs** across 10 columns all point at `ol-app-storage.s3.ap-south-1.amazonaws.com`; 48,394 are `live_streams.cover_image_url`. Keys carry over unchanged, so it is a prefix swap.
- R2 already holds **42,012 objects / 3.189 GiB**, hash-verified. The delta after a freeze is a handful of objects.
- GCP Rekognition `face-prod` (acct **272095698218**) holds **3,066** faces; prodv2's same-named collection (acct **465457334877**) holds **3,098**.

## Before the day (zero downtime)

1. **Deploy the code** so `dist/scripts/{rewrite-media-urls,reindex-face-collection}.js` exist on the VM (push `production`).
2. **R2 custom domain — DEFERRED, and that is a deliberate decision.** The cutover runs fine on `pub-….r2.dev`: objects serve (verified 200) and nothing in these scripts depends on the hostname. What you accept is that r2.dev is Cloudflare's *development* origin — **rate-limited, and not CDN-cached at all** (verified: no `cf-cache-status` header on repeat requests, served via SIN rather than a local edge). Every avatar and all 48k live-stream covers hit the R2 origin on every request.

   Blocked for now because Cloudflare only accepts **root domains** as zones — `cdn.offoolive.com` is rejected (subdomain zones are Enterprise-only), and `offoolive.com` sits on Vercel DNS with the website, both prod and staging API records, LiveKit and email. Moving that zone is its own project.

   **Switching later is cheap** — that is why deferring is reasonable:

   ```bash
   # 1. new secret version with S3_PUBLIC_BASE_URL=https://<new-host>
   # 2. refresh .env on the VM, restart with a sourced shell
   # 3. repoint the URLs already stored in the database:
   node dist/scripts/rewrite-media-urls.js \
     --from=https://pub-db89b578921f4ce3b6f95f9ebc6a83c4.r2.dev \
     --to=https://<new-host> --dry-run     # then without --dry-run
   ```

   The script is idempotent and verifies no old-origin URL survives, so this is a low-risk change on any ordinary day. Watch for `429`s on media requests in the meantime — that is what hitting the r2.dev limit looks like.
3. **Pre-pass the objects:** `03-rclone-delta.sh` unfrozen. Catches nearly all drift for free.
4. **Rehearse:** `01` without `FREEZE=1`, then `02`, then `04 --dry-run`.
5. Confirm `pg_dump` ≥ 16 exists on the EC2 — `01` checks and fails early if not. `pg_restore 16.15` is already installed on the GCE VM.

## Cutover

**T-10 — parallel, no downtime yet**

```bash
# GCE
sudo AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… MAX_AGE=24h bash 03-rclone-delta.sh
```

**T+0 — freeze and dump** *(downtime starts)*

```bash
# prodv2 EC2, via SSM
sudo FREEZE=1 bash 01-dump-prodv2.sh
```

Hand over the three lines it prints (`DUMP_KEY`, `DUMP_SHA`, `DUMP_SIZE`).

**T+1:30 — restore, while the final object delta runs alongside**

```bash
# GCE — terminal A
sudo AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
     DUMP_KEY=db-migration/prod-…dump DUMP_SHA=… bash 02-restore-gcp.sh

# GCE — terminal B, at the same time
sudo AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bash 03-rclone-delta.sh
```

**T+4:30 — after BOTH finish**

```bash
sudo bash 04-post-restore.sh
```

**T+6:30 — the gate. Do not skip.**

```bash
# on the GCE VM — data integrity + integrations
sudo RUN_ON_VM=1 bash 05-smoke-test.sh

# from anywhere — proves HTTPS and the journeys against GCP while
# traffic is still on AWS, because --resolve pins the hostname to the LB
SMOKE_PROVIDER=publicId SMOKE_IDENTIFIER=34216645 SMOKE_PASSWORD=<pw> bash 05-smoke-test.sh
```

It exits non-zero and prints **DO NOT MOVE DNS** if anything failed. Treat that literally — everything up to this point is reversible, and the DNS flip is where that stops being true.

**Watch the skip count, not just the failures.** Without credentials the suite skips the entire authenticated tier and still prints "safe to proceed" — having tested nothing but anonymous `401`s. A green run that proves anything is **21 passed / 0 skipped**.

The restore overwrites the fixture account's password with production's, so `00-run-cutover.sh` re-establishes a known one via `reset-smoke-fixture.js` when `SMOKE_IDENTIFIER`/`SMOKE_PASSWORD` are set. It hashes through the app's own `passwordService`, so the hash cannot disagree with what login verifies against. **This is a real password on what becomes production the moment DNS moves — change it after the cutover.**

Measured 2026-09-09 against the restored GCP copy, both modes **21 passed / 0 failed / 0 skipped**. The authenticated tier is the valuable half: `avatar image loads from object store (200)` is the end-to-end proof that the URL rewrite ran *and* the object exists in R2 — a single check covering the whole S3→R2 migration.

**T+7 — flip DNS.** Note the records are **CNAMEs** pointing at `ol-prod-alb-569195065.ap-south-1.elb.amazonaws.com`, and GCP is an **IP** — so this is a type change (delete CNAME, create A → `136.68.81.230`), not an edit. Do `api` first, alone, verify, then `live`. Keep that ALB hostname written down somewhere outside Vercel: recreating the CNAME is the rollback.

| Record | Moves? | Why |
|---|---|---|
| `api` | **yes** | 21/21 smoke checks pass through the GCP LB |
| `live` | **yes** | every path the app uses (`/api/live-stream/*`, `/api/video-call/*`, socket.io) is covered by the url-map's live rules; socket.io verified 200 |
| `admins3jinyu` | **NO — leave on AWS** | the admin panel is a static Vue SPA served by nginx on the EC2. The GCP LB has no backend for it and answers `404` on every path. Moving this record takes the admin panel down. |

**Therefore the EC2 must stay running after the cutover** — it is still serving the admin panel. Shut down only Postgres writes (the app), not the box.

Moving the admin panel later means hosting the SPA on GCP: a GCS bucket added as a backend to the existing LB (the certificate already covers the hostname), or Firebase Hosting. Either way it needs **SPA fallback** — the router uses `createWebHistory`, so unknown paths must serve `index.html` or every deep link and page refresh 404s. Verify with `curl --resolve … /customer-support/tickets/42` returning `200` *before* touching DNS.

## Why the order is what it is

- **Freeze before dump.** `pg_dump` is transactionally consistent, but writes landing after it starts are simply lost. Stopping the app is what makes the dump the final state.
- **Objects in parallel with the database.** They share nothing. Serialising them adds 2–3 minutes of pure downtime.
- **URL rewrite after restore.** The restore reintroduces old-origin URLs; rewriting earlier accomplishes nothing.
- **Face re-index last.** It needs the restored rows *and* the objects from step 3.
- **App starts last,** in step 4 — never between restore and rewrite, or users hit broken media and stale face ids.

## Seeds and admin views — what the dump does and does not carry

Verified against the restored GCP copy, not assumed:

| Table | Rows after restore | Action |
|---|---|---|
| `coin_packages` | 4 | none — dump carries it |
| `rich_tier_configs` | 10 | none |
| `wallet_level_configs` | 235 | none |
| `coin_trading_topup_rates` | 28 | none (no duplicate active tiers) |
| `agent_exchange_rates` | 24 | none |
| `coin_trading_topup_packages` | 6 | none |
| `gifts` / `banners` | 21 / 4 | none |
| `game_providers` | 0 | none — created on demand by `getOrCreateBaishunProvider()` |
| **`admin_views`** | **0** | **`seed:admin-views` — step 4 does this** |

`admin_views` is the one gap: **0 rows** on the restored copy while the code defines **25 views**.

Step 4 runs **`verify-seed-data.js --repair`**, which reconciles all of the above against the defaults the code ships with and repairs `admin_views` — creating missing views and merging missing endpoints into existing ones. It never removes, so a custom endpoint an operator added survives.

> It deliberately does **not** shell out to `npm run seed:admin-views`. That seeder lives in the root `scripts/` directory and runs under `tsx`, and **neither is shipped to the servers** — only `src/**` is compiled into `dist/`. A cutover step that cannot run on the box it is needed on is worse than no step at all.

Everything other than `admin_views` is **reported, never auto-filled**. A non-empty rates or fee-tier table means an admin has tuned those values, and silently overwriting them mid-cutover would be a financial change nobody asked for. The reconciler prints the seeder to run if a table is genuinely empty.

**Never run `npm run db:seed` after a restore.** It is a fresh-database script using `createMany`; the data is already in the dump, and re-running it against populated tables is exactly how the duplicated topup/agent-exchange ladders happened on 2026-09-06.

Migration state on the restored copy: **152 applied, 0 unfinished**, latest `20260905120000_support_ticket_stars_and_face_dup_sort`. Step 4's `prisma migrate deploy` applies anything the deployed code adds on top.

## What the restore deliberately destroys

The 3,066 GCP FaceIds written on 2026-09-08. The dump carries prodv2's ids back in, and they do not resolve in the GCP collection. `reindex-face-collection` reconciles them — which is why it *rewrites* stored ids rather than just skipping users already in the collection.

## Rollback

Nothing on prodv2 is mutated: the dump is read-only, and the S3→R2 copy only reads S3. Rollback is `pm2 start` on prodv2 and leaving DNS alone. The point of no return is the DNS flip plus the first write to Cloud SQL.

## Traps already paid for

- **rclone 1.60.1 logs one `501 NotImplemented` per object.** Both remotes are `type=s3`, so it tries a server-side copy, R2 refuses, and it streams instead — successfully. `--disable copy` does not suppress it. Judge a run by `rclone check`, never by its error count.
- **`pm2 restart --update-env` never *removes* an env var.** Deleting a line from `.env` leaves pm2 injecting the old value; that needs `pm2 delete` + `pm2 start`. Adding or changing is fine.
- **`--no-owner --no-privileges` on restore.** The dump's RDS role does not exist in Cloud SQL; without these, every `GRANT`/`ALTER OWNER` fails.
- **The AWS key is read-only (`ol-s3-migration`) and shredded on exit** by step 3. Delete the IAM user after the final copy.
