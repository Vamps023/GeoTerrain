# ── GeoTerrain Unreal Plugin: GDAL Setup Script ──────────────────────────────
# Run once before building. Copies GDAL files from your OSGeo4W install
# into the ThirdParty/GDAL folder expected by GeoTerrain.Build.cs
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File UnrealGeoTerrain\Setup_GDAL.ps1

$OSGeo4W = "$env:LOCALAPPDATA\Programs\OSGeo4W"
$Dst     = "$PSScriptRoot\ThirdParty\GDAL"

if (-not (Test-Path $OSGeo4W)) {
    Write-Error "OSGeo4W not found at $OSGeo4W — install it from https://trac.osgeo.org/osgeo4w/"
    exit 1
}

# Create target dirs
New-Item -ItemType Directory -Force -Path "$Dst\include" | Out-Null
New-Item -ItemType Directory -Force -Path "$Dst\lib"     | Out-Null
New-Item -ItemType Directory -Force -Path "$Dst\bin"     | Out-Null

Write-Host "Copying GDAL headers..." -ForegroundColor Cyan
Copy-Item "$OSGeo4W\include\*" "$Dst\include\" -Recurse -Force

Write-Host "Copying GDAL import lib..." -ForegroundColor Cyan
Copy-Item "$OSGeo4W\lib\gdal_i.lib"  "$Dst\lib\" -Force
Copy-Item "$OSGeo4W\lib\gdal312.lib" "$Dst\lib\" -Force -ErrorAction SilentlyContinue

Write-Host "Copying GDAL runtime DLL..." -ForegroundColor Cyan
Copy-Item "$OSGeo4W\bin\gdal312.dll" "$Dst\bin\" -Force

Write-Host ""
Write-Host "Done! ThirdParty\GDAL is ready." -ForegroundColor Green
Write-Host "Next: right-click your .uproject and choose 'Generate Visual Studio project files'"
