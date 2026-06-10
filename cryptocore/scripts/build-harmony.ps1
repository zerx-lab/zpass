<#
.SYNOPSIS
  在 Windows 上把 cryptocore 编译为 HarmonyOS 的 libcryptocore.so（napi-rs 桥）。
  build-harmony.sh 的 PowerShell 等价物 —— bash 版在 Windows 下 /cygdrive 路径与
  GNU 工具依赖（find -printf / stat -c）很脆弱，这里用原生 Windows 工具链。

.DESCRIPTION
  前置依赖：
    - Rust toolchain（>= 1.85 for edition 2024）
    - DevEco Studio 自带的 OpenHarmony NDK（native 目录），默认探测：
        $env:LOCALAPPDATA\OpenHarmony\Sdk\<api>\native
      也可显式指定：
        $env:HARMONY_NDK_HOME = "C:\Users\<you>\AppData\Local\OpenHarmony\Sdk\23\native"
      该目录下应包含 llvm\bin\clang.exe 与 sysroot\。
    - 对应 Rust target（脚本会自动 rustup add）：
        aarch64-unknown-linux-ohos  x86_64-unknown-linux-ohos

  产物布局（由 harmony/entry/build-profile.json5 的 nativeLib 引入）：
    cryptocore/build/ohosLibs/arm64-v8a/libcryptocore.so   (鸿蒙真机)
    cryptocore/build/ohosLibs/x86_64/libcryptocore.so      (鸿蒙模拟器)

.PARAMETER Abis
  要构建的 OHOS ABI，默认 arm64-v8a + x86_64。调试时可缩到单个：
    .\build-harmony.ps1 -Abis arm64-v8a

.EXAMPLE
  .\scripts\build-harmony.ps1
.EXAMPLE
  $env:HARMONY_NDK_HOME = "D:\OpenHarmony\Sdk\23\native"; .\scripts\build-harmony.ps1
#>
[CmdletBinding()]
param(
    [string[]] $Abis = @('arm64-v8a', 'x86_64')
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CrateDir  = Split-Path -Parent $ScriptDir
$OutDir    = Join-Path $CrateDir 'build\ohosLibs'

# ---- 定位 OHOS NDK ----------------------------------------------------------
# 优先级：HARMONY_NDK_HOME > OHOS_NDK_HOME > 自动探测 OpenHarmony\Sdk\<api>\native
$NdkHome = $env:HARMONY_NDK_HOME
if (-not $NdkHome) { $NdkHome = $env:OHOS_NDK_HOME }
if (-not $NdkHome) {
    $sdkRoot = Join-Path $env:LOCALAPPDATA 'OpenHarmony\Sdk'
    if (Test-Path $sdkRoot) {
        # 取数字最大的 API 目录（如 23）
        $apiDir = Get-ChildItem $sdkRoot -Directory |
            Where-Object { $_.Name -match '^\d+$' } |
            Sort-Object { [int]$_.Name } -Descending |
            Select-Object -First 1
        if ($apiDir) {
            $candidate = Join-Path $apiDir.FullName 'native'
            if (Test-Path $candidate) { $NdkHome = $candidate }
        }
    }
}

if (-not $NdkHome -or -not (Test-Path $NdkHome)) {
    Write-Error @"
没有找到 OpenHarmony NDK。请设置 HARMONY_NDK_HOME，例如：
  `$env:HARMONY_NDK_HOME = "$($env:LOCALAPPDATA)\OpenHarmony\Sdk\23\native"
该目录下应有 llvm\bin\clang.exe 与 sysroot\。
"@
    exit 1
}

$Clang = Join-Path $NdkHome 'llvm\bin\clang.exe'
$Ar    = Join-Path $NdkHome 'llvm\bin\llvm-ar.exe'
if (-not (Test-Path $Clang)) { Write-Error "未找到 clang: $Clang"; exit 1 }

# napi-build-ohos 1.x 的 build.rs 只读 OHOS_NDK_HOME；对齐过去。
$env:OHOS_NDK_HOME = $NdkHome

# ---- ABI → rustc target triple ---------------------------------------------
function Get-Triple([string] $abi) {
    switch ($abi) {
        'arm64-v8a'   { 'aarch64-unknown-linux-ohos' }
        'x86_64'      { 'x86_64-unknown-linux-ohos' }
        'armeabi-v7a' { 'armv7-unknown-linux-ohos' }
        default       { $null }
    }
}

# ---- 自动安装缺失的 rustup target ------------------------------------------
if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $installed = (rustup target list --installed) 2>$null
    foreach ($abi in $Abis) {
        $triple = Get-Triple $abi
        if (-not $triple) { Write-Error "未知 ABI: $abi"; exit 1 }
        if ($installed -notcontains $triple) {
            Write-Host "[setup] rustup target add $triple"
            rustup target add $triple
        }
    }
} else {
    Write-Warning "未检测到 rustup —— 假设 target 已手工装好"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "[build] OHOS_NDK_HOME=$NdkHome"
Write-Host "[build] abis=$($Abis -join ' ') -> $OutDir"

Push-Location $CrateDir
try {
    foreach ($abi in $Abis) {
        $triple = Get-Triple $abi
        Write-Host ""
        Write-Host "[build] $abi ($triple)"

        # cargo / cc-rs 的 per-target env：
        #   CARGO_TARGET_<TRIPLE_UPPER>_LINKER     大写 + 下划线
        #   CC_<triple_lower> / AR_<triple_lower>  小写 + 下划线
        $upper = $triple.ToUpper().Replace('-', '_')
        $lower = $triple.Replace('-', '_')

        $linkerVar = "CARGO_TARGET_${upper}_LINKER"
        $ccVar     = "CC_${lower}"
        $cxxVar    = "CXX_${lower}"
        $arVar     = "AR_${lower}"
        $cflagsVar = "CFLAGS_${lower}"

        # 用 ohos clang 当 linker；显式 --target 让 clang 选对 sysroot，
        # 并强制 lld（OHOS 工具链自带 ld.lld）。
        Set-Item -Path "Env:$linkerVar" -Value $Clang
        Set-Item -Path "Env:$ccVar"     -Value $Clang
        Set-Item -Path "Env:$cxxVar"    -Value $Clang
        Set-Item -Path "Env:$arVar"     -Value $Ar
        Set-Item -Path "Env:$cflagsVar" -Value "--target=$triple"
        $env:RUSTFLAGS = "-C link-arg=--target=$triple -C link-arg=-fuse-ld=lld"

        try {
            cargo build --release --no-default-features --features harmony --target $triple
            if ($LASTEXITCODE -ne 0) { Write-Error "cargo build 失败 ($abi)"; exit 1 }

            $src = Join-Path $CrateDir "target\$triple\release\libcryptocore.so"
            if (-not (Test-Path $src)) { Write-Error "编译完成但找不到 $src"; exit 1 }

            $dstDir = Join-Path $OutDir $abi
            New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
            $dst = Join-Path $dstDir 'libcryptocore.so'
            Copy-Item -Force $src $dst
            $size = (Get-Item $dst).Length
            Write-Host "[ok] $dst ($size bytes)"
        }
        finally {
            Remove-Item -ErrorAction SilentlyContinue "Env:$linkerVar", "Env:$ccVar", "Env:$cxxVar", "Env:$arVar", "Env:$cflagsVar", 'Env:RUSTFLAGS'
        }
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "[done] 产物："
Get-ChildItem -Path $OutDir -Recurse -Filter 'libcryptocore.so' | ForEach-Object {
    Write-Host ("  {0} ({1} bytes)" -f $_.FullName, $_.Length)
}
