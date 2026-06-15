@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI PR Review Assistant - 公网模式
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    pause & exit /b 1
)

if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    call npm install
)

if not exist "ngrok.exe" (
    echo.
    echo [WARNING] ngrok.exe not found!
    echo.
    echo Please download ngrok from: https://ngrok.com/download
    echo Place ngrok.exe in this folder: %~dp0
    echo Then double-click this script again.
    echo.
    pause
    exit /b 1
)

echo [INFO] Starting server on 0.0.0.0:3300...
start /b npx tsx src/server.ts

echo [INFO] Waiting for server to start...
timeout /t 3 /nobreak >nul

echo [INFO] Starting ngrok tunnel...
echo.
echo ========================================
echo   Public URL (share this link):
echo ========================================
ngrok http 3300 --log=stdout
