# Windows shortcut for the cross-platform manager (goblin.mjs). It keeps the earlier parameters so
# existing instructions still work; every action is carried out by `node goblin.mjs`.
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall', 'Doctor')][string]$Action = 'Status',
  [string]$InstallRoot = '',
  [string]$SkillDirectory = '',
  [ValidateRange(1024, 65535)][int]$Port = 0,
  [switch]$NoStart,
  [switch]$SkipSkill,
  [switch]$RemoveSettings,
  [switch]$ClaudeHooks,
  [switch]$NoClaudeHooks
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20 or newer is needed. Install it from https://nodejs.org and try again.' }
$cli = Join-Path $PSScriptRoot 'goblin.mjs'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "goblin.mjs is missing from $PSScriptRoot." }

$arguments = @($cli, $Action.ToLowerInvariant())
if ($InstallRoot) { $arguments += @('--install-dir', [IO.Path]::GetFullPath($InstallRoot)) }
if ($SkillDirectory) { $arguments += @('--codex-skill-dir', [IO.Path]::GetFullPath($SkillDirectory)) }
if ($Port) { $arguments += @('--port', [string]$Port) }
if ($NoStart) { $arguments += '--no-start' }
if ($SkipSkill) { $arguments += '--skip-skill' }
if ($RemoveSettings) { $arguments += '--remove-settings' }
if ($ClaudeHooks) { $arguments += '--claude-hooks' }
if ($NoClaudeHooks) { $arguments += '--no-claude-hooks' }

& $node.Source @arguments
exit $LASTEXITCODE
