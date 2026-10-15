param(
  [string]$ThreadId = '',
  [int]$Port = 43917,
  [switch]$Demo
)

$endpoint = "http://127.0.0.1:$Port/api/config"
try {
  Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $env:PORT = [string]$Port
  if ($ThreadId) { $env:CODEX_VIEWER_THREAD_ID = $ThreadId }
  else { Remove-Item Env:CODEX_VIEWER_THREAD_ID -ErrorAction SilentlyContinue }
  $serverPath = Join-Path $PSScriptRoot 'server.mjs'
  Start-Process -FilePath $node -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) { throw 'Goblin Horde did not start. Run .\start.ps1 to inspect the error.' }
}

$python = (Get-Command pythonw.exe -ErrorAction Stop).Source
$widgetPath = Join-Path $PSScriptRoot 'desktop_widget.py'
$existing = Get-CimInstance Win32_Process -Filter "name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like "*$widgetPath*" } |
  Select-Object -First 1
if ($existing) {
  Write-Host "Goblin Horde goblins are already running (process $($existing.ProcessId))."
  return
}
$arguments = @(('"' + $widgetPath + '"'), '--port', [string]$Port)
if ($ThreadId) { $arguments += @('--thread', $ThreadId) }
if ($Demo) { $arguments += '--demo' }
$widget = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Write-Host "Goblin Horde started (process $($widget.Id)). Closing its window keeps the goblins in a strip on the desktop."
