# Staging deploy (ol-stag)

Same flow as production (`production.yml`): GitHub Actions builds a tarball, SCPs it to `/tmp`, then runs `.github/deploy/ec2-unpack-*.sh` via `ssh … 'bash -s'`.

ol-node production uses S3+SSM; staging uses SSH because ol-stag has no SSM instance profile. The unpack script and flags (`RUN_MIGRATE=1 RESTART_WORKERS=1`) are the same.

| App | Staging dir | PM2 / URL |
|---|---|---|
| ol-node | `/home/ec2-user/ol-node` | `ol-api` / https://api-staging.offoolive.com |
| live-server | `/home/ec2-user/live-server` | `ol-live` / https://live-staging.offoolive.com |
| admin | `/var/www/admins3jinyu.offoolive.com` | https://admin-staging.offoolive.com |

`.env` stays on the instance (not in the artifact).

## GitHub (once per repo)

**Settings → Environments → `staging`**

| Secret | Value |
|---|---|
| `STAGING_EC2_HOST` | `3.110.118.179` |
| `STAGING_EC2_USER` | `ec2-user` |
| `STAGING_EC2_SSH_PRIVATE_KEY` | PEM for `ssh ol-stag` |

Inbound TCP 22 on the instance security group must allow GitHub-hosted runners.

_Redeploy: 2026-08-25T11:42+05:30_
