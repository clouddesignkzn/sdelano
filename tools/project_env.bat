@echo off
rem Resolves the project from this file's location, never from the caller's working folder.
set "SDELANO_ROOT="
for %%I in ("%~dp0..") do set "SDELANO_ROOT=%%~fI"
if not exist "%SDELANO_ROOT%\launcher.py" (
  echo [ERROR] Project folder not found: "%SDELANO_ROOT%"
  exit /b 2
)
set "SDELANO_PY=%SDELANO_ROOT%\.venv\Scripts\python.exe"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONDONTWRITEBYTECODE=1"
if exist "%SDELANO_ROOT%\local_config.bat" call "%SDELANO_ROOT%\local_config.bat"
exit /b 0
