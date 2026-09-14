# Requires PowerShell 7. Run ONLY after the owner authorizes builds/verification.
# Uses cached Gradle directly: --offline cannot stop the wrapper downloading itself.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('default','gemma','both')][string]$Runtime,
    [Parameter(Mandatory)][string]$GradleHome,
    [Parameter(Mandatory)][string]$BaselineApk,
    [Parameter(Mandatory)][string]$BuildTools,
    [string]$JdkHome,
    [string]$Python = 'python',
    [switch]$Prebuild
)
$ErrorActionPreference = 'Stop'
$frontend = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$lab = (Resolve-Path (Join-Path $frontend '..')).Path
$android = Join-Path $frontend 'android'
$expectedBranch = 'codex/manus-gemma4-p0-p3'
$package = 'com.ahem.ledgrai'
$branch = & git -C $lab branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne $expectedBranch) { throw 'Wrong lab branch' }
$BaselineApk = (Resolve-Path -LiteralPath $BaselineApk).Path
$BuildTools = (Resolve-Path -LiteralPath $BuildTools).Path
$GradleHome = (Resolve-Path -LiteralPath $GradleHome).Path
$windowsHost = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$exeSuffix = if ($windowsHost) { '.exe' } else { '' }
$gradleName = if ($windowsHost) { 'gradle.bat' } else { 'gradle' }
$gradle = Join-Path $GradleHome "bin/$gradleName"
# This is the pinned distribution, not a newest-version fallback.
if (-not (Test-Path -LiteralPath (Join-Path $GradleHome 'lib/gradle-launcher-8.14.3.jar'))) {
    throw 'Provide an already installed/extracted Gradle 8.14.3 directory'
}
foreach ($tool in @($gradle, (Join-Path $BuildTools "aapt2$exeSuffix"), (Join-Path $BuildTools "zipalign$exeSuffix"))) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Missing installed tool: $tool" }
}
# Read release metadata, not java -version. An explicit JDK must pass; never silently replace it.
$candidates = if ($JdkHome) { @($JdkHome) } else { @($env:GEMMA_JDK, $env:JAVA_HOME) }
$selectedJdk = $null
foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $releaseFile = Join-Path $candidate 'release'
    if (-not (Test-Path -LiteralPath $releaseFile)) { continue }
    $releaseText = Get-Content -LiteralPath $releaseFile -Raw
    if ($releaseText -notmatch '(?m)^JAVA_VERSION="(17|21)(\.|")') { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate "bin/javac$exeSuffix"))) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate "bin/java$exeSuffix"))) { continue }
    $selectedJdk = (Resolve-Path -LiteralPath $candidate).Path
    break
}
if (-not $selectedJdk) { throw 'Set -JdkHome or GEMMA_JDK to a full JDK 17 or 21; JREs/Java 25 are rejected. Nothing installed.' }
$priorEnv = @{}
foreach ($name in @('JAVA_HOME','PATH','EXPO_OFFLINE','CI')) { $priorEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$oldLocation = Get-Location
try {
    $env:JAVA_HOME = $selectedJdk
    $env:PATH = (Join-Path $selectedJdk 'bin') + [IO.Path]::PathSeparator + $env:PATH
    $env:EXPO_OFFLINE = '1'
    $env:CI = '1'
    if ($Prebuild) {
        Set-Location -LiteralPath $frontend
        & node node_modules/expo/bin/cli prebuild --platform android --no-install
        if ($LASTEXITCODE -ne 0) { throw 'Non-clean prebuild failed' }
    }
    $wrapper = Get-Content -LiteralPath (Join-Path $android 'gradle/wrapper/gradle-wrapper.properties') -Raw
    if ($wrapper -notmatch 'gradle-8\.14\.3-bin\.zip') { throw 'Wrapper changed; review JDK/Gradle compatibility before building' }
    # Fail before Gradle if a different/generated signing setup appeared.
    $appGradle = Get-Content -LiteralPath (Join-Path $android 'app/build.gradle') -Raw
    if ($appGradle -match 'MYAPP_RELEASE|RELEASE_STORE|ledgr-release\.keystore' -or
        $appGradle -notmatch 'signingConfig signingConfigs\.debug') {
        throw 'Generated signing config changed; review before audit build'
    }
    $runDir = Join-Path $lab ('artifacts/audit-fixes/build-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runDir | Out-Null
    @{
        branch = $branch.Trim(); runtime = $Runtime; jdk = $selectedJdk
        gradle = $GradleHome; baselineApk = $BaselineApk; buildTools = $BuildTools
        signing = 'local Android debug keystore; not Play signing'
        requestedUtc = [DateTime]::UtcNow.ToString('o'); prebuild = [bool]$Prebuild
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDir 'build-request.json') -Encoding utf8
    $variants = if ($Runtime -eq 'both') { @('gemma','default') } else { @($Runtime) }
    Set-Location -LiteralPath $android
    foreach ($variant in $variants) {
        $enabled = if ($variant -eq 'gemma') { 'true' } else { 'false' }
        $arguments = @(":app:assembleRelease", "-PledgrGemmaEnabled=$enabled",
            '-PreactNativeArchitectures=arm64-v8a', '-PledgrRequireNeedle=true', '-Pandroid.enableMinifyInReleaseBuilds=false',
            '-Pandroid.enableShrinkResourcesInReleaseBuilds=false',
            "-Dorg.gradle.java.home=$selectedJdk", '-Pandroid.builder.sdkDownload=false',
            '--offline', '--no-daemon', '--no-configuration-cache', '--console=plain', '--init-script',
            (Join-Path $PSScriptRoot 'audit-testsigning.init.gradle'))
        & $gradle @arguments 2>&1 | Tee-Object -FilePath (Join-Path $runDir "$variant-build.log")
        if ($LASTEXITCODE -ne 0) { throw "Build failed: $variant (see $runDir); no install/download fallback" }
        $apk = Join-Path $runDir "$variant-arm64-standalone-testsigned.apk"
        Copy-Item -LiteralPath (Join-Path $android 'app/build/outputs/apk/release/app-release.apk') -Destination $apk
        # Preserve this variant BEFORE a second assembleRelease overwrites the output.
        $report = & $Python (Join-Path $PSScriptRoot 'verify-standalone-apk.py') --apk $apk --runtime $variant --package $package --min-sdk 24 --target-sdk 36 --baseline-apk $BaselineApk --zipalign (Join-Path $BuildTools "zipalign$exeSuffix") --aapt2 (Join-Path $BuildTools "aapt2$exeSuffix")
        if ($LASTEXITCODE -ne 0) { throw "APK acceptance failed: $variant; package/log preserved at $runDir" }
        $report | Set-Content -LiteralPath (Join-Path $runDir "$variant-verification.json") -Encoding utf8
    }
    Write-Output "Standalone test-signed artifacts and verification reports: $runDir"
} finally {
    Set-Location -LiteralPath $oldLocation.Path
    foreach ($name in $priorEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $priorEnv[$name], 'Process') }
}
