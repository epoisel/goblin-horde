@echo off
rem The Start menu and sign-in shortcuts run this, so they keep working after Node.js is updated or moved.
where node >nul 2>nul
if errorlevel 1 (
  echo Goblin Horde needs Node.js, which was not found. Install the LTS version from https://nodejs.org, then try again.
  pause
  exit /b 1
)
node %*
