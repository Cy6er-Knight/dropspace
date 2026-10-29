@echo off
rem Double-click this file on Windows to start Dropspace.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Dropspace needs Node.js, which is free. Opening the download page now.
  echo   Install it ^(the LTS version^), then double-click this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node server.js %*
pause
