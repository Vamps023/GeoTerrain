#include <napi.h>
#include <string>

/**
 * Datasource Bridge
 * Exposes DEM/Imagery/Vector data source operations to JS.
 * 
 * TODO: Integrate with rts::datasources::* classes:
 *   - AWSTerrainSource
 *   - CopernicusDEMSource
 *   - ArcGISImagerySource
 *   - OverpassOSMSource
 */

// listSources() -> array of available data sources
static Napi::Value ListSources(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    Napi::Array arr = Napi::Array::New(env, 4);
    
    struct SourceInfo {
        const char* id;
        const char* name;
        const char* type; // "dem" | "imagery" | "vector"
        bool requiresAuth;
    };
    
    SourceInfo sources[] = {
        {"aws-terrarium", "AWS Terrain Tiles", "dem", false},
        {"copernicus-dem", "Copernicus DEM GLO-30", "dem", false},
        {"arcgis", "ArcGIS World Imagery", "imagery", false},
        {"overpass-osm", "OpenStreetMap (Overpass)", "vector", false},
    };
    
    for (size_t i = 0; i < 4; ++i) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", sources[i].id);
        obj.Set("name", sources[i].name);
        obj.Set("type", sources[i].type);
        obj.Set("requiresAuth", sources[i].requiresAuth);
        arr[i] = obj;
    }
    
    return arr;
}

// pingSource(sourceId) -> boolean
static Napi::Value PingSource(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected (sourceId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    // TODO: Call DataSource::ping()
    return Napi::Boolean::New(env, true);
}

Napi::Object InitDatasourceBridge(Napi::Env env, Napi::Object exports) {
    exports.Set("listSources", Napi::Function::New(env, ListSources));
    exports.Set("pingSource", Napi::Function::New(env, PingSource));
    return exports;
}
