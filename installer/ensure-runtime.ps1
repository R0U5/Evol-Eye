$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $Root 'manifest.json'
if (-not (Test-Path -LiteralPath $ManifestPath)) { throw 'manifest.json is missing from the installer bundle' }
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

function Get-NodeVersion([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $v = (& $Path --version 2>$null)
    if ($LASTEXITCODE -eq 0 -and $v -match '^v?\d+') { return ($v -replace '^v','').Trim() }
  } catch { }
  return $null
}

function Test-Version([string]$Actual, [string]$Min) {
  try {
    $a = [Version]$Actual
    $m = [Version]($Min -replace '\.0+$','') -as [System.Version]
    if (-not $m) { $m = [Version]$Min }
    return $a -ge $m
  } catch { return $false }
}

function Get-NodeBin {
  param([string]$Version)
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM') { 'arm64' } else { 'x64' }
  $DistName = "node-v$Version-win-$Arch"
  $Zip = Join-Path $env:TEMP ($DistName + '.zip')
  $Sums = Join-Path $env:TEMP 'SHASUMS256.txt'
  $UrlBase = "https://nodejs.org/dist/v$Version"

  Write-Host "[runtime] Downloading Node.js $Version ($Arch)..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri "$UrlBase/$DistName.zip" -OutFile $Zip -UseBasicParsing -TimeoutSec 120
  Invoke-WebRequest -Uri "$UrlBase/SHASUMS256.txt" -OutFile $Sums -UseBasicParsing -TimeoutSec 60

  $Expected = $null
  Get-Content -LiteralPath $Sums | ForEach-Object {
    if ($_ -match "^([0-9a-fA-F]{64})\s+\*?$([Regex]::Escape($DistName + '.zip'))$") {
      $Expected = $Matches[1].ToLower()
    }
  }
  if (-not $Expected) { throw "Checksum file did not list $DistName.zip" }
  $Actual = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLower()
  if ($Actual -ne $Expected) { throw "Node.js download failed checksum verification (expected $Expected, got $Actual)" }
  Write-Host "[runtime] Node.js download verified." -ForegroundColor Green

  $RuntimeDir = Join-Path $Root '.gev-runtime'
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $Expanded = Join-Path $RuntimeDir $DistName
  if (Test-Path -LiteralPath $Expanded) { Remove-Item -Recurse -Force -LiteralPath $Expanded }
  Expand-Archive -LiteralPath $Zip -DestinationPath $RuntimeDir -Force
  $Target = Join-Path $RuntimeDir 'node'
  if (Test-Path -LiteralPath $Target) { Remove-Item -Recurse -Force -LiteralPath $Target }
  Move-Item -LiteralPath $Expanded -Destination $Target
  return Join-Path $Target 'node.exe'
}

$Node = Join-Path $Root '.gev-runtime\node\node.exe'
$NodeVersion = Get-NodeVersion $Node
if ($NodeVersion) {
  Write-Host "[runtime] Using bundled runtime v$NodeVersion" -ForegroundColor Green
} else {
  $SysNode = (Get-Command 'node' -ErrorAction SilentlyContinue).Source
  $SysVersion = Get-NodeVersion $SysNode
  if ($SysVersion -and (Test-Version $SysVersion $Manifest.minNodeVersion)) {
    $Node = $SysNode
    Write-Host "[runtime] Using system Node.js v$SysVersion" -ForegroundColor Green
  } else {
    if ($SysVersion) { Write-Host "[runtime] System Node v$SysVersion is older than the minimum (v$($Manifest.minNodeVersion)); downloading a fresh runtime." -ForegroundColor Yellow }
    $Node = Get-NodeBin $Manifest.recommendedNodeVersion
    $NodeVersion = Get-NodeVersion $Node
  }
}

if (-not $Node -or -not (Test-Path -LiteralPath $Node)) { throw 'Could not locate a usable Node.js runtime' }

$env:GEV_BOOTSTRAP_NODE = $Node
$Port = $Manifest.installerPort
$ServerScript = Join-Path $Root 'server.mjs'

Write-Host "[installer] Starting Devil's Eye installer on http://127.0.0.1:$Port ..." -ForegroundColor Cyan
$Proc = Start-Process -FilePath $Node -ArgumentList @($ServerScript) -WorkingDirectory $Root -PassThru -NoNewWindow

$Ready = $false
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $Resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 1
    if ($Resp.StatusCode -eq 200) { $Ready = $true; break }
  } catch { }
  if ($Proc.HasExited) { break }
}
if (-not $Ready) {
  Write-Host "[installer] Installer server did not become ready." -ForegroundColor Red
  Wait-Process -Id $Proc.Id -ErrorAction SilentlyContinue
  exit 1
}

$Browser = (Get-Command 'msedge' -ErrorAction SilentlyContinue).Source
if (-not $Browser) { $Browser = (Get-Command 'chrome' -ErrorAction SilentlyContinue).Source }
if (-not $Browser) {
  Start-Process "http://127.0.0.1:$Port"
} else {
  Start-Process -FilePath $Browser -ArgumentList "http://127.0.0.1:$Port"
}

Wait-Process -Id $Proc.Id -ErrorAction SilentlyContinue
exit 0