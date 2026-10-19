# Deploy organizze-pluggy to Cloud Run.
# Reads secrets from repo-root .env — does not print values.
# Set GCP_PROJECT_ID in the environment or pass -ProjectId (never commit your project id).
param(
  [string]$ProjectId = $env:GCP_PROJECT_ID,
  [string]$Region = $(if ($env:GCP_REGION) { $env:GCP_REGION } else { "southamerica-east1" }),
  [string]$Service = $(if ($env:GCP_SERVICE_NAME) { $env:GCP_SERVICE_NAME } else { "organizze-pluggy" }),
  [string]$EnvFile = ""
)

if ([string]::IsNullOrWhiteSpace($ProjectId)) {
  throw "Missing GCP project. Set env GCP_PROJECT_ID or pass -ProjectId."
}

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) {
  $EnvFile = Join-Path $Root ".env"
}
if (-not (Test-Path $EnvFile)) {
  throw "Missing env file: $EnvFile"
}

$Required = @(
  "GOOGLE_CLIENT_ID",
  "GOOGLE_ALLOWED_EMAILS",
  "SESSION_SECRET",
  "ORGANIZZE_EMAIL",
  "ORGANIZZE_API_TOKEN",
  "ORGANIZZE_USER_AGENT",
  "PLUGGY_CLIENT_ID",
  "PLUGGY_CLIENT_SECRET",
  "DATABASE_URL"
)

# Optional — enables Atualizar Open Finance (Cloud Run Job + progress)
$OptionalMeuRefresh = @(
  "GCP_PROJECT_ID",
  "GCP_REGION",
  "MEU_PLUGGY_REFRESH_JOB",
  "MEU_PLUGGY_STORAGE_STATE_GCS",
  "MEU_PLUGGY_PROGRESS_GCS"
)

function Read-DotEnv([string]$Path) {
  $map = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) {
      return
    }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }
  return $map
}

function Escape-YamlDoubleQuoted([string]$Value) {
  return '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
}

$envMap = Read-DotEnv $EnvFile
foreach ($key in $Required) {
  if (-not $envMap.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($envMap[$key])) {
    throw "Missing required env var in ${EnvFile}: $key"
  }
}
if ($envMap["SESSION_SECRET"].Length -lt 32) {
  throw "SESSION_SECRET must be at least 32 characters"
}

Write-Host "Running prisma migrate deploy..."
Push-Location (Join-Path $Root "api")
try {
  $env:DATABASE_URL = $envMap["DATABASE_URL"]
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) {
    throw "prisma migrate deploy failed"
  }
}
finally {
  Pop-Location
}

$yamlPath = Join-Path $env:TEMP "organizze-pluggy-cloudrun-env.yaml"
$yamlLines = @(
  "NODE_ENV: ""production"""
)
foreach ($key in $Required) {
  $yamlLines += ($key + ": " + (Escape-YamlDoubleQuoted $envMap[$key]))
}
foreach ($key in $OptionalMeuRefresh) {
  if ($envMap.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace($envMap[$key])) {
    $yamlLines += ($key + ": " + (Escape-YamlDoubleQuoted $envMap[$key]))
  }
}
if (-not $envMap.ContainsKey("GCP_PROJECT_ID") -or [string]::IsNullOrWhiteSpace($envMap["GCP_PROJECT_ID"])) {
  $yamlLines += ("GCP_PROJECT_ID: " + (Escape-YamlDoubleQuoted $ProjectId))
}
if (-not $envMap.ContainsKey("GCP_REGION") -or [string]::IsNullOrWhiteSpace($envMap["GCP_REGION"])) {
  $yamlLines += ("GCP_REGION: " + (Escape-YamlDoubleQuoted $Region))
}
[System.IO.File]::WriteAllText($yamlPath, ($yamlLines -join "`n"))

Write-Host "Deploying Cloud Run service '$Service' to $ProjectId/$Region..."
try {
  gcloud run deploy $Service `
    --project=$ProjectId `
    --region=$Region `
    --source=$Root `
    --allow-unauthenticated `
    --port=8080 `
    --memory=512Mi `
    --cpu=1 `
    --min-instances=0 `
    --max-instances=1 `
    --cpu-boost `
    --env-vars-file=$yamlPath `
    --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud run deploy failed"
  }
}
finally {
  Remove-Item -LiteralPath $yamlPath -Force -ErrorAction SilentlyContinue
}

$url = gcloud run services describe $Service `
  --project=$ProjectId `
  --region=$Region `
  --format="value(status.url)"

Write-Host ""
Write-Host "Deployed: $url"
Write-Host "Next: add this URL to Google OAuth Authorized JavaScript origins."
Write-Host "Health: $url/api/health"

# Also rebuild/redeploy the Playwright Job when storageState GCS is configured.
$storageStateGcs = $envMap["MEU_PLUGGY_STORAGE_STATE_GCS"]
if ([string]::IsNullOrWhiteSpace($storageStateGcs)) {
  $storageStateGcs = $env:MEU_PLUGGY_STORAGE_STATE_GCS
}
if (-not [string]::IsNullOrWhiteSpace($storageStateGcs)) {
  Write-Host ""
  Write-Host "Deploying Meu Pluggy refresh Job (MEU_PLUGGY_STORAGE_STATE_GCS set)..."
  $env:GCP_PROJECT_ID = $ProjectId
  $env:GCP_REGION = $Region
  $env:MEU_PLUGGY_STORAGE_STATE_GCS = $storageStateGcs
  if ($envMap.ContainsKey("MEU_PLUGGY_REFRESH_JOB") -and -not [string]::IsNullOrWhiteSpace($envMap["MEU_PLUGGY_REFRESH_JOB"])) {
    $env:MEU_PLUGGY_REFRESH_JOB = $envMap["MEU_PLUGGY_REFRESH_JOB"]
  }
  if ($envMap.ContainsKey("MEU_PLUGGY_PROGRESS_GCS") -and -not [string]::IsNullOrWhiteSpace($envMap["MEU_PLUGGY_PROGRESS_GCS"])) {
    $env:MEU_PLUGGY_PROGRESS_GCS = $envMap["MEU_PLUGGY_PROGRESS_GCS"]
  }
  if ($envMap.ContainsKey("MEU_PLUGGY_CONNECTION_IDS") -and -not [string]::IsNullOrWhiteSpace($envMap["MEU_PLUGGY_CONNECTION_IDS"])) {
    $env:MEU_PLUGGY_CONNECTION_IDS = $envMap["MEU_PLUGGY_CONNECTION_IDS"]
  }
  if ($envMap.ContainsKey("MEU_PLUGGY_JOB_SA") -and -not [string]::IsNullOrWhiteSpace($envMap["MEU_PLUGGY_JOB_SA"])) {
    $env:MEU_PLUGGY_JOB_SA = $envMap["MEU_PLUGGY_JOB_SA"]
  }

  $localState = Join-Path $Root ".cache\meu-pluggy-storageState.json"
  if (Test-Path $localState) {
    Write-Host "Uploading local storageState to $storageStateGcs ..."
    gcloud storage cp $localState $storageStateGcs --project=$ProjectId --quiet
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to upload storageState to GCS"
    }
  }

  & (Join-Path $PSScriptRoot "deploy-meu-pluggy-refresh.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "Meu Pluggy Job deploy failed"
  }
} else {
  Write-Host ""
  Write-Host "Skip Meu Pluggy Job deploy (set MEU_PLUGGY_STORAGE_STATE_GCS in .env to enable)."
}
