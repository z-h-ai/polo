param(
    [ValidateSet("x64", "arm64")]
    [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir "..\..\..")

& bun run (Join-Path $RootDir "scripts\electron-dist.ts") `
    "--platform=win32" `
    "--arch=$Arch"
if ($LASTEXITCODE -ne 0) {
    throw "Target-aware Windows Electron release failed with exit code $LASTEXITCODE"
}
