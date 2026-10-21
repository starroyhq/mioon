param(
  [string]$Node,
  [string]$Repo,
  [switch]$PermitTemporaryAccount,
  [switch]$Probe,
  [string]$TargetFile,
  [string]$TargetDirectory,
  [string]$ProbeParent
)
$ErrorActionPreference = 'Stop'
if ($Probe) {
  # This branch runs as the separate standard user. A successful read is a
  # failure, irrespective of what the JavaScript/native policy reports.
  # Prove the public probe parent is reachable so denial cannot be attributed
  # only to the original user's profile/TEMP ancestor permissions.
  try { [IO.Directory]::GetFileSystemEntries($ProbeParent) | Out-Null } catch { exit 45 }
  try { [IO.File]::ReadAllBytes($TargetFile) | Out-Null; exit 41 } catch [UnauthorizedAccessException] {} catch { exit 43 }
  try { [IO.Directory]::GetFileSystemEntries($TargetDirectory) | Out-Null; exit 42 } catch [UnauthorizedAccessException] {} catch { exit 44 }
  exit 0
}
if (-not $PermitTemporaryAccount -or -not $Node -or -not $Repo) { throw 'Explicit temporary-account test authorization, Node and Repo paths are required.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Native two-user verification requires an elevated isolated Windows test host; this is not a skipped/passing test.' }
$name = 'MioonQa' + [guid]::NewGuid().ToString('N').Substring(0,10)
$password = [guid]::NewGuid().ToString('N') + 'aA9!'
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name",$secure)
$root = $null
$shared = $null
$createdUser = $false
try {
  New-LocalUser -Name $name -Password $secure -Description 'Disposable Mioon ACL native QA' -AccountNeverExpires | Out-Null
  $createdUser = $true
  Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $name
  # Only a new random test directory is changed; no existing directory ACL is
  # altered. Authenticated users can read the parent, but cannot modify it.
  $shared = Join-Path ([IO.Path]::GetPathRoot($env:SystemRoot)) ('MioonAclProbe-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $shared | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $shared '/inheritance:r' '/grant:r' ("*$($sid):(OI)(CI)(F)") '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-11:(OI)(CI)(RX)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The independent probe directory could not be protected against modification.' }
  $bootstrap = ConvertTo-Json -InputObject (([uri]::new((Join-Path $Repo 'packages/node-host/src/private-storage-bootstrap.ts'))).AbsoluteUri) -Compress
  $storage = ConvertTo-Json -InputObject (([uri]::new((Join-Path $Repo 'packages/contracts/src/private-storage.ts'))).AbsoluteUri) -Compress
  $parentJson = ConvertTo-Json -InputObject $shared -Compress
  $script = @"
import {initializeNodePrivateStorage} from $bootstrap;
import {createPrivateTemporaryDirectory,writePrivateFileAtomic} from $storage;
import path from 'node:path';
await initializeNodePrivateStorage();const root=createPrivateTemporaryDirectory($parentJson,'mioon-two-user-');const file=path.join(root,'synthetic-secret');writePrivateFileAtomic(file,'SYNTHETIC-NO-USER-CREDENTIAL',{root,maxBytes:128});console.log(JSON.stringify({root,file}));
"@
  $json = $script | & $Node --input-type=module -
  if ($LASTEXITCODE -ne 0) { throw 'Native fixture creation failed.' }
  $fixture = $json | ConvertFrom-Json
  $root = $fixture.root
  # The probe script contains no credentials or payload, and remains readable
  # in the shared parent while the native-created child must deny access.
  try {
    $probeScript = Join-Path $shared 'probe.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $probeScript
    $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$probeScript+'"'),'-Probe','-TargetFile',('"'+$fixture.file+'"'),'-TargetDirectory',('"'+$fixture.root+'"'),'-ProbeParent',('"'+$shared+'"'))
    $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Independent standard-user denial was not verified (probe exit $($process.ExitCode))." }
    @{test='actual-secondary-user-read-and-list-denied';passed=$true;providerCalls=0} | ConvertTo-Json -Compress
  } finally { if ($shared) { Remove-Item -LiteralPath $shared -Recurse -Force; $shared = $null; $root = $null } }
} finally {
  try { if ($shared) { Remove-Item -LiteralPath $shared -Recurse -Force } elseif ($root) { Remove-Item -LiteralPath $root -Recurse -Force } }
  finally {
    try { if ($createdUser) { Remove-LocalUser -Name $name -ErrorAction Stop } }
    finally { $password = $null; $credential = $null; $secure = $null }
  }
}
