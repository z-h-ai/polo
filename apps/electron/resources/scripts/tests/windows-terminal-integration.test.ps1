$ErrorActionPreference = "Stop"

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "windows-terminal-integration.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) "polo-windows-terminal-test-$PID-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $root "Polo AI 安装"
$binDir = Join-Path $root "Existing Bin"
$userPathFile = Join-Path $root "user-path.txt"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw $Message
    }
}

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\vendor\bun") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\app\dist\cli") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\app\dist\server") | Out-Null
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "Polo AI.exe") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\vendor\bun\bun.exe") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\app\dist\cli\polo-cli.js") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\app\dist\server\polo-server.js") | Out-Null
    Set-Content -Path (Join-Path $installDir "resources\app\package.json") -Value '{"version":"0.10.0"}' -Encoding ASCII

    # The user already owns this PATH entry before Polo is installed.
    $originalPath = "$binDir;;C:\User Tools;"
    [IO.File]::WriteAllText($userPathFile, $originalPath)

    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict

    $state = Get-Content (Join-Path $binDir "terminal-integration.json") -Raw | ConvertFrom-Json
    Assert-True ($state.schemaVersion -eq 4) "Polo did not write the installation-bound ownership state schema."
    Assert-True ($state.files.Count -eq 4) "Polo did not record both launchers, wrapper messages, and the root pointer."
    Assert-True ([bool]$state.files[0].sha256) "Polo did not record a managed launcher SHA-256."
    Assert-True ([bool]$state.files[0].identity) "Polo did not record a managed launcher filesystem identity."
    Assert-True (-not $state.pathEntryAddedByPolo) "Polo incorrectly claimed a pre-existing PATH entry."
    $launcher = Get-Content (Join-Path $binDir "polo.cmd") -Raw
    $canonicalLauncher = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) "..\bin\polo.cmd") -Raw
    Assert-True ($launcher.Replace("`r`n", "`n") -ceq $canonicalLauncher.Replace("`r`n", "`n")) `
        "Installed launcher differs from the checked-in template."
    Assert-True ($launcher -notmatch "--polo-cli") "Launcher still delegates CLI commands to Electron."
    Assert-True ($launcher -notmatch 'if /I "%~1"=="app"') "Launcher still intercepts polo app."
    Assert-True (Test-Path (Join-Path $binDir "polo-messages.cmd")) "Polo did not install the launcher message companion."

    # Repair after an App-root move must keep the launcher bytes identical and
    # update only the owned sidecar resolved relative to the launcher.
    $movedInstallDir = Join-Path $root "Polo AI 已移动"
    Move-Item -LiteralPath $installDir -Destination $movedInstallDir
    $installDir = $movedInstallDir
    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict
    $movedLauncher = Get-Content (Join-Path $binDir "polo.cmd") -Raw
    $rootPointer = (Get-Content (Join-Path $binDir "polo-install-root.txt") -Raw).Trim()
    Assert-True ($movedLauncher.Replace("`r`n", "`n") -ceq $canonicalLauncher.Replace("`r`n", "`n")) `
        "Repair after an App move changed the canonical launcher template."
    Assert-True ($rootPointer -eq (Join-Path $installDir "resources")) `
        "Repair after an App move left the launcher root pointer stale."

    & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile

    $afterUninstall = [IO.File]::ReadAllText($userPathFile)
    Assert-True ($afterUninstall -eq $originalPath) "Uninstall removed or changed the user's pre-existing PATH entry."
    Assert-True (-not (Test-Path (Join-Path $binDir "polo.cmd"))) "Managed launcher was not removed."

    # PATH serialization belongs to the user. When Polo adds its own entry it
    # preserves empty segments and trailing delimiters exactly, then removes
    # only the entry it appended during uninstall.
    $originalAbsentPath = "C:\User Tools;;C:\Other Tools;"
    [IO.File]::WriteAllText($userPathFile, $originalAbsentPath)
    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict
    Assert-True (
        [IO.File]::ReadAllText($userPathFile) -eq "$originalAbsentPath;$binDir"
    ) "Install normalized user-owned PATH separators while appending Polo."
    & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile
    Assert-True (
        [IO.File]::ReadAllText($userPathFile) -eq $originalAbsentPath
    ) "Uninstall did not restore the exact user-owned PATH serialization."

    # Checked-in bytes and a matching App root are not ownership when state is
    # missing. A user may have created this exact layout.
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item (Join-Path (Split-Path -Parent $PSScriptRoot) "..\bin\polo.cmd") `
        (Join-Path $binDir "polo.cmd")
    Copy-Item (Join-Path (Split-Path -Parent $PSScriptRoot) "..\bin\polo-ai.cmd") `
        (Join-Path $binDir "polo-ai.cmd")
    Set-Content (Join-Path $binDir "polo-install-root.txt") `
        -Value (Join-Path $installDir "resources")
    & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile
    Assert-True (Test-Path (Join-Path $binDir "polo.cmd")) `
        "Uninstall claimed a state-less user copy of the canonical launcher."
    Assert-True (Test-Path (Join-Path $binDir "polo-install-root.txt")) `
        "Uninstall deleted a state-less user root pointer."
    Remove-Item -Recurse -Force $binDir

    # A modified managed file is no longer owned. Upgrade must stop, and
    # uninstall must preserve both the file and PATH/state evidence.
    Set-Content -Path $userPathFile -Value "C:\User Tools" -Encoding ASCII
    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict
    $managedLauncher = Join-Path $binDir "polo.cmd"
    Add-Content -Path $managedLauncher -Value "rem user modification"
    $upgradeStopped = $false
    try {
        & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict
    } catch {
        $upgradeStopped = $true
    }
    Assert-True $upgradeStopped "Upgrade replaced a launcher whose SHA-256 no longer matched state."

    try {
        & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile
    } catch {
        # An ownership conflict makes uninstall incomplete and must return nonzero.
    }
    Assert-True (Test-Path $managedLauncher) "Uninstall deleted a modified launcher."
    Assert-True (Test-Path (Join-Path $binDir "terminal-integration.json")) "Uninstall deleted ownership state after a conflict."
    Remove-Item -Recurse -Force $binDir

    # Corrupt state is different from absent historical state and must never
    # enable the strict legacy allowlist.
    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict
    Set-Content (Join-Path $binDir "terminal-integration.json") -Value '{"schemaVersion":999}'
    try {
        & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile
    } catch {
        # Corrupt ownership state is a safe uninstall failure.
    }
    Assert-True (Test-Path (Join-Path $binDir "polo.cmd")) "Uninstall deleted a launcher with corrupt state."
    Assert-True (Test-Path (Join-Path $binDir "polo-ai.cmd")) "Uninstall partially deleted files with corrupt state."
    Assert-True (Test-Path (Join-Path $binDir "polo-install-root.txt")) "Uninstall deleted the root pointer with corrupt state."
    Remove-Item -Recurse -Force $binDir

    # Upgrade from the old install-app.ps1 launcher. That installer added the
    # same bin directory to PATH but had no ownership state file. The exact
    # legacy launcher is sufficient evidence that Polo owns this PATH entry.
    # Its batch file was ASCII encoded, so use an ASCII App root for this
    # historical fixture while retaining the Unicode move coverage above.
    $legacyInstallDir = Join-Path $root "Polo AI Legacy"
    Copy-Item -LiteralPath $installDir -Destination $legacyInstallDir -Recurse
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $legacyLauncher = Join-Path $binDir "polo-ai.cmd"
    $exePath = Join-Path $legacyInstallDir "Polo AI.exe"
    Set-Content -Path $legacyLauncher -Value "@echo off`r`nstart `"`" `"$exePath`" %*" -Encoding ASCII
    Set-Content -Path $userPathFile -Value "$binDir;C:\User Tools" -Encoding ASCII

    & $scriptPath -Mode Install -InstallDir $legacyInstallDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict

    $migratedState = Get-Content (Join-Path $binDir "terminal-integration.json") -Raw | ConvertFrom-Json
    Assert-True ($migratedState.schemaVersion -eq 3) "Legacy launcher migration did not create identity-bound state."
    Assert-True $migratedState.pathEntryAddedByPolo "Polo did not claim its legacy PATH entry during upgrade."

    & $scriptPath -Mode Uninstall -InstallDir $legacyInstallDir -BinDir $binDir -UserPathFile $userPathFile

    $migratedPath = (Get-Content $userPathFile -Raw).Trim()
    Assert-True ($migratedPath -eq "C:\User Tools") "Uninstall left the legacy Polo PATH entry behind."
    Write-Host "Windows terminal integration ownership test passed."
} finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
