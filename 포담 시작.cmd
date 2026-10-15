@echo off
chcp 65001 > nul
title Podam
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  ASCII only in this file.
rem  cmd.exe reads .cmd in the system codepage (not UTF-8), so Hangul written
rem  here turns into garbage and breaks parsing. Every message the user should
rem  read lives in the Node launcher, which prints UTF-8 just fine.
rem ---------------------------------------------------------------------------

if exist "%~dp0runtime\node.exe" goto bundled

where node >nul 2>&1
if errorlevel 1 goto nonode
node "%~dp0tools\launcher\start.js" %*
goto done

:bundled
"%~dp0runtime\node.exe" "%~dp0app\tools\launcher\start.js" %*
goto done

:nonode
echo.
echo   [Podam] Node.js was not found.
echo.
echo   - Release zip: unpack the whole folder so that "runtime" sits next to this file.
echo   - From source: install Node 20 or newer from https://nodejs.org
echo.

:done
echo.
pause
