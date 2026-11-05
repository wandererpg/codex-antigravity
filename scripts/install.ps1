param([switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$CodexConfigRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$CodexConfigRoot = [IO.Path]::GetFullPath($CodexConfigRoot)
$InstallRoot = Join-Path $CodexConfigRoot 'tools\codex-antigravity'
$ServerPath = Join-Path $InstallRoot 'src\server.mjs'
$ConfigPath = Join-Path $CodexConfigRoot 'config.toml'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$BackupDirectory = Join-Path $InstallRoot '.local\backups'

if ((Test-Path -LiteralPath $InstallRoot) -and ($ProjectRoot -ne $InstallRoot)) {
  $ExistingPackagePath = Join-Path $InstallRoot 'package.json'
  if (-not (Test-Path -LiteralPath $ExistingPackagePath)) { throw 'The global installation directory is occupied by an unrelated folder.' }
  $ExistingPackage = Get-Content -LiteralPath $ExistingPackagePath -Raw | ConvertFrom-Json
  if ($ExistingPackage.name -ne 'codex-antigravity') { throw 'The global installation directory belongs to another package.' }
}
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null

if ($ProjectRoot -ne $InstallRoot) {
  foreach ($Directory in @('src', 'scripts', 'config', 'skills', 'test', '.codex-plugin')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $Directory) -Destination $InstallRoot -Recurse -Force
  }
  foreach ($File in @('package.json', 'package-lock.json', 'README.md', '.gitignore', 'plugin.json', 'mcp.json')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $File) -Destination (Join-Path $InstallRoot $File) -Force
  }
  $OldTaskDirectory = Join-Path $ProjectRoot '.local\tasks'
  if (Test-Path -LiteralPath $OldTaskDirectory) {
    $TaskDirectory = Join-Path $InstallRoot '.local\tasks'
    New-Item -ItemType Directory -Path $TaskDirectory -Force | Out-Null
    foreach ($TaskFile in Get-ChildItem -LiteralPath $OldTaskDirectory -File) {
      if ($TaskFile.Name -match '^[a-fA-F0-9-]{36}\.(json|fallback-claimed|cancel-requested|cancel-confirmed)$') {
        $TaskDestination = Join-Path $TaskDirectory $TaskFile.Name
        if (-not (Test-Path -LiteralPath $TaskDestination)) { Copy-Item -LiteralPath $TaskFile.FullName -Destination $TaskDestination }
      }
    }
  }
}

if (-not $SkipDependencies) {
  Push-Location -LiteralPath $InstallRoot
  try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; MCP registration was not changed.' }
  } finally { Pop-Location }
} elseif (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\@modelcontextprotocol\sdk\package.json'))) {
  throw 'Dependencies are missing in the global directory. Run without -SkipDependencies.'
}

$OriginalConfigText = ''
if (Test-Path -LiteralPath $ConfigPath) {
  $OriginalConfigText = [IO.File]::ReadAllText($ConfigPath)
  Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $BackupDirectory "codex-config-$Stamp.toml")
}
$CommandToml = ConvertTo-Json -InputObject $NodeExecutable -Compress
$ArgsToml = ConvertTo-Json -InputObject @($ServerPath) -Compress
$Section = "[mcp_servers.codex-antigravity]`ncommand = $CommandToml`nargs = $ArgsToml`nstartup_timeout_sec = 20`ntool_timeout_sec = 90`n"
$NewPattern = '(?ms)^\[mcp_servers\.(?:codex-antigravity|"codex-antigravity")\]\r?\n.*?(?=^\[|\z)'
$LegacyPattern = '(?ms)^\[mcp_servers\.(?:antigravity-bridge|"antigravity-bridge")\]\r?\n.*?(?=^\[|\z)'
# Patch only the owned registration; do not reserialize other Codex settings.
$UpdatedConfigText = [regex]::Replace($OriginalConfigText, $NewPattern, '')
$UpdatedConfigText = [regex]::Replace($UpdatedConfigText, $LegacyPattern, [System.Text.RegularExpressions.MatchEvaluator]{
  param($Match)
  if ($Match.Value -match 'antigravity-mcp-bridge|codex-antigravity') { return '' }
  return $Match.Value
})
$UpdatedConfigText = $UpdatedConfigText.TrimEnd() + "`n`n" + $Section
[IO.File]::WriteAllText($ConfigPath, $UpdatedConfigText, [Text.UTF8Encoding]::new($false))

$McpManifest = @{ mcpServers = @{ 'codex-antigravity' = @{ command = $NodeExecutable; args = @($ServerPath) } } }
# The source manifest is portable release data; only the installed runtime is local.
[IO.File]::WriteAllText((Join-Path $InstallRoot '.mcp.json'), ($McpManifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

$SkillSource = Join-Path $InstallRoot 'skills\codex-antigravity\SKILL.md'
$SkillDirectory = Join-Path $CodexConfigRoot 'skills\codex-antigravity'
$SkillDestination = Join-Path $SkillDirectory 'SKILL.md'
if (-not (Test-Path -LiteralPath $SkillSource)) { throw 'The collaboration skill is missing from the package.' }
if (Test-Path -LiteralPath $SkillDestination) {
  Copy-Item -LiteralPath $SkillDestination -Destination (Join-Path $BackupDirectory "codex-antigravity-skill-$Stamp.md")
}
New-Item -ItemType Directory -Path $SkillDirectory -Force | Out-Null
Copy-Item -LiteralPath $SkillSource -Destination $SkillDestination -Force

$LegacySkillDirectory = Join-Path $CodexConfigRoot 'skills\antigravity-collaboration'
$LegacySkill = Join-Path $LegacySkillDirectory 'SKILL.md'
if (Test-Path -LiteralPath $LegacySkill) {
  # Preserve the previous skill, including any manual edits, before retiring it.
  Move-Item -LiteralPath $LegacySkill -Destination (Join-Path $BackupDirectory "legacy-antigravity-skill-$Stamp.md")
  if (-not (Get-ChildItem -LiteralPath $LegacySkillDirectory -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $LegacySkillDirectory }
}

Write-Output 'Installed global MCP: codex-antigravity'
Write-Output "Runtime: $InstallRoot"
Write-Output "Skill: $SkillDestination"
Write-Output 'Every delegated task uses its active Codex workspace; no global cwd is pinned.'
Write-Output 'Restart Codex to load the renamed MCP tools and collaboration skill.'
