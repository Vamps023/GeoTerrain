#include "UI/SGeoMapPicker.h"
#include "SWebBrowser.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"

// ─── Leaflet HTML (written to a temp file and loaded via file://) ──────────────
static const TCHAR* kLeafletHtml = TEXT(R"HTML(<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>GeoTerrain Map Picker</title>
<style>
  html,body,#map { margin:0;padding:0;width:100%;height:100%;background:#1a1a2e; }
  #hint {
    position:absolute;top:10px;left:50%;transform:translateX(-50%);
    z-index:9999;background:rgba(0,0,0,0.75);color:#fff;
    padding:6px 14px;border-radius:20px;font:13px/1.4 sans-serif;
    pointer-events:none;
  }
  #coords {
    position:absolute;bottom:10px;left:10px;z-index:9999;
    background:rgba(0,0,0,0.7);color:#8cf;
    padding:5px 10px;border-radius:8px;font:12px monospace;
  }
  #sendBtn {
    position:absolute;bottom:10px;right:10px;z-index:9999;
    background:#2563eb;color:#fff;border:none;
    padding:8px 18px;border-radius:8px;font:13px sans-serif;
    cursor:pointer;display:none;
  }
  #sendBtn:hover { background:#1d4ed8; }
  #clearBtn {
    position:absolute;bottom:10px;right:130px;z-index:9999;
    background:#64748b;color:#fff;border:none;
    padding:8px 14px;border-radius:8px;font:13px sans-serif;
    cursor:pointer;display:none;
  }
</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body>
<div id="hint">🖱 Hold Shift + drag to draw bounding box</div>
<div id="coords">No selection</div>
<button id="sendBtn" onclick="sendBounds()">✔ Use These Bounds</button>
<button id="clearBtn" onclick="clearRect()">✖ Clear</button>
<div id="map"></div>
<script>
var map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution:'© OpenStreetMap contributors', maxZoom:19
}).addTo(map);

var rect = null, bounds = null;
var startLL = null, drawing = false;

function updateCoords(b) {
  bounds = b;
  document.getElementById('coords').textContent =
    'W:' + b.getWest().toFixed(5) + '  S:' + b.getSouth().toFixed(5) +
    '  E:' + b.getEast().toFixed(5) + '  N:' + b.getNorth().toFixed(5);
  document.getElementById('sendBtn').style.display = 'block';
  document.getElementById('clearBtn').style.display = 'block';
}

function clearRect() {
  if (rect) { map.removeLayer(rect); rect = null; }
  bounds = null;
  document.getElementById('coords').textContent = 'No selection';
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('clearBtn').style.display = 'none';
}

function sendBounds() {
  if (!bounds) return;
  var url = 'geotb://bounds?w=' + bounds.getWest().toFixed(6) +
            '&s=' + bounds.getSouth().toFixed(6) +
            '&e=' + bounds.getEast().toFixed(6) +
            '&n=' + bounds.getNorth().toFixed(6);
  window.location.href = url;
}

// Shift+drag to draw rectangle
map.on('mousedown', function(e) {
  if (!e.originalEvent.shiftKey) return;
  map.dragging.disable();
  drawing = true;
  startLL = e.latlng;
  if (rect) { map.removeLayer(rect); rect = null; }
});
map.on('mousemove', function(e) {
  if (!drawing) return;
  var b = L.latLngBounds(startLL, e.latlng);
  if (rect) map.removeLayer(rect);
  rect = L.rectangle(b, {color:'#2563eb', weight:2, fillOpacity:0.15}).addTo(map);
  updateCoords(b);
});
map.on('mouseup', function(e) {
  if (!drawing) return;
  drawing = false;
  map.dragging.enable();
  if (rect) {
    var b = rect.getBounds();
    updateCoords(b);
  }
});
</script>
</body>
</html>)HTML");

// ─── SGeoMapPicker::Construct ─────────────────────────────────────────────────
void SGeoMapPicker::Construct(const FArguments& InArgs)
{
    OnBoundsSelected = InArgs._OnBoundsSelected;

    // Write HTML to a temp file so the browser can load it with full JS support
    const FString HtmlPath = FPaths::ProjectSavedDir() / TEXT("GeoTerrain/map_picker.html");
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(HtmlPath), true);
    FFileHelper::SaveStringToFile(kLeafletHtml, *HtmlPath, FFileHelper::EEncodingOptions::ForceUTF8);

    const FString FileUrl = TEXT("file:///") + HtmlPath.Replace(TEXT("\\"), TEXT("/"));

    ChildSlot
    [
        SAssignNew(Browser, SWebBrowser)
        .InitialURL(FileUrl)
        .ShowControls(false)
        .ShowAddressBar(false)
        .OnUrlChanged_Lambda([this](const FText& Url)
        {
            HandleBrowserUrlChanged(Url);
        })
    ];
}

// ─── Parse geotb://bounds?w=...&s=...&e=...&n=... ────────────────────────────
bool SGeoMapPicker::HandleBrowserUrlChanged(const FText& UrlText)
{
    const FString Url = UrlText.ToString();
    if (!Url.StartsWith(TEXT("geotb://bounds"))) return false;

    // Parse query params
    auto GetParam = [&](const FString& Key) -> double
    {
        FString Search = Key + TEXT("=");
        int32 Idx = Url.Find(Search);
        if (Idx == INDEX_NONE) return 0.0;
        Idx += Search.Len();
        int32 End = Url.Find(TEXT("&"), ESearchCase::IgnoreCase, ESearchDir::FromStart, Idx);
        FString Val = (End == INDEX_NONE) ? Url.Mid(Idx) : Url.Mid(Idx, End - Idx);
        return FCString::Atod(*Val);
    };

    double W = GetParam(TEXT("w"));
    double S = GetParam(TEXT("s"));
    double E = GetParam(TEXT("e"));
    double N = GetParam(TEXT("n"));

    if (OnBoundsSelected.IsBound())
        OnBoundsSelected.Execute(W, S, E, N);

    // Navigate back to the map (don't stay on the geotb:// URL)
    if (Browser.IsValid())
    {
        const FString HtmlPath = FPaths::ProjectSavedDir() / TEXT("GeoTerrain/map_picker.html");
        const FString FileUrl  = TEXT("file:///") + HtmlPath.Replace(TEXT("\\"), TEXT("/"));
        Browser->LoadURL(FileUrl);
    }

    return true;
}
