# Run a cargo command with the MSVC environment imported.
#
# `rusqlite`'s `bundled` feature compiles SQLite from C source, so a C toolchain
# must be on PATH. Visual Studio is installed on this machine but
# `vcvars64.bat` has not been run in the shell, so `cl.exe` is not visible and
# the build fails with a linker/compiler-not-found error that says nothing about
# the real cause.
#
# Usage:
#   .\scripts\cargo-msvc.ps1 test -p companion-memory-storage
#   .\scripts\cargo-msvc.ps1 clippy --all-targets -- -D warnings
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CargoArgs
)

$ErrorActionPreference = 'Stop'

$vcvars = @(
  'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $vcvars) {
  throw 'no vcvars64.bat found; install the MSVC C++ build tools or vendor a prebuilt SQLite'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# `cmd /c` is required: vcvars64.bat is a batch file, and its environment must
# be imported into the same process that runs cargo.
$quoted = ($CargoArgs | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
$command = "call `"$vcvars`" >nul 2>&1 && cd /d `"$root`" && cargo $quoted"

cmd /c $command
exit $LASTEXITCODE
