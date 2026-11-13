@echo off
rem Site settings. 01_INSTALL.bat copies this file to local_config.bat (not tracked by git).
rem After editing local_config.bat run 04_RESTART.bat.

rem Port the site listens on. Use the same number as "Forward Port" in Nginx Proxy Manager.
rem Any free port from 20000 to 48000. Do not open it in the router or Windows Firewall.
set "SDELANO_PORT=47391"

rem Address the site listens on:
rem   127.0.0.1  only this computer. Works when Nginx Proxy Manager runs on this same
rem              Windows machine (Docker Desktop: Forward Hostname = host.docker.internal).
rem   0.0.0.0    all network interfaces. Needed when Nginx Proxy Manager runs on another
rem              computer or virtual machine. Do not edit by hand: run 09_PROXY_ACCESS.bat,
rem              it also opens the port in Windows Firewall only for the proxy IP.
set "SDELANO_HOST=127.0.0.1"

rem IP address of Nginx Proxy Manager when it runs on another machine (set by 09_PROXY_ACCESS.bat).
rem When filled in, the site refuses connections from any other address except this computer.
set "SDELANO_TRUSTED_PROXY="

rem Public address of the site: used in link previews and for the www redirect.
set "SDELANO_PUBLIC_URL=https://hvostdoc.online"

rem Extra host names or IPs allowed in requests, comma separated (for example a LAN IP).
set "SDELANO_EXTRA_HOSTS="

rem Strict-Transport-Security header: 1 = on (recommended, the site is served over HTTPS).
set "SDELANO_HSTS=1"

rem Worker threads. 8 is plenty for a static site.
set "SDELANO_THREADS=8"
