@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AI PR Review Assistant
echo ========================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

echo [INFO] Starting Web UI...
echo.
echo   Local:  http://localhost:3300

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set LAN_IP=%%a
    goto :show
)
:show
set LAN_IP=%LAN_IP: =%
if "%LAN_IP%" neq "" echo   LAN:    http://%LAN_IP%:3300
echo.
call npx tsx src/server.ts
pause
