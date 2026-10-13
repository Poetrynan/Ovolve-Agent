@echo off
title Ovolve Agent - Desktop AI Autonomous Engineering System
echo ========================================================
echo         Ovolve Agent - Autonomous AI Engineering
echo ========================================================
echo.

echo [1/2] Checking environment prerequisites...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not found on PATH. Please install Node.js 18+ first.
    pause
    exit /b 1
)

echo [2/2] Launching Ovolve Native TypeScript Backend (Port 8765)...
start "Ovolve Backend" /min cmd /c "cd /d %~dp0 && node .\node_modules\tsx\dist\cli.mjs app\engine\main.ts --server"

echo Launching Ovolve UI...
start "Ovolve UI" /min cmd /c "cd /d %~dp0app\ui && npm run dev"

timeout /t 3 >nul
echo.
echo ========================================================
echo  Ovolve Agent is successfully running!
echo  Opening: http://localhost:3000
echo ========================================================
start http://localhost:3000

exit /b 0
