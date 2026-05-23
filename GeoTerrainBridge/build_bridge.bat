@echo off
REM Build script for GeoTerrain Bridge (UNIGINE plugin)
REM Requires: VS2022, CMake 3.16+, Ninja, Qt5.12.3, UNIGINE SDK

echo [GeoTerrain Bridge] Starting build...

REM Configure paths (edit these to match your system)
set UNIGINE_SDK=C:\Unigine\browser\sdks\sim_windows_2.18.0.1_bin
set QT_DIR=C:\Qt\5.12.3\msvc2017_64
set OSGEO4W_DIR=C:\OSGeo4W
set DEPLOY_DIR=C:\UnigineProject\bin\plugins\Vamps\GeoTerrain

REM Setup VS2022 environment
where cl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Setting up VS2022 build environment...
    call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
)

REM Create build directory
if not exist build_bridge mkdir build_bridge
cd build_bridge

REM Configure
echo Configuring CMake...
cmake .. ^
  -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^^
  -DUNIGINE_SDK_DIR="%UNIGINE_SDK%" ^
  -DCMAKE_PREFIX_PATH="%QT_DIR%" ^
  -DDEPLOY_DIR="%DEPLOY_DIR%"

if %ERRORLEVEL% NEQ 0 (
    echo CMake configuration failed!
    exit /b 1
)

REM Build
echo Building...
ninja

if %ERRORLEVEL% NEQ 0 (
    echo Build failed!
    exit /b 1
)

REM Deploy
echo Deploying to UNIGINE project...
ninja deploy_bridge

echo [GeoTerrain Bridge] Build complete!
cd ..
