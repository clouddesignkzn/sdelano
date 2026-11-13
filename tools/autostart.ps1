# Enables or disables starting the site together with Windows (Task Scheduler, SYSTEM account).
# Called by 07_AUTOSTART_ON.bat and 08_AUTOSTART_OFF.bat with administrator rights.
param([Parameter(Mandatory = $true)][ValidateSet('On', 'Off')][string]$Action)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$TaskName = 'Sdelano Web'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Launcher = Join-Path $Root 'launcher.py'
$RunService = Join-Path $PSScriptRoot 'run_service.cmd'

function Invoke-Launcher([string]$Command, [switch]$Show) {
    # local_config.bat is a batch file, so the settings are loaded through cmd.
    $line = "call `"$PSScriptRoot\project_env.bat`" && `"$Python`" `"$Launcher`" $Command"
    if ($Command -eq 'start') { $line += ' --no-browser' }
    if ($Show) { & cmd.exe /d /c $line | Out-Host } else { & cmd.exe /d /c $line | Out-Null }
    return [int]$LASTEXITCODE
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '[ERROR] Administrator rights are required.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Python)) {
    Write-Host '[ERROR] .venv not found. Run 01_INSTALL.bat first.' -ForegroundColor Red
    exit 1
}

if ($Action -eq 'On') {
    Write-Host '[1/3] Stopping a manually started copy (if any)...'
    [void](Invoke-Launcher 'stop' -Show)

    Write-Host '[2/3] Preparing a low-privilege account (LOCAL SERVICE)...'
    # The site runs as LOCAL SERVICE: it can read the project and write only to data\.
    # It cannot touch user files or system settings even if it were compromised.
    $basePython = (& $Python -c "import sys; print(sys.base_prefix)").Trim()
    $dataDir = Join-Path $Root 'data'
    New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'logs') | Out-Null
    & icacls.exe $Root /grant '*S-1-5-19:(OI)(CI)RX' /Q | Out-Null
    & icacls.exe $dataDir /grant '*S-1-5-19:(OI)(CI)M' /T /C /Q | Out-Null
    if ($basePython -and (Test-Path $basePython)) { & icacls.exe $basePython /grant '*S-1-5-19:(OI)(CI)RX' /Q | Out-Null }

    $taskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c "' + $RunService + '"') -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

    function Register-AndWait([string]$Account) {
        $taskPrincipal = New-ScheduledTaskPrincipal -UserId $Account -LogonType ServiceAccount -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
            -Principal $taskPrincipal -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if ((Invoke-Launcher 'status') -eq 0) { return $true }
        }
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
        return $false
    }

    Write-Host '[3/3] Registering the task "Sdelano Web" and starting...'
    $ok = Register-AndWait 'NT AUTHORITY\LOCALSERVICE'
    if (-not $ok) {
        Write-Host '[WARN] The site did not start as LOCAL SERVICE (usually: Python is installed in a folder' -ForegroundColor Yellow
        Write-Host '       this account cannot read). Falling back to the SYSTEM account.' -ForegroundColor Yellow
        $ok = Register-AndWait 'NT AUTHORITY\SYSTEM'
    }
    if ($ok) {
        Write-Host ''
        Write-Host '[OK] Autostart is enabled. The site starts with Windows, even before anyone logs in,' -ForegroundColor Green
        Write-Host '     and restarts automatically within a minute if it ever crashes.' -ForegroundColor Green
        exit 0
    }
    Write-Host '[ERROR] The task was created but the site did not answer. See data\logs\service.log' -ForegroundColor Red
    exit 2
}

Write-Host '[1/2] Stopping the task...'
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Write-Host '[2/2] Stopping the site and removing the LOCAL SERVICE permissions...'
[void](Invoke-Launcher 'stop' -Show)
& icacls.exe $Root /remove '*S-1-5-19' /T /C /Q 2>$null | Out-Null
$basePython = (& $Python -c "import sys; print(sys.base_prefix)").Trim()
if ($basePython -and (Test-Path $basePython)) { & icacls.exe $basePython /remove '*S-1-5-19' /Q 2>$null | Out-Null }
Write-Host ''
Write-Host '[OK] Autostart is disabled. Start the site manually with 02_START.bat when needed.' -ForegroundColor Green
exit 0
