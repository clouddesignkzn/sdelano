# Lets Nginx Proxy Manager running on ANOTHER machine reach the site, and nobody else.
#   On : listen on all interfaces, allow the port in Windows Firewall only for the proxy IP,
#        and make the site itself refuse every other client address.
#   Off: back to "this computer only" (127.0.0.1) and remove the firewall rule.
# Called by 09_PROXY_ACCESS.bat with administrator rights.
param(
    [ValidateSet('On', 'Off')][string]$Action = 'On',
    [string]$ProxyIp = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Config = Join-Path $Root 'local_config.bat'
$Example = Join-Path $Root 'local_config.example.bat'
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$RuleName = 'Sdelano: Nginx Proxy Manager'

function Invoke-Launcher([string]$Command) {
    & cmd.exe /d /c "call `"$PSScriptRoot\project_env.bat`" && `"$Python`" `"$Root\launcher.py`" $Command --no-browser" | Out-Host
    return [int]$LASTEXITCODE
}

function Set-ConfigValue([string]$Name, [string]$Value) {
    $lines = [System.Collections.Generic.List[string]]([IO.File]::ReadAllLines($Config))
    $line = "set `"$Name=$Value`""
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*set\s+`"$Name=") { $index = $i; break }
    }
    if ($index -ge 0) { $lines[$index] = $line } else { $lines.Add($line) }
    [IO.File]::WriteAllLines($Config, $lines, (New-Object System.Text.ASCIIEncoding))
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
if (-not (Test-Path $Config)) { Copy-Item $Example $Config }

if ($Action -eq 'Off') {
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Set-ConfigValue 'SDELANO_HOST' '127.0.0.1'
    Set-ConfigValue 'SDELANO_TRUSTED_PROXY' ''
    Write-Host '[OK] The site listens on 127.0.0.1 again, the firewall rule was removed.' -ForegroundColor Green
    [void](Invoke-Launcher 'restart')
    exit 0
}

Write-Host ''
Write-Host 'Nginx Proxy Manager must reach this computer over the local network.'
Write-Host 'Its address is in the NPM panel URL, for example http://192.168.1.10:81'
Write-Host ''
while (-not $ProxyIp) {
    $ProxyIp = (Read-Host 'IP address of the machine with Nginx Proxy Manager').Trim()
}
$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($ProxyIp, [ref]$parsed) -or $parsed.AddressFamily -ne 'InterNetwork') {
    Write-Host "[ERROR] '$ProxyIp' is not an IPv4 address." -ForegroundColor Red
    exit 2
}
$ProxyIp = $parsed.ToString()

$port = (& cmd.exe /d /c "call `"$PSScriptRoot\project_env.bat`" && echo %SDELANO_PORT%").Trim()
if ($port -notmatch '^\d+$') { $port = '47391' }

Write-Host "[1/4] Settings: listen on 0.0.0.0:$port, trusted proxy $ProxyIp ..."
Set-ConfigValue 'SDELANO_HOST' '0.0.0.0'
Set-ConfigValue 'SDELANO_TRUSTED_PROXY' $ProxyIp

Write-Host "[2/4] Windows Firewall: allow TCP $port only from $ProxyIp ..."
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $RuleName -Description 'Sdelano (To-Do List): access for Nginx Proxy Manager only' `
    -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress $ProxyIp -Action Allow -Profile Any | Out-Null

# A "Block" rule for Python (left by a cancelled firewall pop-up) would override the allow rule.
$pythonPaths = @((& $Python -c "import sys, os; print(os.path.join(sys.base_prefix, 'python.exe')); print(os.path.join(sys.base_prefix, 'pythonw.exe'))") | ForEach-Object { $_.Trim().ToLowerInvariant() })
$blocking = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Program -and ($pythonPaths -contains $_.Program.ToLowerInvariant()) } |
    Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' }
foreach ($rule in $blocking) {
    Write-Host "      Disabling a blocking rule for Python: $($rule.DisplayName)" -ForegroundColor Yellow
    $rule | Disable-NetFirewallRule
}

Write-Host '[3/4] Restarting the site ...'
[void](Invoke-Launcher 'restart')

Write-Host '[4/4] Checking ...'
$lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
$ok = $false
try { $ok = ((Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 5).service -eq 'sdelano') } catch {}
if (-not $ok) {
    Write-Host '[ERROR] The site does not answer. Run 05_STATUS.bat and see data\logs\server.log' -ForegroundColor Red
    exit 3
}
Write-Host ''
Write-Host '[OK] Done. In Nginx Proxy Manager, Proxy Host hvostdoc.online must point to:' -ForegroundColor Green
Write-Host "       Scheme: http    Forward Hostname / IP: $lan    Forward Port: $port" -ForegroundColor Green
Write-Host "     Only $ProxyIp (and this computer) can open the port; everyone else is refused." -ForegroundColor Green
exit 0
