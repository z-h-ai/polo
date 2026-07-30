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
    $originalPath = "$binDir;C:\User Tools"
    Set-Content -Path $userPathFile -Value $originalPath -Encoding ASCII

    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile -SkipCommandConflict

    $state = Get-Content (Join-Path $binDir "terminal-integration.json") -Raw | ConvertFrom-Json
    Assert-True (-not $state.pathEntryAddedByPolo) "Polo incorrectly claimed a pre-existing PATH entry."
    $launcher = Get-Content (Join-Path $binDir "polo.cmd") -Raw
    Assert-True ($launcher -match [Regex]::Escape("resources\vendor\bun\bun.exe")) "Launcher does not use bundled Bun."
    Assert-True ($launcher -match [Regex]::Escape("dist\cli\polo-cli.js")) "Launcher does not use bundled CLI."
    Assert-True ($launcher -notmatch "--polo-cli") "Launcher still delegates CLI commands to Electron."

    & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $binDir -UserPathFile $userPathFile

    $afterUninstall = (Get-Content $userPathFile -Raw).Trim()
    Assert-True ($afterUninstall -eq $originalPath) "Uninstall removed or changed the user's pre-existing PATH entry."
    Assert-True (-not (Test-Path (Join-Path $binDir "polo.cmd"))) "Managed launcher was not removed."
    Write-Host "Windows terminal integration ownership test passed."
} finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
