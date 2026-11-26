# =============================================================================
# Dragon Browser — Mozilla ESR 153 Source Fetcher & Overlay Bootstrap (Windows)
# Checks/installs prerequisites, downloads firefox-153.7.0esr.source.tar.xz,
# extracts (or migrates) to a space-free source tree (C:\dragon-build\src\firefox-153.7.0
# when the repo path contains spaces), and applies + verifies the Dragon overlay.
# =============================================================================
[CmdletBinding()]
param(
    [ValidateSet("win64", "linux64")]
    [string]$Target = "win64",
    [switch]$NoAutoInstall,
    [string]$BuildRoot = "C:\dragon-build",
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

# 0. Ensure Fetch prerequisites
$PrereqScript = Join-Path $ScriptDir "ensure-prerequisites.ps1"
& $PrereqScript -Mode Fetch -NoAutoInstall:$NoAutoInstall -TargetDrivePath $EngineDir

$PythonExe = Resolve-RealPython

$GeckoTag    = $GeckoVersion.Trim()
$EsrVersion  = ($GeckoTag -replace "esr$", "")
$TarballName = "firefox-$GeckoTag.source.tar.xz"
$SourceUrl   = "https://archive.mozilla.org/pub/firefox/releases/$GeckoTag/source/$TarballName"

$CacheDir     = Join-Path $EngineDir "cache"
$LegacyParent = Join-Path $EngineDir "src"
$LegacySrcDir = Join-Path $LegacyParent "firefox-$EsrVersion"

if (($EngineDir -match "\s") -or ($EngineDir.Length -gt 60)) {
    $SrcParent = Join-Path $BuildRoot "src"
    if (Test-Path $SrcParent) {
        $parentItem = Get-Item $SrcParent -Force
        if ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            # Safely remove legacy junction link only (never Remove-Item -Recurse on a junction)
            & cmd.exe /c "rmdir `"$SrcParent`""
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to remove legacy junction at $SrcParent"
            }
        }
    }
} else {
    $SrcParent = $LegacyParent
}

$SrcDir      = Join-Path $SrcParent "firefox-$EsrVersion"
$TarballPath = Join-Path $CacheDir $TarballName
$MinTarBytes = 104857600  # 100 MB sanity floor

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $SrcParent | Out-Null

# Auto-migrate any existing extracted tree out of a space-containing path (instant same-volume NTFS move)
if (($SrcDir -ne $LegacySrcDir) -and (-not (Test-Path $SrcDir)) -and (Test-Path (Join-Path $LegacySrcDir "mach"))) {
    Write-Host "[INFO] Moving extracted source tree to space-free path: $LegacySrcDir -> $SrcDir ..." -ForegroundColor Yellow
    Move-Item -Path $LegacySrcDir -Destination $SrcDir
}

Write-Host "=== Dragon Browser Gecko Source Fetcher (mozilla-esr153 / $($EsrVersion)esr) ===" -ForegroundColor Cyan

# 1. Validate / download source tarball
if (Test-Path $TarballPath) {
    $tarLen = (Get-Item $TarballPath).Length
    if ($tarLen -lt $MinTarBytes) {
        Write-Host "[WARN] Cached tarball is too small ($tarLen bytes) — removing and re-downloading..." -ForegroundColor Yellow
        Remove-Item -Force $TarballPath
    }
}

if (-not (Test-Path $TarballPath)) {
    Write-Host "[1/4] Downloading $SourceUrl -> $TarballPath ..."
    $PartPath = "$TarballPath.part"
    if (Test-Path $PartPath) { Remove-Item -Force $PartPath }

    $curlCmd = Get-Command "curl.exe" -ErrorAction SilentlyContinue
    if ($curlCmd) {
        & $curlCmd.Source -fL --retry 3 --progress-bar -o $PartPath $SourceUrl
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe download failed with exit code $LASTEXITCODE"
        }
    } else {
        Invoke-WebRequest -Uri $SourceUrl -OutFile $PartPath -UseBasicParsing
    }

    if (-not (Test-Path $PartPath) -or ((Get-Item $PartPath).Length -lt $MinTarBytes)) {
        throw "Downloaded source archive looks incomplete or corrupt: $PartPath"
    }
    Move-Item -Force -Path $PartPath -Destination $TarballPath
} else {
    Write-Host "[1/4] Found cached source tarball at $TarballPath"
}

# 2. Validate / extract source tree cleanly
$MarkerFile   = Join-Path $SrcDir ".dragon-extracted-ok"
$MachFile     = Join-Path $SrcDir "mach"
$AppConstFile = Join-Path $SrcDir "toolkit\modules\AppConstants.sys.mjs"

if ((Test-Path $MarkerFile) -and (Test-Path $MachFile) -and (Test-Path $AppConstFile)) {
    Write-Host "[2/4] Verified extracted source tree at $SrcDir"
} elseif ((Test-Path $MachFile) -and (Test-Path $AppConstFile)) {
    Write-Host "[2/4] Existing source tree verified at $SrcDir — writing extraction marker"
    Set-Content -Path $MarkerFile -Value "ok" -Encoding ASCII
} else {
    if (Test-Path $SrcDir) {
        Write-Host "[WARN] Incomplete source tree detected at $SrcDir — cleaning up before re-extraction..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $SrcDir
    }
    Write-Host "[2/4] Extracting $TarballPath into $SrcParent ..."
    $tarCmd = Get-Command "tar.exe" -ErrorAction SilentlyContinue
    if ($tarCmd) {
        & $tarCmd.Source -xJf $TarballPath -C $SrcParent
        if ($LASTEXITCODE -ne 0) {
            throw "tar.exe extraction failed with exit code $LASTEXITCODE"
        }
    } else {
        $sevenZip = Get-Command "7z.exe" -ErrorAction SilentlyContinue
        if (-not $sevenZip -and (Test-Path (Join-Path $env:ProgramFiles "7-Zip\7z.exe"))) {
            $sevenZip = Get-Item (Join-Path $env:ProgramFiles "7-Zip\7z.exe")
        }
        if (-not $sevenZip) {
            throw "Neither tar.exe nor 7z.exe is available to extract $TarballPath"
        }
        $tempTar = Join-Path $CacheDir "firefox-$($EsrVersion)esr.source.tar"
        & $sevenZip.FullName x $TarballPath "-o$CacheDir" -y
        if ($LASTEXITCODE -ne 0) { throw "7z xz decompression failed" }
        & $sevenZip.FullName x $tempTar "-o$SrcParent" -y
        if ($LASTEXITCODE -ne 0) { throw "7z tar extraction failed" }
        if (Test-Path $tempTar) { Remove-Item -Force $tempTar }
    }

    if (-not (Test-Path $MachFile) -or -not (Test-Path $AppConstFile)) {
        throw "Source extraction finished but expected files (mach / AppConstants.sys.mjs) are missing in $SrcDir"
    }
    Set-Content -Path $MarkerFile -Value "ok" -Encoding ASCII
}

# 3. Ensure generated Dragon branding assets exist
$PrivTile = Join-Path $RepoRoot "engine\branding\dragon\PrivateBrowsing_150.png"
$GenAssetsScript = Join-Path $ScriptDir "generate-branding-assets.py"
if ((Test-Path $GenAssetsScript) -and (-not (Test-Path $PrivTile))) {
    Write-Host "[3/4] Generating Dragon branding assets..."
    & $PythonExe $GenAssetsScript
    if ($LASTEXITCODE -ne 0) {
        throw "generate-branding-assets.py failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "[3/4] Dragon branding assets present."
}

# 4. Apply & verify Dragon Browser source overlay
Write-Host "[4/4] Applying Dragon Browser overlay and patches (target=$Target) ..."
& $PythonExe (Join-Path $ScriptDir "apply-overlay.py") --src-dir $SrcDir --target $Target --apply --verify
if ($LASTEXITCODE -ne 0) {
    throw "apply-overlay.py failed with exit code $LASTEXITCODE"
}

Write-Host "[OK] Dragon Browser Gecko ESR $EsrVersion source tree is ready at: $SrcDir" -ForegroundColor Green
