# Builds Corpus.exe.
#
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1
#
# Uses the C# compiler that ships with Windows (.NET Framework 4), so there is
# nothing to install. Produces a ~15 KB exe in the project root, plus an icon
# and a desktop shortcut.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$csc  = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
  throw "No C# compiler found. Install the .NET Framework 4 developer pack, or use Corpus.bat instead."
}

# --- icon -------------------------------------------------------------------
# A serif C on a warm ground, matching the app. Drawn rather than shipped as a
# binary so there is no opaque blob in the repo.
Add-Type -AssemblyName System.Drawing

$icoPath = Join-Path $PSScriptRoot "corpus.ico"
$sizes   = 256, 64, 48, 32, 16
$pngs    = @()

foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(122, 75, 42))
  $g.FillEllipse($bg, 0, 0, ($size - 1), ($size - 1))

  $fg     = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(251, 250, 247))
  $font   = New-Object System.Drawing.Font "Georgia", ($size * 0.58), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment     = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF 0, ($size * 0.02), $size, $size
  $g.DrawString("C", $font, $fg, $rect, $format)

  $g.Dispose()

  $stream = New-Object System.IO.MemoryStream
  $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,($stream.ToArray())
  $bmp.Dispose()
  $stream.Dispose()
}

# ICO container: 6-byte header, then a 16-byte directory entry per image.
$ico = New-Object System.IO.MemoryStream
$w   = New-Object System.IO.BinaryWriter $ico
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([Byte]$dim); $w.Write([Byte]$dim)
  $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$pngs[$i].Length)
  $w.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $w.Write($png) }
$w.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())
$w.Dispose(); $ico.Dispose()
Write-Host "icon    -> $icoPath"

# --- compile ----------------------------------------------------------------
$exe = Join-Path $root "Corpus.exe"
$src = Join-Path $PSScriptRoot "Launcher.cs"

& $csc /nologo /target:winexe /optimize+ /out:"$exe" `
  /win32icon:"$icoPath" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  "$src"

if ($LASTEXITCODE -ne 0) { throw "Compilation failed." }
Write-Host "exe     -> $exe"

# --- desktop shortcut -------------------------------------------------------
try {
  $desktop  = [Environment]::GetFolderPath("Desktop")
  $lnk      = Join-Path $desktop "Corpus.lnk"
  $shell    = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnk)
  $shortcut.TargetPath       = $exe
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation     = $icoPath
  $shortcut.Description      = "Corpus - your research pedia"
  $shortcut.Save()
  Write-Host "shortcut-> $lnk"
} catch {
  Write-Host "shortcut-> skipped ($($_.Exception.Message))"
}

Write-Host ""
Write-Host "Done. Double-click Corpus.exe (or the desktop shortcut) to start."
