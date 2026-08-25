# Staging deploy (ol-stag)

## Why SSH failed

GitHub Actions never got an SSH banner (`Connection timed out during banner exchange` / port 22). That is **not** a bad PEM. Inbound **TCP 22** from GitHub-hosted runner IPs (and often from your laptop too) is blocked or the host is unreachable on SSH.

ol-node **production** already avoids SSH: OIDC → S3 → **SSM** `AWS-RunShellScript`. Staging now uses that same path.

## Instance must be SSM-managed

ol-stag (`i-04b31dbda6ed0edc4`) needs an **IAM instance profile** with:

1. `AmazonSSMManagedInstanceCore`
2. `s3:GetObject` on `arn:aws:s3:::ol-production-deploy-artifacts-465457334877/*`

Attach it in EC2 → instance → Actions → Security → Modify IAM role. Wait ~1–2 minutes until the instance appears in **Systems Manager → Fleet Manager**.

The GitHub OIDC role `ol-prod-github-deploy-role` must be allowed to `ssm:SendCommand` on this instance (same role as production). If live-server/admin S3 prefixes are denied, allow `live-server/*` and `ol-admin/*` on that bucket (or the whole bucket).

## Optional SSH alternative

EC2 security group inbound **22** from `0.0.0.0/0` (or GitHub Actions CIDRs) would make SSH workflows work again. SSM does not need that.
