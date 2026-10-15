@echo off
REM Double-click to start an online session.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-session.ps1"
if errorlevel 1 pause
