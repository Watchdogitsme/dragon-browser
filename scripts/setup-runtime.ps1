<#
.SYNOPSIS
    Downloads and installs the portable Mozilla Firefox ESR Win64 runtime for Dragon Browser.

.DESCRIPTION
    Fetches the official Mozilla Firefox ESR Win64 installer, extracts it into .\runtime
    (via 7z.exe when available, or Mozilla's official silent portable installer flags),
    strips unnecessary telemetry/updater bloat binaries, and verifies runtime\firefox.exe.
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [ValidateSet("esr", "release")]
    [string]$Channel = "esr",
    [string]$TargetDir = (Join-Path $PSScriptRoot "runtime")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProductSlug = if ($Channel -eq "release") { "firefox-latest-ssl" } else { "firefox-esr-latest-ssl" }
$DownloadUrl = "https://download.mozilla.org/?product=$ProductSlug&os=win64&lang=en-US"
if ([System.IO.Path]::IsPathRooted($TargetDir)) {
    $RuntimeDir = [System.IO.Path]::GetFullPath($TargetDir)
}
else {
    $RuntimeDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $TargetDir))
}
$FirefoxExe = Join-Path $RuntimeDir "firefox.exe"
$DragonExe  = Join-Path $RuntimeDir "dragon.exe"
$DragonExe  = Join-Path $RuntimeDir "dragon.exe"

$BloatBinaries = @(
    "updater.exe",
    "maintenanceservice.exe",
    "maintenanceservice_installer.exe",
    "crashreporter.exe",
    "pingsender.exe",
    "default-browser-agent.exe",
    "crashhelper.exe",
    "private_browsing.exe",
    "firefox.exe.sig",
    "xul.dll.sig",
    "plugin-container.exe.sig",
    "mozwer.dll",
    "onnxruntime.dll",
    "mozinference.dll",
    "xpcshell.exe",
    "certutil.exe",
    "pk12util.exe",
    "updater.ini",
    "update-settings.ini",
    "precomplete",
    "removed-files",
    "browser\blank.pdf",
    "browser\confused_fox.pdf"
)

$BloatDirs = @(
    "uninstall",
    "desktop-launcher",
    "gmp-fake",
    "gmp-fakeopenh264"
)

function Remove-RuntimeBloat {
    param([string]$Dir)
    $removed = @()
    foreach ($bin in $BloatBinaries) {
        $path = Join-Path $Dir $bin
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
            $removed += $bin
        }
    }
    foreach ($d in $BloatDirs) {
        $dpath = Join-Path $Dir $d
        if (Test-Path -LiteralPath $dpath) {
            Remove-Item -LiteralPath $dpath -Recurse -Force -ErrorAction SilentlyContinue
            $removed += "$d/"
        }
    }
    if ($removed.Count -gt 0) {
        Write-Host "==> Stripped bloat items: $($removed -join ', ')" -ForegroundColor DarkGray
    }
}

function Find-SevenZip {
    $cmd = Get-Command "7z.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles "7-Zip\7z.exe"
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe"
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

if (((Test-Path -LiteralPath $DragonExe) -or (Test-Path -LiteralPath $FirefoxExe)) -and -not $Force) {
    Write-Host "Dragon Browser runtime is already installed at: $RuntimeDir" -ForegroundColor Green
    Remove-RuntimeBloat -Dir $RuntimeDir
    Write-Host "Use -Force to re-download and reinstall. Launch with: .\dragon-browser.exe"
    exit 0
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dragon-esr-" + [System.Guid]::NewGuid().ToString("N"))
$InstallerPath = Join-Path $TempRoot "Firefox-ESR-Win64-Setup.exe"
$ExtractStage = Join-Path $TempRoot "extract"

New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $prevProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Write-Host "==> Downloading official Mozilla Firefox ESR (Win64)..." -ForegroundColor Cyan
        Write-Host "    Source: $DownloadUrl" -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -UseBasicParsing
    }
    finally {
        $ProgressPreference = $prevProgress
    }

    if (-not (Test-Path -LiteralPath $InstallerPath) -or ((Get-Item -LiteralPath $InstallerPath).Length -lt 1MB)) {
        throw "Downloaded installer is missing or unexpectedly small."
    }

    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

    $SevenZip = Find-SevenZip
    $Extracted = $false

    if ($SevenZip) {
        Write-Host "==> Extracting runtime core via 7-Zip ($SevenZip)..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Path $ExtractStage -Force | Out-Null
        & $SevenZip x -y "-o$ExtractStage" "$InstallerPath" "core\*" | Out-Null
        $CoreDir = Join-Path $ExtractStage "core"
        if (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath (Join-Path $CoreDir "firefox.exe"))) {
            Get-ChildItem -LiteralPath $CoreDir -Force | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $RuntimeDir -Recurse -Force
            }
            $Extracted = $true
        }
        else {
            Write-Warning "7-Zip extraction did not produce core\firefox.exe; falling back to Mozilla silent installer."
        }
    }

    if (-not $Extracted) {
        Write-Host "==> Extracting portable runtime via Mozilla silent installer..." -ForegroundColor Cyan
        $InstallArgs = "/S /InstallDirectoryPath=`"$RuntimeDir`" /MaintenanceService=false /TaskbarShortcut=false /DesktopShortcut=false /StartMenuShortcut=false"
        $Proc = Start-Process -FilePath $InstallerPath -ArgumentList $InstallArgs -Wait -PassThru
        if ($Proc.ExitCode -ne 0) {
            throw "Mozilla silent installer exited with code $($Proc.ExitCode)."
        }
    }

    Remove-RuntimeBloat -Dir $RuntimeDir

    if (-not (Test-Path -LiteralPath $FirefoxExe)) {
        throw "Verification failed: expected '$FirefoxExe' was not found after extraction."
    }

    $FileInfo = Get-Item -LiteralPath $FirefoxExe
    Write-Host ""
    Write-Host "Dragon Browser runtime ready!" -ForegroundColor Green
    Write-Host "  Runtime path : $RuntimeDir"
    Write-Host "  Engine binary: $($FileInfo.FullName)"
    Write-Host ""
    Write-Host "Next step:" -ForegroundColor Cyan
    Write-Host "  .\dragon-browser.exe"
    Write-Host "  (Run .\dragon-browser.exe --doctor to verify bundle health)"
}
finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
