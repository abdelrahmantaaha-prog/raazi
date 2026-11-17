# Builds the Raazi phone app on this PC.
#
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 [-Debug]
#
# Uses the Java, Android SDK and Gradle in E:\Claude\tools\android (the same
# toolchain Shasha and Adagio build with) and keeps Gradle's downloads there,
# because C: is nearly full. Signs with the release key in android\.signing\,
# so each new APK installs over the last one. Makes the key on first run.
# Output: dist\raazi-phone.apk
param([switch]$Debug)
$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
$root = Split-Path -Parent $here
$tools = "E:\Claude\tools\android"
$env:JAVA_HOME = "$tools\jdk17"
$env:ANDROID_HOME = "$tools\sdk"
$env:ANDROID_SDK_ROOT = "$tools\sdk"
$env:GRADLE_USER_HOME = "$tools\gradle-home"
New-Item -ItemType Directory -Force "$tools\.temp" | Out-Null
$env:GRADLE_OPTS = "-Djava.io.tmpdir=$tools\.temp"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

$sdkDir = $env:ANDROID_HOME.Replace('\', '\\').Replace(':', '\:')
Set-Content -Path "$here\local.properties" -Value "sdk.dir=$sdkDir" -Encoding ascii

# The release key, made once. Its password stays beside it (not in git); a
# copy is sealed in the owner's vault.
$signing = "$here\.signing"
if (-not $Debug -and -not (Test-Path "$signing\keystore.properties")) {
  New-Item -ItemType Directory -Force $signing | Out-Null
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pass = [Convert]::ToBase64String($bytes).Replace('+', 'a').Replace('/', 'b').Replace('=', '')
  & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore "$signing\raazi-release.p12" -storetype PKCS12 `
    -alias raazi -keyalg RSA -keysize 3072 -validity 10000 -storepass $pass -keypass $pass `
    -dname "CN=Raazi, O=LyMoon Tech" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
  Set-Content -Path "$signing\keystore.properties" -Encoding ascii -Value @(
    "storeFile=raazi-release.p12", "storePassword=$pass", "keyAlias=raazi", "keyPassword=$pass")
  Write-Host "Made a new release key in android\.signing\"
}

$task = if ($Debug) { "assembleDebug" } else { "assembleRelease" }
Push-Location $here
& "$tools\gradle-8.11.1\bin\gradle.bat" $task --no-daemon -q
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "Gradle build failed" }

$kind = if ($Debug) { "debug" } else { "release" }
$apk = Get-ChildItem "$here\app\build\outputs\apk\$kind" -Filter *.apk | Select-Object -First 1
New-Item -ItemType Directory -Force "$root\dist" | Out-Null
$out = "$root\dist\raazi-phone.apk"
Copy-Item $apk.FullName $out -Force
Write-Host "Built $out ($([math]::Round($apk.Length / 1MB, 1)) MB)"
