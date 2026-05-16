param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [string]$Browser = "chrome"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$desktopDir = Join-Path $repoRoot "desktop"
$installDir = Join-Path $env:LOCALAPPDATA "ZPass\NativeHost"
$hostExe = Join-Path $installDir "zpass-native-host.exe"
$manifestPath = Join-Path $installDir "com.zerx_lab.zpass.json"

New-Item -ItemType Directory -Force $installDir | Out-Null

Push-Location $desktopDir
try {
  go build -tags nativehost -trimpath -ldflags="-s -w" -o $hostExe .
}
finally {
  Pop-Location
}

$manifest = [ordered]@{
  name = "com.zerx_lab.zpass"
  description = "ZPass native messaging host"
  path = $hostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

switch ($Browser.ToLowerInvariant()) {
  "chrome" {
    $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.zerx_lab.zpass"
  }
  "edge" {
    $registryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.zerx_lab.zpass"
  }
  default {
    throw "Unsupported browser '$Browser'. Use chrome or edge."
  }
}

New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath

Write-Host "Installed ZPass native host for $Browser"
Write-Host "Extension ID: $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host "Host exe: $hostExe"
