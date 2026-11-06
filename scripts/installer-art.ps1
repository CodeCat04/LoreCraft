param(
  [string]$Icon = (Join-Path $PSScriptRoot '..\src-tauri\icons\source\lorecraft-octopus-256.png'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\src-tauri\icons\installer'),
  [string]$PreviewDir = '',
  # The deep-sea navy of the app icon's tile, from top to bottom of the sidebar.
  [string]$Top = '#1d3753',
  [string]$Bottom = '#0b1724',
  # The icon's parchment, for the name, and its tan, for the rule under it.
  [string]$Ink = '#f2dec0',
  [string]$Rule = '#b29e84'
)
# Draws the installer's pictures from the app icon: the sidebar on the first and last pages
# (164x314) and the header band on the others (150x57). Both are 24-bit BMP, which NSIS
# needs. Run it again after changing the icon:
#   powershell -NoProfile -File scripts/installer-art.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  return @($bmp, $g)
}
function C([string]$hex) { return [System.Drawing.ColorTranslator]::FromHtml($hex) }

$art = [System.Drawing.Image]::FromFile((Resolve-Path $Icon))

# ---- Sidebar: the deep sea, a pale glow behind the icon, the name in parchment ----
$bmp, $g = New-Canvas 164 314
$rect = New-Object System.Drawing.Rectangle 0, 0, 164, 314
$fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (C $Top), (C $Bottom), 90
$g.FillRectangle($fill, $rect)
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(-8, 18, 180, 180)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
$parchment = C $Ink
$glow.CenterColor = [System.Drawing.Color]::FromArgb(56, $parchment.R, $parchment.G, $parchment.B)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $parchment.R, $parchment.G, $parchment.B))
$g.FillPath($glow, $glowPath)
$g.DrawImage($art, (New-Object System.Drawing.Rectangle 22, 48, 120, 120))
$font = New-Object System.Drawing.Font 'Georgia', 17, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('LoreCraft', $font, (New-Object System.Drawing.SolidBrush $parchment), (New-Object System.Drawing.RectangleF 0, 186, 164, 26), $format)
$pen = New-Object System.Drawing.Pen (C $Rule), 1
$g.DrawLine($pen, 56, 216, 108, 216)
$g.Dispose()
$bmp.Save((Join-Path $OutDir 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
if ($PreviewDir) { $bmp.Save((Join-Path $PreviewDir 'sidebar.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
$bmp.Dispose()

# ---- Header: white, as the installer's top band is, with the icon on the right ----
$bmp, $g = New-Canvas 150 57
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($art, (New-Object System.Drawing.Rectangle 97, 5, 47, 47))
$g.Dispose()
$bmp.Save((Join-Path $OutDir 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
if ($PreviewDir) { $bmp.Save((Join-Path $PreviewDir 'header.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
$bmp.Dispose()
$art.Dispose()
