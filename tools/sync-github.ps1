<#
  sync-github.ps1 - makes a snapshot of your GitHub repositories for the site.

  WHAT IT DOES
    Downloads the list of repositories + profile of the GitHub user and writes
    data/repos.json (UTF-8 without BOM). The site (assets/js/data/github.js)
    reads this file, so private repositories can be shown on the site
    (only name / description / language / dates - never code).
    The token is used ONLY for the requests below. It is never written to disk,
    never printed and never put into repos.json.

  HOW TO RUN
    Double-click tools\sync-github.bat  (it will ask for a token, Enter = skip)
    or from PowerShell:
      $env:GITHUB_TOKEN = "github_pat_..."; .\tools\sync-github.ps1
      .\tools\sync-github.ps1 -Token "github_pat_..."
      .\tools\sync-github.ps1              # no token: public repositories only

  HOW TO CREATE A TOKEN (fine-grained, read-only, takes 1 minute)
    1. GitHub -> avatar -> Settings -> Developer settings
       -> Personal access tokens -> Fine-grained tokens -> Generate new token
       (direct link: https://github.com/settings/personal-access-tokens/new)
    2. Token name: "site-sync", Expiration: any (for example 90 days).
    3. Resource owner: your account.
    4. Repository access: "All repositories".
    5. Permissions -> Repository permissions -> "Metadata": Read-only.
       NOTHING ELSE. (Metadata read-only is enough to list private repos;
       the token can not read code, write anything or delete anything.)
    6. Generate token, copy it (starts with github_pat_) and paste it when
       sync-github.bat asks. Do NOT commit the token anywhere.

  After the sync, upload the new data/repos.json together with the site.
#>
[CmdletBinding()]
param(
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$User = "ndzeone",
  [string]$Out = "",
  [switch]$Ask
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Windows PowerShell 5.1 quirk: without this arrays may serialize as {"value":[...],"Count":n}
if ($PSVersionTable.PSVersion.Major -lt 6) { Remove-TypeData System.Array -ErrorAction SilentlyContinue }

if (-not $Out) { $Out = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) "data") "repos.json" }
# .NET file APIs do not follow Set-Location, so make the path absolute
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

if (-not $Token -and $Ask) {
  Write-Host ""
  Write-Host "Paste a GitHub token to include PRIVATE repositories (input is hidden)." -ForegroundColor Cyan
  Write-Host "Just press Enter to sync public repositories only." -ForegroundColor DarkGray
  $secure = Read-Host "Token" -AsSecureString
  if ($secure -and $secure.Length -gt 0) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  }
}
if ($Token) { $Token = $Token.Trim() }

$Api = "https://api.github.com"

function Invoke-Gh([string]$Url) {
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "ndze-site-sync"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }
  try {
    $resp = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing
  } catch {
    $status = $null; $msg = $_.Exception.Message
    $r = $_.Exception.Response
    if ($r) {
      $status = [int]$r.StatusCode
      try {
        $reader = New-Object IO.StreamReader($r.GetResponseStream(), [Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        if ($body.message) { $msg = $body.message }
      } catch { }
      if ($status -eq 401) { throw "GitHub: token is invalid or expired (401). Create a new one." }
      $remaining = $null
      try { $remaining = @($r.Headers.GetValues("X-RateLimit-Remaining"))[0] } catch { }
      if (($status -eq 403 -or $status -eq 429) -and $remaining -eq "0") {
        throw "GitHub: API rate limit exceeded. Try again later or use a token."
      }
    }
    throw "GitHub request failed ($status): $msg  [$Url]"
  }
  # decode as UTF-8 ourselves (PS 5.1 may guess the wrong charset)
  $bytes = $resp.RawContentStream.ToArray()
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $next = $null
  # PS 7 returns header values as string[] (then -match would not fill $Matches)
  $link = @($resp.Headers["Link"]) -join ","
  if ($link -and $link -match '<([^>]+)>;\s*rel="next"') { $next = $Matches[1] }
  return @{ Data = ($text | ConvertFrom-Json); Next = $next }
}

function Get-AllPages([string]$Url) {
  $items = New-Object System.Collections.ArrayList
  $page = 0
  while ($Url) {
    $page++
    if ($page -gt 50) { break }
    $r = Invoke-Gh $Url
    foreach ($x in @($r.Data)) { [void]$items.Add($x) }
    $Url = $r.Next
  }
  return ,$items
}

function Str($v) { if ($null -eq $v) { return "" } return [string]$v }
function Num($v) { if ($null -eq $v) { return 0 } return [long]$v }
# PS 7 ConvertFrom-Json turns ISO dates into [datetime]; always write "yyyy-MM-ddTHH:mm:ssZ"
function Iso($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [datetime]) {
    return $v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  }
  return [string]$v
}

# Same shape as mapUser() in assets/js/data/github.js
function Map-User($u) {
  $name = Str $u.name
  if (-not $name) { $name = Str $u.login }
  return [pscustomobject][ordered]@{
    login       = Str $u.login
    name        = $name
    avatarUrl   = Str $u.avatar_url
    htmlUrl     = Str $u.html_url
    bio         = Str $u.bio
    publicRepos = Num $u.public_repos
    followers   = Num $u.followers
  }
}

# Same shape as mapRepo() in assets/js/data/github.js
function Map-Repo($r) {
  $topics = @()
  if ($r.topics) { $topics = @($r.topics | ForEach-Object { [string]$_ }) }
  $lang = $null
  if ($r.language) { $lang = [string]$r.language }
  $branch = Str $r.default_branch
  if (-not $branch) { $branch = "main" }
  return [pscustomobject][ordered]@{
    name          = Str $r.name
    fullName      = Str $r.full_name
    description   = Str $r.description
    private       = [bool]$r.private
    fork          = [bool]$r.fork
    archived      = [bool]$r.archived
    language      = $lang
    stars         = Num $r.stargazers_count
    forks         = Num $r.forks_count
    topics        = $topics
    defaultBranch = $branch
    size          = Num $r.size
    updatedAt     = Iso $r.updated_at
    pushedAt      = Iso $r.pushed_at
    createdAt     = Iso $r.created_at
    htmlUrl       = Str $r.html_url
    homepage      = Str $r.homepage
  }
}

Write-Host ""
if ($Token) {
  Write-Host "Syncing with token: public + private repositories..." -ForegroundColor Green
  $rawUser = (Invoke-Gh "$Api/user").Data
  $rawRepos = Get-AllPages "$Api/user/repos?visibility=all&affiliation=owner&per_page=100&sort=pushed"
} else {
  Write-Host "WARNING: no token - only PUBLIC repositories will be synced." -ForegroundColor Yellow
  Write-Host "         Private repositories need a token (see the header of this script)." -ForegroundColor Yellow
  $rawUser = (Invoke-Gh "$Api/users/$User").Data
  $rawRepos = Get-AllPages "$Api/users/$User/repos?type=owner&per_page=100&sort=pushed"
}

# dates are ISO strings (see Iso), so string sort == time sort
$repos = @($rawRepos | ForEach-Object { Map-Repo $_ } | Sort-Object -Property @{ Expression = { Str $_.pushedAt } } -Descending)

$snapshot = [pscustomobject][ordered]@{
  generatedAt = Iso (Get-Date)
  user        = Map-User $rawUser
  repos       = $repos
}

$json = ConvertTo-Json -InputObject $snapshot -Depth 8
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))

$priv = @($repos | Where-Object { $_.private }).Count
Write-Host ""
Write-Host ("Done: {0} repositories ({1} public, {2} private)" -f $repos.Count, ($repos.Count - $priv), $priv) -ForegroundColor Green
Write-Host "Saved: $Out"
$Token = $null
