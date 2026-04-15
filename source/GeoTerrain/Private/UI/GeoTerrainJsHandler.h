#pragma once
#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "GeoTerrainJsHandler.generated.h"

class SGeoTerrainPanel;

UCLASS()
class UGeoTerrainJsHandler : public UObject
{
    GENERATED_BODY()
public:
    void SetPanel(SGeoTerrainPanel* InPanel) { Panel = InPanel; }

    UFUNCTION()
    void OnBoundsSelected(const FString& JsonStr);

private:
    SGeoTerrainPanel* Panel = nullptr;
};
