#include <napi.h>
#include <string>

/**
 * Pipeline Bridge
 * Exposes raster processing and mask generation to JS.
 * 
 * TODO: Integrate with:
 *   - rts::pipeline::RasterProcessor
 *   - rts::pipeline::MaskGenerator
 */

// getProcessorCapabilities() -> object
static Napi::Value GetProcessorCapabilities(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object caps = Napi::Object::New(env);
    
    Napi::Array ops = Napi::Array::New(env, 6);
    ops[0u] = "resample";
    ops[1u] = "reproject";
    ops[2u] = "normalize";
    ops[3u] = "slope";
    ops[4u] = "hillshade";
    ops[5u] = "fillNodata";
    caps.Set("operations", ops);
    
    Napi::Array masks = Napi::Array::New(env, 5);
    masks[0u] = "road";
    masks[1u] = "water";
    masks[2u] = "vegetation";
    masks[3u] = "building";
    masks[4u] = "cliff";
    caps.Set("maskTypes", masks);
    
    return caps;
}

// processRaster(inputPath, operation, options) -> outputPath
static Napi::Value ProcessRaster(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (inputPath, operation, options)").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string inputPath = info[0].As<Napi::String>().Utf8Value();
    std::string operation = info[1].As<Napi::String>().Utf8Value();
    // TODO: Call RasterProcessor
    return Napi::String::New(env, inputPath); // pass-through for now
}

Napi::Object InitPipelineBridge(Napi::Env env, Napi::Object exports) {
    exports.Set("getProcessorCapabilities", Napi::Function::New(env, GetProcessorCapabilities));
    exports.Set("processRaster", Napi::Function::New(env, ProcessRaster));
    return exports;
}
