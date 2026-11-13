@echo off
rem Used by the "Sdelano Web" scheduled task (07_AUTOSTART_ON.bat). Runs the server in the foreground.
setlocal EnableExtensions
call "%~dp0project_env.bat"
if errorlevel 1 exit /b 21
if not exist "%SDELANO_PY%" exit /b 22
cd /d "%SDELANO_ROOT%"
if not exist "%SDELANO_ROOT%\data\logs" mkdir "%SDELANO_ROOT%\data\logs" >nul 2>&1
"%SDELANO_PY%" "%SDELANO_ROOT%\launcher.py" --serve >> "%SDELANO_ROOT%\data\logs\service.log" 2>&1
set "RC=%ERRORLEVEL%"
>> "%SDELANO_ROOT%\data\logs\service.log" echo [%DATE% %TIME%] server exited with code %RC%
exit /b %RC%
