@echo off
setlocal
rem Polo CLI launcher (managed by Polo AI)
for %%I in ("%~dp0..\..") do set "POLO_AI_APP_ROOT=%%~fI"
for %%I in ("%POLO_AI_APP_ROOT%\..") do set "POLO_AI_RESOURCES_ROOT=%%~fI"
set "POLO_AI_BUN=%POLO_AI_RESOURCES_ROOT%\vendor\bun\bun.exe"
set "POLO_AI_SERVER_ENTRY=%POLO_AI_APP_ROOT%\dist\server\polo-server.js"
set "POLO_AI_CLI_ENTRY=%POLO_AI_APP_ROOT%\dist\cli\polo-cli.js"
set "POLO_AI_RESOURCES_PATH=%POLO_AI_APP_ROOT%\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=%POLO_AI_APP_ROOT%"
set "POLO_AI_IS_PACKAGED=true"
set "POLO_AI_DESKTOP_EXECUTABLE=%POLO_AI_RESOURCES_ROOT%\..\Polo AI.exe"

if not exist "%POLO_AI_BUN%" (
  echo Error: Polo's bundled runtime is missing. Reinstall Polo. 1>&2
  exit /b 1
)
if not exist "%POLO_AI_CLI_ENTRY%" (
  echo Error: Polo terminal files are missing. Reinstall Polo. 1>&2
  exit /b 1
)

"%POLO_AI_BUN%" run "%POLO_AI_CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
