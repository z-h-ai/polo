param(
    [ValidateSet("Smoke", "Bootstrap", "Full")]
    [string]$Mode = "Smoke",
    [string]$ReleaseDir = "",
    [string]$Arch = "x64",
    [string]$PreviousArtifact = $env:POLO_AI_PREVIOUS_ARTIFACT
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)
$uvLockPath = Join-Path $RootDir "scripts\uv-runtime-lock.json"
$signingContract = Join-Path $RootDir "scripts\release-signing-contract.ts"
$expectedPublisher = [string]$env:POLO_AI_RELEASE_WINDOWS_PUBLISHER
$expectedThumbprint = [string]$env:POLO_AI_RELEASE_WINDOWS_THUMBPRINT
if (-not $ReleaseDir) {
    $ReleaseDir = Join-Path $ElectronDir "release"
}
$signingAuditFile = if ($env:POLO_AI_RELEASE_SIGNING_AUDIT_FILE) {
    $env:POLO_AI_RELEASE_SIGNING_AUDIT_FILE
} else {
    Join-Path $ReleaseDir "release-signing-audit-Windows.jsonl"
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
if ($Mode -ne "Smoke") {
    if (
        [string]::IsNullOrWhiteSpace($expectedPublisher) -or
        [string]::IsNullOrWhiteSpace($expectedThumbprint)
    ) {
        throw "Full Windows validation requires the release Publisher and certificate thumbprint"
    }
    if (-not (Test-Path -LiteralPath $signingContract -PathType Leaf)) {
        throw "Full Windows validation requires the release signing contract validator"
    }
    $hostBun = (Get-Command bun.exe -ErrorAction Stop).Source
    Set-Content -LiteralPath $signingAuditFile -Value "" -NoNewline
    Write-Host "release-signing-contract platform=windows mode=full publisher=$expectedPublisher thumbprint=$expectedThumbprint audit=$signingAuditFile"
} else {
    $hostBun = $null
    Write-Host "release-signing-contract platform=windows mode=smoke acceptance=development-only"
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-final-artifact-$PID-$([Guid]::NewGuid().ToString('N'))"
$testLocalAppData = Join-Path $testRoot "用户 Local AppData"
$installDir = Join-Path $testRoot "Polo AI Install"
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$originalProcessPath = $env:Path
$currentVersion = $null
$previousVersion = $null

function Invoke-NsisProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Write-Host "NSIS validation phase=$Label:start"
    # Start-Process -Wait waits for the Windows process tree. An NSIS
    # installer may launch the desktop app after a successful silent install,
    # which would turn a successful installer into an unbounded wait. Wait for
    # the NSIS controller itself instead and retain a bounded failure signal.
    $process = Start-Process -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(90000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "NSIS $Label timed out after 90 seconds"
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) {
        throw "NSIS $Label exited with $($process.ExitCode)"
    }
    Write-Host "NSIS validation phase=$Label:complete"
}

function Stop-InstalledPoloApp([string]$TargetInstallDir = $installDir) {
    $target = Join-Path $TargetInstallDir "Polo AI.exe"
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'Polo AI.exe'" `
        -ErrorAction SilentlyContinue | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath -ieq $target
        })) {
        Write-Host "NSIS validation phase=desktop-app:stop pid=$($process.ProcessId)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Installer([string]$InstallerPath = $installer) {
    Invoke-NsisProcess -FilePath $InstallerPath `
        -ArgumentList @("/S", "/D=$installDir") `
        -Label "installer"
    Stop-InstalledPoloApp
}

function Invoke-Uninstaller {
    $uninstaller = Join-Path $installDir "Uninstall Polo AI.exe"
    if (-not (Test-Path -LiteralPath $uninstaller)) {
        throw "NSIS uninstall executable is missing: $uninstaller"
    }
    Stop-InstalledPoloApp
    Invoke-NsisProcess -FilePath $uninstaller -ArgumentList @("/S") -Label "uninstaller"
}

function Assert-ReleaseAuthenticodeIdentity([string]$Path, [string]$Label) {
    if ($Mode -eq "Smoke") {
        return
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $publisher = if ($signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
    } else {
        ""
    }
    $thumbprint = if ($signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Thumbprint
    } else {
        ""
    }
    $output = & $hostBun run $signingContract verify-windows `
        --label $Label `
        --expected-publisher $expectedPublisher `
        --expected-thumbprint $expectedThumbprint `
        --actual-publisher $publisher `
        --actual-thumbprint $thumbprint `
        --signature ([string]$signature.Status) `
        --output $signingAuditFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$Label release signing identity validation failed: $($output -join "`n")"
    }
    $output | ForEach-Object { Write-Host $_ }
}

function Test-InstalledContainer([bool]$RequireRunHelpers = $true) {
    $resourcesRoot = Join-Path $installDir "resources"
    $appRoot = Join-Path $resourcesRoot "app"
    $bun = Join-Path $resourcesRoot "vendor\bun\bun.exe"
    $launcher = Join-Path $testLocalAppData "Polo AI\bin\polo.cmd"
    $manifestPath = Join-Path $appRoot "dist\cli\artifact-manifest.json"
    $metadataPath = Join-Path $appRoot "dist\cli\package.json"
    $cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
    $serverPath = Join-Path $appRoot "dist\server\polo-server.js"
    $uvPath = Join-Path $appRoot "resources\bin\win32-$Arch\uv.exe"
    $uvManifestPath = Join-Path $appRoot "resources\bin\win32-$Arch\runtime-manifest.json"
    $installedExe = Join-Path $installDir "Polo AI.exe"
    $piServerPath = Join-Path $appRoot "resources\pi-agent-server\index.js"
    $sessionServerPath = Join-Path $appRoot "resources\session-mcp-server\index.js"
    $wrapperMessages = Join-Path $appRoot "resources\bin\polo-messages.cmd"

    foreach ($required in @(
        $bun,
        $launcher,
        $wrapperMessages,
        $manifestPath,
        $metadataPath,
        $cliPath,
        $serverPath,
        $uvPath,
        $uvManifestPath,
        $installedExe,
        $uvLockPath
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Installed NSIS container is missing $required"
        }
    }
    $uvManifest = Get-Content -LiteralPath $uvManifestPath -Raw | ConvertFrom-Json
    $uvLock = Get-Content -LiteralPath $uvLockPath -Raw | ConvertFrom-Json
    $uvTarget = $uvLock.targets."win32-$Arch"
    $uvHash = (Get-FileHash -LiteralPath $uvPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        -not $uvTarget -or
        $uvManifest.schemaVersion -ne 1 -or
        $uvManifest.platform -cne "win32" -or
        $uvManifest.arch -cne $Arch -or
        $uvManifest.source -cne "astral-sh-release" -or
        $uvManifest.version -cne $uvLock.version -or
        $uvManifest.binary -cne "uv.exe" -or
        $uvManifest.sha256 -cne $uvTarget.binarySha256 -or
        $uvManifest.releaseAsset -cne $uvTarget.asset -or
        $uvManifest.releaseAssetSha256 -cne $uvTarget.archiveSha256
    ) {
        throw "Installed NSIS pinned uv runtime manifest is invalid"
    }
    if ($uvHash -cne $uvTarget.binarySha256) {
        $uvSignature = Get-AuthenticodeSignature -LiteralPath $uvPath
        if ($uvSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
            throw "Installed NSIS uv differs from the pinned bytes without a valid Authenticode signature"
        }
    }
    if ($Mode -ne "Smoke") {
        Assert-ReleaseAuthenticodeIdentity $installedExe "installed-current-app"
        Assert-ReleaseAuthenticodeIdentity $uvPath "installed-current-uv"
    } else {
        Write-Host "release-signing-result platform=windows label=installed-current mode=smoke acceptance=development-only"
    }
    $uvOutput = (& $uvPath --version 2>&1 | Out-String).Trim()
    $expectedUvOutput = "uv $($uvLock.version)"
    $expectedUvPattern = "^$([regex]::Escape($expectedUvOutput))(?: \([^()]+\))?$"
    if ($LASTEXITCODE -ne 0 -or $uvOutput -cnotmatch $expectedUvPattern) {
        throw "Installed NSIS uv runtime smoke failed: $uvOutput"
    }
    if ($RequireRunHelpers) {
        foreach ($required in @($piServerPath, $sessionServerPath)) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
                throw "Installed NSIS container is missing run helper $required"
            }
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

    Push-Location $testLocalAppData
    try {
        $versionOutput = (& $launcher --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $versionOutput -cne $manifest.version) {
            throw "Installed NSIS launcher version smoke failed: $versionOutput"
        }
        $helpOutput = (& $launcher --help 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $helpOutput -notmatch [Regex]::Escape("Usage: polo ")) {
            throw "Installed NSIS launcher help smoke failed: $helpOutput"
        }
    } finally {
        Pop-Location
    }
    Write-Host "NSIS final-container CLI smoke passed ($($manifest.version))"
    return [string]$manifest.version
}

function Invoke-FreshShell {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Environment = @{}
    )
    $savedPath = $env:Path
    $savedEnvironment = @{}
    try {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
        foreach ($entry in $Environment.GetEnumerator()) {
            $savedEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
        }
        $freshCommand = "cd /d `"$testLocalAppData`" && ($Command)"
        $output = & $env:ComSpec /d /c $freshCommand 2>&1
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

function Get-UserPathEntries {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    return @($userPath -split ";" | Where-Object { $_ } | ForEach-Object {
        $_.Trim().TrimEnd("\")
    })
}

function Assert-ManagedPathPresent {
    $binDir = (Join-Path $testLocalAppData "Polo AI\bin").TrimEnd("\")
    $matches = @(Get-UserPathEntries | Where-Object { $_ -ieq $binDir })
    if ($matches.Count -ne 1) {
        throw "User PATH must contain the managed Polo bin directory exactly once; found $($matches.Count)"
    }
    $resolved = Invoke-FreshShell "where polo"
    $first = @($resolved -split "`r?`n")[0].Trim()
    $expected = Join-Path $binDir "polo.cmd"
    if ($first -ine $expected) {
        throw "Fresh User+Machine PATH resolved Polo to '$first', expected '$expected'"
    }
}

function Assert-FreshShellCommandAbsent {
    $savedPath = $env:Path
    try {
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
        $output = & $env:ComSpec /d /c "where polo" 2>&1
        if ($LASTEXITCODE -eq 0) {
            throw "Polo still resolves after uninstall: $($output -join "`n")"
        }
    } finally {
        $env:Path = $savedPath
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
    $savedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    try {
        $env:LOCALAPPDATA = $conflictLocalAppData
        $env:Path = "$conflictBin;$savedPath"
        Invoke-NsisProcess -FilePath $installer `
            -ArgumentList @("/S", "/D=$conflictInstall") `
            -Label "conflict-installer"
        Stop-InstalledPoloApp $conflictInstall
        if ((Get-Content -LiteralPath $userCommand -Raw) -cne "@echo off`r`necho user-owned`r`n") {
            throw "NSIS terminal setup overwrote a user-owned polo command"
        }
        if (Test-Path -LiteralPath (Join-Path $conflictLocalAppData "Polo AI\bin\polo.cmd")) {
            throw "NSIS terminal setup installed a launcher despite a user command conflict"
        }
        if ([Environment]::GetEnvironmentVariable("Path", "User") -cne $savedUserPath) {
            throw "NSIS terminal setup changed User PATH despite a user command conflict"
        }
    } finally {
        $uninstaller = Join-Path $conflictInstall "Uninstall Polo AI.exe"
        if (Test-Path -LiteralPath $uninstaller) {
            Stop-InstalledPoloApp $conflictInstall
            Invoke-NsisProcess -FilePath $uninstaller `
                -ArgumentList @("/S") -Label "conflict-uninstaller"
        }
        $env:LOCALAPPDATA = $savedLocalAppData
        $env:Path = $savedPath
        [Environment]::SetEnvironmentVariable("Path", $savedUserPath, "User")
    }
}

function Get-SevenZipExecutable {
    $command = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $rootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)
    $bundled = Join-Path $rootDir "node_modules\7zip-bin\win\x64\7za.exe"
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    throw "Read-only NSIS metadata preflight requires 7z.exe"
}

function Expand-SevenZipArchive([string]$Archive, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $sevenZip = Get-SevenZipExecutable
    $process = Start-Process -FilePath $sevenZip `
        -ArgumentList @("x", "-y", "-o$Destination", $Archive) `
        -PassThru -Wait -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "7-Zip could not inspect $Archive (exit $($process.ExitCode))"
    }
}

function Expand-NsisPayload([string]$Artifact, [string]$Label) {
    $extractRoot = Join-Path $testRoot "preflight-$Label"
    Expand-SevenZipArchive $Artifact $extractRoot

    for ($depth = 0; $depth -lt 2; $depth++) {
        $nested = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File `
            -Filter "*.7z" -ErrorAction SilentlyContinue)
        foreach ($archive in $nested) {
            $nestedDestination = "$($archive.FullName).expanded"
            if (-not (Test-Path -LiteralPath $nestedDestination)) {
                Expand-SevenZipArchive $archive.FullName $nestedDestination
            }
        }
    }
    return $extractRoot
}

function Get-CurrentNsisArtifactVersion([string]$Artifact, [string]$Label) {
    $extractRoot = Expand-NsisPayload $Artifact $Label
    $metadata = Get-ChildItem -LiteralPath $extractRoot -Recurse -File `
        -Filter "package.json" -ErrorAction SilentlyContinue | Where-Object {
            $_.FullName -match '[\\/]dist[\\/]cli[\\/]package\.json$'
        } | Select-Object -First 1
    if (-not $metadata) {
        throw "$Label NSIS artifact does not contain dist\cli\package.json"
    }

    $cliDir = Split-Path -Parent $metadata.FullName
    $appRoot = Split-Path -Parent (Split-Path -Parent $cliDir)
    $manifestPath = Join-Path $cliDir "artifact-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "$Label NSIS artifact does not contain artifact-manifest.json"
    }
    $metadataJson = Get-Content -LiteralPath $metadata.FullName -Raw | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $metadataKeys = @($metadataJson.PSObject.Properties.Name | Sort-Object)
    if (
        ($metadataKeys -join ",") -cne "bin,license,main,name,type,version" -or
        $metadataJson.name -cne "@polo-ai/cli" -or
        $metadataJson.version -cne $manifest.version -or
        $metadataJson.type -cne "module" -or
        $metadataJson.main -cne "./polo-cli.js" -or
        $metadataJson.bin.polo -cne "./polo-cli.js" -or
        $metadataJson.bin."polo-ai" -cne "./polo-cli.js" -or
        $metadataJson.license -cne "Apache-2.0"
    ) {
        throw "$Label NSIS sanitized CLI metadata is invalid"
    }
    foreach ($entry in @(
        @{ Name = "cli"; Relative = "dist/cli/polo-cli.js" },
        @{ Name = "cliPackage"; Relative = "dist/cli/package.json" },
        @{ Name = "server"; Relative = "dist/server/polo-server.js" }
    )) {
        $record = $manifest.artifacts.($entry.Name)
        $path = Join-Path $appRoot ($entry.Relative -replace "/", "\")
        if ($record.path -cne $entry.Relative -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "$Label NSIS manifest path is invalid for $($entry.Name)"
        }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($record.sha256 -cne $hash) {
            throw "$Label NSIS manifest checksum failed for $($entry.Name)"
        }
    }
    $uvPath = Join-Path $appRoot "resources\bin\win32-$Arch\uv.exe"
    $uvManifestPath = Join-Path $appRoot "resources\bin\win32-$Arch\runtime-manifest.json"
    if (
        -not (Test-Path -LiteralPath $uvPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $uvManifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $uvLockPath -PathType Leaf)
    ) {
        throw "$Label NSIS artifact does not contain the packaged uv runtime"
    }
    $uvManifest = Get-Content -LiteralPath $uvManifestPath -Raw | ConvertFrom-Json
    $uvLock = Get-Content -LiteralPath $uvLockPath -Raw | ConvertFrom-Json
    $uvTarget = $uvLock.targets."win32-$Arch"
    $uvHash = (Get-FileHash -LiteralPath $uvPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        -not $uvTarget -or
        $uvManifest.schemaVersion -ne 1 -or
        $uvManifest.platform -cne "win32" -or
        $uvManifest.arch -cne $Arch -or
        $uvManifest.source -cne "astral-sh-release" -or
        $uvManifest.version -cne $uvLock.version -or
        $uvManifest.binary -cne "uv.exe" -or
        $uvManifest.sha256 -cne $uvTarget.binarySha256 -or
        $uvManifest.releaseAsset -cne $uvTarget.asset -or
        $uvManifest.releaseAssetSha256 -cne $uvTarget.archiveSha256
    ) {
        throw "$Label NSIS pinned uv runtime manifest is invalid"
    }
    if ($uvHash -cne $uvTarget.binarySha256) {
        $uvSignature = Get-AuthenticodeSignature -LiteralPath $uvPath
        if ($uvSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
            throw "$Label NSIS uv differs from the pinned bytes without a valid Authenticode signature"
        }
    }
    if ($Mode -ne "Smoke") {
        $payloadExe = Get-ChildItem -LiteralPath $extractRoot -Recurse -File `
            -Filter "Polo AI.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $payloadExe) {
            throw "$Label NSIS artifact does not contain Polo AI.exe"
        }
        Assert-ReleaseAuthenticodeIdentity $Artifact "$Label-installer"
        Assert-ReleaseAuthenticodeIdentity $payloadExe.FullName "$Label-app"
        Assert-ReleaseAuthenticodeIdentity $uvPath "$Label-uv"
    }
    $uvOutput = (& $uvPath --version 2>&1 | Out-String).Trim()
    $expectedUvOutput = "uv $($uvLock.version)"
    $expectedUvPattern = "^$([regex]::Escape($expectedUvOutput))(?: \([^()]+\))?$"
    if ($LASTEXITCODE -ne 0 -or $uvOutput -cnotmatch $expectedUvPattern) {
        throw "$Label NSIS uv runtime smoke failed: $uvOutput"
    }
    return [string]$metadataJson.version
}

function Get-LegacyNsisArtifactVersion([string]$Artifact, [string]$Label) {
    $extractRoot = Expand-NsisPayload $Artifact "legacy-$Label"
    $electronMetadata = $null
    $metadataJson = $null
    foreach ($candidate in @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File `
        -Filter "package.json" -ErrorAction SilentlyContinue)) {
        try {
            $parsed = Get-Content -LiteralPath $candidate.FullName -Raw | ConvertFrom-Json
            if ($parsed.name -ceq "@polo-ai/electron" -and $parsed.main -ceq "dist/main.cjs") {
                $electronMetadata = $candidate
                $metadataJson = $parsed
                break
            }
        } catch {
            # Ignore unrelated package metadata in the extracted installer.
        }
    }
    if (-not $electronMetadata -or -not $metadataJson.version) {
        throw "$Label NSIS artifact does not contain legacy Electron package metadata"
    }
    $appRoot = Split-Path -Parent $electronMetadata.FullName
    if (-not (Get-ChildItem -LiteralPath $extractRoot -Recurse -File `
        -Filter "Polo AI.exe" -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        throw "$Label NSIS artifact does not contain Polo AI.exe"
    }
    $rootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)
    $legacyValidator = Join-Path $rootDir "scripts\validate-legacy-electron-layout.ts"
    $hostBun = (Get-Command bun.exe -ErrorAction Stop).Source
    $version = (& $hostBun run $legacyValidator --app-root $appRoot --platform win32 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "$Label NSIS legacy layout validation failed: $version"
    }
    Write-Host "$Label legacy NSIS container contract passed ($version)"
    return $version
}

function Test-LegacyInstalledContainer {
    $appRoot = Join-Path $installDir "resources\app"
    $metadataPath = Join-Path $appRoot "package.json"
    foreach ($required in @(
        (Join-Path $installDir "Polo AI.exe"),
        $metadataPath,
        (Join-Path $appRoot "dist\main.cjs"),
        (Join-Path $appRoot "resources\bin\polo-ai.cmd")
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Installed previous NSIS is not a supported legacy container: $required"
        }
    }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.name -cne "@polo-ai/electron" -or $metadata.main -cne "dist/main.cjs") {
        throw "Installed previous NSIS Electron metadata is invalid"
    }
    return [string]$metadata.version
}

function Invoke-PackagedRunLifecycle {
    $fixtureRoot = Join-Path $testRoot "mock provider"
    $workspace = Join-Path $testRoot "workspace with 空格"
    $stateFile = Join-Path $fixtureRoot "state.json"
    $requestLog = Join-Path $fixtureRoot "requests.jsonl"
    $providerOut = Join-Path $fixtureRoot "provider.out.log"
    $providerErr = Join-Path $fixtureRoot "provider.err.log"
    $runOutput = Join-Path $fixtureRoot "run-output.log"
    $token = "polo-artifact-e2e-token-$PID-fixed"
    $fixture = Join-Path $ElectronDir "scripts\fixtures\mock-openai-provider.ts"
    $hostBun = (Get-Command bun.exe -ErrorAction Stop).Source
    New-Item -ItemType Directory -Force -Path $fixtureRoot, $workspace, (Join-Path $testRoot "tmp") | Out-Null

    $names = @(
        "POLO_AI_ARTIFACT_E2E_FIXTURE",
        "POLO_AI_ARTIFACT_E2E_ROOT",
        "POLO_AI_E2E_MOCK_STATE",
        "POLO_AI_E2E_MOCK_LOG",
        "POLO_AI_E2E_MOCK_TOKEN"
    )
    $saved = @{}
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
    try {
        $env:POLO_AI_ARTIFACT_E2E_FIXTURE = "1"
        $env:POLO_AI_ARTIFACT_E2E_ROOT = $fixtureRoot
        $env:POLO_AI_E2E_MOCK_STATE = $stateFile
        $env:POLO_AI_E2E_MOCK_LOG = $requestLog
        $env:POLO_AI_E2E_MOCK_TOKEN = $token
        $provider = Start-Process -FilePath $hostBun `
            -ArgumentList @("run", $fixture) `
            -RedirectStandardOutput $providerOut `
            -RedirectStandardError $providerErr `
            -PassThru -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $stateFile) -and
            -not $provider.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 200
        }
        if (-not (Test-Path -LiteralPath $stateFile)) {
            throw "Mock provider did not start: $(Get-Content $providerErr -Raw -ErrorAction SilentlyContinue)"
        }
        $baseUrl = (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json).baseUrl
        $command = "polo run --provider openai --model gpt-4o --api-key `"$token`" " +
            "--base-url `"$baseUrl`" --workspace-dir `"$workspace`" --timeout 60000 " +
            "--send-timeout 60000 `"hello`" > `"$runOutput`" 2>&1"
        Invoke-FreshShell $command @{
            TEMP = (Join-Path $testRoot "tmp")
            TMP = (Join-Path $testRoot "tmp")
        } | Out-Null
        $output = Get-Content -LiteralPath $runOutput -Raw
        $requests = Get-Content -LiteralPath $requestLog -Raw
        if ($output -notmatch "artifact run completed" -or
            $output -notmatch "Workspace registered:" -or
            $output -notmatch "Server ready: ws://127\.0\.0\.1:" -or
            $requests -notmatch '"sawHello":true') {
            throw "Packaged polo run did not complete its real lifecycle: $output"
        }
        $workspaceEscaped = [Regex]::Escape($workspace)
        $configContainsWorkspace = Get-ChildItem -LiteralPath $testLocalAppData -Recurse -File `
            -Filter "config.json" -ErrorAction SilentlyContinue | Where-Object {
                (Get-Content -LiteralPath $_.FullName -Raw) -match $workspaceEscaped
            }
        if (-not $configContainsWorkspace) {
            throw "polo run did not persist its workspace registration"
        }
        if (Get-ChildItem -LiteralPath (Join-Path $testRoot "tmp") -Directory `
            -Filter "polo-run-server-*" -ErrorAction SilentlyContinue) {
            throw "polo run left its temporary server runtime behind"
        }
        $sessionResidue = Get-ChildItem -LiteralPath $testLocalAppData -Recurse -Directory `
            -ErrorAction SilentlyContinue | Where-Object {
                $_.FullName -match '[\\/]sessions[\\/][^\\/]+'
            } | Select-Object -First 1
        if ($sessionResidue) {
            throw "polo run left its temporary session behind: $($sessionResidue.FullName)"
        }
        $portMatch = [Regex]::Match($output, 'Server ready: ws://127\.0\.0\.1:(\d+)')
        if (-not $portMatch.Success) {
            throw "polo run did not report its temporary loopback port"
        }
        $tcp = [Net.Sockets.TcpClient]::new()
        try {
            $connect = $tcp.ConnectAsync("127.0.0.1", [int]$portMatch.Groups[1].Value)
            if ($connect.Wait(1000) -and $tcp.Connected) {
                throw "polo run left its temporary loopback port open"
            }
        } catch [System.AggregateException] {
            # Refused/closed is the expected result.
        } finally {
            $tcp.Dispose()
        }
    } finally {
        if ($provider -and -not $provider.HasExited) {
            Stop-Process -Id $provider.Id -Force -ErrorAction SilentlyContinue
            $provider.WaitForExit()
        }
        foreach ($name in $names) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
        }
    }
}

function Test-FullLifecycle {
    $exe = Join-Path $installDir "Polo AI.exe"
    $launcher = Join-Path $testLocalAppData "Polo AI\bin\polo.cmd"
    $runtimeFile = Join-Path $testLocalAppData "Polo AI\runtime\electron.json"

    Invoke-Installer $PreviousArtifact
    $installedPreviousVersion = Test-LegacyInstalledContainer
    if ($installedPreviousVersion -cne $previousVersion) {
        throw "Installed previous version differs from preflight metadata"
    }
    $legacyLauncher = Join-Path $testLocalAppData "Polo AI\bin\polo-ai.cmd"
    if (-not (Test-Path -LiteralPath $legacyLauncher -PathType Leaf)) {
        throw "Previous NSIS did not install its legacy polo-ai launcher"
    }
    $legacyBinDir = Split-Path -Parent $legacyLauncher
    $legacyPathMatches = @(Get-UserPathEntries | Where-Object { $_ -ieq $legacyBinDir })
    if ($legacyPathMatches.Count -ne 1) {
        throw "Previous NSIS did not install its legacy terminal PATH entry exactly once"
    }

    $originalLegacyContent = Get-Content -LiteralPath $legacyLauncher -Raw
    Add-Content -LiteralPath $legacyLauncher -Value "rem user modification"
    Invoke-Installer
    if ((Get-Content -LiteralPath $legacyLauncher -Raw) -notmatch "rem user modification") {
        throw "NSIS upgrade overwrote a modified legacy launcher"
    }
    if (Test-Path -LiteralPath $launcher) {
        throw "NSIS upgrade installed polo despite a modified legacy ownership conflict"
    }
    [IO.File]::WriteAllText($legacyLauncher, $originalLegacyContent)

    Invoke-Installer
    $installedCurrentVersion = Test-InstalledContainer
    if ($installedCurrentVersion -cne $currentVersion) {
        throw "Installed current version differs from preflight metadata"
    }
    Assert-ManagedPathPresent
    if ((Invoke-FreshShell "polo --version") -cne $installedCurrentVersion) {
        throw "Fresh shell did not resolve the upgraded Polo version"
    }
    Invoke-FreshShell "polo --help | findstr /C:`"Usage: polo `" >nul" | Out-Null
    Invoke-PackagedRunLifecycle
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
    if ($userPath -cne $originalUserPath) {
        throw "NSIS uninstall changed PATH entries not owned by Polo"
    }
    Assert-FreshShellCommandAbsent
    Write-Host "Full NSIS real install/discovery/cross-version upgrade/ownership/uninstall E2E passed"
}

New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
if ($Mode -ne "Smoke") {
    $currentVersion = Get-CurrentNsisArtifactVersion $installer "current"
    if (-not $currentVersion) {
        throw "Unable to read current strict version"
    }
}
if ($Mode -eq "Full") {
    $previousVersion = Get-LegacyNsisArtifactVersion $PreviousArtifact "previous"
    if (-not $previousVersion) {
        throw "Unable to read legacy previous strict version"
    }
    if ($previousVersion -ceq $currentVersion) {
        throw "Previous artifact version must differ from current artifact ($currentVersion)"
    }
    Write-Host "Read-only NSIS lifecycle preflight passed ($previousVersion -> $currentVersion)"
}

$env:LOCALAPPDATA = $testLocalAppData
try {
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
    Stop-InstalledPoloApp
    [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
    $env:Path = $originalProcessPath
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
