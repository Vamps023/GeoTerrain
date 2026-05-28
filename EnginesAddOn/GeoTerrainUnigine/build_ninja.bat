@echo off
REM Build GeoTerrain Bridge Editor Plugin for Unigine
setlocal

set PROJECT_ROOT=%~dp0
set BUILD_DIR=%PROJECT_ROOT%build
set LOCAL_PATHS=%PROJECT_ROOT%local_paths.cmake
set TARGET_NAME=GeoTerrainBridge
set BINARY_NAME=%TARGET_NAME%_editorplugin_double_x64

REM Generate local_paths.cmake if missing
if not exist "%LOCAL_PATHS%" (
    echo Generating local_paths.cmake from defaults...
    echo set^(QT5_DIR        "C:/Qt/Qt5.12.3/5.12.3/msvc2017_64"^)    > "%LOCAL_PATHS%"
    echo set^(UNIGINE_SDK_DIR "C:/Users/nares/AppData/Local/unigine/browser/sdks/sim_windows_2.18.1_bin"^) >> "%LOCAL_PATHS%"
    echo set^(DEPLOY_BASE_DIR "D:/Unigine/unigine_project"^)           >> "%LOCAL_PATHS%"
    echo local_paths.cmake created. Edit it if your paths differ.
)

set DEPLOY_DIR=D:\Unigine\unigine_project\bin\plugins\GeoTerrainStudio\GeoTerrainBridge
set PROJECT_DATA_DIR=D:\Unigine\unigine_project\data

echo Project Root: %PROJECT_ROOT%
echo Build Dir: %BUILD_DIR%
echo Deploy Dir: %DEPLOY_DIR%
echo Target Name: %TARGET_NAME%
echo Binary Name: %BINARY_NAME%
echo.

if not exist "%BUILD_DIR%" md "%BUILD_DIR%"
if not exist "%DEPLOY_DIR%" md "%DEPLOY_DIR%" 2>nul || powershell -Command "New-Item -ItemType Directory -Force '%DEPLOY_DIR%'" >nul
if not exist "%PROJECT_DATA_DIR%" md "%PROJECT_DATA_DIR%" 2>nul || powershell -Command "New-Item -ItemType Directory -Force '%PROJECT_DATA_DIR%'" >nul

REM Copy plugin metadata
copy "%PROJECT_ROOT%source\core\GeoTerrainBridgeEditorPlugin.json" "%DEPLOY_DIR%\" >nul 2>&1
REM Copy brush assets
copy "%PROJECT_ROOT%Content\*.basebrush" "%PROJECT_DATA_DIR%\" >nul 2>&1

REM Setup VS2022 Developer Command Prompt
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul 2>&1

echo Configuring with CMake...
cd /d "%BUILD_DIR%"

if exist "CMakeCache.txt" del /f /q "CMakeCache.txt"
if exist "CMakeFiles" rmdir /s /q "CMakeFiles"

cmake .. -G "Ninja" -DCMAKE_BUILD_TYPE=Release
if %ERRORLEVEL% NEQ 0 (
    echo CMake configuration failed!
    exit /b 1
)

echo Building project...
cmake --build . --config Release
if %ERRORLEVEL% NEQ 0 (
    echo Build failed!
    exit /b 1
)

echo Build completed!
if exist "%DEPLOY_DIR%\%BINARY_NAME%.dll" (
    echo Plugin DLL deployed: %DEPLOY_DIR%\%BINARY_NAME%.dll
) else (
    echo Plugin DLL NOT found at %DEPLOY_DIR%\%BINARY_NAME%.dll
)

if exist "%DEPLOY_DIR%\GeoTerrainBridgeEditorPlugin.json" (
    echo Plugin metadata deployed.
)

if exist "%PROJECT_DATA_DIR%\geoterrain_brush_r32f_overwrite.basebrush" (
    echo Brush assets deployed.
)

echo.
echo Plugin Structure:
echo %DEPLOY_DIR%
echo ├── %BINARY_NAME%.dll
echo └── GeoTerrainBridgeEditorPlugin.json
echo.
exit /b 0
