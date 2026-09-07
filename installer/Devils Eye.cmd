@echo off
rem Launch Devil's Eye. Close this window to stop the app.
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
where "%NODE%" >nul 2>nul
if errorlevel 1 (
  echo Devil's Eye needs Node.js but it was not found.
  echo Run the installer again to bundle a runtime, or install Node from https://nodejs.org
  pause
  exit /b 1
)
"%NODE%" "%~dp0launcher-app.mjs"
exit /b %errorlevel%