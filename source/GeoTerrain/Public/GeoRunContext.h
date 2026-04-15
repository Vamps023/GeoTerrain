#pragma once
#include "CoreMinimal.h"
#include <atomic>

// Replaces Qt RunContext — uses UE TFunction instead of std::function
struct FGeoRunContext
{
    std::atomic_bool* CancelFlag = nullptr;

    // Progress callback: (message, percent 0-100)
    TFunction<void(const FString&, int32)> OnProgress;
    TFunction<void(const FString&)>        OnWarning;

    bool IsCancelled() const
    {
        return CancelFlag && CancelFlag->load();
    }

    void ReportProgress(const FString& Msg, int32 Percent) const
    {
        if (OnProgress) OnProgress(Msg, Percent);
    }

    void ReportWarning(const FString& Msg) const
    {
        if (OnWarning) OnWarning(Msg);
    }
};
