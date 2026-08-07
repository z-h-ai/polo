@echo off
chcp 65001 >nul 2>&1
setlocal
rem Polo CLI launcher (managed by Polo AI)
set "POLO_AI_INSTALL_ROOT_FILE=%~dp0polo-install-root.txt"
if not exist "%POLO_AI_INSTALL_ROOT_FILE%" goto packaged_layout
set /p POLO_AI_RESOURCES_ROOT=<"%POLO_AI_INSTALL_ROOT_FILE%"
for %%I in ("%POLO_AI_RESOURCES_ROOT%") do set "POLO_AI_RESOURCES_ROOT=%%~fI"
set "POLO_AI_APP_ROOT=%POLO_AI_RESOURCES_ROOT%\app"
goto root_ready
:packaged_layout
for %%I in ("%~dp0..\..") do set "POLO_AI_APP_ROOT=%%~fI"
for %%I in ("%POLO_AI_APP_ROOT%\..") do set "POLO_AI_RESOURCES_ROOT=%%~fI"
:root_ready
set "POLO_AI_BUN=%POLO_AI_RESOURCES_ROOT%\vendor\bun\bun.exe"
set "POLO_AI_SERVER_ENTRY=%POLO_AI_APP_ROOT%\dist\server\polo-server.js"
set "POLO_AI_CLI_ENTRY=%POLO_AI_APP_ROOT%\dist\cli\polo-cli.js"
set "POLO_AI_RESOURCES_PATH=%POLO_AI_APP_ROOT%\dist\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=%POLO_AI_APP_ROOT%\dist"
set "POLO_AI_IS_PACKAGED=true"
if "%POLO_AI_CLI_JSON_ONLY%"=="" set "POLO_AI_CLI_JSON_ONLY=1"
set "POLO_AI_DESKTOP_EXECUTABLE=%POLO_AI_RESOURCES_ROOT%\..\Polo AI.exe"
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MESSAGES=%POLO_AI_APP_ROOT%\resources\bin\polo-messages.cmd"
if not exist "%POLO_MESSAGES%" (
  echo [POLO_E_TERMINAL_FILES_MISSING] 1>&2
  exit /b 1
)
call "%POLO_MESSAGES%" "%POLO_LOCALE%"
if "%POLO_AI_DEPRECATED_SHIM%"=="1" (
  echo [POLO_W_DEPRECATED_COMMAND] %POLO_MSG_DEPRECATED% 1>&2
  set "POLO_AI_DEPRECATED_SHIM="
)

if not exist "%POLO_AI_BUN%" (
  echo [POLO_E_BUNDLED_RUNTIME_MISSING] %POLO_MSG_RUNTIME% 1>&2
  exit /b 1
)
if not exist "%POLO_AI_CLI_ENTRY%" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)
if not exist "%POLO_AI_SERVER_ENTRY%" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)

"%POLO_AI_BUN%" run "%POLO_AI_CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
