@echo off
chcp 65001 >nul 2>&1
setlocal
set "POLO_AI_DEPRECATED_SHIM=1"
call "%~dp0polo.cmd" %*
exit /b %ERRORLEVEL%
