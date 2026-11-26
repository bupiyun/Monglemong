@echo off
setlocal EnableExtensions
title MongleMong - Build User Windows Installer
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

echo [1/3] Installing the locked build dependencies.
echo An internet connection is required for the first build.
call npm.cmd ci --include=dev
if errorlevel 1 goto install_error
if not exist "node_modules\.bin\electron-builder.cmd" goto install_error
if not exist "node_modules\electron-builder\package.json" goto install_error
if not exist "node_modules\electron-builder\out\cli\cli.js" goto install_error

:build
echo [2/3] Building the Windows x64 installer.
echo Additional downloads may be required. Keep this window open.
node scripts/build-windows.mjs user
if errorlevel 1 goto build_error
echo [3/3] Checking the installer and bundled game files.
node scripts/verify-windows-package.mjs user
if errorlevel 1 goto verify_error
echo Build and verification complete.
node -e "const p=require('./package.json'); console.log('Installer: release/user/MongleMong-Setup-'+p.version+'-x64.exe')"
echo Install it once, then launch MongleMong from the desktop or Start menu.
echo The installed game does not require Node.js, npm, or a command window.
echo Share the MongleMong-Setup installer, not MongleMong.exe from win-unpacked alone.
start "" explorer.exe "%CD%\release\user"
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
echo Keep package.json and package-lock.json beside this file.
goto failed

:asset_error
echo Cafemong PNG is missing or invalid. Read the error above.
echo Extract the full source ZIP again. It includes assets\characters\cafemong.png.
goto failed

:install_error
echo Dependency installation failed. Read the npm error above.
echo Check your connection, then run npm.cmd ci in this folder and try again.
goto failed

:build_error
echo The Windows installer build failed. Read the electron-builder error above.
echo Check the connection if a build-tool download failed, then try again.
goto failed

:verify_error
echo The installer was built, but package verification failed.
echo Do not distribute this output until the error above is resolved.
echo Save the error text and retry build-windows.cmd after resolving it.

:failed
pause
exit /b 1
