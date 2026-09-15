@echo off
title Ovolve Agent - Desktop AI Autonomous Engineering System
echo ========================================================
echo         Ovolve Agent - Autonomous AI Engineering
echo ========================================================
echo.

echo [1/3] Checking environment prerequisites...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not found on PATH. Please install Python 3.10+ first.
    pause
    exit /b 1
)

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not found on PATH. Please install Node.js 18+ first.
    pause
    exit /b 1
)

echo [2/3] Launching Ovolve High-Performance Backend (Port 8000)...
start "Ovolve Backend" /min cmd /c "cd /d %~dp0app\backend && python -m uvicorn server.http_server:app --port 8000 --host 127.0.0.1"

echo [3/3] Launching Ovolve Next-Gen UI (Port 3000)...
start "Ovolve UI" /min cmd /c "cd /d %~dp0app\ui && npm run dev"

timeout /t 3 >nul
echo.
echo ========================================================
echo  Ovolve Agent is successfully running!
echo  Opening: http://localhost:3000
echo ========================================================
start http://localhost:3000

exit /b 0
