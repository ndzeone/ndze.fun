@echo off
rem Double-click: syncs GitHub repositories into data\repos.json
rem If GITHUB_TOKEN is not set, the script asks for a token (Enter = public only).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-github.ps1" -Ask
echo.
pause
