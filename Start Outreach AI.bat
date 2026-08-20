@echo off
REM Outreach AI - double-click launcher.
REM Installs dependencies if needed, builds, then serves on 127.0.0.1 and opens
REM your browser.
REM
REM Deliberately not called start.bat: `start` is a cmd builtin, so that name
REM gets shadowed depending on how it's invoked and you end up with a bare
REM console instead of the app.
REM
REM Keep every echoed line plain ASCII: this runs in cmd's OEM codepage, and
REM anything else (em-dashes especially) comes out as mojibake.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download the LTS installer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

REM Default to 0 so an unreadable version can't turn the comparison below into
REM a syntax error.
set MAJOR=0
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set MAJOR=%%v
if %MAJOR% LSS 24 (
  echo.
  echo Node %MAJOR% is too old. Outreach AI needs Node 24 or newer.
  echo Update from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

REM Refuse to start if the port is taken, rather than failing with a stack trace.
REM Filtering on LISTENING first means an outbound connection to someone else's
REM port 3000 can't trigger a false positive.
netstat -ano -p tcp | findstr "LISTENING" | findstr /c:":3000 " >nul
if not errorlevel 1 (
  echo.
  echo Something is already using port 3000, probably Outreach AI in another
  echo window. Check http://127.0.0.1:3000 before starting a second copy.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies, this takes a minute the first time...
  call npm install --no-audit --no-fund || goto :failed
)

REM Always build.
REM
REM The obvious optimisation - skip when .next already exists - is wrong, and
REM caused a real bug. `next dev` used to write to .next too, so the directory
REM could exist while holding a development build or, if a build ran alongside a
REM dev server, a half-overwritten one. Serving that gives a page with no
REM styling and chunk-not-found errors. next.config.ts now separates the two
REM directories, but rebuilding here is still the cheap way to be certain the
REM build matches the current source.
echo Building, this takes a few seconds...
call npm run build || goto :failed

REM Open the browser a moment after the server starts. `ping` rather than
REM `timeout`, which refuses to run when stdin is redirected.
start "" cmd /c "ping -n 5 127.0.0.1 >nul & start http://127.0.0.1:3000"

echo.
echo Outreach AI is running at http://127.0.0.1:3000
echo Close this window to stop it.
echo.
call npm start
exit /b 0

:failed
echo.
echo Setup failed - see the messages above.
pause
exit /b 1
