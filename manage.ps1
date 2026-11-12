# Windows shortcut for the cross-platform manager (goblin.mjs). It keeps the earlier parameters so
# existing instructions still work; every action is carried out by `node goblin.mjs`.
# The shared game's actions: -Action PetsHost -HostAction enable|disable|status|code,
# -Action PetsJoin -HostAddress <address[:port]> -CodeFile <path> (or -Off), and
# -Action PetsAdopt -SaveFile <path> [-Replace]. The pairing code is never a parameter.
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall', 'Doctor', 'PetsHost', 'PetsJoin', 'PetsAdopt')][string]$Action = 'Status',
  [string]$InstallRoot = '',
  [string]$SkillDirectory = '',
  [ValidateRange(1024, 65535)][int]$Port = 0,
  [string]$Surface = '',
  [ValidateSet('', 'enable', 'disable', 'status', 'code')][string]$HostAction = '',
  [string]$HostAddress = '',
  [string]$CodeFile = '',
  [string]$SaveFile = '',
  [switch]$Off,
  [switch]$Replace,
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

# PetsHost is the manager's "pets-host", and so on.
$arguments = @($cli, ($Action.ToLowerInvariant() -replace '^pets', 'pets-'))
if ($Action -eq 'PetsHost' -and $HostAction) { $arguments += $HostAction }
if ($Action -eq 'PetsAdopt' -and $SaveFile) { $arguments += [IO.Path]::GetFullPath($SaveFile) }
if ($InstallRoot) { $arguments += @('--install-dir', [IO.Path]::GetFullPath($InstallRoot)) }
if ($SkillDirectory) { $arguments += @('--codex-skill-dir', [IO.Path]::GetFullPath($SkillDirectory)) }
if ($Port) { $arguments += @('--port', [string]$Port) }
if ($Surface) { $arguments += @('--surface', $Surface) }
if ($HostAddress) { $arguments += @('--host', $HostAddress) }
if ($CodeFile) { $arguments += @('--code-file', [IO.Path]::GetFullPath($CodeFile)) }
if ($Off) { $arguments += '--off' }
if ($Replace) { $arguments += '--replace' }
if ($NoStart) { $arguments += '--no-start' }
if ($SkipSkill) { $arguments += '--skip-skill' }
if ($RemoveSettings) { $arguments += '--remove-settings' }
if ($ClaudeHooks) { $arguments += '--claude-hooks' }
if ($NoClaudeHooks) { $arguments += '--no-claude-hooks' }

& $node.Source @arguments
exit $LASTEXITCODE
