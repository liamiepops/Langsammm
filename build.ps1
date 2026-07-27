#!/usr/bin/env pwsh
#
# Builds the wasm module, checks the manifests, and assembles the loadable
# folders.
#
#   ./build.ps1             development. Chrome loads extension/ directly,
#                           Firefox loads dist/firefox. Both keep alt+A.
#   ./build.ps1 -Release    also writes dist/chrome-release and
#                           dist/firefox-release with development-only
#                           features compiled out.

param([switch]$Release)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot

function New-Dist {
    param(
        [string]$Name,
        [string]$Manifest,
        [bool]$StripDev
    )

    $dist = Join-Path $PSScriptRoot "dist\$Name"
    if ($dist -notlike (Join-Path $PSScriptRoot 'dist\*')) { throw "refusing to touch $dist" }
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force $dist | Out-Null

    Copy-Item (Join-Path $PSScriptRoot 'extension\*') $dist -Recurse -Force
    # The Chrome build already ships manifest.json, so there is nothing to swap.
    if ($Manifest -ne 'manifest.json') {
        Copy-Item (Join-Path $dist $Manifest) (Join-Path $dist 'manifest.json') -Force
    }
    Remove-Item (Join-Path $dist 'manifest.firefox.json') -Force

    if ($StripDev) {
        # A silent miss here would ship a testing feature, so it fails loudly.
        $page = Join-Path $dist 'page.js'
        $src = Get-Content $page -Raw
        $needle = 'const DEV = true;'
        if (-not $src.Contains($needle)) { throw "could not find '$needle' in page.js" }
        $src.Replace($needle, 'const DEV = false;') | Set-Content $page -NoNewline
        $check = Get-Content $page -Raw
        if ($check.Contains($needle)) { throw 'failed to strip the DEV flag' }
    }

    $dev = if ($StripDev) { 'release' } else { 'dev, alt+A included' }
    Write-Host ("dist/$Name".PadRight(24) + $dev)
}

try {
    cargo test --quiet
    cargo build --release --target wasm32-unknown-unknown
    $src = Join-Path $PSScriptRoot 'target\wasm32-unknown-unknown\release\slowform.wasm'
    $dst = Join-Path $PSScriptRoot 'extension\slowform.wasm'
    Copy-Item $src $dst -Force
    $kb = [math]::Round((Get-Item $dst).Length / 1024, 1)
    Write-Host "extension/slowform.wasm  $kb KB"

    node (Join-Path $PSScriptRoot 'tools\check-manifests.js')
    node (Join-Path $PSScriptRoot 'tools\worklet-harness.js') | Select-Object -Last 1

    # Chrome loads extension/ directly. Firefox needs its own manifest, because
    # the two browsers take different routes into the page's world.
    New-Dist -Name 'firefox' -Manifest 'manifest.firefox.json' -StripDev $false

    if ($Release) {
        New-Dist -Name 'chrome-release' -Manifest 'manifest.json' -StripDev $true
        New-Dist -Name 'firefox-release' -Manifest 'manifest.firefox.json' -StripDev $true
    }
}
finally {
    Pop-Location
}
