@echo off
setlocal
:: Use Microsoft's signed online installer; do not keep it in the source tree.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges for Microsoft C++ Build Tools...
    powershell -NoProfile -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/c', ('""' + $args[0] + '""') -Verb RunAs" "%~f0"
    exit /b
)
set "buildInstaller=%TEMP%\2pixelshorts-vs-BuildTools.exe"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $env:buildInstaller; $signature=Get-AuthenticodeSignature $env:buildInstaller; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft installer signature validation failed' }"
if errorlevel 1 (
    echo Download or signature validation failed.
    exit /b 1
)
"%buildInstaller%" --passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
set "buildResult=%errorlevel%"
del "%buildInstaller%" >nul 2>&1
if "%buildResult%"=="3010" (
    echo Build tools installed. Restart Windows before building the app.
    exit /b 0
)
if not "%buildResult%"=="0" (
    echo Installer failed with exit code %buildResult%.
    exit /b %buildResult%
)
echo Build tools installed. From the repository root, run npm run tauri -- dev.
