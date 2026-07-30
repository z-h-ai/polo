@echo off
chcp 65001 >nul 2>&1
setlocal
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_DEPRECATED=Warning: 'polo-ai' is deprecated; use 'polo' instead."
if /I "%POLO_LOCALE:~0,2%"=="zh" set "POLO_MSG_DEPRECATED=警告：“polo-ai”已弃用；请改用“polo”。"
echo [POLO_W_DEPRECATED_COMMAND] %POLO_MSG_DEPRECATED% 1>&2
call "%~dp0polo.cmd" %*
exit /b %ERRORLEVEL%
