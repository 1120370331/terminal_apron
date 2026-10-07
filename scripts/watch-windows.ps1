$ErrorActionPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-windows.ps1"
$DataDir = Join-Path $ProjectRoot "data"
$WatchLog = Join-Path $DataDir "watch.log"

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Write-WatchLog {
  param([string] $Message)
  Add-Content -Path $WatchLog -Value "[$(Get-Date -Format o)] $Message"
}

function Get-ConfiguredPort {
  $envFile = Get-ConfiguredEnvFile
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^TWM_PORT=" } | Select-Object -First 1
    if ($line) {
      $value = $line.Split("=", 2)[1].Trim()
      if ($value -match "^\d+$") {
        return [int] $value
      }
    }
  }
  return 3131
}

function Get-ConfiguredHost {
  $envFile = Get-ConfiguredEnvFile
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^TWM_HOST=" } | Select-Object -First 1
    if ($line) {
      $value = $line.Split("=", 2)[1].Trim().Trim('"').Trim("'")
      if ($value) {
        return $value
      }
    }
  }
  return "127.0.0.1"
}

function Resolve-MonitorHost {
  param([string] $HostValue)

  if ($HostValue -in @("0.0.0.0", "::")) {
    return "127.0.0.1"
  }

  if ($HostValue.ToLowerInvariant() -ne "tailscale") {
    return $HostValue
  }

  try {
    $tailscaleIp = (& tailscale.exe ip -4 2>$null | Select-Object -First 1).Trim()
    if ($tailscaleIp) {
      return $tailscaleIp
    }
  } catch {
    return "127.0.0.1"
  }

  return "127.0.0.1"
}

function Get-ConfiguredEnvFile {
  $configured = $env:TWM_ENV_FILE
  if ($configured -and (Test-Path -LiteralPath $configured)) {
    return (Resolve-Path -LiteralPath $configured).Path
  }
  return Join-Path $ProjectRoot ".env"
}

function Test-Health {
  param(
    [string] $HostName,
    [int] $Port
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://${HostName}:$Port/api/health" -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-WatcherAlreadyRunning {
  $escapedScript = [regex]::Escape($PSCommandPath)
  $currentPid = $PID
  $existing = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
    Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.CommandLine -match $escapedScript
    } |
    Select-Object -First 1

  return [bool] $existing
}

if (Test-WatcherAlreadyRunning) {
  Write-WatchLog "another watchdog is already running; exiting"
  exit 0
}

Write-WatchLog "watchdog started"

while ($true) {
  $port = Get-ConfiguredPort
  $configuredHost = Get-ConfiguredHost
  $monitorHost = Resolve-MonitorHost $configuredHost

  if (-not (Test-Health $monitorHost $port)) {
    Write-WatchLog "health check failed at http://${monitorHost}:$port/api/health; starting service"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $StartScript -WorkingDirectory $ProjectRoot -WindowStyle Hidden
    Start-Sleep -Seconds 15
  }

  Start-Sleep -Seconds 60
}
