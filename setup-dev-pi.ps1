<#
.SYNOPSIS
Safely installs the shared Pi configuration on native Windows.

The Unix tmux/worktree commands are intentionally not installed. This script owns
only the explicit Pi resources below and backs up conflicting resources as .bak.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NonInteractive,
  [switch]$BootstrapPiDeps,
  [switch]$Uninstall,
  [switch]$Status
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Uninstall -and $Status) { throw 'Use only one of -Uninstall and -Status.' }

# This script lives in the repository root.
$RepoDir = $PSScriptRoot
$HomeDir = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($HomeDir)) { throw 'Could not determine the Windows user profile directory.' }
$PiDir = Join-Path $HomeDir '.pi\agent'
$PackagesDir = Join-Path $PiDir 'packages'
$ExtensionsDir = Join-Path $PiDir 'extensions'
$Mode = if ($Status) { 'status' } elseif ($Uninstall) { 'uninstall' } else { 'install' }

$PiLinks = @('settings.json', 'models.json', 'skills', 'usage')
# Personal profiles.jsonc is deliberately excluded. Team installs link only
# shared guard prompts, leaving ~/.pi/agent/pi-guard/profiles.jsonc user-owned.
$PiGuardLinks = @('prompts')
$PackageLinks = @('pi-guard', 'pi-webfetch', 'pi-usage', 'pi-guard-subagents', 'pi-skill-toggle')
$ExtensionLinks = @('ask-user-question.ts', 'prompt-snippets')
$ApprovedConflicts = @{}
$LegacyGuardLink = $false

function Say([string]$Message) { Write-Host $Message }
function Warn([string]$Message) { Write-Warning $Message }
function Fail([string]$Message) { throw "ERROR: $Message" }
function Invoke-Plan([scriptblock]$Action, [string]$Description) {
  if ($DryRun) { Say "PLAN: $Description" } else { & $Action }
}
function Get-NormalPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}
function Test-PathEntry([string]$Path) {
  # Get-Item recognizes dangling links, whereas Test-Path follows them.
  try { $null = Get-Item -LiteralPath $Path -Force; return $true } catch { return $false }
}
function Get-LinkTarget([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.LinkType -ne 'SymbolicLink') { return $null }
  $target = $item.Target
  if ($target -is [array]) { $target = $target[0] }
  if ([string]::IsNullOrWhiteSpace($target)) { return $null }
  if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $item.DirectoryName $target }
  return Get-NormalPath $target
}
function Test-OwnedLink([string]$Source, [string]$Target) {
  if (-not (Test-PathEntry $Target)) { return $false }
  try { return (Get-LinkTarget $Target) -eq (Get-NormalPath $Source) } catch { return $false }
}
function Confirm-Conflict([string]$Target) {
  if ($ApprovedConflicts.ContainsKey($Target)) { return }
  $backup = "$Target.bak"
  if (Test-PathEntry $backup) { Fail "Refusing to overwrite existing backup: $backup" }
  if ($DryRun) {
    Say "PLAN: conflict at $Target; would move it to $backup after confirmation"
    $ApprovedConflicts[$Target] = $true
    return
  }
  if ($NonInteractive) { Fail "Conflict at $Target; -NonInteractive never replaces unowned files." }
  do { $reply = Read-Host "Existing unowned target $Target will be moved to $backup. Continue? [y/N]" } while ($reply -notin @('y', 'Y', 'n', 'N', ''))
  if ($reply -notin @('y', 'Y')) { Fail "Skipped conflicting target: $Target" }
  $ApprovedConflicts[$Target] = $true
}
function Preflight-LinkConflict([string]$Source, [string]$Target) {
  if (-not (Test-OwnedLink $Source $Target) -and (Test-PathEntry $Target)) { Confirm-Conflict $Target }
}
function Require-Command([string]$Name, [string]$Help) {
  if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "Missing required command '$Name'. $Help" }
}
function Test-VersionAtLeast([string]$Actual, [string]$Required) {
  try {
    $actualVersion = [version](($Actual.Trim() -replace '^v', '' -replace '-.*$', ''))
    return $actualVersion -ge [version]$Required
  } catch { return $false }
}
function Invoke-InDirectory([string]$Directory, [scriptblock]$Action) {
  Push-Location -LiteralPath $Directory
  try { & $Action } finally { Pop-Location }
}
function Test-SymlinkSupport {
  if ($DryRun) { return }
  $probe = Join-Path $HomeDir ('.pi-link-probe-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType SymbolicLink -Path $probe -Target $RepoDir | Out-Null
  } catch {
    Fail 'Windows cannot create symbolic links for this account. Enable Developer Mode or run PowerShell elevated, then retry.'
  } finally {
    if (Test-PathEntry $probe) { Remove-Item -LiteralPath $probe -Force }
  }
}
function Test-PackageDependencies([string]$Package) {
  $directory = Join-Path $RepoDir "home\.pi\agent\packages\$Package"
  Invoke-InDirectory $directory {
    & npm ls --omit=dev --depth=0 *> $null
    return $LASTEXITCODE -eq 0
  }
}
function Preflight {
  if ($env:OS -ne 'Windows_NT') { Fail 'This installer supports native Windows only. Use setup-dev-pi.sh for macOS.' }
  Require-Command git 'Install Git for Windows: https://git-scm.com/download/win'
  Require-Command pi 'Install Pi: https://pi.dev/'
  Require-Command node 'Install Node.js 22.19 or newer: https://nodejs.org/'
  Require-Command npm 'Install Node.js 22.19 or newer: https://nodejs.org/'
  if ($BootstrapPiDeps) { Require-Command npx 'Install Node.js 22.19 or newer: https://nodejs.org/' }
  $nodeVersion = (& node --version | Select-Object -First 1)
  if (-not (Test-VersionAtLeast $nodeVersion '22.19.0')) { Fail "Node $nodeVersion is too old; Node 22.19.0 or newer is required." }
  $piVersion = (& pi --version | Select-Object -First 1)
  if (-not (Test-VersionAtLeast $piVersion '0.85.0')) { Fail "Pi $piVersion is too old; Pi 0.85.0 or newer is required." }
  if (-not (Test-Path -LiteralPath $HomeDir -PathType Container)) { Fail "User profile directory does not exist: $HomeDir" }
  if (-not (Test-Path -LiteralPath (Join-Path $RepoDir 'home\.pi\agent') -PathType Container)) { Fail 'Missing bundled Pi configuration.' }
  foreach ($package in $PackageLinks) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoDir "home\.pi\agent\packages\$package\package.json") -PathType Leaf)) { Fail "Missing Pi package: $package" }
  }
  if (-not $BootstrapPiDeps) {
    $missing = $false
    foreach ($package in $PackageLinks) {
      if (-not (Test-PackageDependencies $package)) { Warn "Pi package dependencies are missing or invalid: $package (run .\setup-dev-pi.ps1 -BootstrapPiDeps)"; $missing = $true }
    }
    if ($missing) { Fail 'Pi dependency preflight failed; no files were changed.' }
    $playwright = Join-Path $RepoDir 'home\.pi\agent\packages\pi-webfetch\node_modules\.bin\playwright.cmd'
    if (-not (Test-Path -LiteralPath $playwright -PathType Leaf)) { Fail 'Pi webfetch Playwright is missing (run .\setup-dev-pi.ps1 -BootstrapPiDeps).' }
    $installed = & $playwright install --list 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (($installed -join "`n") -match '(^|\s)chromium(\s|-|$)')) { Fail 'Pi webfetch Chromium is missing (run .\setup-dev-pi.ps1 -BootstrapPiDeps).' }
  }
  Test-SymlinkSupport
}
function Test-LegacyGuardLink {
  return Test-OwnedLink (Join-Path $RepoDir 'home\.pi\agent\pi-guard') (Join-Path $PiDir 'pi-guard')
}
function Migrate-LegacyGuardLink {
  if (-not $script:LegacyGuardLink) { return }
  $target = Join-Path $PiDir 'pi-guard'
  if ($DryRun) { Say "PLAN: replace legacy owned $target link with a directory so profiles.jsonc remains user-owned"; return }
  Remove-Item -LiteralPath $target -Force
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Say 'Migrated: legacy Pi guard link; profiles.jsonc is now user-owned'
}
function Install-Link([string]$Source, [string]$Target, [string]$Label) {
  $guardDirectory = (Join-Path $PiDir 'pi-guard') + [IO.Path]::DirectorySeparatorChar
  if ($DryRun -and $script:LegacyGuardLink -and $Target.StartsWith($guardDirectory, [StringComparison]::OrdinalIgnoreCase)) { Say "PLAN: link $Target -> $Source after migrating the legacy Pi guard link"; return }
  if (Test-OwnedLink $Source $Target) { Say "Unchanged: $Label ($Target)"; return }
  if (Test-PathEntry $Target) { Confirm-Conflict $Target; Invoke-Plan { Move-Item -LiteralPath $Target -Destination "$Target.bak" } "move $Target to $Target.bak"; Say "Backed up: $Target -> $Target.bak" }
  Invoke-Plan { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null; New-Item -ItemType SymbolicLink -Path $Target -Target $Source | Out-Null } "create symbolic link $Target -> $Source"
  Say "Linked: $Label ($Target)"
}
function Uninstall-Link([string]$Source, [string]$Target, [string]$Label) {
  if (Test-OwnedLink $Source $Target) {
    Invoke-Plan { Remove-Item -LiteralPath $Target -Force } "remove $Target"; Say "Removed: $Label ($Target)"
    if (Test-PathEntry "$Target.bak") { Invoke-Plan { Move-Item -LiteralPath "$Target.bak" -Destination $Target } "restore $Target.bak to $Target"; Say "Restored: $Target.bak -> $Target" }
  } else { Say "Preserved: $Label ($Target is absent, changed, or unowned)" }
}
function Status-Link([string]$Source, [string]$Target, [string]$Label) {
  if (Test-OwnedLink $Source $Target) { Say "owned link: $Label -> $Target" }
  elseif (Test-PathEntry $Target) { Say "foreign/drifted: $Label -> $Target" }
  else { Say "absent: $Label -> $Target" }
}
function Bootstrap-Dependencies {
  foreach ($package in $PackageLinks) {
    $directory = Join-Path $RepoDir "home\.pi\agent\packages\$package"
    Invoke-Plan { Invoke-InDirectory $directory { Say "Bootstrapping Pi package dependencies: $package"; & npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci failed for $package" } } } "(cd $directory && npm ci)"
  }
  $webfetch = Join-Path $RepoDir 'home\.pi\agent\packages\pi-webfetch'
  Invoke-Plan { Invoke-InDirectory $webfetch { Say 'Installing Playwright Chromium for pi-webfetch'; & npx playwright install chromium; if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium install failed' } } } "(cd $webfetch && npx playwright install chromium)"
}

if ($Mode -eq 'install') { Preflight; if (Test-LegacyGuardLink) { $script:LegacyGuardLink = $true }; foreach ($item in $PiLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) }; if (-not $script:LegacyGuardLink) { foreach ($item in $PiGuardLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\pi-guard\$item") (Join-Path $PiDir "pi-guard\$item") } }; foreach ($item in $PackageLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) }; foreach ($item in $ExtensionLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) }; Migrate-LegacyGuardLink; if ($BootstrapPiDeps) { Bootstrap-Dependencies }; foreach ($item in $PiLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }; foreach ($item in $PiGuardLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\pi-guard\$item") (Join-Path $PiDir "pi-guard\$item") "Pi guard $item" }; foreach ($item in $PackageLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }; foreach ($item in $ExtensionLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" }; Say 'Pi setup complete. The tmux/worktree workflow is not installed on native Windows.' }
elseif ($Mode -eq 'uninstall') { foreach ($item in $PiLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }; foreach ($item in $PiGuardLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\pi-guard\$item") (Join-Path $PiDir "pi-guard\$item") "Pi guard $item" }; foreach ($item in $PackageLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }; foreach ($item in $ExtensionLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" } }
else { foreach ($item in $PiLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }; foreach ($item in $PiGuardLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\pi-guard\$item") (Join-Path $PiDir "pi-guard\$item") "Pi guard $item" }; foreach ($item in $PackageLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }; foreach ($item in $ExtensionLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" } }
