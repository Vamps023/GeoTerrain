#include "UI/GeoTerrainJsHandler.h"
#include "UI/SGeoTerrainPanel.h"

void UGeoTerrainJsHandler::OnBoundsSelected(const FString& JsonStr)
{
    if (Panel)
        Panel->OnBoundsReceivedFromJs(JsonStr);
}
