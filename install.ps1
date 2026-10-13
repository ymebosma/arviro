# Installs or updates Arviro on Windows, for the user who runs it:
#   1. installs Git, Node.js (LTS), poppler and Ollama with winget, when they are missing;
#   2. puts the code in %USERPROFILE%\arviro (or $env:ARVIRO_HOME) with git and installs its npm packages;
#   3. lets Arviro download kiwix-tools and the embedding model (arviro setup);
#   4. starts Arviro now and at every login (arviro service install) and opens the admin page.
#
#   irm https://raw.githubusercontent.com/ymebosma/arviro/main/install.ps1 | iex
#
# Run it again to update. osmium-tool has no Windows package, so map data is not indexed on Windows.
$ErrorActionPreference = "Stop"

$ArviroHome = if ($env:ARVIRO_HOME) { $env:ARVIRO_HOME } else { Join-Path $env:USERPROFILE "arviro" }
$ArviroRepo = if ($env:ARVIRO_REPO) { $env:ARVIRO_REPO } else { "https://github.com/ymebosma/arviro.git" }

function Say($text) { Write-Host "`n==> $text" }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Install-Package($id, $label) {
  Say "Installing $label"
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
function Node-Ok {
  if (-not (Have node)) { return $false }
  return ([int](node -p "process.versions.node.split('.')[0]")) -ge 22
}

if (-not (Have winget)) {
  throw "winget (the App Installer from the Microsoft Store) is needed to install Git, Node.js and the helper programs."
}

if (-not (Have git)) { Install-Package "Git.Git" "Git" }
if (-not (Node-Ok)) { Install-Package "OpenJS.NodeJS.LTS" "Node.js" }
if (-not (Have pdftotext)) { Install-Package "oschwartz10612.Poppler" "poppler (reads PDF files)" }
if (-not (Have ollama)) { Install-Package "Ollama.Ollama" "Ollama" }

Say "Arviro in $ArviroHome"
if (Test-Path (Join-Path $ArviroHome ".git")) {
  git -C $ArviroHome pull --ff-only
} elseif (Test-Path $ArviroHome) {
  throw "$ArviroHome exists but is not a checkout of Arviro. Move it away, or set ARVIRO_HOME to another folder."
} else {
  git clone $ArviroRepo $ArviroHome
}
npm --prefix $ArviroHome install --no-fund --no-audit

Say "kiwix-tools and the embedding model"
# A missing download (no internet, Ollama not running yet) is reported, not fatal: the admin page offers it again.
node (Join-Path $ArviroHome "bin\arviro.js") setup
$global:LASTEXITCODE = 0

Say "Service"
node (Join-Path $ArviroHome "bin\arviro.js") service install
