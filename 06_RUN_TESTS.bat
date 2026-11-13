@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Sdelano - Tests
call "%~dp0tools\project_env.bat"
if errorlevel 1 (pause & exit /b 2)
if not exist "%SDELANO_PY%" (
  echo [ERROR] .venv not found. Run 01_INSTALL.bat first.
  pause
  exit /b 2
)
cd /d "%SDELANO_ROOT%"
echo [1/3] Server tests (Python) ...
"%SDELANO_PY%" -m unittest discover -s tests -p "test_*.py" -v
if errorlevel 1 goto :failed
where node >nul 2>nul
if errorlevel 1 (
  echo [2/3] Node.js not found: browser-side tests are skipped. Install Node.js 22+ to run them.
  goto :done
)
echo [2/3] Task logic tests (Node.js) ...
node --test tests/store.test.mjs
if errorlevel 1 goto :failed
echo [3/3] End-to-end tests in Chrome ...
set "PYTHON=%SDELANO_PY%"
node tests/e2e.mjs
if errorlevel 1 goto :failed
:done
echo.
echo [OK] All tests passed.
pause
exit /b 0
:failed
echo.
echo [ERROR] Some tests failed. Read the messages above.
pause
exit /b 1
