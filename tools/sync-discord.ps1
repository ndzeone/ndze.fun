<#
  sync-discord.ps1 - snapshot of the Discord servers shown on the home page.

  WHAT IT DOES
    Reads the invite codes from assets/js/config.js (SITE.discord[].invite),
    asks the public Discord invite API for each server (name, description,
    member / online counts) and downloads the server icon into data/discord/.
    Writes data/discord.json (UTF-8 without BOM).
    No token is needed - invite info is public.

  WHY
    Discord and its CDN are blocked in Russia, so the site can not rely on
    loading them in the visitor's browser. GitHub Actions runs this script on
    every deploy (and once a day), the files are served from ndze.fun itself.

  HOW TO RUN
    .\tools\sync-discord.ps1
#>
[CmdletBinding()]
param(
  [string]$Config = "",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($PSVersionTable.PSVersion.Major -lt 6) { Remove-TypeData System.Array -ErrorAction SilentlyContinue }

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $Root "assets/js/config.js" }
if (-not $Out) { $Out = Join-Path $Root "data/discord.json" }
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$ImgDir = Join-Path (Split-Path -Parent $Out) "discord"
if (-not (Test-Path $ImgDir)) { New-Item -ItemType Directory -Force -Path $ImgDir | Out-Null }

$configText = [IO.File]::ReadAllText($Config, [Text.Encoding]::UTF8)
$codes = @([regex]::Matches($configText, 'invite:\s*"([A-Za-z0-9-]{2,32})"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
if (-not $codes.Count) { throw "No invite codes found in $Config" }

$headers = @{ "User-Agent" = "ndze-site-sync (https://ndze.fun, 1.0)"; "Accept" = "application/json" }

function Get-Image([string]$Url, [string]$File) {
  try {
    $resp = Invoke-WebRequest -Uri $Url -Headers @{ "User-Agent" = $headers["User-Agent"] } -UseBasicParsing -TimeoutSec 30
    $bytes = $resp.RawContentStream.ToArray()
    if ($bytes.Length -lt 64) { return $null }
    [IO.File]::WriteAllBytes((Join-Path $ImgDir $File), $bytes)
    return "data/discord/$File"
  } catch {
    Write-Host "  image failed: $Url ($($_.Exception.Message))" -ForegroundColor Yellow
    return $null
  }
}

$servers = [ordered]@{}
$keep = New-Object System.Collections.Generic.HashSet[string]
foreach ($code in $codes) {
  Write-Host "Invite $code ..."
  $resp = Invoke-WebRequest -Uri "https://discord.com/api/v10/invites/$($code)?with_counts=true" -Headers $headers -UseBasicParsing -TimeoutSec 30
  $j = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
  $g = $j.guild
  if (-not $g) { Write-Host "  not a server invite, skipped" -ForegroundColor Yellow; continue }

  $icon = $null
  if ($g.icon) {
    $file = "$($g.id)-icon.webp"
    $icon = Get-Image "https://cdn.discordapp.com/icons/$($g.id)/$($g.icon).webp?size=256" $file
    if ($icon) { [void]$keep.Add($file) }
  }
  $desc = ""
  if ($g.description) { $desc = [string]$g.description }
  $servers[$code] = [pscustomobject][ordered]@{
    id          = [string]$g.id
    name        = [string]$g.name
    description = $desc
    icon        = $icon
    members     = [long]$j.approximate_member_count
    online      = [long]$j.approximate_presence_count
    channel     = [string]$j.channel.name
  }
  Write-Host ("  {0}: {1} members, {2} online" -f $g.name, $j.approximate_member_count, $j.approximate_presence_count) -ForegroundColor Green
}

# old icons of servers that are no longer on the site
Get-ChildItem $ImgDir -File | Where-Object { -not $keep.Contains($_.Name) } | Remove-Item -Force

$snapshot = [pscustomobject][ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  servers     = [pscustomobject]$servers
}
[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $snapshot -Depth 6), (New-Object Text.UTF8Encoding $false))
Write-Host "Saved: $Out"
