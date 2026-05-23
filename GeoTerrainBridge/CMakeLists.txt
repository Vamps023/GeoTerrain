cmake_minimum_required(VERSION 3.16)
project(GeoTerrainBridge VERSION 2.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ─── Paths (configure to your system) ─────────────────────────
set(UNIGINE_SDK_DIR "C:/Unigine/browser/sdks/sim_windows_2.18.0.1_bin"
    CACHE PATH "UNIGINE SDK directory")
set(CMAKE_PREFIX_PATH "C:/Qt/5.12.3/msvc2017_64"
    CACHE PATH "Qt5 install path")
set(DEPLOY_DIR "C:/UnigineProject/bin/plugins/Vamps/GeoTerrain"
    CACHE PATH "Plugin deploy directory")

# ─── Find Qt5 ─────────────────────────────────────────────────
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)
find_package(Qt5 COMPONENTS Core Widgets REQUIRED)

# ─── UNIGINE SDK ──────────────────────────────────────────────
set(UNIGINE_INCLUDE_DIR "${UNIGINE_SDK_DIR}/include")
set(UNIGINE_EDITOR_INCLUDE_DIR "${UNIGINE_SDK_DIR}/include/editor")
set(UNIGINE_LIB_DIR "${UNIGINE_SDK_DIR}/lib")

# ─── Sources ──────────────────────────────────────────────────
set(SOURCES
    src/bridge_plugin.cpp
    src/bridge_panel.cpp
    src/package_reader.cpp
)

set(HEADERS
    src/bridge_plugin.h
    src/bridge_panel.h
    src/package_reader.h
)

# ─── Plugin Library ───────────────────────────────────────────
add_library(GeoTerrainBridge SHARED ${SOURCES} ${HEADERS})

target_include_directories(GeoTerrainBridge PRIVATE
    ${UNIGINE_INCLUDE_DIR}
    ${UNIGINE_EDITOR_INCLUDE_DIR}
    ${CMAKE_SOURCE_DIR}/../third_party/nlohmann
    ${CMAKE_SOURCE_DIR}/../src/core
)

target_link_libraries(GeoTerrainBridge PRIVATE
    Qt5::Core
    Qt5::Widgets
)

# UNIGINE plugin naming convention
set_target_properties(GeoTerrainBridge PROPERTIES
    PREFIX ""
    OUTPUT_NAME "GeoTerrainBridge_editorplugin_double_x64"
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)

# ─── Deploy ───────────────────────────────────────────────────
add_custom_target(deploy_bridge
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:GeoTerrainBridge>
        ${DEPLOY_DIR}/$<TARGET_FILE_NAME:GeoTerrainBridge>
    COMMAND ${CMAKE_COMMAND} -E copy
        ${CMAKE_SOURCE_DIR}/GeoTerrainBridge.json
        ${DEPLOY_DIR}/GeoTerrainBridge.json
    DEPENDS GeoTerrainBridge
    COMMENT "Deploying GeoTerrain Bridge to UNIGINE project..."
)
