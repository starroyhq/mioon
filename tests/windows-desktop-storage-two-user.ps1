param(
  [switch]$Prepare,
  [string]$Electron,
  [string]$App,
  [switch]$Verify,
  [switch]$PermitTemporaryAccount,
  [string]$Parent,
  [string]$UserData,
  [string]$Repo,
  [switch]$Cleanup
)
# Native Windows evidence that the desktop app's own userData denies a second
# standard user. Only a new random probe directory is created and changed;
# no existing directory ACL is altered and only synthetic app files exist.
#   -Prepare (as the ordinary interactive user): the staged desktop app creates
#     its private userData inside a fresh probe parent that authenticated users
#     may list but not modify; the app is stopped at its first prompt.
#   -Verify (elevated, disposable account): reuses the reviewed probe of
#     windows-private-storage-two-user.ps1 as a new standard user.
#   -Cleanup: removes the probe parent.
$ErrorActionPreference = 'Stop'
if ($Prepare) {
  if (-not $Electron -or -not $App) { throw 'Electron and the staged desktop App paths are required.' }
  $parent = Join-Path ([IO.Path]::GetPathRoot($env:SystemRoot)) ('MioonDesktopAclProbe-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $parent | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $parent '/inheritance:r' '/grant:r' ("*$($sid):(OI)(CI)(F)") '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-11:(OI)(CI)(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The probe parent could not be protected against modification.' }
  $userData = Join-Path $parent 'user-data'
  $identity = Join-Path $userData 'desktop-identity.json'
  $env:MIOON_DESKTOP_USER_DATA = $userData
  $env:MIOON_ENABLE_LIVE_PROVIDER = '0'
  $process = Start-Process -FilePath $Electron -ArgumentList ('"' + $App + '"') -PassThru
  try {
    for ($index = 0; $index -lt 120 -and -not (Test-Path -LiteralPath $identity); $index++) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
  } finally { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  if (-not (Test-Path -LiteralPath $identity)) { throw 'The desktop app did not create its private userData.' }
  @{parent = $parent; userData = $userData; file = $identity} | ConvertTo-Json -Compress
  exit 0
}
if ($Verify) {
  if (-not $PermitTemporaryAccount -or -not $Parent -or -not $UserData -or -not $Repo) { throw 'Explicit temporary-account authorization, Parent, UserData and Repo are required.' }
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Native two-user verification requires an elevated isolated Windows test host.' }
  $name = 'MioonQa' + [guid]::NewGuid().ToString('N').Substring(0,10)
  $password = [guid]::NewGuid().ToString('N') + 'aA9!'
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
  $createdUser = $false
  try {
    New-LocalUser -Name $name -Password $secure -Description 'Disposable Mioon desktop ACL native QA' -AccountNeverExpires | Out-Null
    $createdUser = $true
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $name
    $probe = Join-Path $Parent 'probe.ps1'
    Copy-Item -LiteralPath (Join-Path $Repo 'tests\windows-private-storage-two-user.ps1') -Destination $probe
    try {
      $file = Join-Path $UserData 'desktop-identity.json'
      $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $probe + '"'),'-Probe','-TargetFile',('"' + $file + '"'),'-TargetDirectory',('"' + $UserData + '"'),'-ProbeParent',('"' + $Parent + '"'))
      $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -ArgumentList $arguments -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "Independent standard-user denial was not verified (probe exit $($process.ExitCode))." }
      @{test = 'desktop-userdata-secondary-user-read-and-list-denied'; passed = $true; providerCalls = 0} | ConvertTo-Json -Compress
    } finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  } finally {
    try { if ($createdUser) { Remove-LocalUser -Name $name -ErrorAction Stop } }
    finally { $password = $null; $credential = $null; $secure = $null }
  }
  exit 0
}
if ($Cleanup) {
  if (-not $Parent -or (Split-Path -Leaf $Parent) -notmatch '^MioonDesktopAclProbe-[0-9a-f]{32}$') { throw 'Only a probe parent created by -Prepare can be removed.' }
  Remove-Item -LiteralPath $Parent -Recurse -Force
  exit 0
}
throw 'Choose -Prepare, -Verify or -Cleanup.'
