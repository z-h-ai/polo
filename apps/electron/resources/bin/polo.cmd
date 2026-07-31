@echo off
setlocal
rem Self-contained launcher for the CLI payload inside an Electron installation.
for %%I in ("%~dp0..\..") do set "POLO_AI_APP_ROOT=%%~fI"
for %%I in ("%POLO_AI_APP_ROOT%\..") do set "POLO_AI_RESOURCES_ROOT=%%~fI"
set "POLO_AI_BUN=%POLO_AI_RESOURCES_ROOT%\vendor\bun\bun.exe"
set "POLO_AI_SERVER_ENTRY=%POLO_AI_APP_ROOT%\dist\server\polo-server.js"
set "POLO_AI_CLI_ENTRY=%POLO_AI_APP_ROOT%\dist\cli\polo-cli.js"
set "POLO_AI_RESOURCES_PATH=%POLO_AI_APP_ROOT%\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=%POLO_AI_APP_ROOT%"
set "POLO_AI_IS_PACKAGED=true"
if "%POLO_AI_CLI_JSON_ONLY%"=="" set "POLO_AI_CLI_JSON_ONLY=1"

if not exist "%POLO_AI_BUN%" (
  echo Polo CLI bundled runtime is missing: %POLO_AI_BUN% 1>&2
  exit /b 1
)
if not exist "%POLO_AI_CLI_ENTRY%" (
  echo Polo CLI payload is missing: %POLO_AI_CLI_ENTRY% 1>&2
  exit /b 1
)
if not exist "%POLO_AI_SERVER_ENTRY%" (
  echo Polo CLI server payload is missing: %POLO_AI_SERVER_ENTRY% 1>&2
  exit /b 1
)

"%POLO_AI_BUN%" run "%POLO_AI_CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
