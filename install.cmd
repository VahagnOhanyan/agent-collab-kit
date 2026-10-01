@echo off
rem Installs agent-collab-kit on this machine (Windows): double-click this file, or run "install" in this folder.
rem It only checks Node and runs bin\agent-collab-kit-install from the folder it sits in; arguments are passed on
rem (for example: install --dry-run). Messages are in English: a console's code page may not show other letters.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 20.19 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 (
  echo Node.js 20.19 or newer is needed. This machine has:
  node -v
  echo Update it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0bin\agent-collab-kit-install" --source "%~dp0." %*
set CODE=%ERRORLEVEL%
echo.
if "%CODE%"=="0" (
  echo Done. Open a NEW terminal window, then in your project folder run:  collab connect
) else (
  echo The installation did not finish, and it leaves nothing half-done. The lines above say why.
)
pause
exit /b %CODE%
