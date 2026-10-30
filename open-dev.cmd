@echo off
setlocal
cd /d "%~dp0"
set MMS_FAKE_PROVIDER=1
set MMS_FAKE_DELAY_MS=20
set ELECTRON_RUN_AS_NODE=
echo Starting mathmodel-studio in offline demo mode...
echo Close this window to stop the app.
call npm run dev
if errorlevel 1 pause
endlocal
