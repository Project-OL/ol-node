# Staging deploy (ol-stag)

Same flow as live-server/admin **production** (`production.yml`): GitHub Actions builds a tarball, SCPs it to `/tmp`, then runs `.github/deploy/ec2-unpack-*.sh` via `ssh … 'bash -s'`.

Do not use OIDC / S3 / SSM for staging. Secrets are already configured on Environment **staging**.

| App | Staging dir | PM2 / URL |
|---|---|---|
| ol-node | `/home/ec2-user/ol-node` (`LOG_DIR=/home/ec2-user/ol-node/logs`) | `ol-api` / https://api-staging.offoolive.com |
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

Deploy **one app at a time** (`npm ci` on this t3.micro saturates CPU).
