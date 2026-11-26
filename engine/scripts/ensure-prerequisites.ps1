# =============================================================================
# Dragon Browser — Windows Prerequisite Checker & Auto-Installer
# Verifies (and optionally auto-installs) every tool required to fetch, patch,
# and compile mozilla-esr153 on Windows x64.
# =============================================================================
[CmdletBinding()]
param(
    [ValidateSet("Fetch", "Build")]
    [string]$Mode = "Build",
    [switch]$NoAutoInstall,
    [string]$TargetDrivePath = "",
    [string]$MozillaBuildShell = "C:\mozilla-build\start-shell.bat"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EngineDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $EngineDir
if ([string]::IsNullOrWhiteSpace($TargetDrivePath)) {
    $TargetDrivePath = $RepoRoot
}

$script:CheckResults = New-Object System.Collections.Generic.List[object]

function Add-CheckResult {
    param([string]$Name, [string]$Status, [string]$Detail)
    $script:CheckResults.Add([PSCustomObject]@{
        Name   = $Name
        Status = $Status
        Detail = $Detail
    })
    $color = switch ($Status) {
        "OK"        { "Green" }
        "INSTALLED" { "Cyan" }
        "WARN"      { "Yellow" }
        default     { "Red" }
    }
    Write-Host ("  [{0,-9}] {1}: {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
}

function Refresh-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
    $candidates  = @()
    foreach ($p in @($machinePath, $userPath, $env:Path)) {
        if (-not [string]::IsNullOrWhiteSpace($p)) {
            $candidates += ($p -split ";")
        }
    }
    $extraDirs = @(
        (Join-Path $env:USERPROFILE ".cargo\bin"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"),
        "C:\mozilla-build\python3",
        "C:\mozilla-build\bin",
        (Join-Path $env:ProgramFiles "Git\cmd"),
        (Join-Path $env:ProgramFiles "7-Zip"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\Scripts"),
        (Join-Path $env:ProgramFiles "Python312"),
        (Join-Path $env:ProgramFiles "Python312\Scripts")
    )
    $candidates = $extraDirs + $candidates
    $seen = @{}
    $final = New-Object System.Collections.Generic.List[string]
    foreach ($dir in $candidates) {
        $trimmed = $dir.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        $key = $trimmed.ToLowerInvariant()
        if (-not $seen.ContainsKey($key) -and (Test-Path $trimmed)) {
            $seen[$key] = $true
            $final.Add($trimmed)
        }
    }
    $env:Path = ($final -join ";")
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($id)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Find-RealPython {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("python3", "python")) {
        $cmds = Get-Command $name -All -ErrorAction SilentlyContinue
        foreach ($c in $cmds) {
            if ($c.Source) { $candidates.Add($c.Source) }
        }
    }
    $searchGlobs = @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "C:\mozilla-build\python3\python3.exe",
        "C:\Python3*\python.exe"
    )
    foreach ($glob in $searchGlobs) {
        Get-Item $glob -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }
    }

    $seen = @{}
    foreach ($exe in $candidates) {
        if ([string]::IsNullOrWhiteSpace($exe)) { continue }
        if ($exe -match "\\WindowsApps\\python[^\\]*\.exe$") { continue }
        $key = $exe.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (-not (Test-Path $exe)) { continue }
        try {
            $ver = & $exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver -match "^3\.") {
                return [PSCustomObject]@{ Exe = $exe; Args = @(); Version = $ver.Trim() }
            }
        } catch {}
    }

    $pyLauncher = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        try {
            $ver = & $pyLauncher.Source -3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver -match "^3\.") {
                return [PSCustomObject]@{ Exe = $pyLauncher.Source; Args = @("-3"); Version = $ver.Trim() }
            }
        } catch {}
    }
    return $null
}

function Install-ViaWinget {
    param(
        [string]$PackageId,
        [string]$OverrideArgs = ""
    )
    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) {
        return $false
    }
    $argList = @(
        "install", "-e", "--id", $PackageId,
        "--accept-package-agreements", "--accept-source-agreements"
    )
    if (-not [string]::IsNullOrWhiteSpace($OverrideArgs)) {
        $argList += @("--override", $OverrideArgs)
    } else {
        $argList += "--silent"
    }
    Write-Host "    Running: winget $($argList -join ' ')" -ForegroundColor DarkGray
    & $winget.Source @argList
    return ($LASTEXITCODE -eq 0)
}

function Find-VsBuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        return $null
    }
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($vsPath)) {
        $atlmfc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.ATLMFC -property installationPath 2>$null
        return [PSCustomObject]@{
            InstallPath = ($vsPath | Select-Object -First 1).Trim()
            HasAtlMfc   = ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($atlmfc))
        }
    }
    return $null
}

Write-Host "=== Dragon Browser Prerequisite Check (Mode=$Mode, AutoInstall=$(-not $NoAutoInstall)) ===" -ForegroundColor Cyan
Refresh-SessionPath

# 1. Disk space check
$driveRoot = [System.IO.Path]::GetPathRoot((Resolve-Path $TargetDrivePath).Path)
$driveInfo = [System.IO.DriveInfo]::new($driveRoot)
$freeGb    = [Math]::Round($driveInfo.AvailableFreeSpace / 1GB, 1)
$minGb     = if ($Mode -eq "Build") { 40 } else { 5 }
if ($freeGb -lt $minGb) {
    Add-CheckResult "Disk Space ($driveRoot)" "FAIL" "$freeGb GB free; at least $minGb GB required"
    throw "Insufficient free disk space on $driveRoot ($freeGb GB free, $minGb GB required for Mode=$Mode)."
}
Add-CheckResult "Disk Space ($driveRoot)" "OK" "$freeGb GB free (required >= $minGb GB)"

# 2. Windows Long Paths
try {
    $fsRegPath = "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem"
    $longPaths = (Get-ItemProperty -Path $fsRegPath -Name "LongPathsEnabled" -ErrorAction SilentlyContinue).LongPathsEnabled
    if ($longPaths -eq 1) {
        Add-CheckResult "Windows Long Paths" "OK" "LongPathsEnabled=1"
    } elseif ((Test-IsAdmin) -and (-not $NoAutoInstall)) {
        Set-ItemProperty -Path $fsRegPath -Name "LongPathsEnabled" -Type DWord -Value 1
        Add-CheckResult "Windows Long Paths" "INSTALLED" "Enabled LongPathsEnabled=1 in registry"
    } else {
        Add-CheckResult "Windows Long Paths" "WARN" "LongPathsEnabled=$longPaths (not Admin; short junction path protects builds, or enable as Admin)"
    }
} catch {
    Add-CheckResult "Windows Long Paths" "WARN" "Could not inspect LongPathsEnabled ($($_.Exception.Message))"
}

# 3. Python 3
$pyInfo = Find-RealPython
if (-not $pyInfo) {
    if ($NoAutoInstall) {
        Add-CheckResult "Python 3" "FAIL" "Python 3 not found (skipping WindowsApps stub) and -NoAutoInstall set"
        throw "Python 3 is required."
    }
    Write-Host "  Python 3 missing — installing Python 3.12..." -ForegroundColor Yellow
    $installedPy = Install-ViaWinget -PackageId "Python.Python.3.12"
    if (-not $installedPy) {
        $pyInstaller = Join-Path $env:TEMP "python-3.12.7-amd64.exe"
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" -OutFile $pyInstaller -UseBasicParsing
        $proc = Start-Process -Wait -PassThru -FilePath $pyInstaller -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0"
        if ($proc.ExitCode -ne 0) {
            throw "Python 3 installer failed with exit code $($proc.ExitCode)"
        }
    }
    Refresh-SessionPath
    $pyInfo = Find-RealPython
    if (-not $pyInfo) {
        Add-CheckResult "Python 3" "FAIL" "Installation finished but python3 was still not found"
        throw "Python 3 installation could not be verified."
    }
    Add-CheckResult "Python 3" "INSTALLED" "Python $($pyInfo.Version) at $($pyInfo.Exe)"
} else {
    Add-CheckResult "Python 3" "OK" "Python $($pyInfo.Version) at $($pyInfo.Exe)"
}

# 4. Archive extraction (tar.exe / 7z.exe)
$tarCmd = Get-Command "tar.exe" -ErrorAction SilentlyContinue
$sevenZipCmd = Get-Command "7z.exe" -ErrorAction SilentlyContinue
if (-not $sevenZipCmd -and (Test-Path (Join-Path $env:ProgramFiles "7-Zip\7z.exe"))) {
    $sevenZipCmd = Get-Item (Join-Path $env:ProgramFiles "7-Zip\7z.exe")
}
$tarOk = $false
if ($tarCmd) {
    & $tarCmd.Source --version *> $null
    if ($LASTEXITCODE -eq 0) { $tarOk = $true }
}
if ($tarOk) {
    Add-CheckResult "Archive Tools" "OK" "tar.exe available at $($tarCmd.Source)"
} elseif ($sevenZipCmd) {
    Add-CheckResult "Archive Tools" "OK" "7z.exe available"
} else {
    if ($NoAutoInstall) {
        Add-CheckResult "Archive Tools" "FAIL" "Neither tar.exe nor 7z.exe found"
        throw "tar.exe or 7z.exe is required."
    }
    Write-Host "  Archive extractor missing — installing 7-Zip..." -ForegroundColor Yellow
    if (-not (Install-ViaWinget -PackageId "7zip.7zip")) {
        throw "Failed to install 7zip.7zip via winget."
    }
    Refresh-SessionPath
    Add-CheckResult "Archive Tools" "INSTALLED" "Installed 7zip.7zip"
}

if ($Mode -eq "Build") {
    # 5. Git
    $gitCmd = Get-Command "git.exe" -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        if ($NoAutoInstall) {
            Add-CheckResult "Git" "FAIL" "git.exe not found"
            throw "Git is required for building Gecko."
        }
        Write-Host "  Git missing — installing Git.Git..." -ForegroundColor Yellow
        if (-not (Install-ViaWinget -PackageId "Git.Git")) {
            throw "Failed to install Git.Git via winget."
        }
        Refresh-SessionPath
        $gitCmd = Get-Command "git.exe" -ErrorAction SilentlyContinue
        if (-not $gitCmd) {
            throw "Git installation completed but git.exe is still missing from PATH."
        }
        Add-CheckResult "Git" "INSTALLED" "$($gitCmd.Source)"
    } else {
        Add-CheckResult "Git" "OK" "$($gitCmd.Source)"
    }

    # 6. MozillaBuild 4.1+
    if (-not (Test-Path $MozillaBuildShell)) {
        if ($NoAutoInstall) {
            Add-CheckResult "MozillaBuild" "FAIL" "Missing $MozillaBuildShell"
            throw "MozillaBuild is required at $MozillaBuildShell."
        }
        Write-Host "  MozillaBuild missing — installing MozillaBuild..." -ForegroundColor Yellow
        $mbInstalled = Install-ViaWinget -PackageId "Mozilla.MozillaBuild"
        if (-not (Test-Path $MozillaBuildShell)) {
            $mbExe = Join-Path $env:TEMP "MozillaBuildSetup-Latest.exe"
            Invoke-WebRequest -Uri "https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe" -OutFile $mbExe -UseBasicParsing
            $proc = Start-Process -Wait -PassThru -FilePath $mbExe -ArgumentList "/S"
            if ($proc.ExitCode -ne 0) {
                throw "MozillaBuildSetup-Latest.exe failed with exit code $($proc.ExitCode)"
            }
        }
        if (-not (Test-Path $MozillaBuildShell)) {
            Add-CheckResult "MozillaBuild" "FAIL" "Still missing $MozillaBuildShell after installation"
            throw "MozillaBuild installation failed: $MozillaBuildShell not found."
        }
        Add-CheckResult "MozillaBuild" "INSTALLED" "$MozillaBuildShell"
    } else {
        Add-CheckResult "MozillaBuild" "OK" "$MozillaBuildShell"
    }

    # 7. Visual Studio 2022 Build Tools (Desktop C++ + Windows SDK + ATL/MFC)
    $vsInfo = Find-VsBuildTools
    if (-not $vsInfo) {
        if ($NoAutoInstall) {
            Add-CheckResult "VS C++ Build Tools" "FAIL" "VC.Tools.x86.x64 not found via vswhere.exe"
            throw "Visual Studio 2022 Build Tools (C++ workload + Windows SDK + ATL/MFC) is required."
        }
        Write-Host "  Visual Studio C++ Build Tools missing — installing VS 2022 Build Tools (this may take several minutes)..." -ForegroundColor Yellow
        $vsOverride = "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.VC.ATLMFC"
        $null = Install-ViaWinget -PackageId "Microsoft.VisualStudio.2022.BuildTools" -OverrideArgs $vsOverride
        Refresh-SessionPath
        $vsInfo = Find-VsBuildTools
        if (-not $vsInfo) {
            Add-CheckResult "VS C++ Build Tools" "FAIL" "VC.Tools.x86.x64 still not detected after install"
            throw "Visual Studio 2022 Build Tools installation could not be verified."
        }
        Add-CheckResult "VS C++ Build Tools" "INSTALLED" "$($vsInfo.InstallPath) (ATLMFC=$($vsInfo.HasAtlMfc))"
    } elseif (-not $vsInfo.HasAtlMfc -and (-not $NoAutoInstall)) {
        Add-CheckResult "VS C++ Build Tools" "WARN" "$($vsInfo.InstallPath) found, attempting to add VC.ATLMFC component..."
        $vsInstaller = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\setup.exe"
        if (Test-Path $vsInstaller) {
            $proc = Start-Process -Wait -PassThru -FilePath $vsInstaller -ArgumentList "modify --installPath `"$($vsInfo.InstallPath)`" --add Microsoft.VisualStudio.Component.VC.ATLMFC --quiet --norestart"
            if ($proc.ExitCode -eq 0) {
                Add-CheckResult "VS ATL/MFC" "INSTALLED" "Added Microsoft.VisualStudio.Component.VC.ATLMFC"
            }
        }
    } else {
        Add-CheckResult "VS C++ Build Tools" "OK" "$($vsInfo.InstallPath) (ATLMFC=$($vsInfo.HasAtlMfc))"
    }

    # 8. Rust (rustup + cargo) + x86_64-pc-windows-msvc target
    $cargoCmd  = Get-Command "cargo.exe" -ErrorAction SilentlyContinue
    $rustupCmd = Get-Command "rustup.exe" -ErrorAction SilentlyContinue
    if (-not $cargoCmd -or -not $rustupCmd) {
        if ($NoAutoInstall) {
            Add-CheckResult "Rust Toolchain" "FAIL" "cargo.exe / rustup.exe not found"
            throw "Rust (rustup + cargo) is required."
        }
        Write-Host "  Rust missing — installing rustup (x86_64-pc-windows-msvc)..." -ForegroundColor Yellow
        $rustupInit = Join-Path $env:TEMP "rustup-init.exe"
        Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupInit -UseBasicParsing
        $proc = Start-Process -Wait -NoNewWindow -PassThru -FilePath $rustupInit -ArgumentList "-y --default-host x86_64-pc-windows-msvc"
        if ($proc.ExitCode -ne 0) {
            throw "rustup-init.exe failed with exit code $($proc.ExitCode)"
        }
        Refresh-SessionPath
        $cargoCmd  = Get-Command "cargo.exe" -ErrorAction SilentlyContinue
        $rustupCmd = Get-Command "rustup.exe" -ErrorAction SilentlyContinue
        if (-not $cargoCmd -or -not $rustupCmd) {
            throw "Rust installation completed but cargo.exe/rustup.exe not found in PATH."
        }
        & $rustupCmd.Source target add x86_64-pc-windows-msvc | Out-Null
        $rustcVer = (& rustc.exe --version 2>$null)
        Add-CheckResult "Rust Toolchain" "INSTALLED" "$rustcVer"
    } else {
        $installedTargets = (& $rustupCmd.Source target list --installed 2>$null)
        if ($installedTargets -notcontains "x86_64-pc-windows-msvc" -and (-not $NoAutoInstall)) {
            & $rustupCmd.Source target add x86_64-pc-windows-msvc | Out-Null
        }
        $rustcVer = (& rustc.exe --version 2>$null)
        Add-CheckResult "Rust Toolchain" "OK" "$rustcVer (x86_64-pc-windows-msvc ready)"
    }
}

Write-Host "[OK] All prerequisites for Mode=$Mode verified." -ForegroundColor Green
