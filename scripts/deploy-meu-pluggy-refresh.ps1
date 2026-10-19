# Build and deploy the Meu Pluggy Playwright refresh Cloud Run Job.
# Prerequisites:
#   - gcloud auth, Artifact Registry or Cloud Build
#   - GCS object with storageState (from npm run pluggy:refresh:login)
#   - Grant the Nest Cloud Run SA roles/run.developer (or run.jobs.run) on this job
#
# Env / params:
#   GCP_PROJECT_ID (required)
#   GCP_REGION (default southamerica-east1)
#   MEU_PLUGGY_REFRESH_JOB (default meu-pluggy-refresh)
#   MEU_PLUGGY_STORAGE_STATE_GCS (required, gs://bucket/path/storageState.json)
#   MEU_PLUGGY_CONNECTION_IDS (optional)
#   MEU_PLUGGY_JOB_SA (optional service account email for the Job)
param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$Region = $(if ($env:GCP_REGION) { $env:GCP_REGION } else { "southamerica-east1" }),
  [string]$Job = $(if ($env:MEU_PLUGGY_REFRESH_JOB) { $env:MEU_PLUGGY_REFRESH_JOB } else { "meu-pluggy-refresh" }),
  [string]$StorageStateGcs = $env:MEU_PLUGGY_STORAGE_STATE_GCS,
  [string]$ConnectionIds = $env:MEU_PLUGGY_CONNECTION_IDS,
  [string]$JobServiceAccount = $env:MEU_PLUGGY_JOB_SA
)

if ([string]::IsNullOrWhiteSpace($ProjectId)) {
  throw "Missing GCP_PROJECT_ID"
}
if ([string]::IsNullOrWhiteSpace($StorageStateGcs)) {
  throw "Missing MEU_PLUGGY_STORAGE_STATE_GCS (gs://bucket/meu-pluggy/storageState.json)"
}
if (-not $StorageStateGcs.StartsWith("gs://")) {
  throw "MEU_PLUGGY_STORAGE_STATE_GCS must be a gs:// URI"
}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Image = "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy/$Job`:latest"

Write-Host "Ensuring Artifact Registry repo cloud-run-source-deploy..."
gcloud artifacts repositories describe cloud-run-source-deploy `
  --project=$ProjectId `
  --location=$Region `
  --quiet 2>$null
if ($LASTEXITCODE -ne 0) {
  gcloud artifacts repositories create cloud-run-source-deploy `
    --project=$ProjectId `
    --location=$Region `
    --repository-format=docker `
    --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create Artifact Registry repo"
  }
}

Write-Host "Building image $Image ..."
gcloud builds submit $Root `
  --project=$ProjectId `
  --region=$Region `
  --tag=$Image `
  --dockerfile=Dockerfile.meu-pluggy-refresh `
  --quiet
if ($LASTEXITCODE -ne 0) {
  # Older gcloud uses --file for cloudbuild; fall back to local docker + push if submit --dockerfile unsupported
  Write-Host "gcloud builds submit --dockerfile failed; trying Cloud Build config..."
  $cloudbuild = Join-Path $env:TEMP "meu-pluggy-refresh-cloudbuild.yaml"
  @"
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '$Image', '-f', 'Dockerfile.meu-pluggy-refresh', '.']
images:
  - '$Image'
"@ | Set-Content -LiteralPath $cloudbuild -Encoding utf8
  gcloud builds submit $Root `
    --project=$ProjectId `
    --region=$Region `
    --config=$cloudbuild `
    --quiet
  Remove-Item -LiteralPath $cloudbuild -Force -ErrorAction SilentlyContinue
  if ($LASTEXITCODE -ne 0) {
    throw "Image build failed"
  }
}

$ProgressGcs = $(if ($env:MEU_PLUGGY_PROGRESS_GCS) { $env:MEU_PLUGGY_PROGRESS_GCS } else { ($StorageStateGcs -replace '[^/]+$', 'progress.json') })
$envPairs = @(
  "MEU_PLUGGY_STORAGE_STATE_GCS=$StorageStateGcs",
  "MEU_PLUGGY_PROGRESS_GCS=$ProgressGcs"
)
if (-not [string]::IsNullOrWhiteSpace($ConnectionIds)) {
  $envPairs += "MEU_PLUGGY_CONNECTION_IDS=$ConnectionIds"
}
$envCsv = ($envPairs -join ",")

$deployArgs = @(
  "run", "jobs", "deploy", $Job,
  "--project=$ProjectId",
  "--region=$Region",
  "--image=$Image",
  "--tasks=1",
  "--max-retries=0",
  "--task-timeout=30m",
  "--memory=2Gi",
  "--cpu=1",
  "--set-env-vars=$envCsv",
  "--quiet"
)
if (-not [string]::IsNullOrWhiteSpace($JobServiceAccount)) {
  $deployArgs += "--service-account=$JobServiceAccount"
}

Write-Host "Deploying Cloud Run Job '$Job'..."
& gcloud @deployArgs
if ($LASTEXITCODE -ne 0) {
  throw "gcloud run jobs deploy failed"
}

Write-Host ""
Write-Host "Job deployed: $Job"
Write-Host "Manual test: gcloud run jobs execute $Job --project=$ProjectId --region=$Region"
Write-Host "App needs env: GCP_PROJECT_ID=$ProjectId GCP_REGION=$Region MEU_PLUGGY_REFRESH_JOB=$Job"
Write-Host "Grant the Cloud Run service SA permission to run this job (roles/run.developer on the job or project)."
