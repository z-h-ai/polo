param(
    [switch]$AsciiOnly
)

$ErrorActionPreference = "Stop"

function ConvertFrom-Base64Utf8([string]$Value) {
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

$unicodeSpaces = ConvertFrom-Base64Utf8 "56m65qC8"
$appLabel = ConvertFrom-Base64Utf8 "5bqU55So"
$userLabel = ConvertFrom-Base64Utf8 "55So5oi3"
$fixtureArgument = ConvertFrom-Base64Utf8 "5Y+C5pWw"
$compatArgument = ConvertFrom-Base64Utf8 "5YW85a65"
$deprecatedText = ConvertFrom-Base64Utf8 "5bey5byD55So"
$missingRuntimeText = ConvertFrom-Base64Utf8 "UG9sbyDlhoXnva7ov5DooYzml7bnvLrlpLHvvIzor7fph43mlrDlronoo4UgUG9sb+OAgg=="
$movedLabel = ConvertFrom-Base64Utf8 "5bey56e75Yqo"
$rootPathLabel = if ($AsciiOnly) { "spaces" } else { $unicodeSpaces }
$appPathLabel = if ($AsciiOnly) { "app" } else { $appLabel }
$binPathLabel = if ($AsciiOnly) { "user" } else { $userLabel }
$movedPathLabel = if ($AsciiOnly) { "moved" } else { $movedLabel }
$fixtureInvocationArgument = if ($AsciiOnly) { "fixture-ascii" } else { $fixtureArgument }
$compatInvocationArgument = if ($AsciiOnly) { "compat-ascii" } else { $compatArgument }

$binSource = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "bin"
$root = Join-Path ([IO.Path]::GetTempPath()) "polo wrapper $rootPathLabel-$PID-$([Guid]::NewGuid().ToString('N'))"
$resources = Join-Path $root "Polo $appPathLabel with spaces\resources"
$appRoot = Join-Path $resources "app"
$binDir = Join-Path $appRoot "resources\bin"
$scriptDir = Join-Path $appRoot "resources\scripts"
$runtimeDir = Join-Path $resources "vendor\bun"
$cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
$serverPath = Join-Path $appRoot "dist\server\polo-server.js"
$record = Join-Path $root "wrapper-record.json"
$installDir = Split-Path -Parent $resources
$installedBin = Join-Path $root "$binPathLabel terminal bin"
$integrationScript = Join-Path $scriptDir "windows-terminal-integration.ps1"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-CapturedNativeCommand([scriptblock]$Action) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # A compatibility warning and the fixture's deliberate nonzero exit
        # are test inputs. Windows PowerShell 5.1 turns redirected stderr
        # into a terminating NativeCommandError when this remains Stop.
        $ErrorActionPreference = "Continue"
        return (& $Action 2>&1 | Out-String)
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

try {
    New-Item -ItemType Directory -Force -Path `
        $binDir, $scriptDir, $runtimeDir, (Split-Path -Parent $cliPath), (Split-Path -Parent $serverPath) | Out-Null
    Copy-Item -LiteralPath (Join-Path $binSource "polo.cmd") -Destination $binDir
    Copy-Item -LiteralPath (Join-Path $binSource "polo-ai.cmd") -Destination $binDir
    Copy-Item -LiteralPath (Join-Path $binSource "polo-messages.cmd") -Destination $binDir
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "windows-terminal-integration.ps1") `
        -Destination $integrationScript
    New-Item -ItemType File -Force -Path (Join-Path $installDir "Polo AI.exe") | Out-Null
    Set-Content -LiteralPath $cliPath -Value "fixture cli" -Encoding UTF8
    Set-Content -LiteralPath $serverPath -Value "fixture server" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $appRoot "package.json") -Value '{"version":"0.15.8"}' -Encoding ASCII

    # The test must be parsed by Windows PowerShell 5.1, which reads a
    # UTF-8-without-BOM script using its legacy code page. Keep the fixture
    # ASCII-only and decode it explicitly so its C# syntax cannot be parsed
    # as PowerShell source.
    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
        "dXNpbmcgU3lzdGVtOwp1c2luZyBTeXN0ZW0uSU87CnVzaW5nIFN5c3RlbS5UZXh0OwpwdWJsaWMgc3RhdGljIGNsYXNzIEZpeHR1cmVCdW4gewogIHByaXZhdGUgc3RhdGljIHN0cmluZyBFc2NhcGUoc3RyaW5nIHZhbHVlKSB7CiAgICByZXR1cm4gdmFsdWUuUmVwbGFjZSgiXFwiLCAiXFxcXCIpLlJlcGxhY2UoIlwiIiwgIlxcXCIiKTsKICB9CiAgcHVibGljIHN0YXRpYyBpbnQgTWFpbihzdHJpbmdbXSBhcmdzKSB7CiAgICB2YXIgcmVjb3JkID0gRW52aXJvbm1lbnQuR2V0RW52aXJvbm1lbnRWYXJpYWJsZSgiUE9MT19XUkFQUEVSX1JFQ09SRCIpOwogICAgdmFyIHZhbHVlcyA9IEFycmF5LkNvbnZlcnRBbGwoYXJncywgdmFsdWUgPT4gIlwiIiArIEVzY2FwZSh2YWx1ZSkgKyAiXCIiKTsKICAgIHZhciBqc29uID0gInsiICsKICAgICAgIlwiYXJndlwiOlsiICsgU3RyaW5nLkpvaW4oIiwiLCB2YWx1ZXMpICsgIl0sIiArCiAgICAgICJcImJ1blwiOlwiIiArIEVzY2FwZShFbnZpcm9ubWVudC5HZXRFbnZpcm9ubWVudFZhcmlhYmxlKCJQT0xPX0FJX0JVTiIpID8/ICIiKSArICJcIiwiICsKICAgICAgIlwic2VydmVyXCI6XCIiICsgRXNjYXBlKEVudmlyb25tZW50LkdldEVudmlyb25tZW50VmFyaWFibGUoIlBPTE9fQUlfU0VSVkVSX0VOVFJZIikgPz8gIiIpICsgIlwiLCIgKwogICAgICAiXCJhcHBSb290XCI6XCIiICsgRXNjYXBlKEVudmlyb25tZW50LkdldEVudmlyb25tZW50VmFyaWFibGUoIlBPTE9fQUlfQVBQX1JPT1QiKSA/PyAiIikgKyAiXCIsIiArCiAgICAgICJcInJlc291cmNlc1wiOlwiIiArIEVzY2FwZShFbnZpcm9ubWVudC5HZXRFbnZpcm9ubWVudFZhcmlhYmxlKCJQT0xPX0FJX1JFU09VUkNFU19QQVRIIikgPz8gIiIpICsgIlwiLCIgKwogICAgICAiXCJhc3NldHNSb290XCI6XCIiICsgRXNjYXBlKEVudmlyb25tZW50LkdldEVudmlyb25tZW50VmFyaWFibGUoIlBPTE9fQUlfQlVORExFRF9BU1NFVFNfUk9PVCIpID8/ICIiKSArICJcIiwiICsKICAgICAgIlwicGFja2FnZWRcIjpcIiIgKyBFc2NhcGUoRW52aXJvbm1lbnQuR2V0RW52aXJvbm1lbnRWYXJpYWJsZSgiUE9MT19BSV9JU19QQUNLQUdFRCIpID8/ICIiKSArICJcIn0iOwogICAgRmlsZS5Xcml0ZUFsbFRleHQocmVjb3JkLCBqc29uLCBuZXcgVVRGOEVuY29kaW5nKGZhbHNlKSk7CiAgICByZXR1cm4gMzc7CiAgfQp9Cg=="
    ))
    # PowerShell 7's Add-Type deliberately no longer emits executable
    # assemblies. Compile a real fixture bun.exe with the .NET Framework C#
    # compiler so cmd.exe exercises the same process boundary as the packaged
    # launcher.
    $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path -LiteralPath $compiler)) {
        throw "Windows C# compiler not found: $compiler"
    }
    $fixtureSource = Join-Path $runtimeDir "fixture-bun.cs"
    [IO.File]::WriteAllText($fixtureSource, $source, [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:exe "/out:$(Join-Path $runtimeDir 'bun.exe')" $fixtureSource
    if ($LASTEXITCODE -ne 0) {
        throw "Could not compile fixture bun.exe"
    }

    $env:POLO_WRAPPER_RECORD = $record
    & $integrationScript -Mode Install -InstallDir $installDir -BinDir $installedBin `
        -UserPathFile (Join-Path $root "user-path.txt") -SkipCommandConflict
    foreach ($name in @("polo.cmd", "polo-ai.cmd", "polo-messages.cmd")) {
        $installedContent = [IO.File]::ReadAllText((Join-Path $installedBin $name))
        Assert-True ($installedContent.Contains("`r`n")) "$name was not written with CRLF line endings"
    }

    & (Join-Path $installedBin "polo.cmd") "--fixture" "value with spaces" $fixtureInvocationArgument
    Assert-True ($LASTEXITCODE -eq 37) "polo.cmd did not preserve the runtime exit code"
    $data = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    $expectedArgs = "run|$cliPath|--fixture|value with spaces|$fixtureInvocationArgument"
    $actualArgs = $data.argv -join "|"
    Assert-True ($actualArgs -ceq $expectedArgs) `
        "polo.cmd did not preserve arguments (expected: $expectedArgs; actual: $actualArgs)"
    Assert-True ($data.bun -ceq (Join-Path $runtimeDir "bun.exe")) "polo.cmd resolved the wrong Bun"
    Assert-True ($data.server -ceq $serverPath) "polo.cmd resolved the wrong server"
    Assert-True ($data.appRoot -ceq $appRoot) "polo.cmd resolved the wrong app root"
    Assert-True ($data.resources -ceq (Join-Path $appRoot "dist\resources")) "polo.cmd set wrong resources"
    Assert-True ($data.assetsRoot -ceq (Join-Path $appRoot "dist")) "polo.cmd set wrong assets root"
    Assert-True ($data.packaged -ceq "true") "polo.cmd omitted packaged mode"

    & (Join-Path $installedBin "polo-ai.cmd") $compatInvocationArgument "space arg"
    Assert-True ($LASTEXITCODE -eq 37) "polo-ai.cmd did not preserve the runtime exit code"
    $compat = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    Assert-True (($compat.argv -join "|") -ceq "run|$cliPath|$compatInvocationArgument|space arg") `
        "polo-ai.cmd did not preserve arguments"

    $env:POLO_AI_LOCALE = "zh-CN"
    $warningOutput = Invoke-CapturedNativeCommand { & (Join-Path $installedBin "polo-ai.cmd") "--version" }
    Assert-True ($warningOutput.Contains("POLO_W_DEPRECATED_COMMAND")) `
        "polo-ai.cmd did not emit a stable warning code"
    if (-not $AsciiOnly) {
        Assert-True ($warningOutput.Contains($deprecatedText)) `
            "polo-ai.cmd did not localize its warning"
    }

    $savedRuntime = "$($runtimeDir)\bun.saved.exe"
    Move-Item -LiteralPath (Join-Path $runtimeDir "bun.exe") -Destination $savedRuntime
    $missingRuntime = Invoke-CapturedNativeCommand { & (Join-Path $installedBin "polo.cmd") "--version" }
    Assert-True ($LASTEXITCODE -eq 1) "polo.cmd did not reject a missing runtime"
    Assert-True ($missingRuntime.Contains("POLO_E_BUNDLED_RUNTIME_MISSING")) `
        "polo.cmd omitted the stable runtime error code"
    if (-not $AsciiOnly) {
        Assert-True ($missingRuntime.Contains($missingRuntimeText)) `
            "polo.cmd did not localize the missing runtime error"
    }
    Move-Item -LiteralPath $savedRuntime -Destination (Join-Path $runtimeDir "bun.exe")

    $env:POLO_AI_LOCALE = "fr-FR"
    $savedCli = "$cliPath.saved"
    Move-Item -LiteralPath $cliPath -Destination $savedCli
    $missingFiles = Invoke-CapturedNativeCommand { & (Join-Path $installedBin "polo.cmd") "--version" }
    Assert-True ($LASTEXITCODE -eq 1) "polo.cmd did not reject missing terminal files"
    Assert-True ($missingFiles.Contains("POLO_E_TERMINAL_FILES_MISSING")) `
        "polo.cmd omitted the stable terminal-files error code"
    Assert-True ($missingFiles.Contains("Polo terminal files are missing")) `
        "polo.cmd did not use the base-locale fallback"
    Move-Item -LiteralPath $savedCli -Destination $cliPath

    # The installed copy resolves its App root through a self-relative owned
    # sidecar. `app` remains a normal CLI subcommand.
    & (Join-Path $installedBin "polo.cmd") "app"
    Assert-True ($LASTEXITCODE -eq 37) "Installed polo.cmd did not preserve the runtime exit code"
    $installedData = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    Assert-True (($installedData.argv -join "|") -ceq "run|$cliPath|app") `
        "Installed polo.cmd intercepted app instead of forwarding it to the CLI"

    $movedParent = Join-Path $root "Polo $movedPathLabel"
    Move-Item -LiteralPath (Split-Path -Parent $resources) -Destination $movedParent
    $movedResources = Join-Path $movedParent "resources"
    $movedCli = Join-Path $movedResources "app\dist\cli\polo-cli.js"
    [IO.File]::WriteAllText((Join-Path $installedBin "polo-install-root.txt"), $movedResources)
    & (Join-Path $installedBin "polo.cmd") "sessions"
    Assert-True ($LASTEXITCODE -eq 37) "Moved-App repair did not preserve the runtime exit code"
    $movedData = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    Assert-True (($movedData.argv -join "|") -ceq "run|$movedCli|sessions") `
        "Installed polo.cmd retained a stale absolute App path after repair"
    Write-Host "Windows checked-in Polo wrapper smoke passed."
    # The fixture deliberately proves cmd.exe preserves nonzero application
    # exits. Clear its final test value so the surrounding CI PowerShell
    # process reports this successful test rather than the fixture's 37.
    $global:LASTEXITCODE = 0
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
