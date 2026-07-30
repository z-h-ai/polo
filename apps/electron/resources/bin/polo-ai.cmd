@echo off
echo Warning: 'polo-ai' is deprecated; use 'polo' instead. 1>&2
call "%~dp0polo.cmd" %*
exit /b %ERRORLEVEL%
