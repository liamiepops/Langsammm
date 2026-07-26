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
}
finally {
    Pop-Location
}
