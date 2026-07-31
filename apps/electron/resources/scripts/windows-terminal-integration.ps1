param(
    [ValidateSet("Install", "Uninstall", "Validate")]
    [string]$Mode = "Install",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Polo AI",
    [string]$BinDir = "",
    [string]$UserPathFile = "",
    [switch]$SkipCommandConflict
)

$ErrorActionPreference = "Stop"
if (-not $BinDir) {
    $BinDir = "$env:LOCALAPPDATA\Polo AI\bin"
}

$launcher = Join-Path $BinDir "polo.cmd"
$legacyLauncher = Join-Path $BinDir "polo-ai.cmd"
$rootPointer = Join-Path $BinDir "polo-install-root.txt"
$stateFile = Join-Path $BinDir "terminal-integration.json"
$exePath = Join-Path $InstallDir "Polo AI.exe"
$bunPath = Join-Path $InstallDir "resources\vendor\bun\bun.exe"
$appRoot = Join-Path $InstallDir "resources\app"
$cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
$serverPath = Join-Path $appRoot "dist\server\polo-server.js"
$packagePath = Join-Path $appRoot "package.json"
$launcherTemplate = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\polo.cmd"
$legacyLauncherTemplate = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\polo-ai.cmd"

function Write-AtomicUtf8([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $temp = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
        Move-Item -Path $temp -Destination $Path -Force
    } finally {
        Remove-Item -Path $temp -Force -ErrorAction SilentlyContinue
    }
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Normalize-LineEndings([string]$Content) {
    return $Content.Replace("`r`n", "`n")
}

function Test-ExactContent([string]$Path, [string[]]$AllowedContents) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $actual = Normalize-LineEndings ([IO.File]::ReadAllText($Path))
    foreach ($allowed in $AllowedContents) {
        if ($actual -ceq (Normalize-LineEndings $allowed)) {
            return $true
        }
    }
    return $false
}

function Get-UserPath {
    if ($UserPathFile) {
        if (Test-Path $UserPathFile) {
            return Get-Content $UserPathFile -Raw
        }
        return ""
    }
    return [Environment]::GetEnvironmentVariable("Path", "User")
}

function Set-UserPath([string]$Value) {
    if ($UserPathFile) {
        Write-AtomicUtf8 $UserPathFile $Value
        return
    }
    [Environment]::SetEnvironmentVariable("Path", $Value, "User")
}

function Test-PathEntry([string[]]$Entries, [string]$Path) {
    return [bool]($Entries | Where-Object {
        $_ -and $_.Trim().TrimEnd("\") -ieq $Path.TrimEnd("\")
    } | Select-Object -First 1)
}

function Read-State {
    if (-not (Test-Path $stateFile)) {
        return $null
    }
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($state.schemaVersion -ne 1 -and $state.schemaVersion -ne 2) {
            return $null
        }
        return $state
    } catch {
        return $null
    }
}

function Get-StateFileRecord($State, [string]$Path) {
    if (-not $State -or $State.schemaVersion -ne 2 -or -not $State.files) {
        return $null
    }
    return $State.files | Where-Object {
        $_.path -and $_.path.TrimEnd("\") -ieq $Path.TrimEnd("\")
    } | Select-Object -First 1
}

function Test-StateOwnedFile($State, [string]$Path) {
    $record = Get-StateFileRecord $State $Path
    if (-not $record -or -not $record.sha256) {
        return $false
    }
    $actualHash = Get-Sha256 $Path
    return $actualHash -and $actualHash -ceq ([string]$record.sha256).ToLowerInvariant()
}

function Write-State([bool]$PathEntryAddedByPolo) {
    $files = @()
    foreach ($managedFile in @($launcher, $legacyLauncher, $rootPointer)) {
        $hash = Get-Sha256 $managedFile
        if ($hash) {
            $files += @{
                path = $managedFile
                sha256 = $hash
            }
        }
    }
    $state = @{
        schemaVersion = 2
        pathEntryAddedByPolo = $PathEntryAddedByPolo
        binDir = $BinDir
        files = $files
        updatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 4
    Write-AtomicUtf8 $stateFile $state
}

function Test-LegacyPoloLauncher {
    if (-not (Test-Path $legacyLauncher)) {
        return $false
    }
    try {
        # POO-14 replaces the pre-unified launcher created by install-app.ps1.
        # Match that exact two-line file so an unrelated polo-ai.cmd can never
        # transfer ownership of a user-created PATH entry to Polo.
        $expected = "@echo off`r`nstart `"`" `"$exePath`" %*"
        return (Test-ExactContent $legacyLauncher @($expected, "$expected`r`n"))
    } catch {
        return $false
    }
}

function Assert-PackagedArtifacts {
    foreach ($required in @(
        $exePath,
        $bunPath,
        $cliPath,
        $serverPath,
        $packagePath,
        $launcherTemplate,
        $legacyLauncherTemplate
    )) {
        if (-not (Test-Path $required)) {
            throw "Required Polo artifact not found: $required"
        }
    }
}

function Get-LauncherContent {
    return [IO.File]::ReadAllText($launcherTemplate)
}

function Get-LegacyShimContent {
    return [IO.File]::ReadAllText($legacyLauncherTemplate)
}

function Get-HistoricalLauncherAllowlist([string]$Path) {
    if ($Path.TrimEnd("\") -ieq $launcher.TrimEnd("\")) {
        # Exact POO-14 pre-template launcher. This allowlist is intentionally
        # generated from its old absolute layout and is only consulted when
        # ownership state is absent.
        $oldContent = @"
@echo off
chcp 65001 >nul 2>&1
setlocal
rem Polo CLI launcher (managed by Polo AI)
set "POLO_AI_BUN=$bunPath"
set "POLO_AI_SERVER_ENTRY=$serverPath"
set "POLO_AI_CLI_ENTRY=$cliPath"
set "POLO_AI_APP_ROOT=$appRoot"
set "POLO_AI_RESOURCES_PATH=$appRoot\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=$appRoot"
set "POLO_AI_DESKTOP_EXECUTABLE=$exePath"
set "POLO_AI_IS_PACKAGED=true"
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_RUNTIME=Error: Polo's bundled runtime is missing. Reinstall Polo."
set "POLO_MSG_FILES=Error: Polo terminal files are missing. Reinstall Polo."
if /I "%POLO_LOCALE:~0,2%"=="zh" (
  set "POLO_MSG_RUNTIME=错误：Polo 内置运行时缺失。请重新安装 Polo。"
  set "POLO_MSG_FILES=错误：Polo 终端文件缺失。请重新安装 Polo。"
)
if not exist "$bunPath" (
  echo [POLO_E_BUNDLED_RUNTIME_MISSING] %POLO_MSG_RUNTIME% 1>&2
  exit /b 1
)
if not exist "$cliPath" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)
if not exist "$serverPath" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)
if /I "%~1"=="app" (
  start "" "$exePath"
  exit /b 0
)
"$bunPath" run "$cliPath" %*
exit /b %ERRORLEVEL%
"@
        return @($oldContent, "$oldContent`r`n")
    }
    if ($Path.TrimEnd("\") -ieq $legacyLauncher.TrimEnd("\")) {
        $oldLocalizedShim = @"
@echo off
chcp 65001 >nul 2>&1
setlocal
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_DEPRECATED=Warning: 'polo-ai' is deprecated; use 'polo' instead."
if /I "%POLO_LOCALE:~0,2%"=="zh" set "POLO_MSG_DEPRECATED=警告：“polo-ai”已弃用；请改用“polo”。"
echo [POLO_W_DEPRECATED_COMMAND] %POLO_MSG_DEPRECATED% 1>&2
call "$launcher" %*
exit /b %ERRORLEVEL%
"@
        $previousShim = "@echo off`r`necho Warning: 'polo-ai' is deprecated; use 'polo' instead. 1>&2`r`ncall `"$launcher`" %*`r`nexit /b %ERRORLEVEL%"
        $oldGui = "@echo off`r`nstart `"`" `"$exePath`" %*"
        return @(
            $oldLocalizedShim,
            "$oldLocalizedShim`r`n",
            $previousShim,
            "$previousShim`r`n",
            $oldGui,
            "$oldGui`r`n"
        )
    }
    return @()
}

function Assert-FileOwnedForReplacement($State, [string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (Test-StateOwnedFile $State $Path) {
        return
    }
    if (Test-ExactContent $Path (Get-HistoricalLauncherAllowlist $Path)) {
        return
    }
    throw "Polo cannot replace $Path because it is modified or user-owned. Restore the managed file or remove it manually, then retry."
}

function Install-LauncherFiles([bool]$CheckCommandConflict, $PreviousState) {
    if ($CheckCommandConflict) {
        $existing = Get-Command polo -ErrorAction SilentlyContinue
        if ($existing -and $existing.Source.TrimEnd("\") -ine $launcher.TrimEnd("\")) {
            throw "Another command named polo already exists at $($existing.Source). Polo did not overwrite it."
        }
    }
    Assert-FileOwnedForReplacement $PreviousState $launcher
    Assert-FileOwnedForReplacement $PreviousState $legacyLauncher
    Assert-FileOwnedForReplacement $PreviousState $rootPointer

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Write-AtomicUtf8 $launcher (Get-LauncherContent)
    Write-AtomicUtf8 $legacyLauncher (Get-LegacyShimContent)
    Write-AtomicUtf8 $rootPointer (Join-Path $InstallDir "resources")
}

if ($Mode -eq "Validate") {
    Assert-PackagedArtifacts
    $validationRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-launcher-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        $BinDir = $validationRoot
        $launcher = Join-Path $BinDir "polo.cmd"
        $legacyLauncher = Join-Path $BinDir "polo-ai.cmd"
        $rootPointer = Join-Path $BinDir "polo-install-root.txt"
        $stateFile = Join-Path $BinDir "terminal-integration.json"
        Install-LauncherFiles $false $null
        $actualContent = Get-Content $launcher -Raw
        if ((Normalize-LineEndings $actualContent) -cne
            (Normalize-LineEndings ([IO.File]::ReadAllText($launcherTemplate)))) {
            throw "Installed launcher differs from the checked-in canonical template."
        }
        $expectedVersion = (Get-Content $packagePath -Raw | ConvertFrom-Json).version
        $output = & $launcher --version 2>&1
        if ($LASTEXITCODE -ne 0 -or (($output -join "`n").Trim() -ne $expectedVersion)) {
            throw "Generated launcher validation failed: $($output -join "`n")"
        }
    } finally {
        Remove-Item $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

if ($Mode -eq "Install") {
    Assert-PackagedArtifacts

    $previousState = Read-State
    if ((Test-Path -LiteralPath $stateFile) -and -not $previousState) {
        throw "Polo cannot repair terminal integration because its ownership state is invalid."
    }
    $userPath = Get-UserPath
    $entries = @($userPath -split ";" | Where-Object { $_ })
    $pathEntryPresent = Test-PathEntry $entries $BinDir
    $legacyPathEntryOwned = -not (Test-Path -LiteralPath $stateFile) `
        -and $pathEntryPresent `
        -and (Test-LegacyPoloLauncher)

    Install-LauncherFiles (-not $SkipCommandConflict) $previousState

    $pathEntryOwned = [bool](
        ($previousState -and $previousState.pathEntryAddedByPolo) `
        -or $legacyPathEntryOwned
    )
    if (-not $pathEntryPresent) {
        # Persist ownership before mutating PATH so an interrupted install never
        # loses track of an entry Polo intended to add.
        $pathEntryOwned = $true
        Write-State $pathEntryOwned
        Set-UserPath (($entries + $BinDir) -join ";")
    } else {
        # A pre-existing entry without Polo state belongs to the user.
        Write-State $pathEntryOwned
    }
    return
}

$state = Read-State
$stateMissing = -not (Test-Path -LiteralPath $stateFile)
$ownershipConflict = $false
$ownedFiles = @()
$existingManagedFiles = @($launcher, $legacyLauncher, $rootPointer) | Where-Object {
    Test-Path -LiteralPath $_
}
foreach ($managedFile in $existingManagedFiles) {
    $owned = Test-StateOwnedFile $state $managedFile
    if (-not $state -and $stateMissing) {
        $owned = Test-ExactContent $managedFile (Get-HistoricalLauncherAllowlist $managedFile)
    }
    if ($owned) {
        $ownedFiles += $managedFile
    } else {
        $ownershipConflict = $true
        Write-Warning "Polo left modified or user-owned file unchanged: $managedFile"
    }
}
if (-not $ownershipConflict) {
    foreach ($managedFile in $ownedFiles) {
        Remove-Item -LiteralPath $managedFile -Force
    }
}

if (-not $ownershipConflict -and $state -and $state.pathEntryAddedByPolo) {
    $userPath = Get-UserPath
    $remaining = @($userPath -split ";" | Where-Object {
        $_ -and $_.Trim().TrimEnd("\") -ine $BinDir.TrimEnd("\")
    })
    Set-UserPath ($remaining -join ";")
}
if (-not $ownershipConflict) {
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Warning "Polo terminal state was preserved because managed files no longer match their recorded SHA-256."
}

if ((Test-Path $BinDir) -and -not (Get-ChildItem $BinDir -Force | Select-Object -First 1)) {
    Remove-Item $BinDir -Force
}
