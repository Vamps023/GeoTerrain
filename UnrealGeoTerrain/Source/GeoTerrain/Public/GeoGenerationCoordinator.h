#pragma once
#include "CoreMinimal.h"
#include "GeoGenerationTypes.h"
#include "GeoRunContext.h"

DECLARE_MULTICAST_DELEGATE_TwoParams(FGeoOnLogMessage, const FString& /*Message*/, bool /*bIsError*/);
DECLARE_MULTICAST_DELEGATE_OneParam (FGeoOnProgress,   int32          /*Percent*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FGeoOnFinished,   EGeoJobStatus  /*Status*/, const FString& /*Message*/);

// Replaces GenerationCoordinator (QThread) with a UE async task.
// Kick off with Run() from the game thread; delegates fire on game thread.
class GEOTERRAIN_API FGeoGenerationCoordinator : public TSharedFromThis<FGeoGenerationCoordinator>
{
public:
    FGeoOnLogMessage OnLogMessage;
    FGeoOnProgress   OnProgress;
    FGeoOnFinished   OnFinished;

    // Start async generation — returns immediately
    void Run(const FGeoGenerationRequest& Request);

    // Request cancellation — cooperative, may take a moment
    void Cancel();

    bool IsRunning() const { return bRunning; }

private:
    void RunInternal(FGeoGenerationRequest Request);

    std::atomic_bool     bCancelRequested{ false };
    std::atomic_bool     bRunning        { false };
};
