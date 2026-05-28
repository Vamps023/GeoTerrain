cmake_minimum_required(VERSION 3.16)

project(GeoTerrainBridgeEditorPlugin)

set(vendor_name GeoTerrainStudio)
set(target_name GeoTerrainBridge)

# C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Preprocessor definitions
add_definitions(-DUNIGINE_DOUBLE -D_CRT_SECURE_NO_WARNINGS)

# Qt5 setup - auto MOC for Q_OBJECT macros
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC OFF)
set(CMAKE_AUTOUIC OFF)

# Load machine-local paths if present, otherwise use -D passed values
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/local_paths.cmake)
    include(${CMAKE_CURRENT_SOURCE_DIR}/local_paths.cmake)
else()
    if(NOT DEFINED UNIGINE_SDK_DIR)
        message(FATAL_ERROR "UNIGINE_SDK_DIR not defined. Pass -DUNIGINE_SDK_DIR=<path> or create local_paths.cmake")
    endif()
    if(NOT DEFINED QT5_DIR)
        message(FATAL_ERROR "QT5_DIR not defined. Pass -DQT5_DIR=<path> or create local_paths.cmake")
    endif()
    if(NOT DEFINED DEPLOY_BASE_DIR)
        set(DEPLOY_BASE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/deploy)
    endif()
endif()

set(CMAKE_PREFIX_PATH "${QT5_DIR}")
set(Qt5_DIR "${QT5_DIR}/lib/cmake/Qt5")

find_package(Qt5 REQUIRED COMPONENTS Core Gui Widgets)

set(UNIGINE_INCLUDE_DIR "${UNIGINE_SDK_DIR}/include")
set(UNIGINE_LIB_DIR "${UNIGINE_SDK_DIR}/lib")

# Allow DEPLOY_DIR to be passed directly, or construct from DEPLOY_BASE_DIR
if(NOT DEFINED DEPLOY_DIR)
    set(DEPLOY_DIR "${DEPLOY_BASE_DIR}/bin/plugins/${vendor_name}/${target_name}")
endif()

set(binary_name ${target_name}_editorplugin)
string(APPEND binary_name "_double")
string(APPEND binary_name "_x64")

set(SOURCES
    source/core/GeoTerrainBridgeEditorPlugin.cpp
    source/landscape/LandscapeSaveManager.cpp
    source/terrain/BrushMaterialFactory.cpp
    source/importer/GeoTerrainImporter.cpp
    source/ui/GeoTerrainController.cpp
    source/ui/GeoTerrainPanel.cpp
)

set(HEADERS
    source/core/GeoTerrainBridgeEditorPlugin.h
    source/core/NodeTreeWalker.h
    source/landscape/LandscapeSaveManager.h
    source/terrain/BrushMaterialFactory.h
    source/importer/GeoTerrainImporter.h
    source/ui/GeoTerrainController.h
    source/ui/GeoTerrainPanel.h
)

add_library(${target_name} SHARED ${SOURCES} ${HEADERS})

target_include_directories(${target_name}
    PRIVATE
        ${UNIGINE_INCLUDE_DIR}
        ${UNIGINE_INCLUDE_DIR}/editor
        ${CMAKE_CURRENT_SOURCE_DIR}/source
        ${CMAKE_CURRENT_SOURCE_DIR}/source/core
        ${CMAKE_CURRENT_SOURCE_DIR}/source/landscape
        ${CMAKE_CURRENT_SOURCE_DIR}/source/terrain
        ${CMAKE_CURRENT_SOURCE_DIR}/source/importer
        ${CMAKE_CURRENT_SOURCE_DIR}/source/ui
)

target_link_libraries(${target_name}
    PRIVATE
        Qt5::Core
        Qt5::Gui
        Qt5::Widgets
        "${UNIGINE_LIB_DIR}/EditorCore_double_x64.lib"
        "${UNIGINE_LIB_DIR}/Unigine_double_x64.lib"
)

set_target_properties(${target_name} PROPERTIES
    OUTPUT_NAME ${binary_name}$<$<CONFIG:Debug>:d>
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${DEPLOY_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${DEPLOY_DIR}"
)
