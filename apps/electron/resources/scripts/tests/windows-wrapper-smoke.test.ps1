$ErrorActionPreference = "Stop"

$binSource = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "bin"
$root = Join-Path ([IO.Path]::GetTempPath()) "polo wrapper 空格-$PID-$([Guid]::NewGuid().ToString('N'))"
$resources = Join-Path $root "Polo 应用 with spaces\resources"
$appRoot = Join-Path $resources "app"
$binDir = Join-Path $appRoot "resources\bin"
$runtimeDir = Join-Path $resources "vendor\bun"
$cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
$serverPath = Join-Path $appRoot "dist\server\polo-server.js"
$record = Join-Path $root "wrapper-record.json"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Force -Path `
        $binDir, $runtimeDir, (Split-Path -Parent $cliPath), (Split-Path -Parent $serverPath) | Out-Null
    Copy-Item -LiteralPath (Join-Path $binSource "polo.cmd") -Destination $binDir
    Copy-Item -LiteralPath (Join-Path $binSource "polo-ai.cmd") -Destination $binDir
    Set-Content -LiteralPath $cliPath -Value "fixture cli" -Encoding UTF8
    Set-Content -LiteralPath $serverPath -Value "fixture server" -Encoding UTF8

    $source = @"
using System;
using System.IO;
using System.Text;
public static class FixtureBun {
  private static string Escape(string value) {
    return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
  }
  public static int Main(string[] args) {
    var record = Environment.GetEnvironmentVariable("POLO_WRAPPER_RECORD");
    var values = Array.ConvertAll(args, value => "\"" + Escape(value) + "\"");
    var json = "{" +
      "\"argv\":[" + String.Join(",", values) + "]," +
      "\"bun\":\"" + Escape(Environment.GetEnvironmentVariable("POLO_AI_BUN") ?? "") + "\"," +
      "\"server\":\"" + Escape(Environment.GetEnvironmentVariable("POLO_AI_SERVER_ENTRY") ?? "") + "\"," +
      "\"appRoot\":\"" + Escape(Environment.GetEnvironmentVariable("POLO_AI_APP_ROOT") ?? "") + "\"," +
      "\"resources\":\"" + Escape(Environment.GetEnvironmentVariable("POLO_AI_RESOURCES_PATH") ?? "") + "\"," +
      "\"packaged\":\"" + Escape(Environment.GetEnvironmentVariable("POLO_AI_IS_PACKAGED") ?? "") + "\"}";
    File.WriteAllText(record, json, new UTF8Encoding(false));
    return 37;
  }
}
"@
    Add-Type -TypeDefinition $source -OutputAssembly (Join-Path $runtimeDir "bun.exe") `
        -OutputType ConsoleApplication

    $env:POLO_WRAPPER_RECORD = $record
    & (Join-Path $binDir "polo.cmd") "--fixture" "value with spaces" "参数"
    Assert-True ($LASTEXITCODE -eq 37) "polo.cmd did not preserve the runtime exit code"
    $data = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    Assert-True (($data.argv -join "|") -ceq "run|$cliPath|--fixture|value with spaces|参数") `
        "polo.cmd did not preserve arguments"
    Assert-True ($data.bun -ceq (Join-Path $runtimeDir "bun.exe")) "polo.cmd resolved the wrong Bun"
    Assert-True ($data.server -ceq $serverPath) "polo.cmd resolved the wrong server"
    Assert-True ($data.appRoot -ceq $appRoot) "polo.cmd resolved the wrong app root"
    Assert-True ($data.resources -ceq (Join-Path $appRoot "resources")) "polo.cmd set wrong resources"
    Assert-True ($data.packaged -ceq "true") "polo.cmd omitted packaged mode"

    & (Join-Path $binDir "polo-ai.cmd") "兼容" "space arg"
    Assert-True ($LASTEXITCODE -eq 37) "polo-ai.cmd did not preserve the runtime exit code"
    $compat = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    Assert-True (($compat.argv -join "|") -ceq "run|$cliPath|兼容|space arg") `
        "polo-ai.cmd did not preserve arguments"

    $env:POLO_AI_LOCALE = "zh-CN"
    $warningOutput = (& (Join-Path $binDir "polo-ai.cmd") "--version" 2>&1 | Out-String)
    Assert-True ($warningOutput.Contains("POLO_W_DEPRECATED_COMMAND")) `
        "polo-ai.cmd did not emit a stable warning code"
    Assert-True ($warningOutput.Contains("已弃用")) `
        "polo-ai.cmd did not localize its warning"

    $savedRuntime = "$($runtimeDir)\bun.saved.exe"
    Move-Item -LiteralPath (Join-Path $runtimeDir "bun.exe") -Destination $savedRuntime
    $missingRuntime = (& (Join-Path $binDir "polo.cmd") "--version" 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 1) "polo.cmd did not reject a missing runtime"
    Assert-True ($missingRuntime.Contains("POLO_E_BUNDLED_RUNTIME_MISSING")) `
        "polo.cmd omitted the stable runtime error code"
    Assert-True ($missingRuntime.Contains("Polo 内置运行时缺失")) `
        "polo.cmd did not localize the missing runtime error"
    Move-Item -LiteralPath $savedRuntime -Destination (Join-Path $runtimeDir "bun.exe")

    $env:POLO_AI_LOCALE = "fr-FR"
    $savedCli = "$cliPath.saved"
    Move-Item -LiteralPath $cliPath -Destination $savedCli
    $missingFiles = (& (Join-Path $binDir "polo.cmd") "--version" 2>&1 | Out-String)
    Assert-True ($LASTEXITCODE -eq 1) "polo.cmd did not reject missing terminal files"
    Assert-True ($missingFiles.Contains("POLO_E_TERMINAL_FILES_MISSING")) `
        "polo.cmd omitted the stable terminal-files error code"
    Assert-True ($missingFiles.Contains("Polo terminal files are missing")) `
        "polo.cmd did not use the base-locale fallback"
    Move-Item -LiteralPath $savedCli -Destination $cliPath
    Write-Host "Windows checked-in Polo wrapper smoke passed."
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
