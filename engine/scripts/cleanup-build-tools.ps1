# =============================================================================
# Dragon Browser — Post-Build Cleanup & Build Toolchain Uninstaller (Windows)
# Removes temporary Gecko source/object/cache trees and build toolchains that
# are no longer needed once dist\dragon-browser.exe and dist\runtime\dragon.exe
# are built. NEVER touches dist\.
# =============================================================================
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$KeepBuildTools,
    [switch]$KeepRust,
    [switch]$RemoveGit,
    [switch]$RemoveRepoTarget,
    [string]$BuildRoot = "C:\dragon-build"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EngineDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $EngineDir
$DistDir   = Join-Path $RepoRoot "dist"

$LauncherExe = Join-Path $DistDir "dragon-browser.exe"
$EngineExe   = Join-Path (Join-Path $DistDir "runtime") "dragon.exe"

function Get-DriveFreeBytes {
    param([string]$DriveLetter = "C:\")
    $root = [System.IO.Path]::GetPathRoot($DriveLetter)
    return ([System.IO.DriveInfo]::new($root)).AvailableFreeSpace
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ("{0:N2} GB" -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ("{0:N1} MB" -f ($Bytes / 1MB)) }
    return ("{0:N0} KB" -f ($Bytes / 1KB))
}

function Remove-TreeSafely {
    param(
        [string]$PathToRemove,
        [string]$Label
    )
    if ([string]::IsNullOrWhiteSpace($PathToRemove)) { return }
    if (-not (Test-Path -LiteralPath $PathToRemove)) {
        Write-Host ("  [SKIP] {0}: not present ({1})" -f $Label, $PathToRemove) -ForegroundColor DarkGray
        return
    }

    $resolvedTarget = (Resolve-Path -LiteralPath $PathToRemove).Path.TrimEnd("\")
    $resolvedDist   = (Resolve-Path -LiteralPath $DistDir).Path.TrimEnd("\")
    $driveRoot      = ([System.IO.Path]::GetPathRoot($resolvedTarget)).TrimEnd("\")

    if (($resolvedTarget -ieq $driveRoot) -or
        ($resolvedTarget -ieq $resolvedDist) -or
        ($resolvedTarget.StartsWith($resolvedDist + "\", [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to remove protected path: $resolvedTarget"
    }

    if ($DryRun) {
        Write-Host ("  [DRY-RUN] Would remove {0}: {1}" -f $Label, $resolvedTarget) -ForegroundColor Yellow
        return
    }

    $item = Get-Item -LiteralPath $resolvedTarget -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Write-Host ("  [REMOVE] Unlinking junction {0}: {1}" -f $Label, $resolvedTarget) -ForegroundColor Cyan
        & cmd.exe /c "rmdir `"$resolvedTarget`""
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("  [WARN] Could not unlink junction {0} (exit {1})" -f $resolvedTarget, $LASTEXITCODE) -ForegroundColor Yellow
        }
        return
    }

    Write-Host ("  [REMOVE] Deleting {0}: {1} ..." -f $Label, $resolvedTarget) -ForegroundColor Cyan
    & cmd.exe /c "rmdir /s /q `"$resolvedTarget`""
    if (Test-Path -LiteralPath $resolvedTarget) {
        Write-Host ("  [WARN] Some files may remain in {0} (check if locked by another process)." -f $resolvedTarget) -ForegroundColor Yellow
    } else {
        Write-Host ("  [OK]   Removed {0}" -f $Label) -ForegroundColor Green
    }
}

function Remove-FileSafely {
    param([string]$FilePath, [string]$Label)
    if (-not (Test-Path -LiteralPath $FilePath)) { return }
    if ($DryRun) {
        Write-Host ("  [DRY-RUN] Would remove {0}: {1}" -f $Label, $FilePath) -ForegroundColor Yellow
        return
    }
    Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
    Write-Host ("  [OK]   Removed {0}: {1}" -f $Label, $FilePath) -ForegroundColor Green
}

function Invoke-WingetUninstall {
    param([string]$PackageId, [string]$DisplayName)
    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }

    # Check if installed first to avoid noisy errors
    $listOut = & $winget.Source list --exact --id $PackageId --accept-source-agreements 2>$null
    if ($LASTEXITCODE -ne 0 -or (($listOut -join "`n") -notmatch [regex]::Escape($PackageId))) {
        return $false
    }

    if ($DryRun) {
        Write-Host ("  [DRY-RUN] Would uninstall via winget: {0} ({1})" -f $DisplayName, $PackageId) -ForegroundColor Yellow
        return $true
    }

    Write-Host ("  [UNINSTALL] Removing {0} via winget ({1})..." -f $DisplayName, $PackageId) -ForegroundColor Cyan
    & $winget.Source uninstall -e --id $PackageId --silent --accept-source-agreements
    return ($LASTEXITCODE -eq 0)
}

Write-Host "=== Dragon Browser Post-Build Cleanup ===" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "  Mode: DRY-RUN (no files or programs will be modified)" -ForegroundColor Yellow
}

# 1. Verify standalone browser is intact and guarantee dist\ stays untouched
if (-not (Test-Path -LiteralPath $LauncherExe) -or -not (Test-Path -LiteralPath $EngineExe)) {
    throw "Refusing cleanup: finished Dragon Browser binaries missing under $DistDir ($LauncherExe / $EngineExe)."
}
Write-Host ("  [SAFE] Standalone Dragon Browser verified at: {0}" -f $DistDir) -ForegroundColor Green
Write-Host "  [SAFE] dist\ will NOT be touched." -ForegroundColor Green

$StartFreeBytes = Get-DriveFreeBytes "C:\"

# 2. Clean temporary build directories, caches, and bootstrap artifacts
Write-Host "`n[1/3] Removing temporary Gecko build files and caches..." -ForegroundColor Cyan
Remove-TreeSafely -PathToRemove $BuildRoot -Label "Gecko source & obj-dragon tree"
Remove-TreeSafely -PathToRemove (Join-Path $EngineDir "cache") -Label "Gecko source tarball cache"
Remove-TreeSafely -PathToRemove (Join-Path $EngineDir "src") -Label "Legacy engine/src directory"
Remove-TreeSafely -PathToRemove (Join-Path $env:USERPROFILE ".mozbuild") -Label "MozillaBuild bootstrap cache (.mozbuild)"

foreach ($tmpName in @("MozillaBuildSetup-Latest.exe", "rustup-init.exe", "python-3.12.7-amd64.exe")) {
    Remove-FileSafely -FilePath (Join-Path $env:TEMP $tmpName) -Label "Temp installer"
}

if ($RemoveRepoTarget) {
    Remove-TreeSafely -PathToRemove (Join-Path $RepoRoot "target") -Label "Rust launcher target/ build cache"
} else {
    Write-Host ("  [KEEP] Rust launcher target/ kept (pass -RemoveRepoTarget to delete it too).") -ForegroundColor DarkGray
}

# 3. Uninstall build toolchains (unless -KeepBuildTools)
Write-Host "`n[2/3] Cleaning up build toolchains..." -ForegroundColor Cyan
if ($KeepBuildTools) {
    Write-Host "  [KEEP] -KeepBuildTools set; skipping MozillaBuild, VS Build Tools, and Rust uninstalls." -ForegroundColor DarkGray
} else {
    # MozillaBuild
    $mbRemoved = Invoke-WingetUninstall -PackageId "Mozilla.MozillaBuild" -DisplayName "MozillaBuild"
    $mbDir = "C:\mozilla-build"
    $mbUninst = Join-Path $mbDir "uninstall.exe"
    if (Test-Path -LiteralPath $mbUninst) {
        if ($DryRun) {
            Write-Host ("  [DRY-RUN] Would run {0} /S" -f $mbUninst) -ForegroundColor Yellow
        } else {
            Write-Host "  [UNINSTALL] Running MozillaBuild uninstaller..." -ForegroundColor Cyan
            $proc = Start-Process -Wait -PassThru -FilePath $mbUninst -ArgumentList "/S"
            if ($proc.ExitCode -ne 0) {
                Write-Host ("  [WARN] MozillaBuild uninstall.exe returned exit code {0}" -f $proc.ExitCode) -ForegroundColor Yellow
            }
        }
    }
    if (Test-Path -LiteralPath $mbDir) {
        Remove-TreeSafely -PathToRemove $mbDir -Label "MozillaBuild directory"
    } elseif (-not $mbRemoved) {
        Write-Host "  [SKIP] MozillaBuild: not present" -ForegroundColor DarkGray
    }

    # Visual Studio 2022 Build Tools
    $vsUninstalled = Invoke-WingetUninstall -PackageId "Microsoft.VisualStudio.2022.BuildTools" -DisplayName "Visual Studio 2022 Build Tools"
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    $vsSetup = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\setup.exe"
    if (Test-Path -LiteralPath $vswhere) {
        $btPaths = & $vswhere -products Microsoft.VisualStudio.Product.BuildTools -property installationPath 2>$null
        foreach ($btPath in $btPaths) {
            $trimmedPath = $btPath.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmedPath)) { continue }
            if ($DryRun) {
                Write-Host ("  [DRY-RUN] Would run VS Installer uninstall for: {0}" -f $trimmedPath) -ForegroundColor Yellow
            } elseif (Test-Path -LiteralPath $vsSetup) {
                Write-Host ("  [UNINSTALL] Uninstalling VS Build Tools at {0} ..." -f $trimmedPath) -ForegroundColor Cyan
                $proc = Start-Process -Wait -PassThru -FilePath $vsSetup -ArgumentList "uninstall --installPath `"$trimmedPath`" --quiet --norestart"
                if ($proc.ExitCode -eq 0) {
                    Write-Host "  [OK]   Visual Studio Build Tools uninstalled." -ForegroundColor Green
                } else {
                    Write-Host ("  [WARN] VS Build Tools uninstaller exited with code {0}" -f $proc.ExitCode) -ForegroundColor Yellow
                }
            }
        }
    } elseif (-not $vsUninstalled) {
        Write-Host "  [SKIP] Visual Studio Build Tools: not detected" -ForegroundColor DarkGray
    }

    # Rust toolchain
    if ($KeepRust) {
        Write-Host "  [KEEP] -KeepRust set; leaving Rust toolchain installed." -ForegroundColor DarkGray
    } else {
        $rustupExe = Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe"
        if (-not (Test-Path -LiteralPath $rustupExe)) {
            $rustupCmd = Get-Command "rustup.exe" -ErrorAction SilentlyContinue
            if ($rustupCmd) { $rustupExe = $rustupCmd.Source }
        }
        if (Test-Path -LiteralPath $rustupExe) {
            if ($DryRun) {
                Write-Host ("  [DRY-RUN] Would run: {0} self uninstall -y" -f $rustupExe) -ForegroundColor Yellow
            } else {
                Write-Host "  [UNINSTALL] Running rustup self uninstall -y ..." -ForegroundColor Cyan
                & $rustupExe self uninstall -y
            }
        }
        Remove-TreeSafely -PathToRemove (Join-Path $env:USERPROFILE ".rustup") -Label "Rustup toolchain cache (.rustup)"
        Remove-TreeSafely -PathToRemove (Join-Path $env:USERPROFILE ".cargo") -Label "Cargo cache (.cargo)"
    }

    # Git (opt-in only)
    if ($RemoveGit) {
        $null = Invoke-WingetUninstall -PackageId "Git.Git" -DisplayName "Git for Windows"
    } else {
        Write-Host "  [KEEP] Git left installed (pass -RemoveGit if you want to uninstall Git.Git too)." -ForegroundColor DarkGray
    }

    Write-Host "  [KEEP] Pre-existing Windows Python left untouched. If Python 3.12 was auto-installed and unwanted, run:" -ForegroundColor DarkGray
    Write-Host "         winget uninstall -e --id Python.Python.3.12" -ForegroundColor DarkGray
}

# 4. Verify Dragon Browser is still HEALTHY and report space reclaimed
Write-Host "`n[3/3] Verifying standalone Dragon Browser health (--doctor)..." -ForegroundColor Cyan
& $LauncherExe --doctor
if ($LASTEXITCODE -ne 0) {
    throw "Dragon Browser --doctor reported an error (exit code $LASTEXITCODE)."
}

$EndFreeBytes = Get-DriveFreeBytes "C:\"
$Reclaimed    = [Math]::Max(0, $EndFreeBytes - $StartFreeBytes)
Write-Host ""
if ($DryRun) {
    Write-Host "[OK] Dry-run complete. Re-run without -DryRun to apply cleanup." -ForegroundColor Green
} else {
    Write-Host ("[OK] Cleanup complete! Reclaimed {0} on C:\ (now {1} free)." -f (Format-Size $Reclaimed), (Format-Size $EndFreeBytes)) -ForegroundColor Green
}
