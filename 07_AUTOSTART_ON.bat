@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Sdelano - Enable autostart
net session >nul 2>&1
if errorlevel 1 (
  set "SDELANO_CALLER=%~f0"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:SDELANO_CALLER -Verb RunAs"
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\autostart.ps1" -Action On
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
