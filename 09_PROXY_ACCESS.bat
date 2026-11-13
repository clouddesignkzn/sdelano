@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Sdelano - Access for Nginx Proxy Manager on another machine
net session >nul 2>&1
if errorlevel 1 (
  set "SDELANO_CALLER=%~f0"
  set "SDELANO_ARGS=%*"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "if ($env:SDELANO_ARGS) { Start-Process -FilePath $env:SDELANO_CALLER -ArgumentList $env:SDELANO_ARGS -Verb RunAs } else { Start-Process -FilePath $env:SDELANO_CALLER -Verb RunAs }"
  exit /b 0
)
rem Usage: 09_PROXY_ACCESS.bat             asks for the proxy IP
rem        09_PROXY_ACCESS.bat 192.168.1.10
rem        09_PROXY_ACCESS.bat off         back to "this computer only"
if /i "%~1"=="off" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\proxy_access.ps1" -Action Off
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\proxy_access.ps1" -Action On -ProxyIp "%~1"
)
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
