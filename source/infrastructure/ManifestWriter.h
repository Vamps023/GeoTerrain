#pragma once

#include "../domain/GenerationTypes.h"
#include "../domain/Result.h"

namespace ManifestWriter
{
Result<void> writeManifest(const OutputManifest& manifest);
Result<void> writeMetadata(const OutputManifest& manifest, const GenerationRequest& request);
}
