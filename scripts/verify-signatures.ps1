<#
.SYNOPSIS
    Audits Authenticode digital signatures across Dragon Browser binaries and installers.

.DESCRIPTION
    Checks every .exe and .dll in dist\ (launcher + runtime\ engine) and release\
    using PowerShell's Get-AuthenticodeSignature. Useful to verify Windows Smart App
    Control readiness locally and in CI.
#>
[CmdletBinding()]
param(
    [string]$DistDir = "",
    [string]$ReleaseDir = "",
    [switch]$Strict,
    [switch]$RuntimeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
if ([string]::IsNullOrWhiteSpace($DistDir)) {
    $DistDir = Join-Path $RepoRoot "dist"
}
if ([string]::IsNullOrWhiteSpace($ReleaseDir)) {
    $ReleaseDir = Join-Path $RepoRoot "release"
}

$Targets = New-Object System.Collections.Generic.List[System.IO.FileInfo]

if (-not $RuntimeOnly) {
    $LauncherExe = Join-Path $DistDir "dragon-browser.exe"
    if (Test-Path -LiteralPath $LauncherExe) {
        $Targets.Add((Get-Item -LiteralPath $LauncherExe))
    }
    $StubExe = Join-Path (Join-Path (Join-Path $RepoRoot "installer") "build") "dragon-installer-stub.exe"
    if (Test-Path -LiteralPath $StubExe) {
        $Targets.Add((Get-Item -LiteralPath $StubExe))
    }
    if (Test-Path -LiteralPath $ReleaseDir) {
        Get-ChildItem -LiteralPath $ReleaseDir -Filter "DragonBrowser-Setup-*-win64.exe" -File -ErrorAction SilentlyContinue | ForEach-Object {
            $Targets.Add($_)
        }
    }
}

$RuntimeDir = Join-Path $DistDir "runtime"
if (Test-Path -LiteralPath $RuntimeDir) {
    Get-ChildItem -LiteralPath $RuntimeDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
        ($_.Extension -ieq ".exe") -or ($_.Extension -ieq ".dll")
    } | Sort-Object FullName | ForEach-Object {
        $Targets.Add($_)
    }
}

if ($Targets.Count -eq 0) {
    throw "No Dragon Browser binaries found to audit under '$DistDir' or '$ReleaseDir'."
}

$ValidCount = 0
$UnsignedCount = 0
$InvalidCount = 0

Write-Host "=== Dragon Browser Authenticode Signature Audit ===" -ForegroundColor Cyan
foreach ($File in $Targets) {
    $Sig = Get-AuthenticodeSignature -LiteralPath $File.FullName
    $Status = [string]$Sig.Status
    $Signer = "UNSIGNED"
    if ($Sig.SignerCertificate) {
        $Subj = $Sig.SignerCertificate.Subject
        if ($Subj -match "CN=([^,]+)") {
            $Signer = $Matches[1].Trim('"')
        } else {
            $Signer = $Subj
        }
    }

    $Rel = $File.FullName
    if ($Rel.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $Rel = $Rel.Substring($RepoRoot.Length).TrimStart("\")
    }

    if ($Status -eq "Valid") {
        $ValidCount++
        Write-Host ("  [VALID]    {0,-30} {1}" -f $Signer, $Rel) -ForegroundColor Green
    } elseif ($Status -eq "NotSigned") {
        $UnsignedCount++
        Write-Host ("  [UNSIGNED] {0,-30} {1}" -f $Signer, $Rel) -ForegroundColor Yellow
    } else {
        $InvalidCount++
        Write-Host ("  [{0}] {1,-28} {2}" -f $Status.ToUpperInvariant(), $Signer, $Rel) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("Summary: {0} valid, {1} unsigned, {2} invalid/untrusted (total {3})" -f $ValidCount, $UnsignedCount, $InvalidCount, $Targets.Count) -ForegroundColor Cyan

if ($Strict -and (($UnsignedCount -gt 0) -or ($InvalidCount -gt 0))) {
    throw "Strict signature verification failed ($UnsignedCount unsigned, $InvalidCount invalid)."
}
