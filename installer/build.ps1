<#
  Builds installer\dist\SentinelSetup.exe from installer\SentinelSetup.cs.

  No SDK, no NuGet, no build tool. The C# compiler that ships inside the
  .NET Framework is on every Windows 10 and 11 machine at
  %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe, and the binary it
  produces has no runtime dependency beyond the framework that is already
  there. That is the whole reason this is a .NET Framework console app and
  not a .NET 8 one: a .NET 8 build needs an SDK on the build machine and a
  runtime on the target, and neither is a thing we can assume.

  Usage:
    powershell -ExecutionPolicy Bypass -File installer\build.ps1
    powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Clean

  Output is deliberately under installer\dist\, which .gitignore already
  excludes. See installer\README.md for why the binary is not committed and
  what that means for the download button on the enrollment page.

  ----------------------------------------------------------------------
  This file is pure ASCII with no BOM, and must stay that way. Windows
  PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a UTF-8 en-dash or a
  typographic quote arrives as two garbage bytes and the parser treats one
  of them as a string delimiter. That has broken scripts in this repo twice.
  No `??`, no ternaries, no `-` other than ASCII hyphen.
  ----------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  # Remove dist\ before building, so a stale exe cannot be mistaken for a
  # fresh one when the compile fails.
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source  = Join-Path $Here 'SentinelSetup.cs'
$DistDir = Join-Path $Here 'dist'
$Output  = Join-Path $DistDir 'SentinelSetup.exe'

function Write-Head($text) {
  Write-Host ''
  Write-Host ('== ' + $text + ' ' + ('=' * [Math]::Max(4, 68 - $text.Length))) -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host ('  [ ok ] ' + $text) -ForegroundColor Green }
function Write-Info($text) { Write-Host ('  [ .. ] ' + $text) }
function Write-Warn($text) { Write-Host ('  [warn] ' + $text) -ForegroundColor Yellow }

function Stop-Build {
  param([string]$Problem, [string[]]$Fix)
  Write-Host ''
  Write-Host ('  [FAIL] ' + $Problem) -ForegroundColor Red
  Write-Host ''
  Write-Host '  What to do:' -ForegroundColor Yellow
  foreach ($line in $Fix) { Write-Host ('    ' + $line) -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

# --------------------------------------------------------- find a compiler ---

<#
  Returns the first usable C# compiler as a hashtable:
    @{ Exe = <path to run>; Prefix = @(<leading args>); Kind = <label> }

  Deliberately not one hardcoded path. Framework64 is right on every 64-bit
  machine we have met, but a 32-bit Windows has only Framework\, a locked
  down build agent can have the directory removed, and a machine with a real
  .NET SDK carries Roslyn instead. Each of those is a plausible place for
  somebody to run this, and failing on the first miss would be unhelpful when
  the second candidate would have worked.
#>
function Find-CSharpCompiler {
  $windir = $env:WINDIR
  if (-not $windir) { $windir = 'C:\Windows' }

  # Newest framework version first. v4.0.30319 is the only one that has ever
  # existed for .NET 4.x, but globbing costs nothing and survives a surprise.
  foreach ($arch in @('Framework64', 'Framework')) {
    $base = Join-Path $windir (Join-Path 'Microsoft.NET' $arch)
    if (-not (Test-Path -LiteralPath $base)) { continue }

    $versions = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'v4.*' } |
      Sort-Object Name -Descending

    foreach ($version in $versions) {
      $candidate = Join-Path $version.FullName 'csc.exe'
      if (Test-Path -LiteralPath $candidate) {
        return @{ Exe = $candidate; Prefix = @(); Kind = ('.NET Framework csc (' + $arch + '\' + $version.Name + ')') }
      }
    }
  }

  # A real SDK, if one is installed. `dotnet build` would need a .csproj we
  # do not have and do not want, so the SDK's Roslyn is invoked directly -
  # it takes the same command line as csc.exe.
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if ($dotnet) {
    $sdkLines = @()
    try { $sdkLines = @(& $dotnet.Source --list-sdks 2>$null) } catch { }

    foreach ($line in ($sdkLines | Sort-Object -Descending)) {
      # Format is:  9.0.100 [C:\Program Files\dotnet\sdk]
      $open = $line.IndexOf('[')
      if ($open -lt 1) { continue }
      $version = $line.Substring(0, $open).Trim()
      $root    = $line.Substring($open + 1).TrimEnd(']').Trim()

      $roslyn = Join-Path $root (Join-Path $version 'Roslyn\bincore\csc.dll')
      if (Test-Path -LiteralPath $roslyn) {
        return @{ Exe = $dotnet.Source; Prefix = @('exec', $roslyn); Kind = ('dotnet SDK Roslyn (' + $version + ')') }
      }
    }
  }

  return $null
}

# ------------------------------------------------------------------ build ---

Write-Head 'IT SENTINEL - building SentinelSetup.exe'

if (-not (Test-Path -LiteralPath $Source)) {
  Stop-Build -Problem ('Cannot find the source file: ' + $Source) -Fix @(
    'Run this script from a full checkout. It expects SentinelSetup.cs to be',
    'in the same folder as build.ps1.')
}

$compiler = Find-CSharpCompiler
if (-not $compiler) {
  Stop-Build -Problem 'No C# compiler found on this machine.' -Fix @(
    'Looked for, in order:',
    ('  ' + $env:WINDIR + '\Microsoft.NET\Framework64\v4.*\csc.exe'),
    ('  ' + $env:WINDIR + '\Microsoft.NET\Framework\v4.*\csc.exe'),
    '  a dotnet SDK carrying Roslyn at sdk\<version>\Roslyn\bincore\csc.dll',
    '',
    'The first two ship with the .NET Framework, which is part of Windows, so',
    'their absence is unusual. Turning on ".NET Framework 4.8 Advanced',
    'Services" in Windows Features restores them.',
    '',
    'You do not need this exe to enroll a machine. installer\SentinelSetup.cmd',
    'needs no compiler at all and does the same job.')
}

Write-Ok ('Compiler: ' + $compiler.Kind)
Write-Info $compiler.Exe

if ($Clean -and (Test-Path -LiteralPath $DistDir)) {
  Remove-Item -LiteralPath $DistDir -Recurse -Force
  Write-Info ('Cleaned ' + $DistDir)
}
if (-not (Test-Path -LiteralPath $DistDir)) {
  New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

# /platform:anycpu32bitpreferred keeps it a single binary that runs on both
# 32- and 64-bit Windows. /debug- and /optimize+ because nobody debugs this
# on a branch laptop and a smaller file is a marginally less alarming
# download. No /win32icon: an icon is another unsigned resource for very
# little, and the default console icon is what a console app should look
# like.
$cscArgs = @(
  '/nologo'
  '/target:exe'
  '/platform:anycpu32bitpreferred'
  '/optimize+'
  '/debug-'
  '/warnaserror+'
  ('/out:' + $Output)
  $Source
)

Write-Head 'COMPILE'
Write-Info ('-> ' + $Output)

# csc writes warnings to stdout and this is a native process, so its exit
# code is the only thing worth judging it by. $ErrorActionPreference is
# relaxed for the duration: Windows PowerShell 5.1 turns anything a native
# command writes to stderr into a terminating NativeCommandError under Stop.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $allArgs = @($compiler.Prefix) + $cscArgs
  & $compiler.Exe @allArgs 2>&1 | ForEach-Object { Write-Host ('         ' + $_) -ForegroundColor DarkGray }
  $code = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $prev
}

if ($code -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
  Stop-Build -Problem ('The compiler exited with code ' + $code + ' and produced no usable binary.') -Fix @(
    'The errors are printed above, with line numbers into SentinelSetup.cs.',
    '',
    'If they are about language features rather than your changes: the .NET',
    'Framework csc.exe only supports C# 5. No string interpolation, no',
    'null-conditional operators, no expression-bodied members.')
}

# ----------------------------------------------------------------- report ---

$file = Get-Item -LiteralPath $Output
$hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash

Write-Head 'BUILT'
Write-Ok $file.FullName
Write-Host ('         size    : ' + $file.Length + ' bytes')
Write-Host ('         sha256  : ' + $hash)
Write-Host ('         built   : ' + $file.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))

Write-Host ''
Write-Host '  Check it without installing anything:' -ForegroundColor Yellow
Write-Host ('    ' + $file.FullName + ' --dry-run --no-pause')
Write-Host ''
Write-Host '  This binary is NOT code signed, so a teammate who downloads it through' -ForegroundColor Yellow
Write-Host '  a browser gets a SmartScreen warning. installer\README.md explains the' -ForegroundColor Yellow
Write-Host '  click-path and says when to reach for SentinelSetup.cmd instead.' -ForegroundColor Yellow
Write-Host ''
