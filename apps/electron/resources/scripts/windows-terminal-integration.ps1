param(
    [ValidateSet("Install", "Uninstall")]
    [string]$Mode = "Install",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Polo AI"
)

$ErrorActionPreference = "Stop"
$binDir = "$env:LOCALAPPDATA\Polo AI\bin"
$launcher = Join-Path $binDir "polo.cmd"
$legacyLauncher = Join-Path $binDir "polo-ai.cmd"
$exePath = Join-Path $InstallDir "Polo AI.exe"
$marker = "Polo CLI launcher (managed by Polo AI)"

function Write-AtomicAscii([string]$Path, [string]$Content) {
    $temp = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        Set-Content -Path $temp -Value $Content -Encoding ASCII
        Move-Item -Path $temp -Destination $Path -Force
    } finally {
        Remove-Item -Path $temp -Force -ErrorAction SilentlyContinue
    }
}

function Is-Managed([string]$Path, [string]$Pattern) {
    return (Test-Path $Path) -and ((Get-Content $Path -Raw) -match $Pattern)
}

if ($Mode -eq "Install") {
    if (-not (Test-Path $exePath)) {
        throw "Polo executable not found: $exePath"
    }

    $existing = Get-Command polo -ErrorAction SilentlyContinue
    if ($existing -and $existing.Source -ne $launcher) {
        throw "Another command named polo already exists at $($existing.Source). Polo did not overwrite it."
    }
    if ((Test-Path $launcher) -and -not (Is-Managed $launcher "managed by Polo AI")) {
        throw "Another file already exists at $launcher. Polo did not overwrite it."
    }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $content = @"
@echo off
rem $marker
if /I "%~1"=="app" (
  shift
  start "" "$exePath" %*
  exit /b 0
)
"$exePath" --polo-cli %*
exit /b %ERRORLEVEL%
"@
    Write-AtomicAscii $launcher $content

    if (-not (Test-Path $legacyLauncher) -or (Is-Managed $legacyLauncher "Polo AI|managed by Polo AI|deprecated")) {
        $legacy = "@echo off`r`necho Warning: 'polo-ai' is deprecated; use 'polo' instead. 1>&2`r`ncall `"$launcher`" %*`r`nexit /b %ERRORLEVEL%"
        Write-AtomicAscii $legacyLauncher $legacy
    }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") })) {
        [Environment]::SetEnvironmentVariable("Path", (($entries + $binDir) -join ";"), "User")
    }
    exit 0
}

if (Is-Managed $launcher "managed by Polo AI") {
    Remove-Item -Path $launcher -Force
}
if (Is-Managed $legacyLauncher "deprecated; use 'polo'") {
    Remove-Item -Path $legacyLauncher -Force
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$remaining = @($userPath -split ";" | Where-Object {
    $_ -and $_.TrimEnd("\") -ine $binDir.TrimEnd("\")
})
[Environment]::SetEnvironmentVariable("Path", ($remaining -join ";"), "User")

if ((Test-Path $binDir) -and -not (Get-ChildItem $binDir -Force | Select-Object -First 1)) {
    Remove-Item $binDir -Force
}
