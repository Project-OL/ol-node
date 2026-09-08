# AWS prodv2 → GCP cutover runbook

Four scripts, two operators. Target: **~8 minutes of write downtime.**

| Step | Where | Who | Time |
|---|---|---|---|
| `01-dump-prodv2.sh` | prodv2 EC2 (SSM) | **prodv2 operator** | ~90s |
| `02-restore-gcp.sh` | GCE VM | GCP operator | ~3 min |
| `03-rclone-delta.sh` | GCE VM | GCP operator | ~2 min — **runs in parallel with 01/02** |
| `04-post-restore.sh` | GCE VM | GCP operator | ~2 min |

## Facts this plan is built on

Measured 2026-09-08, not assumed:

- Database is **231 MB**, PostgreSQL 16.14 → a full dump/restore is faster than engineering an incremental path.
- **54,856 stored absolute URLs** across 10 columns all point at `ol-app-storage.s3.ap-south-1.amazonaws.com`; 48,394 are `live_streams.cover_image_url`. Keys carry over unchanged, so it is a prefix swap.
- R2 already holds **42,012 objects / 3.189 GiB**, hash-verified. The delta after a freeze is a handful of objects.
- GCP Rekognition `face-prod` (acct **272095698218**) holds **3,066** faces; prodv2's same-named collection (acct **465457334877**) holds **3,098**.

## Before the day (zero downtime)

1. **Deploy the code** so `dist/scripts/{rewrite-media-urls,reindex-face-collection}.js` exist on the VM (push `production`).
2. **Custom domain on R2.** `S3_PUBLIC_BASE_URL` is `pub-….r2.dev`, Cloudflare's *development* origin — rate-limited and not CDN-cached. 48k cover images plus every avatar will route through it. One env line; do it before real traffic.
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

**T+7 — verify by hand, then flip DNS:** avatar loads, one face verification passes, one game launches.

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
