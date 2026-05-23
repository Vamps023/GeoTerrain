#include <napi.h>
#include <string>
#include <memory>

// Forward declarations for bridge modules
Napi::Object InitSessionBridge(Napi::Env env, Napi::Object exports);
Napi::Object InitDatasourceBridge(Napi::Env env, Napi::Object exports);
Napi::Object InitPipelineBridge(Napi::Env env, Napi::Object exports);

/**
 * GeoTerrain Native Addon - N-API Entry Point
 * 
 * Exposes the C++20 core to Node.js/Electron via node-addon-api.
 * Modules:
 *   - Session: TerrainSession, TerrainProfile, save/load
 *   - Datasource: DEM/Imagery/Vector fetch operations
 *   - Pipeline: RasterProcessor, MaskGenerator
 */
Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
    exports.Set("getVersion", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
        return Napi::String::New(info.Env(), "2.0.0-native");
    }));

    InitSessionBridge(env, exports);
    InitDatasourceBridge(env, exports);
    InitPipelineBridge(env, exports);

    return exports;
}

NODE_API_MODULE(geoterrain_native, InitAll)
