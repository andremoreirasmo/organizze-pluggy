# One-time: connect GitHub repo + create Cloud Build trigger for master pushes.
# Prerequisites:
#   - gcloud auth, project brazuca-rd (or GCP_PROJECT_ID)
#   - Cloud Build GitHub app connected (prompted if missing)
#   - Secret Manager secret DATABASE_URL (optional; migrate skipped if absent)
#
# Usage:
#   $env:GCP_PROJECT_ID = "brazuca-rd"
#   .\scripts\setup-cloudbuild-trigger.ps1

param(
  [string]$ProjectId = $(if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "brazuca-rd" }),
  [string]$Region = $(if ($env:GCP_REGION) { $env:GCP_REGION } else { "southamerica-east1" }),
  [string]$RepoOwner = "andremoreirasmo",
  [string]$RepoName = "organizze-pluggy",
  [string]$Branch = "master",
  [string]$TriggerName = "organizze-pluggy-deploy"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "Enabling APIs..."
gcloud services enable `
  cloudbuild.googleapis.com `
  run.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  --project=$ProjectId `
  --quiet

# Ensure DATABASE_URL secret exists for prisma migrate step (from local .env if present).
$envFile = Join-Path $Root ".env"
$dbUrl = $null
if (Test-Path $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') {
      $dbUrl = $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
}
if (-not [string]::IsNullOrWhiteSpace($dbUrl)) {
  $tmp = Join-Path $env:TEMP "organizze-pluggy-database-url.txt"
  # UTF8 no BOM - Prisma rejects URLs with a leading BOM.
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($tmp, $dbUrl, $utf8NoBom)
  gcloud secrets describe DATABASE_URL --project=$ProjectId --quiet 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating Secret Manager secret DATABASE_URL..."
    gcloud secrets create DATABASE_URL --project=$ProjectId --replication-policy=automatic --quiet
  }
  Write-Host "Adding DATABASE_URL secret version..."
  gcloud secrets versions add DATABASE_URL --project=$ProjectId --data-file=$tmp --quiet
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "WARN: DATABASE_URL not in .env - create Secret Manager secret DATABASE_URL for migrate."
}

$ProjectNumber = gcloud projects describe $ProjectId --format="value(projectNumber)"
$BuildSa = "$ProjectNumber@cloudbuild.gserviceaccount.com"
Write-Host "Granting Cloud Build SA ($BuildSa) deploy roles..."
foreach ($role in @(
  "roles/run.admin",
  "roles/iam.serviceAccountUser",
  "roles/artifactregistry.writer",
  "roles/secretmanager.secretAccessor",
  "roles/storage.admin"
)) {
  gcloud projects add-iam-policy-binding $ProjectId `
    --member="serviceAccount:$BuildSa" `
    --role=$role `
    --condition=None `
    --quiet | Out-Null
}

$subs = @(
  "_REGION=$Region",
  "_SERVICE=organizze-pluggy",
  "_AR_REPO=cloud-run-source-deploy",
  "_RUN_PRISMA_MIGRATE=true"
)
$subsCsv = ($subs -join ",")

# Prefer 2nd-gen GitHub trigger if connection exists; else classic.
$connection = gcloud builds connections list `
  --project=$ProjectId `
  --region=$Region `
  --format="value(name)" 2>$null | Select-Object -First 1

if ($connection) {
  Write-Host "Using Developer Connect / Build connection: $connection"
  $repoResource = gcloud builds repositories list `
    --connection=$connection `
    --project=$ProjectId `
    --region=$Region `
    --format="value(name)" 2>$null | Where-Object { $_ -match $RepoName } | Select-Object -First 1

  if (-not $repoResource) {
    Write-Host "Link the GitHub repo in Cloud Build console, then re-run this script."
    Write-Host "https://console.cloud.google.com/cloud-build/repositories?project=$ProjectId"
    throw "GitHub repository not linked to Cloud Build connection"
  }

  gcloud builds triggers describe $TriggerName --project=$ProjectId --region=$Region --quiet 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Updating trigger $TriggerName ..."
    gcloud builds triggers update github $TriggerName `
      --project=$ProjectId `
      --region=$Region `
      --repository=$repoResource `
      --branch-pattern="^$Branch$" `
      --build-config=cloudbuild.yaml `
      --update-substitutions=$subsCsv `
      --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to update trigger $TriggerName" }
  } else {
    Write-Host "Creating trigger $TriggerName ..."
    gcloud builds triggers create github `
      --name=$TriggerName `
      --project=$ProjectId `
      --region=$Region `
      --repository=$repoResource `
      --branch-pattern="^$Branch$" `
      --build-config=cloudbuild.yaml `
      --substitutions=$subsCsv `
      --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to create trigger $TriggerName" }
  }
} else {
  Write-Host "No Build connection found - creating classic GitHub trigger."
  Write-Host "If this fails, connect the repo once in:"
  Write-Host "https://console.cloud.google.com/cloud-build/triggers/connect?project=$ProjectId"

  gcloud builds triggers describe $TriggerName --project=$ProjectId --quiet 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Updating trigger $TriggerName ..."
    gcloud builds triggers update github $TriggerName `
      --project=$ProjectId `
      --repo-owner=$RepoOwner `
      --repo-name=$RepoName `
      --branch-pattern="^$Branch$" `
      --build-config=cloudbuild.yaml `
      --update-substitutions=$subsCsv `
      --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to update trigger $TriggerName" }
  } else {
    Write-Host "Creating trigger $TriggerName ..."
    gcloud builds triggers create github `
      --name=$TriggerName `
      --project=$ProjectId `
      --repo-owner=$RepoOwner `
      --repo-name=$RepoName `
      --branch-pattern="^$Branch$" `
      --build-config=cloudbuild.yaml `
      --substitutions=$subsCsv `
      --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to create trigger $TriggerName" }
  }
}

Write-Host ""
Write-Host "Done. Push to $Branch will run Cloud Build ($TriggerName)."
Write-Host "Manual run: gcloud builds triggers run $TriggerName --project=$ProjectId --branch=$Branch"
