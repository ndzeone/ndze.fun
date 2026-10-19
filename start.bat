@echo off
start "" http://localhost:8000
powershell -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
