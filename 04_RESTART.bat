@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Sdelano - Restart
call "%~dp0tools\project_env.bat"
if errorlevel 1 (pause & exit /b 2)
if not exist "%SDELANO_PY%" (
  echo [ERROR] .venv not found. Run 01_INSTALL.bat first.
  pause
  exit /b 2
)
set "SDELANO_CALLER=%~f0"
call "%SDELANO_ROOT%\tools\elevate_if_autostart.bat"
if "%ERRORLEVEL%"=="10" exit /b 0
cd /d "%SDELANO_ROOT%"
"%SDELANO_PY%" launcher.py restart --no-browser
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (pause & exit /b %RC%)
timeout /t 5 >nul
exit /b 0
