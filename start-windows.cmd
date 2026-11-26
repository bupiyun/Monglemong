@echo off
setlocal
title MongleMong - Start
cd /d "%~dp0"
if errorlevel 1 goto folder_error

where node.exe >nul 2>&1
if errorlevel 1 goto node_error
where npm.cmd >nul 2>&1
if errorlevel 1 goto node_error
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 goto version_error
if not exist "package.json" goto folder_error
if not exist "package-lock.json" goto folder_error

echo Checking the bundled Cafemong PNG.
node scripts/check-base-assets.mjs
if errorlevel 1 goto asset_error
if not exist "scripts\ensure-electron.mjs" goto folder_error

if not exist "node_modules\.bin\electron.cmd" goto install
if not exist "node_modules\electron\package.json" goto install
if not exist "node_modules\electron\cli.js" goto install
if not exist "node_modules\electron\install.js" goto install
goto ensure_electron

:install
echo Installing MongleMong dependencies. An internet connection is required.
call npm.cmd ci --include=dev
if errorlevel 1 goto install_error
if not exist "node_modules\.bin\electron.cmd" goto install_error
if not exist "node_modules\electron\package.json" goto install_error
if not exist "node_modules\electron\cli.js" goto install_error
if not exist "node_modules\electron\install.js" goto install_error

:ensure_electron
echo Checking the Electron runtime. Missing runtime files will be downloaded.
node scripts/ensure-electron.mjs
if errorlevel 1 goto electron_error

:start
echo Starting MongleMong. Use Ctrl+Shift+M to open or hide its menu.
echo To quit, use the MongleMong tray icon or the in-game settings.
call npm.cmd start
if errorlevel 1 goto start_error
echo MongleMong has closed.
pause
exit /b 0

:node_error
echo Node.js and npm were not found.
echo Install the LTS version from https://nodejs.org, then try again.
goto failed

:version_error
echo MongleMong requires Node.js 22.12 or newer. Install the current LTS version.
goto failed

:folder_error
echo Open this file from the fully extracted MongleMong source folder.
echo Keep package.json, package-lock.json and the scripts folder beside this file.
goto failed

:asset_error
echo Cafemong PNG is missing or invalid. Read the error above.
echo Extract the full source ZIP again. It includes assets\characters\cafemong.png.
goto failed

:install_error
echo Dependency installation failed. Read the npm error above.
echo Check your connection, then run npm.cmd ci in this folder and try again.
goto failed

:electron_error
echo Electron runtime setup failed. Read the installer error above.
echo Check your connection. To retry the official runtime download, run:
echo   node node_modules/electron/install.js
echo Then open start-windows.cmd again.
goto failed

:start_error
echo MongleMong could not start or exited with an error. Read the message above.

:failed
pause
exit /b 1
