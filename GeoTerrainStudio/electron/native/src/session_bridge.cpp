#include <napi.h>
#include <json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

// Helper: Convert JS GeoBounds object to JSON
static json GeoBoundsFromJs(const Napi::Object& obj) {
    json j;
    j["west"] = obj.Get("west").As<Napi::Number>().DoubleValue();
    j["south"] = obj.Get("south").As<Napi::Number>().DoubleValue();
    j["east"] = obj.Get("east").As<Napi::Number>().DoubleValue();
    j["north"] = obj.Get("north").As<Napi::Number>().DoubleValue();
    return j;
}

// Helper: Convert JS TerrainProfile object to JSON
static json ProfileFromJs(const Napi::Object& obj) {
    json j;
    j["name"] = obj.Get("name").As<Napi::String>().Utf8Value();
    
    auto res = obj.Get("resolution").As<Napi::Object>();
    j["resolution"]["heightmap_size"] = res.Get("heightmapSize").As<Napi::Number>().Uint32Value();
    j["resolution"]["albedo_size"] = res.Get("albedoSize").As<Napi::Number>().Uint32Value();
    j["resolution"]["pixel_size_m"] = res.Get("pixelSizeM").As<Napi::Number>().DoubleValue();
    
    auto src = obj.Get("sources").As<Napi::Object>();
    j["sources"]["dem_source"] = src.Get("demSource").As<Napi::String>().Utf8Value();
    j["sources"]["imagery_source"] = src.Get("imagerySource").As<Napi::String>().Utf8Value();
    j["sources"]["enable_osm"] = src.Get("enableOSM").As<Napi::Boolean>().Value();
    
    auto proc = obj.Get("processing").As<Napi::Object>();
    j["processing"]["normalize_heights"] = proc.Get("normalizeHeights").As<Napi::Boolean>().Value();
    j["processing"]["height_scale"] = proc.Get("heightScale").As<Napi::Number>().DoubleValue();
    j["processing"]["seam_stitching"] = proc.Get("seamStitching").As<Napi::Boolean>().Value();
    
    return j;
}

// planGeneration(bounds, profile) -> GenerationPlan
static Napi::Value PlanGeneration(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Expected (bounds: object, profile: object)").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto boundsObj = info[0].As<Napi::Object>();
    auto profileObj = info[1].As<Napi::Object>();
    
    json bounds = GeoBoundsFromJs(boundsObj);
    json profile = ProfileFromJs(profileObj);
    
    // TODO: Call actual C++ GenerationService::planGeneration()
    // For now, return a mock plan matching the JS mock
    json plan;
    plan["zoom"] = 12;
    
    double w = bounds["west"].get<double>();
    double e = bounds["east"].get<double>();
    double s = bounds["south"].get<double>();
    double n = bounds["north"].get<double>();
    double width = e - w;
    double height = n - s;
    
    int rows = std::min(4, std::max(1, (int)std::ceil(height * 10)));
    int cols = std::min(4, std::max(1, (int)std::ceil(width * 10)));
    
    std::vector<json> tiles;
    for (int r = 0; r < rows; ++r) {
        for (int c = 0; c < cols; ++c) {
            json tile;
            tile["row"] = r;
            tile["col"] = c;
            tile["bounds"]["west"] = w + (c / (double)cols) * width;
            tile["bounds"]["east"] = w + ((c + 1) / (double)cols) * width;
            tile["bounds"]["south"] = s + (r / (double)rows) * height;
            tile["bounds"]["north"] = s + ((r + 1) / (double)rows) * height;
            tiles.push_back(tile);
        }
    }
    plan["tiles"] = tiles;
    plan["estimatedMemoryMb"] = (int)(tiles.size() * 256);
    plan["estimatedDurationSec"] = (int)(tiles.size() * 45);
    
    return Napi::String::New(env, plan.dump());
}

// startGeneration(sessionId, plan) -> jobId
static Napi::Value StartGeneration(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (sessionId: string, plan: object)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string sessionId = info[0].As<Napi::String>().Utf8Value();
    // TODO: Integrate with GenerationService
    std::string jobId = "job-" + sessionId;
    return Napi::String::New(env, jobId);
}

// cancelGeneration(jobId)
static Napi::Value CancelGeneration(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected (jobId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    // TODO: Integrate with GenerationService
    return env.Undefined();
}

// getProgress(jobId) -> progress object
static Napi::Value GetProgress(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "Expected (jobId: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string jobId = info[0].As<Napi::String>().Utf8Value();
    
    // TODO: Query actual GenerationService progress
    json progress;
    progress["jobId"] = jobId;
    progress["state"] = "downloading";
    progress["overallProgress"] = 0.42;
    progress["currentTile"] = "chunk_0_1";
    progress["tileProgress"] = 0.75;
    progress["message"] = "Downloading DEM tiles...";
    
    return Napi::String::New(env, progress.dump());
}

// exportPackage(sessionId, outputPath, preset) -> outputPath
static Napi::Value ExportPackage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (sessionId: string, outputPath: string, preset: string)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string sessionId = info[0].As<Napi::String>().Utf8Value();
    std::string outputPath = info[1].As<Napi::String>().Utf8Value();
    std::string preset = info[2].As<Napi::String>().Utf8Value();
    
    // TODO: Integrate with session export logic
    return Napi::String::New(env, outputPath);
}

Napi::Object InitSessionBridge(Napi::Env env, Napi::Object exports) {
    exports.Set("planGeneration", Napi::Function::New(env, PlanGeneration));
    exports.Set("startGeneration", Napi::Function::New(env, StartGeneration));
    exports.Set("cancelGeneration", Napi::Function::New(env, CancelGeneration));
    exports.Set("getProgress", Napi::Function::New(env, GetProgress));
    exports.Set("exportPackage", Napi::Function::New(env, ExportPackage));
    return exports;
}
