@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Sdelano - Status
call "%~dp0tools\project_env.bat"
if errorlevel 1 (pause & exit /b 2)
if not exist "%SDELANO_PY%" (
  echo [ERROR] .venv not found. Run 01_INSTALL.bat first.
  pause
  exit /b 2
)
cd /d "%SDELANO_ROOT%"
"%SDELANO_PY%" launcher.py status
echo.
pause
exit /b 0
