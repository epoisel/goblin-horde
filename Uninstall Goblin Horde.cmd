@echo off
rem Double-click to remove Goblin Horde. It asks first; settings stay unless you also choose to remove them.
setlocal
rem Prefer the installed copy's manager; this file is also installed beside it.
set "GH_MANAGER=%LOCALAPPDATA%\Programs\GoblinHorde\goblin.mjs"
if not exist "%GH_MANAGER%" set "GH_MANAGER=%~dp0goblin.mjs"
rem Run from a folder uninstall does not remove, so the app folder can be deleted.
cd /d "%TEMP%"
if not exist "%GH_MANAGER%" (
  echo Goblin Horde was not found, and this folder has no manager to run.
  echo If you unzipped Goblin Horde, run this file from the extracted folder.
  echo.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Removing Goblin Horde needs Node.js, and it was not found.
  echo.
  pause
  exit /b 1
)
echo This removes Goblin Horde: the app, its Start menu entry, its sign-in shortcut,
echo its manager skills, and its Claude Code hook entries. Your other settings stay.
echo.
choice /c YN /m "Remove Goblin Horde now"
if errorlevel 2 (
  echo Nothing was removed.
  echo.
  pause
  exit /b 0
)
set "GH_RESET="
choice /c YN /n /m "Also remove its saved layout, phone pairing code, and recorded activity? [Y/N] "
if not errorlevel 2 set "GH_RESET=--remove-settings"
rem One block, read before it runs: uninstall may delete this very file.
(
  node "%GH_MANAGER%" uninstall %GH_RESET%
  echo.
  pause
  exit /b 0
)
