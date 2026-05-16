@echo off
REM Build GeoTerrainEditorPlugin with Ninja
echo === Building Vamps GeoTerrain Editor Plugin (Ninja) ===
setlocal

set PROJECT_ROOT=%~dp0
set BUILD_DIR=%PROJECT_ROOT%build
set DEPLOY_DIR=C:\Users\snare\Documents\UNIGINE Projects\unigine_project_3\bin\plugins\Vamps\GeoTerrain
set UNIGINE_BIN=C:\Users\snare\Documents\UNIGINE Projects\unigine_project_3\bin
set OSGEO4W_BIN=C:\Users\snare\AppData\Local\Programs\OSGeo4W\bin
set TARGET_NAME=GeoTerrain
set BINARY_NAME=%TARGET_NAME%_editorplugin_double_x64

echo Project Root: %PROJECT_ROOT%
echo Build Dir:    %BUILD_DIR%
echo Deploy Dir:   %DEPLOY_DIR%
echo.

if not exist "%BUILD_DIR%"   mkdir "%BUILD_DIR%"
if not exist "%DEPLOY_DIR%"  mkdir "%DEPLOY_DIR%"

REM Setup VS2022
echo Setting up VS2022 Developer Command Prompt...
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul 2>&1
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

REM Copy proj.db from Unigine gdal3data (modern PROJ database required by gdal312.dll)
if defined UNIGINE_BIN (
    echo.
    echo Step 3a: Copying proj.db from Unigine gdal3data...
    if exist "%UNIGINE_BIN%\gdal3data\proj.db" (
        xcopy /Y /Q "%UNIGINE_BIN%\gdal3data\proj.db" "%DEPLOY_DIR%\" >nul 2>&1
        echo [OK] proj.db copied to plugin folder
    ) else (
        echo [WARN] proj.db not found at %UNIGINE_BIN%\gdal3data
    )
)

REM Copy gdal312.dll from OSGeo4W bin (required runtime dependency)
if defined OSGEO4W_BIN (
    echo.
    echo Step 3: Copying gdal312.dll from OSGeo4W bin...
    if exist "%OSGEO4W_BIN%\gdal312.dll" (
        xcopy /Y /Q "%OSGEO4W_BIN%\gdal312.dll" "%DEPLOY_DIR%\" >nul 2>&1
        echo [OK] gdal312.dll copied to plugin folder
    ) else (
        echo [WARN] gdal312.dll not found at %OSGEO4W_BIN%
    )
)

REM Copy OSGeo4W runtime DLLs if OSGEO4W_BIN is set.
if defined OSGEO4W_BIN (
    echo.
    echo Step 4: Copying OSGeo4W runtime DLLs to plugin folder...
    xcopy /Y /Q "%OSGEO4W_BIN%\*.dll" "%DEPLOY_DIR%\" >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo [OK] OSGeo4W DLLs deployed to plugin folder
    ) else (
        echo [WARN] Some DLLs may not have copied correctly
    )
) else (
    echo.
    echo [INFO] OSGEO4W_BIN not set — skipping OSGeo4W DLL copy.
)

echo.
echo === Build Complete ===
echo.
echo NOTE: If OSGeo4W runtime DLLs are needed, set OSGEO4W_BIN and they will be copied.
echo.
echo Usage in Unigine Editor:
echo   Menu: VampsPlugin ^> GeoTerrain Generator
echo.
exit /b 0
