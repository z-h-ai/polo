param(
    [ValidateSet("Smoke", "Full")]
    [string]$Mode = "Smoke",
    [string]$ReleaseDir = "",
    [string]$Arch = "x64"
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

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-final-artifact-$PID-$([Guid]::NewGuid().ToString('N'))"
$testLocalAppData = Join-Path $testRoot "用户 Local AppData"
$installDir = Join-Path $testRoot "Polo AI Install"
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:LOCALAPPDATA = $testLocalAppData

function Invoke-Installer {
    $process = Start-Process -FilePath $installer `
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
}

function Test-FullLifecycle {
    $exe = Join-Path $installDir "Polo AI.exe"
    $launcher = Join-Path $testLocalAppData "Polo AI\bin\polo.cmd"
    $runtimeFile = Join-Path $testLocalAppData "Polo AI\runtime\electron.json"
    $process = Start-Process -FilePath $exe -PassThru
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while (-not (Test-Path -LiteralPath $runtimeFile) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path -LiteralPath $runtimeFile)) {
            throw "Full artifact E2E timed out waiting for Electron discovery"
        }
        & $launcher sessions | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Installed CLI could not discover Electron"
        }
    } finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }

    Invoke-Installer
    Test-InstalledContainer
    Write-Host "Full NSIS install/discovery/upgrade validation passed"
}

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    Invoke-Installer
    Test-InstalledContainer
    if ($Mode -eq "Full") {
        Test-FullLifecycle
    }
    Invoke-Uninstaller
    if (Test-Path -LiteralPath (Join-Path $testLocalAppData "Polo AI\bin\polo.cmd")) {
        throw "NSIS uninstall left the managed Polo launcher behind"
    }
    Write-Host "Final Windows artifact validation passed ($Mode)"
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
