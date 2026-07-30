param(
    [ValidateSet("Smoke", "Full")]
    [string]$Mode = "Smoke",
    [string]$ReleaseDir = "",
    [string]$Arch = "x64",
    [string]$PreviousArtifact = $env:POLO_AI_PREVIOUS_ARTIFACT
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
if (-not $ReleaseDir) {
    $ReleaseDir = Join-Path $ElectronDir "release"
}

$installer = Join-Path $ReleaseDir "Polo-AI-$Arch.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Final Windows validation requires $installer"
}
if ($Mode -eq "Full" -and (
    -not $PreviousArtifact -or
    -not (Test-Path -LiteralPath $PreviousArtifact -PathType Leaf)
)) {
    throw "Full validation requires -PreviousArtifact or POLO_AI_PREVIOUS_ARTIFACT"
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-final-artifact-$PID-$([Guid]::NewGuid().ToString('N'))"
$testLocalAppData = Join-Path $testRoot "用户 Local AppData"
$installDir = Join-Path $testRoot "Polo AI Install"
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:LOCALAPPDATA = $testLocalAppData

function Invoke-Installer([string]$InstallerPath = $installer) {
    $process = Start-Process -FilePath $InstallerPath `
        -ArgumentList @("/S", "/D=$installDir") `
        -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "NSIS installer exited with $($process.ExitCode)"
    }
}

function Invoke-Uninstaller {
    $uninstaller = Join-Path $installDir "Uninstall Polo AI.exe"
    if (-not (Test-Path -LiteralPath $uninstaller)) {
        throw "NSIS uninstall executable is missing: $uninstaller"
    }
    $process = Start-Process -FilePath $uninstaller `
        -ArgumentList @("/S") `
        -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "NSIS uninstaller exited with $($process.ExitCode)"
    }
}

function Test-InstalledContainer {
    $resourcesRoot = Join-Path $installDir "resources"
    $appRoot = Join-Path $resourcesRoot "app"
    $bun = Join-Path $resourcesRoot "vendor\bun\bun.exe"
    $launcher = Join-Path $testLocalAppData "Polo AI\bin\polo.cmd"
    $manifestPath = Join-Path $appRoot "dist\cli\artifact-manifest.json"
    $metadataPath = Join-Path $appRoot "dist\cli\package.json"
    $cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
    $serverPath = Join-Path $appRoot "dist\server\polo-server.js"

    foreach ($required in @($bun, $launcher, $manifestPath, $metadataPath, $cliPath, $serverPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Installed NSIS container is missing $required"
        }
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $artifacts = @{
        cli = @{ Path = $cliPath; Relative = "dist/cli/polo-cli.js" }
        cliPackage = @{ Path = $metadataPath; Relative = "dist/cli/package.json" }
        server = @{ Path = $serverPath; Relative = "dist/server/polo-server.js" }
    }
    foreach ($name in $artifacts.Keys) {
        $expected = $artifacts[$name]
        if ($manifest.artifacts.$name.path -cne $expected.Relative) {
            throw "Unexpected $name manifest path"
        }
        $actualHash = (Get-FileHash -LiteralPath $expected.Path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($manifest.artifacts.$name.sha256 -cne $actualHash) {
            throw "$name checksum mismatch in installed NSIS container"
        }
    }

    $metadataKeys = @($metadata.PSObject.Properties.Name | Sort-Object)
    if (
        ($metadataKeys -join ",") -cne "bin,license,main,name,type,version" -or
        $metadata.name -cne "@polo-ai/cli" -or
        $metadata.version -cne $manifest.version -or
        $metadata.type -cne "module" -or
        $metadata.main -cne "./polo-cli.js" -or
        $metadata.bin.polo -cne "./polo-cli.js" -or
        $metadata.bin."polo-ai" -cne "./polo-cli.js" -or
        $metadata.license -cne "Apache-2.0"
    ) {
        throw "Sanitized CLI package metadata mismatch in installed NSIS container"
    }

    $versionOutput = (& $launcher --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionOutput -cne $manifest.version) {
        throw "Installed NSIS launcher version smoke failed: $versionOutput"
    }
    $helpOutput = (& $launcher --help 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $helpOutput -notmatch [Regex]::Escape("Usage: polo ")) {
        throw "Installed NSIS launcher help smoke failed: $helpOutput"
    }
    Write-Host "NSIS final-container CLI smoke passed ($($manifest.version))"
    return [string]$manifest.version
}

function Invoke-FreshShell {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{}
    )
    $binDir = Join-Path $testLocalAppData "Polo AI\bin"
    $savedPath = $env:Path
    $savedEnvironment = @{}
    try {
        $env:Path = "$binDir;$env:SystemRoot\System32;$env:SystemRoot"
        foreach ($entry in $Environment.GetEnumerator()) {
            $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
        }
        $output = & $env:ComSpec /d /c $Command 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Fresh cmd.exe failed ($LASTEXITCODE): $Command`n$($output -join "`n")"
        }
        return ($output -join "`n").Trim()
    } finally {
        $env:Path = $savedPath
        foreach ($entry in $Environment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable(
                $entry.Key,
                $savedEnvironment[$entry.Key],
                "Process"
            )
        }
    }
}

function Wait-ForDiscovery([string]$RuntimeFile) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (-not (Test-Path -LiteralPath $RuntimeFile) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $RuntimeFile)) {
        throw "Full artifact E2E timed out waiting for Electron discovery: $RuntimeFile"
    }
}

function Stop-DiscoveredApp([string]$RuntimeFile) {
    if (-not (Test-Path -LiteralPath $RuntimeFile)) {
        return
    }
    $runtime = Get-Content -LiteralPath $RuntimeFile -Raw | ConvertFrom-Json
    Stop-Process -Id ([int]$runtime.pid) -Force -ErrorAction SilentlyContinue
}

function Test-UserCommandConflict {
    $conflictRoot = Join-Path $testRoot "user command conflict"
    $conflictBin = Join-Path $conflictRoot "bin"
    $conflictInstall = Join-Path $conflictRoot "Polo AI"
    $conflictLocalAppData = Join-Path $conflictRoot "Local AppData"
    $userCommand = Join-Path $conflictBin "polo.cmd"
    New-Item -ItemType Directory -Force -Path $conflictBin | Out-Null
    [IO.File]::WriteAllText($userCommand, "@echo off`r`necho user-owned`r`n")

    $savedLocalAppData = $env:LOCALAPPDATA
    $savedPath = $env:Path
    try {
        $env:LOCALAPPDATA = $conflictLocalAppData
        $env:Path = "$conflictBin;$savedPath"
        $process = Start-Process -FilePath $installer `
            -ArgumentList @("/S", "/D=$conflictInstall") `
            -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -ne 0) {
            throw "Conflict NSIS install unexpectedly failed at process level"
        }
        if ((Get-Content -LiteralPath $userCommand -Raw) -cne "@echo off`r`necho user-owned`r`n") {
            throw "NSIS terminal setup overwrote a user-owned polo command"
        }
        if (Test-Path -LiteralPath (Join-Path $conflictLocalAppData "Polo AI\bin\polo.cmd")) {
            throw "NSIS terminal setup installed a launcher despite a user command conflict"
        }
    } finally {
        $uninstaller = Join-Path $conflictInstall "Uninstall Polo AI.exe"
        if (Test-Path -LiteralPath $uninstaller) {
            Start-Process -FilePath $uninstaller -ArgumentList @("/S") `
                -Wait -WindowStyle Hidden | Out-Null
        }
        $env:LOCALAPPDATA = $savedLocalAppData
        $env:Path = $savedPath
    }
}

function Test-FullLifecycle {
    $exe = Join-Path $installDir "Polo AI.exe"
    $launcher = Join-Path $testLocalAppData "Polo AI\bin\polo.cmd"
    $runtimeFile = Join-Path $testLocalAppData "Polo AI\runtime\electron.json"

    Invoke-Installer $PreviousArtifact
    $previousVersion = Test-InstalledContainer
    if ((Invoke-FreshShell "polo --version") -cne $previousVersion) {
        throw "Fresh shell did not resolve the previous installed Polo version"
    }
    Invoke-FreshShell "polo --help | findstr /C:`"Usage: polo `" >nul" | Out-Null
    $runProbe = Invoke-FreshShell `
        "polo run `"packaged headless probe`"" `
        @{ POLO_AI_E2E_RUN_PROBE = "1" }
    if ($runProbe -notmatch "Run probe connected via temporary") {
        throw "Installed polo run did not exercise its temporary server: $runProbe"
    }

    $originalLauncherContent = Get-Content -LiteralPath $launcher -Raw
    Add-Content -LiteralPath $launcher -Value "rem user modification"
    Invoke-Installer
    if ((Get-Content -LiteralPath $launcher -Raw) -notmatch "rem user modification") {
        throw "NSIS upgrade overwrote a modified launcher"
    }
    [IO.File]::WriteAllText($launcher, $originalLauncherContent)

    Invoke-Installer
    $currentVersion = Test-InstalledContainer
    if ($previousVersion -ceq $currentVersion) {
        throw "Previous artifact version must differ from current artifact ($currentVersion)"
    }
    if ((Invoke-FreshShell "polo --version") -cne $currentVersion) {
        throw "Fresh shell did not resolve the upgraded Polo version"
    }
    Invoke-FreshShell "polo --help | findstr /C:`"Usage: polo `" >nul" | Out-Null
    Test-UserCommandConflict

    Invoke-FreshShell "polo app" @{
        POLO_AI_RUNTIME_DISCOVERY_FILE = $runtimeFile
    } | Out-Null
    Wait-ForDiscovery $runtimeFile
    Invoke-FreshShell "polo sessions >nul" @{
        POLO_AI_RUNTIME_DISCOVERY_FILE = $runtimeFile
    } | Out-Null
    Stop-DiscoveredApp $runtimeFile

    Invoke-Uninstaller
    if (Test-Path -LiteralPath $launcher) {
        throw "NSIS uninstall left the managed Polo launcher behind"
    }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -and @($userPath -split ";") -contains (Split-Path -Parent $launcher)) {
        throw "NSIS uninstall left the managed Polo PATH entry behind"
    }
    Write-Host "Full NSIS real install/discovery/cross-version upgrade/ownership/uninstall E2E passed"
}

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    if ($Mode -eq "Full") {
        Test-FullLifecycle
    } else {
        Invoke-Installer
        Test-InstalledContainer | Out-Null
        Invoke-Uninstaller
        if (Test-Path -LiteralPath (Join-Path $testLocalAppData "Polo AI\bin\polo.cmd")) {
            throw "NSIS uninstall left the managed Polo launcher behind"
        }
    }
    Write-Host "Final Windows artifact validation passed ($Mode)"
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
