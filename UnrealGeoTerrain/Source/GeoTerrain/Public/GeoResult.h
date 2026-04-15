#pragma once
#include "CoreMinimal.h"

// Lightweight result type — mirrors the Unigine plugin's Result<T>
template<typename T>
struct TGeoResult
{
    bool    bSuccess    = false;
    int32   ErrorCode   = 0;
    FString Message;
    T       Value;

    static TGeoResult<T> Ok(const T& Val)
    {
        TGeoResult<T> R;
        R.bSuccess = true;
        R.Value    = Val;
        return R;
    }

    static TGeoResult<T> Fail(int32 Code, const FString& Msg)
    {
        TGeoResult<T> R;
        R.bSuccess  = false;
        R.ErrorCode = Code;
        R.Message   = Msg;
        return R;
    }
};
