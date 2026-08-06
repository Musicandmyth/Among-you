@echo off
setlocal
rem --- Among Ourselves: start the client (P2P host/join happens inside it) ---
cd /d "%~dp0"

rem Ensure Node.js is on PATH (winget installs to %ProgramFiles%\nodejs).
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  ) else (
    echo.
    echo   Node.js was not found. Install the LTS from https://nodejs.org/ and retry.
    echo.
    pause
    exit /b 1
  )
)

rem Install dependencies the first time.
if not exist "node_modules" (
  echo Installing dependencies ^(first run^)...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

rem Open the browser shortly after the server comes up.
start "" cmd /c "timeout /t 3 >nul & start "" http://localhost:5173/"

echo.
echo   Starting client at http://localhost:5173/
echo   Create a game to host, or join with a room code. Press Ctrl+C to stop.
echo.
call npm run dev

endlocal
