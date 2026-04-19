cmake_minimum_required(VERSION 3.16)

project(GeoTerrainEditorPlugin)
option(GEOTERRAIN_ENABLE_DEPLOY "Deploy plugin files after build" ON)
option(GEOTERRAIN_BUILD_TESTS "Build non-UI refactor tests" ON)

set(vendor_name Vamps)
set(target_name GeoTerrain)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_definitions(-DUNIGINE_DOUBLE -D_CRT_SECURE_NO_WARNINGS -DNOMINMAX -D_USE_MATH_DEFINES)

set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC OFF)
set(CMAKE_AUTOUIC OFF)

# Qt5 - match Unigine 2.18
set(CMAKE_PREFIX_PATH "C:/Qt/Qt5.12.3/5.12.3/msvc2017_64")
set(Qt5_DIR "C:/Qt/Qt5.12.3/5.12.3/msvc2017_64/lib/cmake/Qt5")

find_package(Qt5 REQUIRED COMPONENTS Core Gui Widgets Network)

# Unigine SDK
set(UNIGINE_SDK_DIR "C:/Users/snare.ext/AppData/Local/unigine/browser/sdks/sim_windows_2.18.0.1_bin")
set(UNIGINE_INCLUDE_DIR "${UNIGINE_SDK_DIR}/include")
set(UNIGINE_LIB_DIR "${UNIGINE_SDK_DIR}/lib")

# Deploy path
set(DEPLOY_DIR "C:/Users/snare.ext/Documents/UNIGINE Projects/unigine_project_3/bin/plugins/${vendor_name}/${target_name}")
set(LOCAL_RUNTIME_DIR "${CMAKE_BINARY_DIR}/bin")

set(binary_name ${target_name}_editorplugin)
string(APPEND binary_name "_double")
string(APPEND binary_name "_x64")

# GDAL (set GDAL_DIR or provide paths here)
set(OSGEO4W_DIR "C:/Users/snare.ext/AppData/Local/Programs/OSGeo4W")
set(QGIS_ROOT "C:/Users/snare.ext/Documents/Sogeclair Rail Simulation/Track Editor/cots/qgis" CACHE PATH "QGIS installation root")

set(GDAL_INCLUDE_DIR "${OSGEO4W_DIR}/include" CACHE PATH "GDAL include directory")
set(GDAL_LIB        "${OSGEO4W_DIR}/lib/gdal_i.lib" CACHE FILEPATH "GDAL import library")

# libcurl
set(CURL_INCLUDE_DIR "${OSGEO4W_DIR}/include" CACHE PATH "libcurl include directory")
set(CURL_LIB        "${OSGEO4W_DIR}/lib/libcurl_imp.lib" CACHE FILEPATH "libcurl import library")

# nlohmann/json (header-only)
set(JSON_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/nlohmann" CACHE PATH "nlohmann/json include directory")

include_directories(
    ${UNIGINE_INCLUDE_DIR}
    ${UNIGINE_INCLUDE_DIR}/editor
    ${CMAKE_CURRENT_SOURCE_DIR}/source
    ${GDAL_INCLUDE_DIR}
    ${CURL_INCLUDE_DIR}
    ${JSON_INCLUDE_DIR}
)

set(SOURCES
    source/plugin/GeoTerrainEditorPlugin.cpp
    source/ui/GeoTerrainPanel.cpp
    source/ui/MapPanel.cpp
    source/ui/MapSelectionSection.cpp
    source/ui/SourceSettingsSection.cpp
    source/ui/GenerationSettingsSection.cpp
    source/ui/RunConsoleSection.cpp
    source/ui/TerrainBuilderSection.cpp
    source/pipeline/DEMFetcher.cpp
    source/pipeline/TileDownloader.cpp
    source/pipeline/OSMParser.cpp
    source/pipeline/ShapefileExporter.cpp
    source/pipeline/MaskGenerator.cpp
    source/infrastructure/GdalUtils.cpp
    source/infrastructure/ManifestWriter.cpp
    source/infrastructure/OverlayLoader.cpp
    source/domain/Validation.cpp
    source/application/AsyncJob.cpp
    source/application/ChunkPlanner.cpp
    source/application/ExportCoordinator.cpp
    source/application/GenerationCoordinator.cpp
    source/application/TerrainBuilder.cpp
    source/application/GeoTerrainController.cpp
)

set(HEADERS
    source/plugin/GeoTerrainEditorPlugin.h
    source/ui/GeoTerrainPanel.h
    source/ui/MapPanel.h
    source/ui/MapSelectionSection.h
    source/ui/SourceSettingsSection.h
    source/ui/GenerationSettingsSection.h
    source/ui/RunConsoleSection.h
    source/ui/TerrainBuilderSection.h
    source/pipeline/DEMFetcher.h
    source/pipeline/TileDownloader.h
    source/pipeline/OSMParser.h
    source/pipeline/ShapefileExporter.h
    source/pipeline/MaskGenerator.h
    source/infrastructure/GdalUtils.h
    source/infrastructure/RunContext.h
    source/infrastructure/ManifestWriter.h
    source/infrastructure/OverlayLoader.h
    source/domain/GeoBounds.h
    source/domain/Result.h
    source/domain/GenerationTypes.h
    source/domain/Validation.h
    source/application/AsyncJob.h
    source/application/ChunkPlanner.h
    source/application/ExportCoordinator.h
    source/application/TerrainBuilder.h
    source/application/GeoTerrainController.h
)

add_library(${target_name} SHARED ${SOURCES} ${HEADERS})

target_link_libraries(${target_name}
    Qt5::Core
    Qt5::Gui
    Qt5::Widgets
    Qt5::Network
    "${UNIGINE_LIB_DIR}/EditorCore_double_x64.lib"
    "${UNIGINE_LIB_DIR}/Unigine_double_x64.lib"
    "${GDAL_LIB}"
    "${CURL_LIB}"
)

set_target_properties(${target_name} PROPERTIES
    OUTPUT_NAME ${binary_name}$<$<CONFIG:Debug>:d>
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${LOCAL_RUNTIME_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${LOCAL_RUNTIME_DIR}"
    ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}"
    ARCHIVE_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_BINARY_DIR}"
)

if(GEOTERRAIN_ENABLE_DEPLOY)
    add_custom_command(TARGET ${target_name} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${DEPLOY_DIR}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:${target_name}>"
            "${DEPLOY_DIR}/$<TARGET_FILE_NAME:${target_name}>"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/source/plugin/GeoTerrainEditorPlugin.json"
            "${DEPLOY_DIR}/GeoTerrainEditorPlugin.json"
        COMMENT "Deploying plugin files"
    )
endif()

if(GEOTERRAIN_BUILD_TESTS)
    enable_testing()
    add_executable(GeoTerrainCoreTests
        tests/GeoTerrainCoreTests.cpp
        source/domain/Validation.cpp
        source/application/ChunkPlanner.cpp
    )
    target_include_directories(GeoTerrainCoreTests PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/source
    )
    add_test(NAME GeoTerrainCoreTests COMMAND GeoTerrainCoreTests)
endif()
