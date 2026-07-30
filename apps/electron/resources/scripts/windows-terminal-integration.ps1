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
$stateFile = Join-Path $BinDir "terminal-integration.json"
$exePath = Join-Path $InstallDir "Polo AI.exe"
$bunPath = Join-Path $InstallDir "resources\vendor\bun\bun.exe"
$appRoot = Join-Path $InstallDir "resources\app"
$cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
$serverPath = Join-Path $appRoot "dist\server\polo-server.js"
$packagePath = Join-Path $appRoot "package.json"
$marker = "Polo CLI launcher (managed by Polo AI)"

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
    foreach ($managedFile in @($launcher, $legacyLauncher)) {
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
    foreach ($required in @($exePath, $bunPath, $cliPath, $serverPath, $packagePath)) {
        if (-not (Test-Path $required)) {
            throw "Required Polo artifact not found: $required"
        }
    }
}

function Get-LauncherContent {
    return @"
@echo off
chcp 65001 >nul
setlocal
rem $marker
set "POLO_AI_BUN=$bunPath"
set "POLO_AI_SERVER_ENTRY=$serverPath"
set "POLO_AI_CLI_ENTRY=$cliPath"
set "POLO_AI_APP_ROOT=$appRoot"
set "POLO_AI_RESOURCES_PATH=$appRoot\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=$appRoot"
set "POLO_AI_DESKTOP_EXECUTABLE=$exePath"
set "POLO_AI_IS_PACKAGED=true"
if /I "%~1"=="app" (
  start "" "$exePath"
  exit /b 0
)
"$bunPath" run "$cliPath" %*
exit /b %ERRORLEVEL%
"@
}

function Get-LegacyShimContent {
    return "@echo off`r`necho Warning: 'polo-ai' is deprecated; use 'polo' instead. 1>&2`r`ncall `"$launcher`" %*`r`nexit /b %ERRORLEVEL%"
}

function Get-HistoricalLauncherAllowlist([string]$Path) {
    if ($Path.TrimEnd("\") -ieq $launcher.TrimEnd("\")) {
        $content = Get-LauncherContent
        return @($content, "$content`r`n")
    }
    if ($Path.TrimEnd("\") -ieq $legacyLauncher.TrimEnd("\")) {
        $shim = Get-LegacyShimContent
        $oldGui = "@echo off`r`nstart `"`" `"$exePath`" %*"
        return @($shim, "$shim`r`n", $oldGui, "$oldGui`r`n")
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

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Write-AtomicUtf8 $launcher (Get-LauncherContent)
    Write-AtomicUtf8 $legacyLauncher (Get-LegacyShimContent)
}

if ($Mode -eq "Validate") {
    Assert-PackagedArtifacts
    $validationRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-launcher-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        $BinDir = $validationRoot
        $launcher = Join-Path $BinDir "polo.cmd"
        $legacyLauncher = Join-Path $BinDir "polo-ai.cmd"
        $stateFile = Join-Path $BinDir "terminal-integration.json"
        Install-LauncherFiles $false $null
        $actualContent = Get-Content $launcher -Raw
        if ($actualContent -match "--polo-cli" -or
            $actualContent -notmatch [Regex]::Escape($bunPath) -or
            $actualContent -notmatch [Regex]::Escape($cliPath)) {
            throw "Generated launcher does not directly invoke the bundled Bun and CLI."
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
    $userPath = Get-UserPath
    $entries = @($userPath -split ";" | Where-Object { $_ })
    $pathEntryPresent = Test-PathEntry $entries $BinDir
    $legacyPathEntryOwned = -not $previousState `
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
$ownershipConflict = $false
foreach ($managedFile in @($launcher, $legacyLauncher)) {
    if (-not (Test-Path -LiteralPath $managedFile)) {
        continue
    }
    $owned = Test-StateOwnedFile $state $managedFile
    if (-not $state) {
        $owned = Test-ExactContent $managedFile (Get-HistoricalLauncherAllowlist $managedFile)
    }
    if ($owned) {
        Remove-Item -LiteralPath $managedFile -Force
    } else {
        $ownershipConflict = $true
        Write-Warning "Polo left modified or user-owned file unchanged: $managedFile"
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
