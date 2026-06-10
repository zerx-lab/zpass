<#
.SYNOPSIS
  在 Windows 上用 cargo-ndk 把 cryptocore 编译为 Android 多 ABI 的 libcryptocore.so。
  build-android.sh 的 PowerShell 等价物。

.DESCRIPTION
  前置依赖：
    - Rust toolchain（>= 1.85 for edition 2024）
    - Android NDK（建议用 Android Studio SDK Manager 安装），并设置：
        $env:ANDROID_NDK_HOME = "C:\Users\<you>\AppData\Local\Android\Sdk\ndk\<version>"
    - cargo-ndk：
        cargo install cargo-ndk
    - Android target 三元组（脚本会自动 rustup add）：
        aarch64-linux-android armv7-linux-androideabi
        x86_64-linux-android  i686-linux-android

  产物布局（被 phone 的 prebuild 流程 / with-cryptocore 复制到 app/src/main/jniLibs/）：
    cryptocore/build/jniLibs/arm64-v8a/libcryptocore.so
    cryptocore/build/jniLibs/armeabi-v7a/libcryptocore.so
    cryptocore/build/jniLibs/x86_64/libcryptocore.so
    cryptocore/build/jniLibs/x86/libcryptocore.so

.PARAMETER Abis
  要构建的 Android ABI。默认 4 ABI 全量；调试时可缩到单个：
    .\build-android.ps1 -Abis arm64-v8a

.PARAMETER AndroidApi
  Android API level，必须 >= phone/android 的 minSdkVersion。默认 24。

.EXAMPLE
  .\scripts\build-android.ps1
.EXAMPLE
  .\scripts\build-android.ps1 -Abis arm64-v8a,x86_64
#>
[CmdletBinding()]
param(
    [string[]] $Abis = @('arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'),
    [int]      $AndroidApi = 24
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CrateDir  = Split-Path -Parent $ScriptDir
$OutDir    = Join-Path $CrateDir 'build\jniLibs'

# ---- 检查 cargo-ndk ---------------------------------------------------------
if (-not (Get-Command cargo-ndk -ErrorAction SilentlyContinue)) {
    # cargo-ndk 是 cargo 子命令，独立 exe 名为 cargo-ndk
    $hasSub = $false
    try { cargo ndk --version *> $null; if ($LASTEXITCODE -eq 0) { $hasSub = $true } } catch {}
    if (-not $hasSub) {
        Write-Error @"
cargo-ndk 未安装。请先执行：
  cargo install cargo-ndk
"@
        exit 1
    }
}

# ---- 检查 / 探测 Android NDK ------------------------------------------------
$Ndk = $env:ANDROID_NDK_HOME
if (-not $Ndk) { $Ndk = $env:NDK_HOME }
if (-not $Ndk) {
    # 自动探测 SDK\ndk\<version>，取版本号最大的
    $sdkNdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk\ndk'
    if (Test-Path $sdkNdk) {
        $ver = Get-ChildItem $sdkNdk -Directory |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($ver) { $Ndk = $ver.FullName }
    }
}
if (-not $Ndk -or -not (Test-Path $Ndk)) {
    Write-Error @"
没有找到 Android NDK。请安装后设置 ANDROID_NDK_HOME，例如：
  `$env:ANDROID_NDK_HOME = "$($env:LOCALAPPDATA)\Android\Sdk\ndk\<version>"
（推荐用 Android Studio 的 SDK Manager 安装 NDK。）
"@
    exit 1
}
$env:ANDROID_NDK_HOME = $Ndk

# ---- ABI → rustc target triple ---------------------------------------------
function Get-Triple([string] $abi) {
    switch ($abi) {
        'arm64-v8a'   { 'aarch64-linux-android' }
        'armeabi-v7a' { 'armv7-linux-androideabi' }
        'x86_64'      { 'x86_64-linux-android' }
        'x86'         { 'i686-linux-android' }
        default       { $null }
    }
}

# ---- 自动安装缺失的 rustup target ------------------------------------------
if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $installed = (rustup target list --installed) 2>$null
    $toAdd = @()
    foreach ($abi in $Abis) {
        $triple = Get-Triple $abi
        if (-not $triple) { Write-Error "未知 ABI: $abi"; exit 1 }
        if ($installed -notcontains $triple) { $toAdd += $triple }
    }
    if ($toAdd.Count -gt 0) {
        Write-Host "[setup] 安装缺失的 rustup target: $($toAdd -join ' ')"
        rustup target add @toAdd
    }
} else {
    Write-Warning "未检测到 rustup —— 跳过 target 自动安装，假设你已手工装好"
}

# ---- 拼 cargo-ndk 的 -t 参数（用 Android ABI 名）---------------------------
$tArgs = @()
foreach ($abi in $Abis) { $tArgs += @('-t', $abi) }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "[build] ANDROID_NDK_HOME=$Ndk"
Write-Host "[build] abis=$($Abis -join ' ') api=$AndroidApi -> $OutDir"

Push-Location $CrateDir
try {
    cargo ndk @tArgs --platform $AndroidApi --output-dir $OutDir -- build --release --features android
    if ($LASTEXITCODE -ne 0) { Write-Error "cargo ndk build 失败"; exit 1 }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "[done] 产物："
Get-ChildItem -Path $OutDir -Recurse -Filter 'libcryptocore.so' | ForEach-Object {
    Write-Host ("  {0} ({1} bytes)" -f $_.FullName, $_.Length)
}
