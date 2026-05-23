{
  "targets": [
    {
      "target_name": "geoterrain_native",
      "sources": [
        "src/addon.cpp",
        "src/session_bridge.cpp",
        "src/datasource_bridge.cpp",
        "src/pipeline_bridge.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../../src/core",
        "../../../src/datasources",
        "../../../src/pipeline",
        "../../../src/cache",
        "../../../src/session",
        "../../../third_party/nlohmann",
        "../../../third_party/gdal/include"
      ],
      "libraries": [
        "../../../build/bin/rts_core.lib",
        "../../../build/bin/rts_datasources.lib",
        "../../../build/bin/rts_pipeline.lib",
        "../../../build/bin/rts_cache.lib",
        "../../../build/bin/rts_session.lib"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++20"]
        }
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "-l../../../third_party/gdal/lib/gdal_i.lib"
            ]
          }
        ]
      ]
    }
  ]
}
