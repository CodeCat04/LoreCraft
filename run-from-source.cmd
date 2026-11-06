@echo off
rem Builds LoreCraft from this folder and starts it. Double-click, or run from a terminal.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo LoreCraft needs Node.js 24 or newer, and it is not installed.
  echo Get it from https://nodejs.org/ ^(the LTS download^), then run this again.
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo LoreCraft needs Node.js 24 or newer. This computer has Node.js %NODE_MAJOR%.
  echo Get a newer one from https://nodejs.org/, then run this again.
  goto :fail
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo LoreCraft needs Rust, and it is not installed.
  echo Get it from https://rustup.rs/ ^(choose the default install^), then open a new window and run this again.
  echo Rust on Windows also needs the Visual Studio C++ Build Tools. rustup offers to install them.
  goto :fail
)

if not exist node_modules\ (
  echo Installing packages. This happens only the first time.
  call npm ci
  if errorlevel 1 goto :fail
)

echo Building LoreCraft. The first build takes several minutes.
call npm run app:debug
if errorlevel 1 goto :fail

set "EXE=src-tauri\target\debug\lorecraft.exe"
if defined CARGO_TARGET_DIR set "EXE=%CARGO_TARGET_DIR%\debug\lorecraft.exe"
if not exist "%EXE%" (
  echo The build finished, but %EXE% is missing.
  goto :fail
)
start "" "%EXE%"
exit /b 0

:fail
echo.
pause
exit /b 1
