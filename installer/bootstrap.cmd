@echo off
rem Devil's Eye installer bootstrap - zero-prerequisite launcher for Windows.
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if "%ROOT%"=="" set "ROOT=%CD%\"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%ensure-runtime.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Let the installer close, then run it again.
  pause
  exit /b 1
)