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
  [switch]$Status,
  [switch]$Verify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ((@($Uninstall, $Status, $Verify) | Where-Object { $_ }).Count -gt 1) { throw 'Use only one of -Uninstall, -Status, and -Verify.' }
if ($Verify -and $DryRun) { throw '-Verify cannot be combined with -DryRun.' }
if (($Uninstall -or $Status -or $Verify) -and $BootstrapPiDeps) { throw '-BootstrapPiDeps is install-only.' }
if (($Uninstall -or $Status -or $Verify) -and $NonInteractive) { throw '-NonInteractive is install-only.' }

# This script lives in the repository root.
$RepoDir = $PSScriptRoot
$HomeDir = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($HomeDir)) { throw 'Could not determine the Windows user profile directory.' }
$PiDir = Join-Path $HomeDir '.pi\agent'
$PackagesDir = Join-Path $PiDir 'packages'
$ExtensionsDir = Join-Path $PiDir 'extensions'
$Operation = if ($Verify) { 'verify' } elseif ($Status) { 'status' } elseif ($Uninstall) { 'uninstall' } else { 'install' }

$PiLinks = @('settings.json', 'models.json', 'skills', 'usage')
$PackageLinks = @('pi-guard', 'pi-webfetch', 'pi-usage', 'pi-guard-subagents', 'pi-skill-toggle')
$ExtensionLinks = @('ask-user-question.ts', 'prompt-snippets')
$ApprovedConflicts = @{}

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
  if (-not (Test-Path -LiteralPath $Source)) { return $false }
  if (-not (Test-PathEntry $Target)) { return $false }
  try { return (Get-LinkTarget $Target) -eq (Get-NormalPath $Source) } catch { return $false }
}
function Assert-SafeTargetAncestors {
  foreach ($ancestor in @((Join-Path $HomeDir '.pi'), $PiDir, $PackagesDir, $ExtensionsDir)) {
    if (Test-PathEntry $ancestor) {
      $ancestorItem = Get-Item -LiteralPath $ancestor -Force
      if ($ancestorItem.LinkType -eq 'SymbolicLink' -or $null -ne $ancestorItem.LinkType) { Fail "Refusing to manage targets beneath linked/reparse-point directory: $ancestor" }
    }
  }
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
  if ($env:OS -ne 'Windows_NT') { Fail 'This installer supports native Windows only. Use ./setup.sh for macOS.' }
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
  Assert-SafeTargetAncestors
  foreach ($item in $PiLinks) {
    $source = Join-Path $RepoDir "home\.pi\agent\$item"
    if (-not (Test-Path -LiteralPath $source)) { Fail "Missing Pi source: $source" }
  }
  foreach ($package in $PackageLinks) {
    $source = Join-Path $RepoDir "home\.pi\agent\packages\$package"
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { Fail "Missing Pi package source: $source" }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json') -PathType Leaf)) { Fail "Missing Pi package manifest: $package" }
  }
  foreach ($item in $ExtensionLinks) {
    $source = Join-Path $RepoDir "home\.pi\agent\extensions\$item"
    if (-not (Test-Path -LiteralPath $source)) { Fail "Missing Pi extension source: $source" }
  }
  if (-not $BootstrapPiDeps) {
    $missing = $false
    foreach ($package in $PackageLinks) {
      if (-not (Test-PackageDependencies $package)) { Warn "Pi package dependencies are missing or invalid: $package (run .\setup.ps1 -BootstrapPiDeps)"; $missing = $true }
    }
    if ($missing) { Fail 'Pi dependency preflight failed; no files were changed.' }
    $playwright = Join-Path $RepoDir 'home\.pi\agent\packages\pi-webfetch\node_modules\.bin\playwright.cmd'
    if (-not (Test-Path -LiteralPath $playwright -PathType Leaf)) { Fail 'Pi webfetch Playwright is missing (run .\setup.ps1 -BootstrapPiDeps).' }
    $installed = & $playwright install --list 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (($installed -join "`n") -match 'chromium(\s|-|$)')) { Fail 'Pi webfetch Chromium is missing (run .\setup.ps1 -BootstrapPiDeps).' }
  }
  Test-SymlinkSupport
}
function Test-LegacyGuardLink {
  return Test-OwnedLink (Join-Path $RepoDir 'home\.pi\agent\pi-guard') (Join-Path $PiDir 'pi-guard')
}
function Install-Link([string]$Source, [string]$Target, [string]$Label) {
  if (Test-OwnedLink $Source $Target) { Say "Unchanged: $Label ($Target)"; return }
  if (Test-PathEntry $Target) { Confirm-Conflict $Target; Invoke-Plan { Move-Item -LiteralPath $Target -Destination "$Target.bak" } "move $Target to $Target.bak"; Say "Backed up: $Target -> $Target.bak" }
  Invoke-Plan { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null; New-Item -ItemType SymbolicLink -Path $Target -Target $Source | Out-Null } "create symbolic link $Target -> $Source"
  Say "Linked: $Label ($Target)"
}
function Uninstall-Link([string]$Source, [string]$Target, [string]$Label) {
  if (Test-OwnedLink $Source $Target) {
    Invoke-Plan { Remove-Item -LiteralPath $Target -Force } "remove $Target"; Say "Removed: $Label ($Target)"
    if (Test-PathEntry "$Target.bak") { Say "Preserved backup for manual restoration: $Target.bak" }
  } else { Say "Preserved: $Label ($Target is absent, changed, or unowned)" }
}
function Status-Link([string]$Source, [string]$Target, [string]$Label) {
  if (Test-OwnedLink $Source $Target) { Say "owned link: $Label -> $Target" }
  elseif (Test-PathEntry $Target) { Say "foreign/drifted: $Label -> $Target" }
  else { Say "absent: $Label -> $Target" }
}
function Verify-Link([string]$Source, [string]$Target, [string]$Label) {
  if (-not (Test-OwnedLink $Source $Target)) { Fail "$Label is missing or drifted: $Target" }
  Say "verified: $Label"
}
function Bootstrap-Dependencies {
  foreach ($package in $PackageLinks) {
    $directory = Join-Path $RepoDir "home\.pi\agent\packages\$package"
    Invoke-Plan { Invoke-InDirectory $directory { Say "Bootstrapping Pi package dependencies: $package"; & npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci failed for $package" } } } "(cd $directory && npm ci)"
  }
  $webfetch = Join-Path $RepoDir 'home\.pi\agent\packages\pi-webfetch'
  $playwright = Join-Path $webfetch 'node_modules\.bin\playwright.cmd'
  Invoke-Plan { Say 'Installing Playwright Chromium for pi-webfetch'; & $playwright install chromium; if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium install failed' } } "$playwright install chromium"
}

if ($Operation -eq 'install') {
  Preflight
  if (Test-LegacyGuardLink) { Fail 'Legacy installer state detected; no files were changed. Run ./scripts/setup/migrate-legacy.sh from Git Bash, then rerun .\setup.ps1.' }
  foreach ($item in $PiLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) }
  foreach ($item in $PackageLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) }
  foreach ($item in $ExtensionLinks) { Preflight-LinkConflict (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) }
  if ($BootstrapPiDeps) { Bootstrap-Dependencies }
  foreach ($item in $PiLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }
  foreach ($item in $PackageLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }
  foreach ($item in $ExtensionLinks) { Install-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" }
  Say 'Pi setup complete. The tmux/worktree workflow is not installed on native Windows.'
} elseif ($Operation -eq 'uninstall') {
  Assert-SafeTargetAncestors
  foreach ($item in $PiLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }
  foreach ($item in $PackageLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }
  foreach ($item in $ExtensionLinks) { Uninstall-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" }
} elseif ($Operation -eq 'verify') {
  Assert-SafeTargetAncestors
  foreach ($item in $PiLinks) { Verify-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }
  foreach ($item in $PackageLinks) { Verify-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }
  foreach ($item in $ExtensionLinks) { Verify-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" }
  Say 'Verification passed.'
} else {
  Assert-SafeTargetAncestors
  foreach ($item in $PiLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\$item") (Join-Path $PiDir $item) "Pi $item" }
  foreach ($item in $PackageLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\packages\$item") (Join-Path $PackagesDir $item) "Pi package $item" }
  foreach ($item in $ExtensionLinks) { Status-Link (Join-Path $RepoDir "home\.pi\agent\extensions\$item") (Join-Path $ExtensionsDir $item) "Pi extension $item" }
}
