@echo off
REM Build and Deploy GeoTerrain Plugin
REM Syncs source from SVN to project, builds plugin, and deploys

setlocal enabledelayedexpansion

set SVN_SOURCE=c:\ALL_SVN\GeoTerrain\source
set PROJECT_PLUGIN=C:\Users\snare.ext\Documents\Unreal Projects\CppProject\Plugins\GeoTerrain\Source
set PROJECT_UPROJECT=C:\Users\snare.ext\Documents\Unreal Projects\CppProject\CppProject.uproject
set UE_BUILD="C:\Program Files\Epic Games\UE_5.3\Engine\Build\BatchFiles\Build.bat"

echo ========================================
echo GeoTerrain Build and Deploy Script
echo ========================================
echo.

REM Step 1: Sync source files
echo [1/3] Syncing source files from SVN to project...
robocopy "%SVN_SOURCE%" "%PROJECT_PLUGIN%" /MIR /XD .git /NFL /NDL /NJH
if %ERRORLEVEL% GTR 7 (
    echo ERROR: robocopy failed
    exit /b 1
)
echo Sync complete.
echo.

REM Step 2: Touch a file to force rebuild (optional but recommended)
echo [2/3] Touching GeoLandscapeImporter.cpp to force rebuild...
powershell -Command "(Get-Item '%PROJECT_PLUGIN%\GeoTerrain\Private\Pipeline\GeoLandscapeImporter.cpp').LastWriteTime = Get-Date"
echo Touch complete.
echo.

REM Step 3: Build the project
echo [3/3] Building CppProjectEditor...
call %UE_BUILD% CppProjectEditor Win64 Development "%PROJECT_UPROJECT%" -WaitMutex -FromMsBuild
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Build failed
    exit /b 1
)
echo Build complete.
echo.

echo ========================================
echo SUCCESS: Plugin synced and built
echo ========================================
echo.
echo Next steps:
echo 1. Close Unreal Editor if open
echo 2. Reopen CppProject.uproject
echo 3. Press Ctrl+Alt+F11 to apply Live Coding (if editor is already open)
echo.

pause
