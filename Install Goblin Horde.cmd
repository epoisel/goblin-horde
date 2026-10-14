@echo off
rem Double-click to install or update Goblin Horde from this folder. Nothing needs administrator rights.
setlocal
cd /d "%~dp0"
rem Opened straight from the ZIP, Windows extracts only this file to a temporary folder.
if not exist "%~dp0goblin.mjs" goto :not_extracted
if not exist "%~dp0lib\manager.mjs" goto :not_extracted
where node >nul 2>nul
if errorlevel 1 (
  echo Goblin Horde needs Node.js 20 or newer, and it is not installed yet.
  echo Opening the Node.js download page: install the LTS version, then double-click this file again.
  start "" "https://nodejs.org/en/download"
  echo.
  pause
  exit /b 1
)
node goblin.mjs setup
if errorlevel 1 (
  echo.
  echo Setup did not finish. The message above says why.
)
echo.
pause
exit /b 0

:not_extracted
echo Goblin Horde has to be unzipped before it can be installed.
echo.
echo Right-click the ZIP, choose Extract All, then run Install Goblin Horde.cmd from the extracted folder.
echo.
pause
exit /b 1
