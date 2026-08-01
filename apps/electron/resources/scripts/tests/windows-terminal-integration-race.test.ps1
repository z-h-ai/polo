$ErrorActionPreference = "Stop"

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "windows-terminal-integration.ps1"
$root = Join-Path ([IO.Path]::GetTempPath()) "polo-windows-terminal-race-$PID-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $root "Polo AI 安装"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try {
        & $Action
    } catch {
        $failed = $true
    }
    Assert-True $failed $Message
}

function New-Case([string]$Name, [string]$InitialPath = "C:\User Tools") {
    $caseRoot = Join-Path $root $Name
    $binDir = Join-Path $caseRoot "Polo Bin"
    $userPathFile = Join-Path $caseRoot "user-path.txt"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    [IO.File]::WriteAllText($userPathFile, $InitialPath)
    return [PSCustomObject]@{
        Root = $caseRoot
        Bin = $binDir
        UserPath = $userPathFile
        Launcher = Join-Path $binDir "polo.cmd"
        Legacy = Join-Path $binDir "polo-ai.cmd"
        RootPointer = Join-Path $binDir "polo-install-root.txt"
        State = Join-Path $binDir "terminal-integration.json"
    }
}

function Install-Case($Case, [scriptblock]$Hook = $null) {
    & $scriptPath -Mode Install -InstallDir $installDir -BinDir $Case.Bin `
        -UserPathFile $Case.UserPath -SkipCommandConflict -TestMutationHook $Hook
}

function Uninstall-Case($Case, [scriptblock]$Hook = $null) {
    & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $Case.Bin `
        -UserPathFile $Case.UserPath -TestMutationHook $Hook
}

try {
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\vendor\bun") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\app\dist\cli") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $installDir "resources\app\dist\server") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "Polo AI.exe") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\vendor\bun\bun.exe") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\app\dist\cli\polo-cli.js") | Out-Null
    New-Item -ItemType File -Force -Path (Join-Path $installDir "resources\app\dist\server\polo-server.js") | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $installDir "resources\app\package.json"),
        '{"version":"0.10.0"}'
    )

    # A regular user file at a managed leaf is never treated as an upgrade.
    $regular = New-Case "regular-user-leaf"
    [IO.File]::WriteAllText($regular.Launcher, "user launcher")
    Assert-Throws { Install-Case $regular } "Install overwrote a regular user launcher."
    Assert-True ((Get-Content -LiteralPath $regular.Launcher -Raw) -ceq "user launcher") `
        "Install changed a regular user launcher."
    Assert-True (-not (Test-Path -LiteralPath $regular.State)) `
        "Install published state after a regular-file ownership conflict."

    # Reparse points are claimed as leaf objects, rejected, and restored without
    # reading through or writing to their targets.
    $symlink = New-Case "symlink-user-leaf"
    $outside = Join-Path $symlink.Root "outside-user.cmd"
    [IO.File]::WriteAllText($outside, "outside user content")
    New-Item -ItemType SymbolicLink -Path $symlink.Launcher -Target $outside | Out-Null
    Assert-Throws { Install-Case $symlink } "Install accepted a user launcher symlink."
    $linkItem = Get-Item -Force -LiteralPath $symlink.Launcher
    Assert-True ([bool]($linkItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) `
        "Install did not restore the user launcher symlink."
    Assert-True ((Get-Content -LiteralPath $outside -Raw) -ceq "outside user content") `
        "Install changed a symlink target outside the managed directory."

    # A rename-and-replace immediately before the claim makes the replacement
    # the claimed candidate; ownership validation rejects it and restores it.
    $rename = New-Case "repair-rename-race"
    Install-Case $rename
    $renamedManaged = Join-Path $rename.Root "managed-before-race.cmd"
    $renameState = @{ fired = $false }
    $renameHook = {
        param($step, $path, $candidate)
        if (-not $renameState.fired -and $step -eq "install:before-claim" -and
            $path -ieq $rename.Launcher) {
            $renameState.fired = $true
            [IO.File]::Move($path, $renamedManaged)
            [IO.File]::WriteAllText($path, "concurrent user launcher")
        }
    }.GetNewClosure()
    Assert-Throws { Install-Case $rename $renameHook } `
        "Repair accepted a launcher replaced immediately before claim."
    Assert-True ((Get-Content -LiteralPath $rename.Launcher -Raw) -ceq "concurrent user launcher") `
        "Repair removed the concurrent user launcher."
    Assert-True (Test-Path -LiteralPath $renamedManaged) `
        "Repair removed the pre-race managed launcher candidate."
    Assert-True (Test-Path -LiteralPath $rename.State) `
        "Repair did not restore ownership state after the rename race."

    # The compatibility shim and root pointer use the same no-replace leaf
    # publication as the primary launcher.
    foreach ($leafName in @("polo-ai.cmd", "polo-install-root.txt")) {
        $leafCase = New-Case "repair-publish-$($leafName.Replace('.', '-'))"
        Install-Case $leafCase
        $leafPath = Join-Path $leafCase.Bin $leafName
        $leafState = @{ fired = $false }
        $leafHook = {
            param($step, $path, $candidate)
            if (-not $leafState.fired -and $step -eq "install:before-publish" -and
                $path -ieq $leafPath) {
                $leafState.fired = $true
                [IO.File]::WriteAllText($path, "concurrent user leaf: $leafName")
            }
        }.GetNewClosure()
        Assert-Throws { Install-Case $leafCase $leafHook } `
            "Repair replaced a concurrent $leafName publication."
        Assert-True ((Get-Content -LiteralPath $leafPath -Raw) -ceq "concurrent user leaf: $leafName") `
            "Repair removed the concurrent $leafName publication."
        Assert-True (Test-Path -LiteralPath $leafCase.State) `
            "Repair did not restore state after the $leafName publication race."
    }

    # Content changes after the atomic claim invalidate ownership even though
    # the filesystem identity is unchanged.
    $content = New-Case "repair-content-race"
    Install-Case $content
    $contentState = @{ fired = $false }
    $contentHook = {
        param($step, $path, $candidate)
        if (-not $contentState.fired -and $step -eq "install:after-claim" -and
            $path -ieq $content.Launcher) {
            $contentState.fired = $true
            [IO.File]::AppendAllText($candidate, "`r`nrem concurrent user edit")
        }
    }.GetNewClosure()
    Assert-Throws { Install-Case $content $contentHook } `
        "Repair accepted content changed after the atomic claim."
    Assert-True ((Get-Content -LiteralPath $content.Launcher -Raw) -match "concurrent user edit") `
        "Repair discarded the content-race candidate."
    Assert-True (Test-Path -LiteralPath $content.State) `
        "Repair removed state after a content race."

    # No-replace publication preserves a concurrent file placed in the leaf
    # after the old managed file has been claimed.
    $publication = New-Case "repair-publication-race"
    Install-Case $publication
    $publicationState = @{ fired = $false }
    $publicationHook = {
        param($step, $path, $candidate)
        if (-not $publicationState.fired -and $step -eq "install:before-publish" -and
            $path -ieq $publication.Launcher) {
            $publicationState.fired = $true
            [IO.File]::WriteAllText($path, "publication competitor")
        }
    }.GetNewClosure()
    Assert-Throws { Install-Case $publication $publicationHook } `
        "Repair replaced a file occupying the publication leaf."
    Assert-True ((Get-Content -LiteralPath $publication.Launcher -Raw) -ceq "publication competitor") `
        "Repair removed the publication competitor."
    Assert-True (@(Get-ChildItem -LiteralPath $publication.Bin -Filter "polo.cmd.polo-claim-*").Count -eq 1) `
        "Repair did not preserve the displaced managed rollback candidate."

    # Uninstall claims first, then revalidates identity and content before its
    # commit. A concurrent edit aborts and restores the complete installation.
    $uninstallContent = New-Case "uninstall-content-race"
    Install-Case $uninstallContent
    $uninstallState = @{ fired = $false }
    $uninstallHook = {
        param($step, $path, $candidate)
        if (-not $uninstallState.fired -and $step -eq "uninstall:before-commit" -and
            $path -ieq $uninstallContent.Launcher) {
            $uninstallState.fired = $true
            [IO.File]::AppendAllText($candidate, "`r`nrem uninstall competitor")
        }
    }.GetNewClosure()
    Assert-Throws { Uninstall-Case $uninstallContent $uninstallHook } `
        "Uninstall committed after claimed content changed."
    Assert-True ((Get-Content -LiteralPath $uninstallContent.Launcher -Raw) -match "uninstall competitor") `
        "Uninstall deleted the content-race candidate."
    Assert-True (Test-Path -LiteralPath $uninstallContent.State) `
        "Uninstall removed state after a content race."
    Assert-True ((Get-Content -LiteralPath $uninstallContent.UserPath -Raw) -match
        [Regex]::Escape($uninstallContent.Bin)) `
        "Uninstall did not restore its PATH entry after aborting."

    # A symlink or rename-and-replace appearing at uninstall time is a user leaf,
    # regardless of whether its bytes resemble a managed launcher.
    $uninstallSymlink = New-Case "uninstall-symlink-race"
    Install-Case $uninstallSymlink
    $uninstallManaged = Join-Path $uninstallSymlink.Root "managed-before-symlink.cmd"
    [IO.File]::Move($uninstallSymlink.Launcher, $uninstallManaged)
    $uninstallOutside = Join-Path $uninstallSymlink.Root "outside-uninstall.cmd"
    [IO.File]::WriteAllText($uninstallOutside, "outside uninstall user content")
    New-Item -ItemType SymbolicLink -Path $uninstallSymlink.Launcher -Target $uninstallOutside | Out-Null
    Assert-Throws { Uninstall-Case $uninstallSymlink } `
        "Uninstall accepted a symlink replacement."
    $uninstallLink = Get-Item -Force -LiteralPath $uninstallSymlink.Launcher
    Assert-True ([bool]($uninstallLink.Attributes -band [IO.FileAttributes]::ReparsePoint)) `
        "Uninstall did not restore the symlink replacement."
    Assert-True ((Get-Content -LiteralPath $uninstallOutside -Raw) -ceq "outside uninstall user content") `
        "Uninstall changed the symlink target."
    Assert-True (Test-Path -LiteralPath $uninstallSymlink.State) `
        "Uninstall removed state after a symlink race."

    foreach ($leafName in @("polo-ai.cmd", "polo-install-root.txt")) {
        $uninstallLeaf = New-Case "uninstall-rename-$($leafName.Replace('.', '-'))"
        Install-Case $uninstallLeaf
        $leafPath = Join-Path $uninstallLeaf.Bin $leafName
        $savedLeaf = Join-Path $uninstallLeaf.Root "managed-$leafName"
        $leafState = @{ fired = $false }
        $leafHook = {
            param($step, $path, $candidate)
            if (-not $leafState.fired -and $step -eq "uninstall:before-claim" -and
                $path -ieq $leafPath) {
                $leafState.fired = $true
                [IO.File]::Move($path, $savedLeaf)
                [IO.File]::WriteAllText($path, "uninstall rename competitor: $leafName")
            }
        }.GetNewClosure()
        Assert-Throws { Uninstall-Case $uninstallLeaf $leafHook } `
            "Uninstall accepted a renamed $leafName replacement."
        Assert-True ((Get-Content -LiteralPath $leafPath -Raw) -ceq "uninstall rename competitor: $leafName") `
            "Uninstall removed the $leafName rename competitor."
        Assert-True (Test-Path -LiteralPath $savedLeaf) `
            "Uninstall removed the displaced managed $leafName candidate."
        Assert-True (Test-Path -LiteralPath $uninstallLeaf.State) `
            "Uninstall did not restore state after the $leafName rename race."
    }

    # User-PATH fixture updates use the same claim/no-replace protocol. A writer
    # occupying the path during repair wins, while Polo preserves the old value
    # in an explicit rollback candidate instead of losing either update.
    $pathRace = New-Case "path-file-race"
    Install-Case $pathRace
    $pathState = @{ fired = $false }
    $pathHook = {
        param($step, $path, $candidate)
        if (-not $pathState.fired -and $step -eq "path:after-claim" -and
            $path -ieq $pathRace.UserPath) {
            $pathState.fired = $true
            [IO.File]::WriteAllText($path, "C:\Concurrent Tools")
        }
    }.GetNewClosure()
    Assert-Throws { Install-Case $pathRace $pathHook } `
        "Repair overwrote a concurrent PATH-file update."
    Assert-True ((Get-Content -LiteralPath $pathRace.UserPath -Raw) -ceq "C:\Concurrent Tools") `
        "Repair lost the concurrent PATH-file update."
    Assert-True (@(Get-ChildItem -LiteralPath $pathRace.Root -Filter "user-path.txt.polo-claim-*").Count -eq 1) `
        "Repair did not preserve the prior PATH rollback candidate."

    # The production User PATH is changed through a transacted registry value.
    # This injected non-transacted writer runs between the transactional read
    # and commit; Windows must reject Polo's transaction and retain the writer.
    $registry = New-Case "registry-path-race"
    $registrySubKey = "Software\PoloAi\TerminalRace-$PID-$([Guid]::NewGuid().ToString('N'))"
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registrySubKey)
    try {
        $registryKey.SetValue("TestPath", "C:\User Tools", [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $registryKey.Dispose()
    }
    Assert-Throws {
        & $scriptPath -Mode Install -InstallDir $installDir -BinDir $registry.Bin `
            -SkipCommandConflict -UserPathRegistrySubKey $registrySubKey `
            -UserPathRegistryValueName "TestPath" `
            -TestRegistryRaceValue "C:\Concurrent Registry Tools"
    } "Install committed over a concurrent User PATH registry update."
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registrySubKey)
    try {
        Assert-True ($registryKey.GetValue("TestPath", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) `
            -ceq "C:\Concurrent Registry Tools") `
            "Install lost the concurrent User PATH registry update."
    } finally {
        $registryKey.Dispose()
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registrySubKey, $false)
    }
    Assert-True (-not (Test-Path -LiteralPath $registry.State)) `
        "Install published ownership state after the registry transaction conflict."

    # Registry-backed PATH updates must preserve the user's byte layout. This
    # covers the production path rather than only the file-backed test fixture.
    $registryPreservation = New-Case "registry-path-preservation"
    $preservationSubKey = "Software\PoloAi\TerminalPathPreservation-$PID-$([Guid]::NewGuid().ToString('N'))"
    $preservationKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($preservationSubKey)
    $preservationBefore = "C:\User Tools;;C:\Other Tools;"
    try {
        $preservationKey.SetValue(
            "TestPath",
            $preservationBefore,
            [Microsoft.Win32.RegistryValueKind]::ExpandString
        )
    } finally {
        $preservationKey.Dispose()
    }
    try {
        & $scriptPath -Mode Install -InstallDir $installDir -BinDir $registryPreservation.Bin `
            -SkipCommandConflict -UserPathRegistrySubKey $preservationSubKey `
            -UserPathRegistryValueName "TestPath"
        $preservationKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($preservationSubKey)
        try {
            Assert-True (
                $preservationKey.GetValue(
                    "TestPath",
                    $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                ) -ceq "$preservationBefore;$($registryPreservation.Bin)"
            ) "Install normalized user-owned registry PATH separators."
        } finally {
            $preservationKey.Dispose()
        }
        & $scriptPath -Mode Uninstall -InstallDir $installDir -BinDir $registryPreservation.Bin `
            -UserPathRegistrySubKey $preservationSubKey `
            -UserPathRegistryValueName "TestPath"
        $preservationKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($preservationSubKey)
        try {
            Assert-True (
                $preservationKey.GetValue(
                    "TestPath",
                    $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                ) -ceq $preservationBefore
            ) "Uninstall did not restore the exact registry PATH serialization."
        } finally {
            $preservationKey.Dispose()
        }
    } finally {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($preservationSubKey, $false)
    }

    # If a later publication fails, rollback restores the exact prior registry
    # value only when the value still equals Polo's committed update. A newer
    # non-transacted writer wins and is never overwritten by rollback.
    $registryRollback = New-Case "registry-rollback-race"
    $rollbackSubKey = "Software\PoloAi\TerminalRollback-$PID-$([Guid]::NewGuid().ToString('N'))"
    $rollbackKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($rollbackSubKey)
    try {
        $rollbackKey.SetValue("TestPath", "C:\User Tools", [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $rollbackKey.Dispose()
    }
    $rollbackState = @{ fired = $false }
    $rollbackHook = {
        param($step, $path, $candidate)
        if (-not $rollbackState.fired -and $step -eq "state:before-publish") {
            $rollbackState.fired = $true
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($rollbackSubKey, $true)
            try {
                $key.SetValue(
                    "TestPath",
                    "C:\Concurrent After Commit",
                    [Microsoft.Win32.RegistryValueKind]::ExpandString
                )
            } finally {
                $key.Dispose()
            }
            [IO.File]::WriteAllText($path, "concurrent state leaf")
        }
    }.GetNewClosure()
    Assert-Throws {
        & $scriptPath -Mode Install -InstallDir $installDir -BinDir $registryRollback.Bin `
            -SkipCommandConflict -UserPathRegistrySubKey $rollbackSubKey `
            -UserPathRegistryValueName "TestPath" -TestMutationHook $rollbackHook
    } "Install rollback overwrote a concurrent registry update."
    $rollbackKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($rollbackSubKey)
    try {
        Assert-True ($rollbackKey.GetValue("TestPath", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) `
            -ceq "C:\Concurrent After Commit") `
            "Guarded rollback lost the newer User PATH registry value."
    } finally {
        $rollbackKey.Dispose()
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($rollbackSubKey, $false)
    }
    Assert-True ((Get-Content -LiteralPath $registryRollback.State -Raw) -ceq "concurrent state leaf") `
        "Install rollback removed the concurrent state-file publication."

    Write-Host "Windows terminal integration race tests passed."
} finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
