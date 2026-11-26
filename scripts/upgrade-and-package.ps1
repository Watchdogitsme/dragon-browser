<#
.SYNOPSIS
    Upgrades Dragon Browser's Gecko engine and builds a Windows Setup .exe installer.

.DESCRIPTION
    One-command workflow for Dragon Browser:
      1. Checks/downloads latest Mozilla Firefox ESR (or Rapid Release with -Channel release),
         verifies SHA256SUMS, compiles Dragon's zero-telemetry omni.ja + Native Core,
         verifies integrity, and atomically updates dist\runtime\ (preserving dist\profile\).
      2. Rebuilds dragon-browser.exe & dragon-installer-stub.exe when Cargo/WSL is available
         (or cleanly reuses prebuilt binaries if Rust was cleaned up).
      3. Packages release\DragonBrowser-Setup-<version>-win64.exe (+ optional Portable .zip).
#>
[CmdletBinding()]
param(
    [ValidateSet("esr", "release")]
    [string]$Channel = "esr",
    [string]$Version = "",
    [switch]$CheckOnly,
    [switch]$Force,
    [switch]$FromSource,
    [switch]$SkipUpgrade,
    [switch]$AlsoZip,
    [switch]$ReuseBinaries,
    [string]$OutputDir = "",
    [string]$LocalInstaller = "",
    [string]$LocalRuntime = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RepoRoot "release"
}

function Resolve-RealPython {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("python3", "python")) {
        Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Source) { $candidates.Add($_.Source) }
        }
    }
    foreach ($glob in @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "C:\mozilla-build\python3\python3.exe"
    )) {
        Get-Item $glob -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
    }
    foreach ($exe in $candidates) {
        if ([string]::IsNullOrWhiteSpace($exe)) { continue }
        if ($exe -match "\\WindowsApps\\python[^\\]*\.exe$") { continue }
        if (-not (Test-Path -LiteralPath $exe)) { continue }
        try {
            $ver = & $exe -c "import sys; print(sys.version_info.major)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver.Trim() -eq "3") { return $exe }
        } catch {}
    }
    throw "No working Python 3 executable found (Windows Store stub ignored)."
}

$PythonExe = Resolve-RealPython
$UpgradeScript = Join-Path (Join-Path (Join-Path $RepoRoot "engine") "scripts") "upgrade-engine.py"
$PackagerScript = Join-Path $ScriptDir "package-installer.py"

$UpgradeArgs = New-Object System.Collections.Generic.List[string]
$UpgradeArgs.Add($UpgradeScript)
$UpgradeArgs.Add("--channel")
$UpgradeArgs.Add($Channel)
if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $UpgradeArgs.Add("--version")
    $UpgradeArgs.Add($Version)
}

if ($CheckOnly) {
    $UpgradeArgs.Add("--check-only")
    & $PythonExe @UpgradeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Engine update check failed (exit code $LASTEXITCODE)."
    }
    exit 0
}

if (-not $SkipUpgrade) {
    if ($Force) { $UpgradeArgs.Add("--force") }
    if ($FromSource) { $UpgradeArgs.Add("--from-source") }
    if (-not [string]::IsNullOrWhiteSpace($LocalInstaller)) {
        $UpgradeArgs.Add("--local-installer")
        $UpgradeArgs.Add($LocalInstaller)
    }
    if (-not [string]::IsNullOrWhiteSpace($LocalRuntime)) {
        $UpgradeArgs.Add("--local-runtime")
        $UpgradeArgs.Add($LocalRuntime)
    }
    Write-Host "==> [1/3] Upgrading Dragon Gecko Engine (channel=$Channel)..." -ForegroundColor Cyan
    & $PythonExe @UpgradeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Engine upgrade failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "==> [1/3] Skipping engine upgrade (-SkipUpgrade)." -ForegroundColor DarkGray
}

$DistDir = Join-Path $RepoRoot "dist"
$LauncherOut = Join-Path $DistDir "dragon-browser.exe"
$StubCache = Join-Path (Join-Path (Join-Path $RepoRoot "installer") "build") "dragon-installer-stub.exe"
$BuiltBinaries = $false

if (-not $ReuseBinaries) {
    $CargoCmd = Get-Command "cargo.exe" -ErrorAction SilentlyContinue
    if ($CargoCmd) {
        Write-Host "==> [2/3] Rebuilding launcher & installer stub with Cargo..." -ForegroundColor Cyan
        Push-Location $RepoRoot
        try {
            & $CargoCmd.Source build --release -p dragon-browser -p dragon-installer-stub
            if ($LASTEXITCODE -eq 0) {
                $WinTargetRel = Join-Path (Join-Path $RepoRoot "target") "release"
                $BuiltLauncher = Join-Path $WinTargetRel "dragon-browser.exe"
                $BuiltStub = Join-Path $WinTargetRel "dragon-installer-stub.exe"
                if ((Test-Path -LiteralPath $BuiltLauncher) -and (Test-Path -LiteralPath $BuiltStub)) {
                    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StubCache) | Out-Null
                    Copy-Item -LiteralPath $BuiltLauncher -Destination $LauncherOut -Force
                    Copy-Item -LiteralPath $BuiltStub -Destination $StubCache -Force
                    $BuiltBinaries = $true
                }
            }
        }
        finally {
            Pop-Location
        }
    }
}

if (-not $BuiltBinaries) {
    Write-Host "==> [2/3] Using existing prebuilt dragon-browser.exe & installer stub..." -ForegroundColor DarkGray
    if (-not (Test-Path -LiteralPath $LauncherOut) -or -not (Test-Path -LiteralPath $StubCache)) {
        throw "Prebuilt launcher ($LauncherOut) or installer stub ($StubCache) is missing. Build them first via WSL 'bash scripts/build.sh' or install Rust."
    }
}

# Keep dist\resources synced with gecko\
$GeckoDir = Join-Path $RepoRoot "gecko"
$DistRes  = Join-Path $DistDir "resources"
New-Item -ItemType Directory -Force -Path (Join-Path $DistRes "autoconfig") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DistRes "chrome") | Out-Null
Copy-Item -LiteralPath (Join-Path $GeckoDir "user.js") -Destination (Join-Path $DistRes "user.js") -Force
Copy-Item -LiteralPath (Join-Path $GeckoDir "policies.template.json") -Destination (Join-Path $DistRes "policies.template.json") -Force
Copy-Item -LiteralPath (Join-Path (Join-Path $GeckoDir "autoconfig") "autoconfig.js") -Destination (Join-Path (Join-Path $DistRes "autoconfig") "autoconfig.js") -Force
Copy-Item -LiteralPath (Join-Path (Join-Path $GeckoDir "autoconfig") "dragon.cfg") -Destination (Join-Path (Join-Path $DistRes "autoconfig") "dragon.cfg") -Force
Copy-Item -LiteralPath (Join-Path (Join-Path $GeckoDir "autoconfig") "dragon-chrome.uc.js") -Destination (Join-Path (Join-Path $DistRes "autoconfig") "dragon-chrome.uc.js") -Force
Copy-Item -LiteralPath (Join-Path (Join-Path $GeckoDir "chrome") "userChrome.css") -Destination (Join-Path (Join-Path $DistRes "chrome") "userChrome.css") -Force
Copy-Item -LiteralPath (Join-Path (Join-Path $GeckoDir "chrome") "userContent.css") -Destination (Join-Path (Join-Path $DistRes "chrome") "userContent.css") -Force

Write-Host "==> [3/3] Packaging Windows Setup .exe into $OutputDir..." -ForegroundColor Cyan
$PkgArgs = New-Object System.Collections.Generic.List[string]
$PkgArgs.Add($PackagerScript)
$PkgArgs.Add("--dist-dir")
$PkgArgs.Add($DistDir)
$PkgArgs.Add("--output-dir")
$PkgArgs.Add($OutputDir)
if ($AlsoZip) {
    $PkgArgs.Add("--also-zip")
}
& $PythonExe @PkgArgs
if ($LASTEXITCODE -ne 0) {
    throw "package-installer.py failed with exit code $LASTEXITCODE."
}

if (Test-Path -LiteralPath $LauncherOut) {
    Write-Host ""
    Write-Host "Running launcher health check (--doctor)..." -ForegroundColor Cyan
    & $LauncherOut --doctor
    if ($LASTEXITCODE -ne 0) {
        throw "dragon-browser.exe --doctor failed with exit code $LASTEXITCODE."
    }
}

$SetupMatches = Get-ChildItem -LiteralPath $OutputDir -Filter "DragonBrowser-Setup-*-win64.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($SetupMatches -and $SetupMatches.Count -gt 0) {
    $LatestSetup = $SetupMatches[0].FullName
    Write-Host "Verifying generated installer ($LatestSetup)..." -ForegroundColor Cyan
    & $LatestSetup --verify
    if ($LASTEXITCODE -ne 0) {
        throw "Generated installer --verify failed with exit code $LASTEXITCODE."
    }
}
