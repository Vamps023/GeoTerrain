@echo off
REM Build GeoTerrainEditorPlugin with Ninja
echo === Building Vamps GeoTerrain Editor Plugin (Ninja) ===
setlocal

set PROJECT_ROOT=%~dp0
set BUILD_DIR=%PROJECT_ROOT%build
set DEPLOY_DIR=C:\Users\snare.ext\Documents\UNIGINE Projects\unigine_project_3\bin\plugins\Vamps\GeoTerrain
set UNIGINE_BIN=C:\Users\snare.ext\Documents\UNIGINE Projects\unigine_project_3\bin
set OSGEO4W_BIN=C:\Users\snare.ext\AppData\Local\Programs\OSGeo4W\bin
set TARGET_NAME=GeoTerrain
set BINARY_NAME=%TARGET_NAME%_editorplugin_double_x64

echo Project Root: %PROJECT_ROOT%
echo Build Dir:    %BUILD_DIR%
echo Deploy Dir:   %DEPLOY_DIR%
echo.

if not exist "%BUILD_DIR%"   mkdir "%BUILD_DIR%"
if not exist "%DEPLOY_DIR%"  mkdir "%DEPLOY_DIR%"

REM Copy third_party nlohmann/json if not present
if not exist "%PROJECT_ROOT%third_party\nlohmann\json.hpp" (
    echo [INFO] Downloading nlohmann/json single-header...
    if not exist "%PROJECT_ROOT%third_party\nlohmann" mkdir "%PROJECT_ROOT%third_party\nlohmann"
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp' -OutFile '%PROJECT_ROOT%third_party\nlohmann\json.hpp'"
)

REM Setup VS2022
echo Setting up VS2022 Developer Command Prompt...
call "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul 2>&1
echo VS2022 initialized.

cd /d "%BUILD_DIR%"

if exist "CMakeCache.txt" del /f /q "CMakeCache.txt"
if exist "CMakeFiles"     rmdir /s /q "CMakeFiles"

echo Step 1: CMake configure...
cmake .. -G "Ninja" -DCMAKE_BUILD_TYPE=Release
if %ERRORLEVEL% NEQ 0 ( echo CMake configure failed! & exit /b 1 )

echo Step 2: Build...
cmake --build . --config Release
if %ERRORLEVEL% NEQ 0 (
    echo Build failed - trying direct ninja...
    ninja
    if %ERRORLEVEL% NEQ 0 ( echo Ninja build failed! & exit /b 1 )
)

echo.
if exist "%DEPLOY_DIR%\%BINARY_NAME%.dll" (
    echo [OK] Plugin DLL: %DEPLOY_DIR%\%BINARY_NAME%.dll
) else (
    echo [WARN] DLL not found at deploy location.
)
if exist "%DEPLOY_DIR%\GeoTerrainEditorPlugin.json" (
    echo [OK] Plugin JSON: %DEPLOY_DIR%\GeoTerrainEditorPlugin.json
)

REM Copy ALL OSGeo4W runtime DLLs into the plugin folder.
REM gdal312.dll has ~30 transitive dependencies — copy everything to be safe.
echo.
echo Step 4: Copying OSGeo4W runtime DLLs to plugin folder...
xcopy /Y /Q "%OSGEO4W_BIN%\*.dll" "%DEPLOY_DIR%\" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [OK] OSGeo4W DLLs deployed to plugin folder
) else (
    echo [WARN] Some DLLs may not have copied correctly
)

echo.
echo === Build Complete ===
echo.
echo Usage in Unigine Editor:
echo   Menu: VampsPlugin ^> GeoTerrain Generator
echo.
exit /b 0
