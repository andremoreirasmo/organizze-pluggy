# Deploy organizze-pluggy to Cloud Run (southamerica-east1).
# Reads secrets from repo-root .env — does not print values.
param(
  [string]$ProjectId = "brazuca-rd",
  [string]$Region = "southamerica-east1",
  [string]$Service = "organizze-pluggy",
  [string]$EnvFile = ""
)

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
