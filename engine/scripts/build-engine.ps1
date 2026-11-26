# =============================================================================
# Dragon Browser — From-Source Gecko Engine Builder (Windows / MozillaBuild)
# Self-healing pipeline: checks/installs prerequisites, stages source in a real
# space-free directory (C:\dragon-build\src\firefox-153.7.0) when repo path has
# spaces (auto-migrating existing extracted trees cleanly), runs ./mach bootstrap
# + configure + build + package via MozillaBuild, stages dist/runtime/, and
# runs compile-engine-pack.py.
# =============================================================================
[CmdletBinding()]
param(
    [string]$MozillaBuildShell = "C:\mozilla-build\start-shell.bat",
    [string]$SourceDir = "",
    [switch]$SkipBootstrap,
    [switch]$ForceBootstrap,
    [switch]$NoAutoInstall,
    [string]$JunctionRoot = "C:\dragon-build",
    [string]$GeckoVersion = "153.7.0esr"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EngineDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $EngineDir

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
        if (-not (Test-Path $exe)) { continue }
        try {
            $ver = & $exe -c "import sys; print(sys.version_info.major)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver.Trim() -eq "3") { return $exe }
        } catch {}
    }
    throw "No working Python 3 executable found (Windows Store stub ignored)."
}

function Convert-ToMsysPath {
    param([string]$WinPath)
    $norm = $WinPath -replace "\\", "/"
    if ($norm -match "^([A-Za-z]):(.*)$") {
        return "/" + $Matches[1].ToLowerInvariant() + $Matches[2]
    }
    return $norm
}

$GeckoTag   = $GeckoVersion.Trim()
$EsrVersion = ($GeckoTag -replace "esr$", "")
$DistDir    = Join-Path $RepoRoot "dist"
$RuntimeDir = Join-Path $DistDir "runtime"
$NativeDir  = Join-Path $RepoRoot "native"
$CacheDir   = Join-Path $EngineDir "cache"

Write-Host "=== Dragon Browser From-Source Gecko Engine Builder (Windows x64) ===" -ForegroundColor Cyan

# 0. Check & auto-install build prerequisites
$PrereqScript = Join-Path $ScriptDir "ensure-prerequisites.ps1"
& $PrereqScript -Mode Build -NoAutoInstall:$NoAutoInstall -TargetDrivePath $EngineDir -MozillaBuildShell $MozillaBuildShell

$PythonExe = Resolve-RealPython

# 1. Resolve a real, space-free physical source & object directory
#    (Mozilla's mach calls os.path.realpath() and rejects spaces in topsrcdir even behind junctions.)
$UseCleanRoot = ($EngineDir -match "\s") -or ($EngineDir.Length -gt 60)
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    if ($UseCleanRoot) {
        New-Item -ItemType Directory -Force -Path $JunctionRoot | Out-Null
        $CleanSrcParent = Join-Path $JunctionRoot "src"
        if (Test-Path $CleanSrcParent) {
            $item = Get-Item $CleanSrcParent -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                # IMPORTANT: Never use Remove-Item -Recurse on a junction! cmd rmdir removes only the junction link.
                & cmd.exe /c "rmdir `"$CleanSrcParent`""
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to remove legacy junction at $CleanSrcParent"
                }
            }
        }
        New-Item -ItemType Directory -Force -Path $CleanSrcParent | Out-Null

        $SourceDir    = Join-Path $CleanSrcParent "firefox-$EsrVersion"
        $LegacySrcDir = Join-Path (Join-Path $EngineDir "src") "firefox-$EsrVersion"
        if ((-not (Test-Path $SourceDir)) -and (Test-Path (Join-Path $LegacySrcDir "mach"))) {
            Write-Host "[1/5] Moving existing source tree to space-free path: $LegacySrcDir -> $SourceDir ..." -ForegroundColor Yellow
            Move-Item -Path $LegacySrcDir -Destination $SourceDir
        }
        $ObjDir    = Join-Path $JunctionRoot "obj-dragon"
        $RunnerDir = $JunctionRoot
    } else {
        $SourceDir = Join-Path (Join-Path $EngineDir "src") "firefox-$EsrVersion"
        $ObjDir    = Join-Path $SourceDir "obj-dragon"
        $RunnerDir = $CacheDir
    }
} else {
    if ($SourceDir -match "\s") {
        throw "Mozilla's ./mach forbids spaces in the real source directory path ('$SourceDir'). Move it or omit -SourceDir to auto-stage in $JunctionRoot\src."
    }
    $ObjDir    = Join-Path $SourceDir "obj-dragon"
    $RunnerDir = $CacheDir
}

# 2. Ensure source tree is present & extracted
$MachCheck = Join-Path $SourceDir "mach"
if (-not (Test-Path $SourceDir) -or -not (Test-Path $MachCheck)) {
    Write-Host "[1/5] Source tree missing or incomplete at $SourceDir — running fetch-source.ps1..."
    & (Join-Path $ScriptDir "fetch-source.ps1") -Target "win64" -NoAutoInstall:$NoAutoInstall -BuildRoot $JunctionRoot -GeckoVersion $GeckoTag
}

if ($SourceDir -match "\s") {
    throw "Resolved source directory still contains spaces ('$SourceDir'), which ./mach rejects."
}

# 3. Generate Dragon branding assets & apply/verify overlay
Write-Host "[2/5] Generating Dragon branding icon assets & verifying source overlay..."
$GenAssetsScript = Join-Path $ScriptDir "generate-branding-assets.py"
if (Test-Path $GenAssetsScript) {
    & $PythonExe $GenAssetsScript
    if ($LASTEXITCODE -ne 0) {
        throw "generate-branding-assets.py failed with exit code $LASTEXITCODE"
    }
}

& $PythonExe (Join-Path $ScriptDir "apply-overlay.py") --src-dir $SourceDir --target win64 --apply --verify
if ($LASTEXITCODE -ne 0) {
    throw "apply-overlay.py failed with exit code $LASTEXITCODE"
}

$BuildSrcDir = $SourceDir
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null

$UnixBuildSrc      = Convert-ToMsysPath $BuildSrcDir
$UnixObjDir        = Convert-ToMsysPath $ObjDir
$BootstrapMarker   = Join-Path $CacheDir ".mach-bootstrapped"
$UnixBootstrapMark = Convert-ToMsysPath $BootstrapMarker
$UnixCacheDir      = Convert-ToMsysPath $CacheDir
$RunBootstrap      = (-not $SkipBootstrap) -and ($ForceBootstrap -or (-not (Test-Path $BootstrapMarker)))

$BootstrapBlock = ""
if ($RunBootstrap) {
    $BootstrapBlock = @"
echo "[mach] Running one-time ./mach --no-interactive bootstrap --application-choice=browser ..."
./mach --no-interactive bootstrap --application-choice=browser
mkdir -p '$UnixCacheDir'
echo "ok" > '$UnixBootstrapMark'
"@
}

$RunnerScriptWin  = Join-Path $RunnerDir "run-mach.sh"
$RunnerScriptUnix = Convert-ToMsysPath $RunnerScriptWin

$RunnerContent = @"
#!/usr/bin/env bash
set -euo pipefail
export PATH="`$HOME/.cargo/bin:`$PATH"
cd '$UnixBuildSrc'
export MOZCONFIG='$UnixBuildSrc/mozconfig'
export MOZ_OBJDIR='$UnixObjDir'
export MOZBUILD_STATE_PATH="`${MOZBUILD_STATE_PATH:-`$HOME/.mozbuild}"
$BootstrapBlock
echo "[mach] Running ./mach configure ..."
./mach configure
echo "[mach] Running ./mach build ..."
./mach build
echo "[mach] Running ./mach package ..."
./mach package
"@

# Write with LF line endings and no UTF-8 BOM for MSYS2 bash
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($RunnerScriptWin, ($RunnerContent -replace "`r`n", "`n"), $Utf8NoBom)

Write-Host "[3/5] Running MozillaBuild ./mach pipeline (src=$UnixBuildSrc, obj=$UnixObjDir)..."
& $MozillaBuildShell -c "bash '$RunnerScriptUnix'"
if ($LASTEXITCODE -ne 0) {
    throw "MozillaBuild ./mach pipeline failed with exit code $LASTEXITCODE"
}

if ($RunBootstrap) {
    Set-Content -Path $BootstrapMarker -Value "ok" -Encoding ASCII
}

$PkgDir = Join-Path (Join-Path $ObjDir "dist") "dragon"
$ObjBinDir = if (Test-Path (Join-Path $PkgDir "omni.ja")) { $PkgDir } else { Join-Path (Join-Path $ObjDir "dist") "bin" }
if (-not (Test-Path $ObjBinDir)) {
    throw "Build output directory not found at $ObjBinDir"
}

Write-Host "[4/5] Copying compiled binaries from $ObjBinDir -> $RuntimeDir ..."
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Copy-Item -Path (Join-Path $ObjBinDir "*") -Destination $RuntimeDir -Recurse -Force

Write-Host "[5/5] Running compile-engine-pack.py on $RuntimeDir ..."
& $PythonExe (Join-Path $ScriptDir "compile-engine-pack.py") --runtime-dir $RuntimeDir --native-dir $NativeDir --refresh-binary --verify
if ($LASTEXITCODE -ne 0) {
    throw "compile-engine-pack.py failed with exit code $LASTEXITCODE"
}

$LauncherExe = Join-Path $DistDir "dragon-browser.exe"
if (Test-Path $LauncherExe) {
    Write-Host "Running launcher health check (--doctor)..."
    & $LauncherExe --doctor
}

Write-Host "[OK] Dragon Browser Gecko Engine build complete in: $RuntimeDir" -ForegroundColor Green
