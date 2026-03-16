@echo off
echo ========================================
echo    ZABOR - Сборка установщика
echo ========================================
echo.

echo [1/2] Сборка проекта...
call npx electron-vite build
if %errorlevel% neq 0 (
    echo ОШИБКА: electron-vite build failed
    pause
    exit /b 1
)

echo.
echo [2/2] Создание установщика...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win

if %errorlevel% neq 0 (
    echo ОШИБКА: electron-builder failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo    ГОТОВО! Версия: см. package.json
echo ========================================
echo.
echo Установщик: release\ZABOR-Setup-*.exe
echo.
explorer release
pause