<#
.SYNOPSIS
  Rebuild the OL production GCP stack (ol-node-rest + Live-server + ol-admin) in a NEW
  project, mirroring project-c17dfdc3-d1fc-437a-866 as inventoried on 2026-09-28.

.DESCRIPTION
  Idempotent: every step checks whether its resource exists and skips it if so, so the
  script can be re-run after a failure or with -Steps to redo one part.

  The script only ever READS the OLD project (step `pull`: copy the running code and the
  four secret files off the old VM, via -OldConfiguration). It never changes the old project.
  Every write goes to -Project through -Configuration, and the script refuses to start
  if either one points at the old project/account.

  Steps (default = all, in this order):
    project   create project, link billing, enable APIs
    network   VPC, subnet, 5 firewall rules, router + NAT, private-services range + peering
    pull      OLD VM -> local $SeedDir: running code (3 tarballs) + 4 secret files
    sql       Cloud SQL Postgres 16 + database + app user (password reused from old .env)
    redis     Memorystore Redis 7.2, maxmemory-policy=noeviction (BullMQ needs it)
    iam       service accounts + role bindings
    wif       GitHub Workload Identity pool/provider + per-repo bindings
    bucket    release bucket + IAM, uploads seed tarballs as */latest.tgz if missing
    secrets   4 secrets; .env copies rewritten to the NEW SQL/Redis IPs + project ID
    template  instance template with .github/deploy/gce-bootstrap.sh as startup script
    mig       regional MIG, named ports, autoscaler
    certs     Certificate Manager DNS auths (per-project records), certs, cert map
    lb        health checks, backend services, url maps, static IP, proxies, fwd rules
    bigquery  billing_export dataset
    summary   print every value you need for DNS, GitHub and the cutover

  First run (rehearsal) boots the VM with start-processes=false: nginx/admin comes up,
  but no pm2 app starts, so nothing touches the real third parties. At cutover, re-run
  `-Steps template,summary -StartProcesses`, then run the replace command it prints.

.EXAMPLE
  # print every command, run nothing
  .\.github\deploy\gcp\provision.ps1 -Project offoo-prod -Configuration offoo-new `
      -BillingAccount 01ABCD-234567-89EFGH -ReleaseBucket gs://offoo-ol-releases -DryRun

.EXAMPLE
  # the real run (rehearsal mode)
  .\.github\deploy\gcp\provision.ps1 -Project offoo-prod -Configuration offoo-new `
      -BillingAccount 01ABCD-234567-89EFGH -ReleaseBucket gs://offoo-ol-releases
#>
param(
  [Parameter(Mandatory)][string]$Project,
  [Parameter(Mandatory)][string]$Configuration,
  [Parameter(Mandatory)][string]$ReleaseBucket,
  [string]$BillingAccount,
  [string]$Region = 'asia-south1',
  [string]$SqlZone = 'asia-south1-a',
  [string]$RedisTier = 'basic',
  [int]$RedisSizeGb = 2,
  [string]$OldConfiguration = 'jinyu-old',
  [string]$SeedDir = (Join-Path $env:USERPROFILE 'ol-gcp-seed'),
  [string[]]$GithubRepos = @('Project-OL/ol-node', 'Project-OL/Live-server', 'Project-OL/ol-admin'),
  [string[]]$Steps = @('project', 'network', 'pull', 'sql', 'redis', 'iam', 'wif', 'bucket', 'secrets',
                       'template', 'mig', 'certs', 'lb', 'bigquery', 'summary'),
  [switch]$StartProcesses,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'   # gcloud writes progress to stderr; exit codes are checked by hand

# ------------------------------------------------------------------ constants (old side)
$OldProject = 'project-c17dfdc3-d1fc-437a-866'
$OldOrgId = '691750531115'            # jinyutechnologies-org
$OldAccount = 'jinyutechnologies@gmail.com'
$OldRegion = 'asia-south1'

$Vpc = 'ol-node-rest-vpc'
$Subnet = 'ol-node-rest-subnet'
$PsaRange = 'google-managed-services-ol-node-rest-vpc'
$SqlInstance = 'ol-node-rest-db-16'
$RedisInstance = 'ol-node-rest-redis'
$Mig = 'ol-node-rest-mig'
$TemplateName = if ($StartProcesses) { 'ol-node-rest-api-tmpl-v3' } else { 'ol-node-rest-api-tmpl-rehearsal' }
$ApiSa = "ol-node-rest-api-sa@$Project.iam.gserviceaccount.com"
$DeploySa = "gh-actions-gcp-deploy@$Project.iam.gserviceaccount.com"
$Domain = 'offoolive.com'
$AdminHostnames = "admins3jinyu.$Domain priviledge.$Domain"
$SecretNames = @('ol-node-rest-env', 'ol-node-rest-firebase-adminsdk', 'ol-live-server-env', 'ol-live-server-google-credentials')
$SeedReleases = @{ 'ol-node-rest' = 'seed-ol-node-rest.tgz'; 'live-server' = 'seed-live-server.tgz'; 'ol-admin' = 'seed-ol-admin.tgz' }

$G = @("--project=$Project", "--configuration=$Configuration", '--quiet')

# ------------------------------------------------------------------ helpers
function Show([string]$line) {
  # never echo a password to the terminal
  $line -replace '(--password=)\S+', '$1****'
}

function Run([string[]]$a, [int]$Retries = 0) {
  $line = Show ('gcloud ' + ($a -join ' '))
  if ($DryRun) { Write-Host "[dry-run] $line" -ForegroundColor DarkGray; return }
  for ($i = 0; ; $i++) {
    Write-Host "> $line" -ForegroundColor Cyan
    & gcloud @a @G
    if ($LASTEXITCODE -eq 0) { return }
    # a freshly created service account / pool takes a few seconds to become visible to IAM
    if ($i -ge $Retries) { throw "FAILED (exit $LASTEXITCODE): $line" }
    Write-Host "  retrying in 15s ($($i + 1)/$Retries)" -ForegroundColor Yellow
    Start-Sleep -Seconds 15
  }
}

function Exists([string[]]$a) {
  if ($DryRun) { return $false }
  & gcloud @a @G '--format=value(name)' 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Ensure([string]$what, [string[]]$describe, [string[]]$create) {
  if (Exists $describe) { Write-Host "= $what already exists" -ForegroundColor DarkGreen; return }
  Run $create
}

function Get([string[]]$a, [string]$fmt) {
  if ($DryRun) { return "<$fmt>" }
  $o = & gcloud @a @G "--format=$fmt" 2>$null
  return (($o | Out-String).Trim())
}

function Step([string]$name) {
  Write-Host ''
  Write-Host "==================== $name ====================" -ForegroundColor Magenta
}

# Old project, read-only. plink (gcloud ssh/scp on Windows) returns bogus exit codes, so
# these never throw on exit status - callers verify the result (RC= marker / file exists).
function OldGcloud([string[]]$a) {
  $line = 'gcloud ' + ($a -join ' ') + " --project=$OldProject --configuration=$OldConfiguration"
  if ($DryRun) { Write-Host "[dry-run][OLD, read-only] $line" -ForegroundColor DarkGray; return '' }
  Write-Host "> [OLD, read-only] $line" -ForegroundColor DarkYellow
  $o = & gcloud @a "--project=$OldProject" "--configuration=$OldConfiguration" --quiet 2>&1
  return (($o | Out-String).Trim())
}

# Takes `list-instances --format=json`. Its "instance" field is a URL
# .../zones/<zone>/instances/<name>; value(instance) would shorten it to the bare name
# and lose the zone, hence JSON.
function ParseInstance([string]$json) {
  $none = @{ zone = ''; name = '' }
  # OldGcloud merges stderr in, so gcloud warnings may precede the JSON array
  $a = if ($json) { $json.IndexOf('[') } else { -1 }
  $b = if ($json) { $json.LastIndexOf(']') } else { -1 }
  if ($a -lt 0 -or $b -le $a) { return $none }
  $first = @($json.Substring($a, $b - $a + 1) | ConvertFrom-Json)[0]
  if (-not $first) { return $none }
  $m = [regex]::Match([string]$first.instance, 'zones/([^/\s]+)/instances/([^/\s]+)')
  if ($m.Success) { return @{ zone = $m.Groups[1].Value; name = $m.Groups[2].Value } }
  return $none
}

function WriteLf([string]$path, [string]$text) {
  # UTF-8 without BOM, LF line endings (bash on the VM chokes on CRLF)
  [IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
}

function ReadUtf8([string]$path) { [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding $false)) }

# ------------------------------------------------------------------ guards
if ($Project -eq $OldProject) { throw "-Project is the OLD project ($OldProject). Refusing." }
if ($ReleaseBucket -notmatch '^gs://[a-z0-9._-]+$') { throw "-ReleaseBucket must look like gs://bucket-name" }
if ($Configuration -eq $OldConfiguration) { throw "-Configuration equals -OldConfiguration ($OldConfiguration). Refusing." }

$cfgAccount = (& gcloud config configurations describe $Configuration '--format=value(properties.core.account)' 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $cfgAccount) {
  if (-not $DryRun) { throw "gcloud configuration '$Configuration' is missing or has no account. See runbook section 2.1." }
  Write-Host "WARNING: configuration '$Configuration' does not exist yet (ok for -DryRun only)" -ForegroundColor Yellow
}
if ($cfgAccount -eq $OldAccount) { throw "Configuration '$Configuration' is logged in as the OLD account $OldAccount. Refusing." }

# bq has no --configuration flag; pin the whole process to NEW so bq cannot drift to OLD.
$prevCfg = $env:CLOUDSDK_ACTIVE_CONFIG_NAME
$env:CLOUDSDK_ACTIVE_CONFIG_NAME = $Configuration

Write-Host ''
Write-Host "TARGET  project=$Project  configuration=$Configuration  account=$cfgAccount" -ForegroundColor Green
Write-Host "SOURCE  project=$OldProject  configuration=$OldConfiguration  (read-only)" -ForegroundColor DarkYellow
Write-Host "MODE    template=$TemplateName  dry-run=$DryRun  steps=$($Steps -join ',')"

try {
  # ================================================================ project
  if ($Steps -contains 'project') {
    Step 'project'
    Ensure 'project' @('projects', 'describe', $Project) @('projects', 'create', $Project, '--name=OL Production')
    if (-not $DryRun) {
      $parent = Get @('projects', 'describe', $Project) 'value(parent.id)'
      if ($parent -eq $OldOrgId) { throw "Project $Project sits in the OLD org (jinyutechnologies-org). Wrong account created it." }
    }
    if ($BillingAccount) {
      Run @('billing', 'projects', 'link', $Project, "--billing-account=$BillingAccount")
    }
    elseif (-not $DryRun -and (Get @('billing', 'projects', 'describe', $Project) 'value(billingEnabled)') -ne 'True') {
      throw "Project has no billing. Pass -BillingAccount."
    }
    Run @('services', 'enable',
      'compute.googleapis.com', 'sqladmin.googleapis.com', 'servicenetworking.googleapis.com',
      'redis.googleapis.com', 'secretmanager.googleapis.com', 'certificatemanager.googleapis.com',
      'storage.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com',
      'oslogin.googleapis.com', 'iap.googleapis.com', 'logging.googleapis.com', 'monitoring.googleapis.com',
      'bigquery.googleapis.com', 'cloudresourcemanager.googleapis.com', 'cloudbilling.googleapis.com')
  }

  # ================================================================ network
  if ($Steps -contains 'network') {
    Step 'network'
    Ensure 'vpc' @('compute', 'networks', 'describe', $Vpc) `
      @('compute', 'networks', 'create', $Vpc, '--subnet-mode=custom', '--bgp-routing-mode=regional')
    Ensure 'subnet' @('compute', 'networks', 'subnets', 'describe', $Subnet, "--region=$Region") `
      @('compute', 'networks', 'subnets', 'create', $Subnet, "--network=$Vpc", "--region=$Region", '--range=10.10.0.0/20')

    $lbRanges = '130.211.0.0/22,35.191.0.0/16'   # Google LB + health-check probes
    $rules = @(
      , @('ol-node-rest-allow-lb-healthcheck', $lbRanges, 'tcp:3000')
      , @('ol-node-rest-allow-lb-healthcheck-live', $lbRanges, 'tcp:5000')
      , @('ol-node-rest-allow-lb-healthcheck-admin', $lbRanges, 'tcp:8080')
      , @('ol-node-rest-vpc-allow-iap-ssh', '35.235.240.0/20', 'tcp:22')
      , @('ol-node-rest-vpc-allow-internal', '10.10.0.0/20', 'tcp,udp,icmp')
    )
    foreach ($r in $rules) {
      Ensure "firewall $($r[0])" @('compute', 'firewall-rules', 'describe', $r[0]) `
        @('compute', 'firewall-rules', 'create', $r[0], "--network=$Vpc", '--direction=INGRESS', '--priority=1000',
          "--source-ranges=$($r[1])", "--allow=$($r[2])")
    }

    Ensure 'router' @('compute', 'routers', 'describe', 'ol-node-rest-router', "--region=$Region") `
      @('compute', 'routers', 'create', 'ol-node-rest-router', "--network=$Vpc", "--region=$Region")
    Ensure 'nat' @('compute', 'routers', 'nats', 'describe', 'ol-node-rest-nat', '--router=ol-node-rest-router', "--region=$Region") `
      @('compute', 'routers', 'nats', 'create', 'ol-node-rest-nat', '--router=ol-node-rest-router', "--region=$Region",
        '--auto-allocate-nat-external-ips', '--nat-all-subnet-ip-ranges')

    # Private services access: Cloud SQL gets its private IP from this range.
    Ensure 'private services range' @('compute', 'addresses', 'describe', $PsaRange, '--global') `
      @('compute', 'addresses', 'create', $PsaRange, '--global', '--purpose=VPC_PEERING',
        '--addresses=10.37.0.0', '--prefix-length=16', "--network=$Vpc")
    $peer = if ($DryRun) { '' } else { Get @('services', 'vpc-peerings', 'list', "--network=$Vpc") 'value(peering)' }
    if ($peer) { Write-Host '= servicenetworking peering already exists' -ForegroundColor DarkGreen }
    else {
      Run @('services', 'vpc-peerings', 'connect', '--service=servicenetworking.googleapis.com',
        "--ranges=$PsaRange", "--network=$Vpc")
    }
  }

  # ================================================================ pull (OLD, read-only)
  if ($Steps -contains 'pull') {
    Step 'pull (old VM -> local, read-only)'
    if (-not $DryRun) { New-Item -ItemType Directory -Force $SeedDir | Out-Null }
    $bundle = Join-Path $SeedDir 'ol-seed.tar'
    $haveAll = (@($SeedReleases.Values) + $SecretNames | Where-Object { -not (Test-Path (Join-Path $SeedDir $_)) }).Count -eq 0
    if ($haveAll) {
      Write-Host "= seed files already in $SeedDir (delete them to pull again)" -ForegroundColor DarkGreen
    }
    else {
      $inst = ParseInstance (OldGcloud @('compute', 'instance-groups', 'managed', 'list-instances', $Mig, "--region=$OldRegion", '--format=json'))
      $oldVm = $inst.name; $oldZone = $inst.zone
      if (-not $DryRun -and -not $oldVm) { throw "Could not find the old VM (is the old project still running / billed?)" }
      Write-Host "old VM: $oldVm ($oldZone)"

      # Same file lists as the three gcp-production.yml build steps, taken from what is
      # RUNNING (not from git), so the new project boots exactly the live code.
      $pack = @'
#!/usr/bin/env bash
set -euo pipefail
S=/tmp/ol-seed; sudo rm -rf "$S"; mkdir -p "$S"
cd /opt/ol/apps/ol-node-rest
sudo tar -czf "$S/seed-ol-node-rest.tgz" dist prisma package.json package-lock.json
cd /opt/ol/apps/live-server
files=""; for f in server.js package.json package-lock.json prisma prisma.config.ts src public scripts; do [ -e "$f" ] && files="$files $f"; done
sudo tar -czf "$S/seed-live-server.tgz" $files
sudo tar -czf "$S/seed-ol-admin.tgz" -C /var/www/admins3jinyu.offoolive.com .
sudo cp /opt/ol/apps/ol-node-rest/.env                              "$S/ol-node-rest-env"
sudo cp /opt/ol/apps/ol-node-rest/offoolive-firebase-adminsdk.json  "$S/ol-node-rest-firebase-adminsdk"
sudo cp /opt/ol/apps/live-server/.env                               "$S/ol-live-server-env"
sudo cp /opt/ol/apps/live-server/google-credentials.json            "$S/ol-live-server-google-credentials"
sudo tar -cf /tmp/ol-seed.tar -C "$S" .
sudo chown "$(id -un)" /tmp/ol-seed.tar; chmod 600 /tmp/ol-seed.tar
sudo rm -rf "$S"
ls -l /tmp/ol-seed.tar
echo "RC=0"
'@
      if ($DryRun) { $SeedWork = $env:TEMP } else { $SeedWork = $SeedDir; WriteLf (Join-Path $SeedDir 'ol-seed-pack.sh') $pack }
      Push-Location $SeedWork   # relative local paths: gcloud scp can mistake "C:" for an instance name
      try {
        OldGcloud @('compute', 'scp', 'ol-seed-pack.sh', "${oldVm}:/tmp/ol-seed-pack.sh", "--zone=$oldZone", '--tunnel-through-iap') | Write-Host
        $out = OldGcloud @('compute', 'ssh', $oldVm, "--zone=$oldZone", '--tunnel-through-iap', '--command=bash /tmp/ol-seed-pack.sh; rm -f /tmp/ol-seed-pack.sh')
        Write-Host $out
        if (-not $DryRun -and $out -notmatch 'RC=0') { throw 'Packing on the old VM failed (no RC=0 marker).' }
        OldGcloud @('compute', 'scp', "${oldVm}:/tmp/ol-seed.tar", 'ol-seed.tar', "--zone=$oldZone", '--tunnel-through-iap') | Write-Host
        OldGcloud @('compute', 'ssh', $oldVm, "--zone=$oldZone", '--tunnel-through-iap', '--command=rm -f /tmp/ol-seed.tar') | Out-Null
        if (-not $DryRun) {
          if (-not (Test-Path $bundle) -or (Get-Item $bundle).Length -eq 0) { throw 'scp reported done but ol-seed.tar did not land locally.' }
          & tar -xf 'ol-seed.tar'
          Remove-Item 'ol-seed.tar', 'ol-seed-pack.sh' -Force
        }
      }
      finally { Pop-Location }
      if (-not $DryRun) {
        foreach ($f in @($SeedReleases.Values) + $SecretNames) {
          $p = Join-Path $SeedDir $f
          if (-not (Test-Path $p) -or (Get-Item $p).Length -eq 0) { throw "missing after pull: $p" }
          Write-Host ("  {0,-40} {1,10:N0} bytes" -f $f, (Get-Item $p).Length)
        }
      }
      Write-Host "NOTE: $SeedDir now holds PRODUCTION SECRETS. Delete it after cutover." -ForegroundColor Yellow
    }
  }

  # ================================================================ sql
  if ($Steps -contains 'sql') {
    Step 'cloud sql'
    Ensure 'cloud sql instance' @('sql', 'instances', 'describe', $SqlInstance) `
      @('sql', 'instances', 'create', $SqlInstance, '--database-version=POSTGRES_16', '--edition=ENTERPRISE',
        # --zone implies the region; gcloud rejects --region and --zone together
        '--tier=db-custom-2-8192', "--zone=$SqlZone", '--availability-type=ZONAL',
        '--storage-type=SSD', '--storage-size=100', '--storage-auto-increase',
        "--network=projects/$Project/global/networks/$Vpc", '--no-assign-ip',
        '--backup-start-time=18:00', '--retained-backups-count=7',
        '--enable-point-in-time-recovery', '--retained-transaction-log-days=7', '--deletion-protection')
    Ensure 'database ol_node_rest' @('sql', 'databases', 'describe', 'ol_node_rest', "--instance=$SqlInstance") `
      @('sql', 'databases', 'create', 'ol_node_rest', "--instance=$SqlInstance")

    # Reuse the old app password so the restored DB and both .env files stay consistent.
    $envPath = Join-Path $SeedDir 'ol-node-rest-env'
    $users = if ($DryRun) { '' } else { Get @('sql', 'users', 'list', "--instance=$SqlInstance") 'value(name)' }
    if ($users -split "`n" | Where-Object { $_.Trim() -eq 'ol_node_rest_app' }) {
      Write-Host '= sql user ol_node_rest_app already exists' -ForegroundColor DarkGreen
    }
    elseif (Test-Path $envPath) {
      $m = [regex]::Match((ReadUtf8 $envPath), '(?m)^DATABASE_URL=["'']?postgres(?:ql)?://([^:]+):([^@]+)@')
      if (-not $m.Success) { throw "could not parse DATABASE_URL in $envPath" }
      $pw = [uri]::UnescapeDataString($m.Groups[2].Value)
      Run @('sql', 'users', 'create', $m.Groups[1].Value, "--instance=$SqlInstance", "--password=$pw")
    }
    elseif ($DryRun) { Run @('sql', 'users', 'create', 'ol_node_rest_app', "--instance=$SqlInstance", '--password=<from old .env>') }
    else { Write-Host "! skipped sql user: $envPath not found (run step 'pull' first)" -ForegroundColor Yellow }
  }

  # ================================================================ redis
  if ($Steps -contains 'redis') {
    Step 'memorystore redis'
    # noeviction matches the old instance (INFO, 2026-09-28). Memorystore's default is
    # volatile-lru, which can silently evict BullMQ job keys under memory pressure.
    Ensure 'redis' @('redis', 'instances', 'describe', $RedisInstance, "--region=$Region") `
      @('redis', 'instances', 'create', $RedisInstance, "--region=$Region", "--tier=$RedisTier", "--size=$RedisSizeGb",
        '--redis-version=redis_7_2', "--network=projects/$Project/global/networks/$Vpc",
        '--connect-mode=direct-peering', '--redis-config=maxmemory-policy=noeviction')
  }

  # ================================================================ iam
  if ($Steps -contains 'iam') {
    Step 'service accounts + iam'
    Ensure 'api service account' @('iam', 'service-accounts', 'describe', $ApiSa) `
      @('iam', 'service-accounts', 'create', 'ol-node-rest-api-sa', '--display-name=ol-node-rest API instance')
    Ensure 'deploy service account' @('iam', 'service-accounts', 'describe', $DeploySa) `
      @('iam', 'service-accounts', 'create', 'gh-actions-gcp-deploy', '--display-name=GitHub Actions GCP Deploy')

    foreach ($role in 'roles/cloudsql.client', 'roles/bigquery.jobUser', 'roles/bigquery.dataViewer', 'roles/monitoring.viewer') {
      Run @('projects', 'add-iam-policy-binding', $Project, "--member=serviceAccount:$ApiSa", "--role=$role", '--condition=None') -Retries 4
    }
    foreach ($role in 'roles/compute.osAdminLogin', 'roles/compute.viewer', 'roles/iap.tunnelResourceAccessor') {
      Run @('projects', 'add-iam-policy-binding', $Project, "--member=serviceAccount:$DeploySa", "--role=$role", '--condition=None') -Retries 4
    }
    # the deploy SA ssh-es into VMs that run as the api SA
    Run @('iam', 'service-accounts', 'add-iam-policy-binding', $ApiSa,
      "--member=serviceAccount:$DeploySa", '--role=roles/iam.serviceAccountUser') -Retries 4
  }

  # ================================================================ wif
  if ($Steps -contains 'wif') {
    Step 'github workload identity'
    Ensure 'wif pool' @('iam', 'workload-identity-pools', 'describe', 'github-pool', '--location=global') `
      @('iam', 'workload-identity-pools', 'create', 'github-pool', '--location=global', '--display-name=GitHub Actions Pool')
    $repoList = ($GithubRepos | ForEach-Object { "'$_'" }) -join ','
    Ensure 'wif provider' @('iam', 'workload-identity-pools', 'providers', 'describe', 'github-provider',
      '--workload-identity-pool=github-pool', '--location=global') `
      @('iam', 'workload-identity-pools', 'providers', 'create-oidc', 'github-provider',
        '--workload-identity-pool=github-pool', '--location=global',
        '--issuer-uri=https://token.actions.githubusercontent.com',
        '--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository',
        "--attribute-condition=assertion.repository in [$repoList]")
    $num = Get @('projects', 'describe', $Project) 'value(projectNumber)'
    foreach ($repo in $GithubRepos) {
      Run @('iam', 'service-accounts', 'add-iam-policy-binding', $DeploySa, '--role=roles/iam.workloadIdentityUser',
        "--member=principalSet://iam.googleapis.com/projects/$num/locations/global/workloadIdentityPools/github-pool/attribute.repository/$repo") -Retries 4
    }
  }

  # ================================================================ bucket
  if ($Steps -contains 'bucket') {
    Step 'release bucket'
    Ensure 'bucket' @('storage', 'buckets', 'describe', $ReleaseBucket) `
      @('storage', 'buckets', 'create', $ReleaseBucket, "--location=$Region", '--uniform-bucket-level-access', '--public-access-prevention')
    Run @('storage', 'buckets', 'add-iam-policy-binding', $ReleaseBucket, "--member=serviceAccount:$ApiSa", '--role=roles/storage.objectViewer') -Retries 4
    # objectUser (not objectCreator): the workflows overwrite latest.tgz, which needs delete
    Run @('storage', 'buckets', 'add-iam-policy-binding', $ReleaseBucket, "--member=serviceAccount:$DeploySa", '--role=roles/storage.objectUser') -Retries 4

    foreach ($app in $SeedReleases.Keys) {
      $obj = "$ReleaseBucket/$app/latest.tgz"
      $local = Join-Path $SeedDir $SeedReleases[$app]
      if (Exists @('storage', 'objects', 'describe', $obj)) {
        # never overwrite: after cutover the workflows publish newer builds here
        Write-Host "= $obj already exists (left alone)" -ForegroundColor DarkGreen
      }
      elseif ($DryRun -or (Test-Path $local)) { Run @('storage', 'cp', $local, $obj) }
      else { Write-Host "! $obj missing and no seed at $local (run step 'pull')" -ForegroundColor Yellow }
    }
  }

  # ================================================================ secrets
  if ($Steps -contains 'secrets') {
    Step 'secret manager'
    $sqlIp = Get @('sql', 'instances', 'describe', $SqlInstance) 'value(ipAddresses[0].ipAddress)'
    $redisHost = Get @('redis', 'instances', 'describe', $RedisInstance, "--region=$Region") 'value(host)'
    $redisPort = Get @('redis', 'instances', 'describe', $RedisInstance, "--region=$Region") 'value(port)'
    if (-not $DryRun -and (-not $sqlIp -or -not $redisHost)) { throw "SQL/Redis not ready (sql=$sqlIp redis=$redisHost). Run steps sql, redis first." }
    Write-Host "new SQL private IP: $sqlIp   new Redis: ${redisHost}:$redisPort"

    $outDir = Join-Path $SeedDir 'rewritten'
    if (-not $DryRun) { New-Item -ItemType Directory -Force $outDir | Out-Null }
    foreach ($name in $SecretNames) {
      Ensure "secret $name" @('secrets', 'describe', $name) @('secrets', 'create', $name, '--replication-policy=automatic')
      Run @('secrets', 'add-iam-policy-binding', $name, "--member=serviceAccount:$ApiSa", '--role=roles/secretmanager.secretAccessor') -Retries 4

      $src = Join-Path $SeedDir $name
      if (-not $DryRun -and -not (Test-Path $src)) { Write-Host "! $src missing (run step 'pull')" -ForegroundColor Yellow; continue }
      $hasVersion = if ($DryRun) { '' } else { Get @('secrets', 'versions', 'list', $name, '--filter=state=enabled', '--limit=1') 'value(name)' }
      if ($hasVersion) { Write-Host "= $name already has a version (left alone)" -ForegroundColor DarkGreen; continue }

      $dst = $src
      if ($name -like '*-env' -and -not $DryRun) {
        $t = ReadUtf8 $src
        $t = [regex]::Replace($t, '(?m)^((?:DATABASE_URL|DATABASE_DIRECT_URL)=["'']?postgres(?:ql)?://[^@\s]+@)[^:/\s"'']+', "`${1}$sqlIp")
        $t = [regex]::Replace($t, '(?m)^(REDIS_URL=["'']?rediss?://(?:[^@/\s]*@)?)[^/\s"'']+', "`${1}${redisHost}:$redisPort")
        $t = [regex]::Replace($t, '(?m)^GCP_PROJECT_ID=.*$', "GCP_PROJECT_ID=$Project")
        # (the new SQL can legitimately land on the same private IP - same 10.37.0.0/16 range)
        foreach ($stale in @('10.37.0.6', '10.4.236.195', $OldProject) | Where-Object { $_ -ne $sqlIp -and $_ -ne $redisHost }) {
          if ($t.Contains($stale)) { throw "$name still contains old value '$stale' after rewrite - fix by hand in $src" }
        }
        $dst = Join-Path $outDir $name
        WriteLf $dst $t
        Write-Host "  rewrote DATABASE_URL/DATABASE_DIRECT_URL/REDIS_URL/GCP_PROJECT_ID -> $dst"
      }
      Run @('secrets', 'versions', 'add', $name, "--data-file=$dst")
    }
  }

  # ================================================================ template
  if ($Steps -contains 'template') {
    Step "instance template ($TemplateName)"
    $boot = Join-Path $PSScriptRoot '..\gce-bootstrap.sh'
    $bootLf = Join-Path $env:TEMP 'ol-gce-bootstrap.lf.sh'
    WriteLf $bootLf (ReadUtf8 $boot)
    $startFlag = if ($StartProcesses) { 'true' } else { 'false' }
    Ensure "template $TemplateName" @('compute', 'instance-templates', 'describe', $TemplateName) `
      @('compute', 'instance-templates', 'create', $TemplateName,
        '--machine-type=e2-standard-4', '--image-family=ubuntu-2404-lts-amd64', '--image-project=ubuntu-os-cloud',
        '--boot-disk-size=50GB', '--boot-disk-type=pd-ssd',
        "--network=projects/$Project/global/networks/$Vpc",
        "--subnet=projects/$Project/regions/$Region/subnetworks/$Subnet", '--no-address',
        "--service-account=$ApiSa", '--scopes=cloud-platform',
        '--shielded-vtpm', '--shielded-integrity-monitoring',
        "--metadata=enable-oslogin=TRUE,run-workers=true,start-processes=$startFlag,release-bucket=$ReleaseBucket,admin-hostnames=$AdminHostnames",
        "--metadata-from-file=startup-script=$bootLf")
    if (Exists @('compute', 'instance-groups', 'managed', 'describe', $Mig, "--region=$Region")) {
      $cur = Get @('compute', 'instance-groups', 'managed', 'describe', $Mig, "--region=$Region") 'value(instanceTemplate.basename())'
      if ($cur -ne $TemplateName) {
        Run @('compute', 'instance-groups', 'managed', 'set-instance-template', $Mig, "--region=$Region", "--template=$TemplateName")
        Write-Host ''
        Write-Host "MIG now points at $TemplateName, but the running VM was NOT replaced. When ready:" -ForegroundColor Yellow
        Write-Host "  gcloud compute instance-groups managed rolling-action replace $Mig --region=$Region --max-unavailable=1 --max-surge=0 --project=$Project --configuration=$Configuration" -ForegroundColor Yellow
      }
    }
  }

  # ================================================================ mig
  if ($Steps -contains 'mig') {
    Step 'managed instance group'
    Ensure 'mig' @('compute', 'instance-groups', 'managed', 'describe', $Mig, "--region=$Region") `
      @('compute', 'instance-groups', 'managed', 'create', $Mig, "--region=$Region", "--template=$TemplateName",
        '--size=1', "--base-instance-name=$Mig", "--zones=$Region-a,$Region-b,$Region-c")
    # set-named-ports REPLACES the whole set - always all three together
    Run @('compute', 'instance-groups', 'managed', 'set-named-ports', $Mig, "--region=$Region", '--named-ports=http:3000,live:5000,admin:8080')
    Run @('compute', 'instance-groups', 'managed', 'set-autoscaling', $Mig, "--region=$Region",
      '--min-num-replicas=1', '--max-num-replicas=1', '--target-cpu-utilization=0.6', '--cool-down-period=60', '--mode=on')
  }

  # ================================================================ certs
  if ($Steps -contains 'certs') {
    Step 'certificate manager'
    # per-project-record: the CNAME name is unique to this project, so it can be added
    # next to the OLD project's _acme-challenge records without breaking their renewal.
    $subs = @('api', 'live', 'admins3jinyu', 'priviledge')
    foreach ($s in $subs) {
      Ensure "dns auth $s" @('certificate-manager', 'dns-authorizations', 'describe', "auth-$s") `
        @('certificate-manager', 'dns-authorizations', 'create', "auth-$s", "--domain=$s.$Domain", '--type=per-project-record')
    }
    Ensure 'cert ol-node-rest-cert' @('certificate-manager', 'certificates', 'describe', 'ol-node-rest-cert') `
      @('certificate-manager', 'certificates', 'create', 'ol-node-rest-cert',
        "--domains=api.$Domain,live.$Domain,admins3jinyu.$Domain", '--dns-authorizations=auth-api,auth-live,auth-admins3jinyu')
    Ensure 'cert ol-node-rest-cert-priviledge' @('certificate-manager', 'certificates', 'describe', 'ol-node-rest-cert-priviledge') `
      @('certificate-manager', 'certificates', 'create', 'ol-node-rest-cert-priviledge',
        "--domains=priviledge.$Domain", '--dns-authorizations=auth-priviledge')
    Ensure 'cert map' @('certificate-manager', 'maps', 'describe', 'ol-node-rest-certmap') `
      @('certificate-manager', 'maps', 'create', 'ol-node-rest-certmap')
    foreach ($s in $subs) {
      $cert = if ($s -eq 'priviledge') { 'ol-node-rest-cert-priviledge' } else { 'ol-node-rest-cert' }
      Ensure "map entry $s" @('certificate-manager', 'maps', 'entries', 'describe', "$s-entry", '--map=ol-node-rest-certmap') `
        @('certificate-manager', 'maps', 'entries', 'create', "$s-entry", '--map=ol-node-rest-certmap',
          "--hostname=$s.$Domain", "--certificates=$cert")
    }
  }

  # ================================================================ lb
  if ($Steps -contains 'lb') {
    Step 'load balancer'
    $hcs = @(
      , @('ol-node-rest-hc', '3000', '/health', '10s', '3')
      , @('ol-node-rest-live-hc', '5000', '/', '10s', '3')
      , @('ol-node-rest-admin-hc', '8080', '/', '5s', '2')
    )
    foreach ($h in $hcs) {
      Ensure "health check $($h[0])" @('compute', 'health-checks', 'describe', $h[0], '--global') `
        @('compute', 'health-checks', 'create', 'http', $h[0], '--global', "--port=$($h[1])", "--request-path=$($h[2])",
          "--check-interval=$($h[3])", '--timeout=5s', '--healthy-threshold=2', "--unhealthy-threshold=$($h[4])")
    }
    # All three EXTERNAL_MANAGED (the old project mixed EXTERNAL + EXTERNAL_MANAGED).
    $bes = @(
      , @('ol-node-rest-backend', 'http', 'ol-node-rest-hc', '30s', 'NONE')
      , @('ol-node-rest-live-backend', 'live', 'ol-node-rest-live-hc', '3600s', 'CLIENT_IP')   # websockets
      , @('ol-node-rest-admin-backend', 'admin', 'ol-node-rest-admin-hc', '30s', 'NONE')
    )
    foreach ($b in $bes) {
      Ensure "backend $($b[0])" @('compute', 'backend-services', 'describe', $b[0], '--global') `
        @('compute', 'backend-services', 'create', $b[0], '--global', '--load-balancing-scheme=EXTERNAL_MANAGED',
          '--protocol=HTTP', "--port-name=$($b[1])", "--health-checks=$($b[2])", '--global-health-checks',
          "--timeout=$($b[3])", "--session-affinity=$($b[4])")
      $groups = if ($DryRun) { '' } else { Get @('compute', 'backend-services', 'describe', $b[0], '--global') 'value(backends[].group)' }
      if ($groups -match "instanceGroups/$Mig") { Write-Host "= $($b[0]) already has the MIG" -ForegroundColor DarkGreen }
      else {
        # two backend services sharing one instance group must agree on max-utilization
        Run @('compute', 'backend-services', 'add-backend', $b[0], '--global', "--instance-group=$Mig",
          "--instance-group-region=$Region", '--balancing-mode=UTILIZATION', '--max-utilization=0.8')
      }
    }

    foreach ($um in @(@{ name = 'ol-node-rest-urlmap'; file = 'urlmap-main.yaml' }, @{ name = 'ol-node-rest-redirect'; file = 'urlmap-redirect.yaml' })) {
      $rendered = Join-Path $env:TEMP "ol-$($um.file)"
      WriteLf $rendered ((ReadUtf8 (Join-Path $PSScriptRoot $um.file)) -replace '__PROJECT__', $Project)
      Run @('compute', 'url-maps', 'import', $um.name, '--global', "--source=$rendered")
    }

    Ensure 'static ip' @('compute', 'addresses', 'describe', 'ol-node-rest-lb-ip', '--global') `
      @('compute', 'addresses', 'create', 'ol-node-rest-lb-ip', '--global', '--ip-version=IPV4')
    Ensure 'http proxy' @('compute', 'target-http-proxies', 'describe', 'ol-node-rest-http-proxy', '--global') `
      @('compute', 'target-http-proxies', 'create', 'ol-node-rest-http-proxy', '--global', '--url-map=ol-node-rest-redirect')
    Ensure 'https proxy' @('compute', 'target-https-proxies', 'describe', 'ol-node-rest-https-proxy', '--global') `
      @('compute', 'target-https-proxies', 'create', 'ol-node-rest-https-proxy', '--global',
        '--url-map=ol-node-rest-urlmap', '--certificate-map=ol-node-rest-certmap')
    Ensure 'fwd rule :80' @('compute', 'forwarding-rules', 'describe', 'ol-node-rest-fr', '--global') `
      @('compute', 'forwarding-rules', 'create', 'ol-node-rest-fr', '--global', '--load-balancing-scheme=EXTERNAL_MANAGED',
        '--address=ol-node-rest-lb-ip', '--target-http-proxy=ol-node-rest-http-proxy', '--ports=80')
    Ensure 'fwd rule :443' @('compute', 'forwarding-rules', 'describe', 'ol-node-rest-fr-https', '--global') `
      @('compute', 'forwarding-rules', 'create', 'ol-node-rest-fr-https', '--global', '--load-balancing-scheme=EXTERNAL_MANAGED',
        '--address=ol-node-rest-lb-ip', '--target-https-proxy=ol-node-rest-https-proxy', '--ports=443')
  }

  # ================================================================ bigquery
  if ($Steps -contains 'bigquery') {
    Step 'bigquery billing_export'
    if ($DryRun) { Write-Host "[dry-run] bq --project_id=$Project mk --dataset --location=$Region ${Project}:billing_export" -ForegroundColor DarkGray }
    else {
      & bq --project_id=$Project show "${Project}:billing_export" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Host '= dataset billing_export already exists' -ForegroundColor DarkGreen }
      else {
        & bq --project_id=$Project mk --dataset --location=$Region "${Project}:billing_export"
        if ($LASTEXITCODE -ne 0) { throw 'bq mk failed' }
      }
    }
    Write-Host 'MANUAL: Console -> Billing -> Billing export -> BigQuery export -> Standard usage cost ->' -ForegroundColor Yellow
    Write-Host "        project $Project, dataset billing_export. Data appears ~24h later." -ForegroundColor Yellow
  }

  # ================================================================ summary
  if ($Steps -contains 'summary') {
    Step 'summary'
    $num = Get @('projects', 'describe', $Project) 'value(projectNumber)'
    $lbIp = Get @('compute', 'addresses', 'describe', 'ol-node-rest-lb-ip', '--global') 'value(address)'
    $natIp = Get @('compute', 'routers', 'get-status', 'ol-node-rest-router', "--region=$Region") 'value(result.natStatus[0].autoAllocatedNatIps)'
    $sqlIp = Get @('sql', 'instances', 'describe', $SqlInstance) 'value(ipAddresses[0].ipAddress)'
    $redisHost = Get @('redis', 'instances', 'describe', $RedisInstance, "--region=$Region") 'value(host)'
    $inst = ParseInstance (Get @('compute', 'instance-groups', 'managed', 'list-instances', $Mig, "--region=$Region") 'json')
    $vm = if ($DryRun) { '<vm name>' } else { $inst.name }
    $vmZone = if ($DryRun) { '<vm zone>' } else { $inst.zone }

    Write-Host "project            $Project  (number $num)"
    Write-Host "LB IP (DNS A)      $lbIp   -> api / live / admins3jinyu / priviledge .$Domain"
    Write-Host "NAT egress IP      $natIp   -> give to anyone who allowlisted 8.231.90.210"
    Write-Host "Cloud SQL IP       $sqlIp"
    Write-Host "Redis host         $redisHost"
    Write-Host "VM                 $vm ($vmZone)"
    Write-Host ''
    Write-Host 'DNS: add these CNAMEs now (certs go ACTIVE before any A record moves):' -ForegroundColor Green
    foreach ($s in 'api', 'live', 'admins3jinyu', 'priviledge') {
      Write-Host ('  ' + (Get @('certificate-manager', 'dns-authorizations', 'describe', "auth-$s") 'value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)'))
    }
    Write-Host ''
    Write-Host "GitHub (all of: $($GithubRepos -join ', ')):" -ForegroundColor Green
    Write-Host "  vars.GCP_PROJECT_ID                  = $Project"
    Write-Host "  vars.GCP_ZONE                        = $vmZone"
    Write-Host "  vars.GCE_INSTANCE                    = $vm"
    Write-Host "  vars.GCP_RELEASE_BUCKET              = $ReleaseBucket"
    Write-Host "  secrets.GCP_WORKLOAD_IDENTITY_PROVIDER = projects/$num/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
    Write-Host "  secrets.GCP_DEPLOY_SERVICE_ACCOUNT     = $DeploySa"
  }
}
finally {
  $env:CLOUDSDK_ACTIVE_CONFIG_NAME = $prevCfg
}
