@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo Starting MathModel Studio (offline provider by default)...
echo Close this window to stop the app.
call npm run dev
if errorlevel 1 pause
endlocal
