@echo off
REM =========================================================================
REM  Linker MemMap Viewer — Windows build script
REM  Run from inside the lmv\ folder (where app.py lives)
REM =========================================================================

echo.
echo  Linker MemMap Viewer — Building
echo  =================================
echo.

REM Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Install from https://python.org
    pause & exit /b 1
)

REM Install / upgrade dependencies
echo  [1/4] Installing dependencies...
pip install bottle pyinstaller --quiet --upgrade
if errorlevel 1 (echo  [ERROR] pip install failed & pause & exit /b 1)

REM Clean previous build
echo  [2/4] Cleaning previous build...
if exist build      rmdir /s /q build
if exist dist       rmdir /s /q dist

REM Build the exe (onedir — a folder, not a single file)
echo  [3/4] Building (this takes 30-60 seconds)...
pyinstaller linker_memmap.spec --noconfirm
if errorlevel 1 (echo  [ERROR] PyInstaller build failed & pause & exit /b 1)

REM Zip the output folder for easy distribution
echo  [4/4] Zipping dist\LinkerMemMap\ ...
if exist dist\LinkerMemMap.zip del dist\LinkerMemMap.zip
powershell -Command "Compress-Archive -Path 'dist\LinkerMemMap' -DestinationPath 'dist\LinkerMemMap.zip'" 2>nul
if exist dist\LinkerMemMap.zip (
    echo   Created dist\LinkerMemMap.zip
) else (
    echo   [WARN] Could not create zip (PowerShell not available) — distribute the dist\LinkerMemMap\ folder directly
)

echo.
echo  =====================================================
echo   BUILD COMPLETE
echo   Run:      dist\LinkerMemMap\LinkerMemMap.exe
echo   Dist zip: dist\LinkerMemMap.zip  (if created)
echo.
echo   ANTIVIRUS NOTE:
echo   If your AV flags the exe, add the dist\LinkerMemMap\
echo   folder to AV exclusions, or run from source:
echo     python app.py
echo  =====================================================
echo.
echo  Test it now? Press any key to launch.
pause
dist\LinkerMemMap\LinkerMemMap.exe
