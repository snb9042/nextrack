@echo off
title NexTrack v2
color 0B

echo.
echo  ╔══════════════════════════════════════╗
echo  ║         NexTrack v2 - Starting       ║
echo  ╚══════════════════════════════════════╝
echo.

:: Check if node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Download from nodejs.org
    pause
    exit /b 1
)

:: Check if Python is available
py --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [WARN] Python ^(py launcher^) not found.
    echo         Apple + Google sync will use simulation mode.
    echo         Install Python from python.org to enable real tracking.
    echo.
)

:: Move into backend directory
cd /d "%~dp0backend"

:: Install Node dependencies if node_modules is missing
if not exist "node_modules" (
    echo  Installing Node dependencies...
    call npm install
    echo.
)

:: Install Python dependencies if pyicloud is missing
py -c "import pyicloud" >nul 2>&1
if %errorlevel% neq 0 (
    echo  Installing Python dependencies...
    py -m pip install -r requirements.txt
    echo.
)

:: Kill anything on port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 " ^| findstr "LISTENING"') do (
    echo  Freeing port 3001 ^(PID %%a^)...
    taskkill /PID %%a /F >nul 2>&1
)

echo  Starting NexTrack backend...
echo  Open http://localhost:3001 in your browser.
echo.
echo  Press Ctrl+C to stop.
echo.

:: Start the server
node server.js

pause
