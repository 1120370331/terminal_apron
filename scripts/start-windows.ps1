$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot ".env"
$DataDir = Join-Path $ProjectRoot "data"
$LogFile = Join-Path $DataDir "runtime.log"

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $name, $value = $line.Split("=", 2)
    $name = $name.Trim()
    $value = $value.Trim().Trim('"').Trim("'")
    if ($name) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

if (-not $env:TWM_HOST) { $env:TWM_HOST = "127.0.0.1" }
if (-not $env:TWM_PORT) { $env:TWM_PORT = "3131" }
if (-not $env:TWM_SESSION_BACKEND) { $env:TWM_SESSION_BACKEND = "auto" }

if ($env:TWM_HOST.ToLowerInvariant() -eq "tailscale") {
  $tailscaleIp = $null
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      $tailscaleIp = (& tailscale.exe ip -4 2>$null | Select-Object -First 1).Trim()
    } catch {
      $tailscaleIp = $null
    }

    if ($tailscaleIp) {
      break
    }
    Start-Sleep -Seconds 2
  }

  if ($tailscaleIp) {
    $env:TWM_HOST = $tailscaleIp
  } else {
    $env:TWM_HOST = "127.0.0.1"
  }
}

& npm.cmd start *> $LogFile
