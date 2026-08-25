# Staging deploy (ol-stag)

Pushes to the `staging` branch build this repo on GitHub Actions, store a tarball as a workflow artifact, then SCP it to **ol-stag** and unpack with `.github/deploy/ec2-unpack-ol-node.sh`.

Instance layout (do not put `.env` in the artifact):

- App dir: `/home/ec2-user/ol-node`
- PM2: `ol-api`, `ol-worker`, `ol-face-worker`
- Public URL: https://api-staging.offoolive.com

## GitHub configuration

Do this once per repo (`Project-OL/ol-node`, `Project-OL/Live-server`, `Project-OL/ol-admin`). Same three secrets in each.

### 1. Environment

**Settings → Environments → New environment → `staging`**

Optional: required reviewers (blocks auto-deploy until someone approves).

### 2. Secrets

On that environment (preferred) or **Settings → Secrets and variables → Actions** (repo secrets):

| Name | Value |
|---|---|
| `STAGING_EC2_HOST` | `3.110.118.179` (or `ec2-3-110-118-179.ap-south-1.compute.amazonaws.com`) |
| `STAGING_EC2_USER` | `ec2-user` |
| `STAGING_EC2_SSH_PRIVATE_KEY` | Full PEM used for `ssh ol-stag` (`ol-dev-key.pem`), including `-----BEGIN … KEY-----` / `-----END … KEY-----` |

Paste the private key as a single secret. Do not commit it.

### 3. AWS security group (ol-stag)

GitHub-hosted runners need **inbound TCP 22** to this instance. Either:

- Allow SSH from `0.0.0.0/0` (only if you already do this), or
- Allow GitHub Actions IP ranges ([api.github.com/meta](https://api.github.com/meta) `actions` CIDRs) — they change, or
- Attach an instance profile later and switch this workflow to SSM (same pattern as `production.yml`).

If deploy fails with `Connection timed out` / `Permission denied`, it is almost always SG or the PEM.

**`ssh-keyscan` / empty deploy logs:** GitHub-hosted runners must reach **TCP 22**. In the instance security group for `i-04b31dbda6ed0edc4`, add inbound SSH (port 22) from `0.0.0.0/0` (or GitHub Actions CIDRs). Without that, the deploy step exits 1 with almost no output.

**PEM paste:** paste the file contents with real line breaks (or a single line using `\n`). Include `BEGIN` / `END` lines. Do not paste the `.pub` file.

### 4. Branch protection (optional)

**Settings → Branches → Add rule** for `staging`: require PR, or allow direct push if only CI should update it.

## What you do not put in GitHub

Secrets stay on the box in `/home/ec2-user/ol-node/.env` (and live-server `.env`). The artifact is `dist` + `prisma` + lockfile only.
