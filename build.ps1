#!/usr/bin/env pwsh
# Builds the wasm module and drops it into the extension folder.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
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
    $dist = Join-Path $PSScriptRoot 'dist\firefox'
    if ($dist -notlike (Join-Path $PSScriptRoot 'dist\*')) { throw "refusing to touch $dist" }
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force $dist | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'extension\*') $dist -Recurse -Force
    Copy-Item (Join-Path $dist 'manifest.firefox.json') (Join-Path $dist 'manifest.json') -Force
    Remove-Item (Join-Path $dist 'manifest.firefox.json') -Force
    Write-Host "dist/firefox            load this one in Firefox"
}
finally {
    Pop-Location
}
