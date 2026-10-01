@echo off
:: Check for administrative rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ====================================================================
    echo Requesting Administrator privileges to install C++ Build Tools...
    echo Please click YES on the Windows prompt on your screen.
    echo ====================================================================
    powershell -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

:: Running as Administrator
cd /d "%~dp0"
title TUARI V2 - Installing Microsoft C++ Build Tools

echo ====================================================================
echo TUARI V2 - Installing Microsoft C++ Build Tools (MSVC Linker ^& SDK)
echo ====================================================================
echo.
echo Installing Visual C++ Tools:
echo   - Microsoft C/C++ Compiler (cl.exe)
echo   - Microsoft C/C++ Linker (link.exe)
echo   - Windows 10/11 SDK (kernel32.lib, user32.lib, etc.)
echo.
echo Please wait while the installer runs (this takes a few minutes)...
echo A progress window will show the download and installation progress.
echo.

"%~dp0vs_BuildTools.exe" --passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended

echo.
echo ====================================================================
echo [SUCCESS] Visual C++ Build Tools and Windows SDK installed!
echo.
echo You can now close this window and run:
echo    npm run tauri dev
echo ====================================================================
pause
