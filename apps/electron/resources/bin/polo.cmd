@echo off
chcp 65001 >nul 2>&1
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
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_RUNTIME=Error: Polo's bundled runtime is missing. Reinstall Polo."
set "POLO_MSG_FILES=Error: Polo terminal files are missing. Reinstall Polo."
if /I "%POLO_LOCALE:~0,2%"=="zh" (
  set "POLO_MSG_RUNTIME=错误：Polo 内置运行时缺失。请重新安装 Polo。"
  set "POLO_MSG_FILES=错误：Polo 终端文件缺失。请重新安装 Polo。"
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
