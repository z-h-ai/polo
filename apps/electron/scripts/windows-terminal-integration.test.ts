import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronRoot = join(import.meta.dir, '..')
const integrationScript = readFileSync(
  join(electronRoot, 'resources', 'scripts', 'windows-terminal-integration.ps1'),
  'utf8',
)
const launcherTemplate = readFileSync(
  join(electronRoot, 'resources', 'bin', 'polo.cmd'),
  'utf8',
)
const nativeRaceTest = readFileSync(
  join(electronRoot, 'resources', 'scripts', 'tests', 'windows-terminal-integration-race.test.ps1'),
  'utf8',
)
const afterPack = readFileSync(join(import.meta.dir, 'afterPack.cjs'), 'utf8')

describe('Windows terminal integration packaging', () => {
  it('installs the checked-in self-relative launcher template verbatim', () => {
    expect(integrationScript).toContain('[IO.File]::ReadAllText($launcherTemplate)')
    expect(integrationScript).toContain('[IO.File]::ReadAllText($legacyLauncherTemplate)')
    expect(integrationScript).toContain('polo-install-root.txt')
    expect(integrationScript).not.toContain('"$exePath" --polo-cli')
    expect(launcherTemplate).toContain('%~dp0polo-install-root.txt')
    expect(launcherTemplate).toContain('%~dp0polo-messages.cmd')
    expect(launcherTemplate).toContain('"%POLO_AI_BUN%" run "%POLO_AI_CLI_ENTRY%" %*')
    expect(launcherTemplate).not.toContain('if /I "%~1"=="app"')
  })

  it('persists PATH ownership and only removes entries owned by Polo', () => {
    expect(integrationScript).toContain('pathEntryAddedByPolo')
    expect(integrationScript).toContain('Get-StateFileRecord')
    expect(integrationScript).toContain('Get-Sha256')
    expect(integrationScript).toContain('schemaVersion = 3')
    expect(integrationScript).toContain('GetRegularFileIdentity')
    expect(integrationScript).toContain('MoveNoReplace')
    expect(integrationScript).toContain('RegOpenKeyTransacted')
    expect(integrationScript).toContain('CommitTransaction')
    expect(integrationScript).toContain('DeleteRegularFilesIfOwned')
    expect(integrationScript).toContain('Discard-ClaimsAfterCommit')
    expect(integrationScript).toContain('SetFileInformationByHandle')
    expect(integrationScript).toContain('SendMessageTimeout')
    expect(integrationScript).toContain('expectedValue')
    expect(integrationScript).toContain('ContainsPathEntry')
    expect(integrationScript).toContain('MutatePathValue')
    expect(integrationScript).toContain('RemoveLastPathEntry')
    expect(integrationScript).toContain('("PoloWindowsTerminalAtomic" -as [type])')
    expect(integrationScript).toContain('function Get-ManagedFileSpecs')
    expect(integrationScript).toContain('Path = $launcher')
    expect(integrationScript).toContain('Path = $legacyLauncher')
    expect(integrationScript).toContain('Path = $messages')
    expect(integrationScript).toContain('Get-WrapperMessagesContent')
    expect(integrationScript).toContain('ConvertTo-WindowsBatchContent')
    expect(integrationScript).toContain('[regex]::Replace($Content, "\\r?\\n", "`r`n")')
    expect(integrationScript).toContain('[bool]$UsesUserPathFile')
    expect(integrationScript).toContain('Install-Transactional (-not $SkipCommandConflict) ([bool]$UserPathFile)')
    expect(integrationScript).toContain('Uninstall-Transactional ([bool]$UserPathFile)')
    expect(integrationScript).toContain('function Write-TerminalIntegrationDiagnostic([Exception]$Exception)')
    expect(integrationScript).toContain('Write-TerminalIntegrationDiagnostic $_.Exception')
    expect(integrationScript).toContain('function Assert-StateTargetsCurrentBin($State)')
    expect(integrationScript).toContain('ownership state from a different bin directory')
    expect(integrationScript).toContain('owned by a different installation directory')
    expect(integrationScript).toContain('if (-not $UsesUserPathFile) {')
    expect(integrationScript).toContain('-ExpectedValue $null')
    expect(integrationScript).toContain('[AllowNull()]\n    [object]$ExpectedValue')
    expect(integrationScript).toContain('Test-ClaimOwnedForUpgrade -State $previousState')
    expect(integrationScript).toContain('Test-ExactContent -Path $ClaimPath')
    expect(integrationScript).toContain('Undo-UserPathMutation -Mutation $pathMutation')
    expect(integrationScript).toContain('Path = $rootPointer')
    expect(integrationScript).toContain('$legacyLauncherWasHistorical')
    expect(integrationScript).not.toContain('function Is-Managed')
    expect(integrationScript).not.toContain('-match $Pattern')
  })

  it('uses strict full-content history only when hash state is unavailable', () => {
    expect(integrationScript).toContain('Test-ExactContent')
    expect(integrationScript).toContain('Get-HistoricalLauncherAllowlist')
    expect(integrationScript).toContain('Polo cannot replace')
    expect(integrationScript).toContain('modified or user-owned file unchanged')
    expect(integrationScript).toContain('Claim-ExistingPath $stateFile "state"')
    expect(integrationScript).toContain('ownership state is invalid')
    expect(integrationScript).not.toContain('return @($previousRoot')
    expect(integrationScript).not.toContain('Move-Item -Path $temp -Destination $Path -Force')
    expect(integrationScript).not.toContain('Remove-Item -LiteralPath $managedFile -Force')
  })

  it('afterPack validates the launcher generated by the installer script', () => {
    expect(afterPack).toContain("'-Mode',")
    expect(afterPack).toContain("'Validate',")
    expect(afterPack).toContain('windowsInstallerScript')
    expect(afterPack).toContain('unpacked installer launcher execution failed')
  })

  it('runs deterministic native races for every managed leaf and User PATH', () => {
    expect(nativeRaceTest).toContain('"polo.cmd"')
    expect(nativeRaceTest).toContain('"polo-ai.cmd"')
    expect(nativeRaceTest).toContain('"polo-install-root.txt"')
    expect(nativeRaceTest).toContain('install:before-claim')
    expect(nativeRaceTest).toContain('install:after-claim')
    expect(nativeRaceTest).toContain('install:before-publish')
    expect(nativeRaceTest).toContain('uninstall:before-claim')
    expect(nativeRaceTest).toContain('uninstall:before-commit')
    expect(nativeRaceTest).toContain('-ItemType SymbolicLink')
    expect(nativeRaceTest).toContain('-TestRegistryRaceValue')
    expect(nativeRaceTest).toContain('registry-path-preservation')
    expect(nativeRaceTest).toContain('Install normalized user-owned registry PATH separators.')
    expect(nativeRaceTest).not.toContain('Start-Sleep')
  })
})
