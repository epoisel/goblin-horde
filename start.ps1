param(
  [string]$ThreadId = '',
  [int]$Port = 43917
)

if ($ThreadId) { $env:CODEX_VIEWER_THREAD_ID = $ThreadId }
else { Remove-Item Env:CODEX_VIEWER_THREAD_ID -ErrorAction SilentlyContinue }
$env:PORT = [string]$Port
Set-Location -LiteralPath $PSScriptRoot
Write-Host "Opening Goblin Horde at http://127.0.0.1:$Port"
node .\server.mjs
