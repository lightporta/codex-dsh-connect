param(
  [Parameter(Mandatory = $true)][string]$Distribution,
  [string]$NodePath = '/usr/bin/node'
)
$ErrorActionPreference = 'Stop'

# This job uses an existing opt-in self-hosted WSL2 environment. It never installs
# WSL, changes the default distro, requests account login or copies credentials.
if ($Distribution -notmatch '^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$') { throw 'Invalid explicit WSL distribution' }
if ($NodePath -notmatch '^/[^\x00-\x1f\\]+$') { throw 'NodePath must be an absolute Linux path' }
$distros = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | ForEach-Object { Get-ItemProperty $_.PSPath }
$selected = @($distros | Where-Object { $_.DistributionName -ceq $Distribution })
if ($selected.Count -ne 1 -or $selected[0].Version -ne 2) { throw 'The selected distribution must already exist and use WSL2' }

function Invoke-SelectedWsl {
  param([string[]]$Arguments)
  & wsl.exe --distribution $Distribution --exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 @Arguments
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed with exit code $LASTEXITCODE" }
}

$sourcePath = (& wsl.exe --distribution $Distribution --exec /usr/bin/wslpath -a -u $PWD.Path).Trim()
if ($LASTEXITCODE -ne 0 -or -not $sourcePath.StartsWith('/')) { throw 'Unable to resolve the checkout in the selected distribution' }
$linuxTemp = (& wsl.exe --distribution $Distribution --exec /usr/bin/mktemp -d /tmp/codex-wsl-ci-XXXXXXXX).Trim()
if ($LASTEXITCODE -ne 0 -or $linuxTemp -notmatch '^/tmp/codex-wsl-ci-[A-Za-z0-9]+$') { throw 'Unable to create a bounded temporary WSL checkout' }
try {
  # Copy only the working sources. Git metadata and local dependencies remain on
  # the host, and all test writes stay on the distro's Linux filesystem.
  Invoke-SelectedWsl -Arguments @('/bin/cp', '-r', '--', "$sourcePath/bin", "$sourcePath/lib", "$sourcePath/scripts", "$sourcePath/test", "$sourcePath/skill", "$sourcePath/package.json", "$sourcePath/package-lock.json", "$sourcePath/README.md", "$sourcePath/CHANGELOG.md", "$sourcePath/LICENSE", $linuxTemp)
  Invoke-SelectedWsl -Arguments @($NodePath, '--version')
  Invoke-SelectedWsl -Arguments @($NodePath, "$linuxTemp/scripts/test.mjs")
  Invoke-SelectedWsl -Arguments @($NodePath, "$linuxTemp/scripts/platform-isolation.mjs")
} finally {
  Invoke-SelectedWsl -Arguments @('/bin/rm', '-rf', '--', $linuxTemp)
}
