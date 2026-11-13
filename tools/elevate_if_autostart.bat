@echo off
rem When autostart is enabled the site runs as a SYSTEM task, and only an administrator
rem may start or stop it. Exit code 10 means "the caller was re-launched as administrator".
schtasks /query /tn "Sdelano Web" >nul 2>&1
if errorlevel 1 exit /b 0
net session >nul 2>&1
if not errorlevel 1 exit /b 0
echo Autostart is enabled: administrator rights are required. Confirm the Windows prompt.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:SDELANO_CALLER -Verb RunAs"
exit /b 10
