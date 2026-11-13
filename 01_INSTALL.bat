@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Sdelano - Installation
chcp 65001 >nul 2>nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"

echo ==========================================================
echo   Sdelano (To-Do List) - installation
echo ==========================================================
echo.

set "PY="
where py >nul 2>nul
if not errorlevel 1 (
  py -3.13 -c "import sys" >nul 2>nul && set "PY=py -3.13"
  if not defined PY py -3.12 -c "import sys" >nul 2>nul && set "PY=py -3.12"
  if not defined PY py -3.11 -c "import sys" >nul 2>nul && set "PY=py -3.11"
  if not defined PY py -3.10 -c "import sys" >nul 2>nul && set "PY=py -3.10"
  if not defined PY py -3.14 -c "import sys" >nul 2>nul && set "PY=py -3.14"
)
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY goto :no_python

%PY% -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,15) else 1)"
if errorlevel 1 (
  echo [ERROR] Python 3.10 - 3.14 is required. Found: %PY%
  goto :fail
)

echo [1/5] Virtual environment .venv ...
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
) else (
  echo       Existing .venv is reused.
)

echo [2/5] Python packages (verified by SHA-256 hashes) ...
".venv\Scripts\python.exe" -c "import pip" >nul 2>nul
if errorlevel 1 ".venv\Scripts\python.exe" -m ensurepip --upgrade
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-input --require-hashes --no-deps -r requirements.txt
if errorlevel 1 goto :fail

echo [3/5] Settings ...
if not exist "local_config.bat" (
  copy /y "local_config.example.bat" "local_config.bat" >nul
  if errorlevel 1 goto :fail
  echo       Created local_config.bat with default settings ^(port 47391^).
) else (
  echo       local_config.bat already exists and was kept.
)
call "tools\project_env.bat"
if errorlevel 1 goto :fail

echo [4/5] Self-test ...
"%SDELANO_PY%" -m unittest discover -s tests -p "test_*.py"
if errorlevel 1 (
  echo [ERROR] Self-test failed. Read the messages above.
  goto :fail
)

echo [5/5] Environment check ...
"%SDELANO_PY%" launcher.py check
if errorlevel 1 goto :fail

echo.
echo ==========================================================
echo   Installation complete.
echo   Start the site:          02_START.bat
echo   NPM on another machine:  09_PROXY_ACCESS.bat ^<proxy IP^>   ^(required, otherwise 502^)
echo   Start with Windows:      07_AUTOSTART_ON.bat
echo   Proxy and domain setup:  INSTALL.md
echo ==========================================================
pause
exit /b 0

:no_python
echo [ERROR] Python was not found.
echo Install Python 3.12 or 3.13 from python.org and enable "Add python.exe to PATH".
pause
exit /b 1

:fail
echo.
echo [ERROR] Installation failed. Read the message above.
echo If downloading the package failed, check the Internet connection and run this file again.
pause
exit /b 1
