param(
    [ValidateSet("Install", "Uninstall", "Validate")]
    [string]$Mode = "Install",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Polo AI",
    [string]$BinDir = "",
    [string]$UserPathFile = "",
    [switch]$SkipCommandConflict,
    [scriptblock]$TestMutationHook = $null,
    [string]$UserPathRegistrySubKey = "Environment",
    [string]$UserPathRegistryValueName = "Path",
    [string]$TestRegistryRaceValue = $null
)

$ErrorActionPreference = "Stop"
if (-not $BinDir) {
    $BinDir = "$env:LOCALAPPDATA\Polo AI\bin"
}

$launcher = Join-Path $BinDir "polo.cmd"
$legacyLauncher = Join-Path $BinDir "polo-ai.cmd"
$rootPointer = Join-Path $BinDir "polo-install-root.txt"
$stateFile = Join-Path $BinDir "terminal-integration.json"
$exePath = Join-Path $InstallDir "Polo AI.exe"
$bunPath = Join-Path $InstallDir "resources\vendor\bun\bun.exe"
$appRoot = Join-Path $InstallDir "resources\app"
$cliPath = Join-Path $appRoot "dist\cli\polo-cli.js"
$serverPath = Join-Path $appRoot "dist\server\polo-server.js"
$packagePath = Join-Path $appRoot "package.json"
$launcherTemplate = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\polo.cmd"
$legacyLauncherTemplate = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\polo-ai.cmd"
$messageTemplate = Join-Path (Split-Path -Parent $PSScriptRoot) "bin\polo-messages.cmd"

# A native ownership test imports this script repeatedly in one
# powershell.exe process. Add-Type cannot redefine a type name in that
# process, so compile the interop helpers only once.
if (-not ("PoloWindowsTerminalAtomic" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public sealed class PoloPathMutationResult {
    public bool WasPresent { get; set; }
    public bool Changed { get; set; }
    public string PreviousValue { get; set; }
    public string Value { get; set; }
}

public static class PoloWindowsTerminalAtomic {
    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInformation {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle handle,
        int informationClass,
        ref FileDispositionInformation information,
        uint bufferSize);

    [DllImport("ktmw32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateTransaction(
        IntPtr attributes,
        IntPtr unitOfWork,
        uint createOptions,
        uint isolationLevel,
        uint isolationFlags,
        uint timeout,
        string description);

    [DllImport("ktmw32.dll", SetLastError = true)]
    private static extern bool CommitTransaction(IntPtr transaction);

    [DllImport("ktmw32.dll", SetLastError = true)]
    private static extern bool RollbackTransaction(IntPtr transaction);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window,
        uint message,
        IntPtr wParam,
        string lParam,
        uint flags,
        uint timeout,
        out IntPtr result);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegOpenKeyTransacted(
        IntPtr key,
        string subKey,
        uint options,
        int desiredAccess,
        out IntPtr result,
        IntPtr transaction,
        IntPtr extendedParameter);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegQueryValueEx(
        IntPtr key,
        string valueName,
        IntPtr reserved,
        out uint type,
        byte[] data,
        ref uint dataLength);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegSetValueEx(
        IntPtr key,
        string valueName,
        int reserved,
        uint type,
        byte[] data,
        int dataLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int RegCloseKey(IntPtr key);

    private const int KeyQueryValue = 0x0001;
    private const int KeySetValue = 0x0002;
    private const int ErrorSuccess = 0;
    private const int ErrorFileNotFound = 2;
    private const int ErrorMoreData = 234;
    private const uint RegSz = 1;
    private const uint RegExpandSz = 2;
    private const uint GenericRead = 0x80000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint FileShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const int FileDispositionInfo = 4;

    private static string IdentityFromInformation(ByHandleFileInformation information) {
        ulong fileIndex = ((ulong)information.FileIndexHigh << 32) |
            information.FileIndexLow;
        return information.VolumeSerialNumber.ToString("x8") + ":" +
            fileIndex.ToString("x16");
    }

    public static string GetRegularFileIdentity(string path) {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) != 0 ||
            (attributes & FileAttributes.ReparsePoint) != 0) {
            return null;
        }
        using (FileStream stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete)) {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out information)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return IdentityFromInformation(information);
        }
    }

    public static bool DeleteRegularFileIfOwned(
        string path,
        string expectedIdentity,
        string expectedSha256) {
        return DeleteRegularFilesIfOwned(
            new string[] { path },
            new string[] { expectedIdentity },
            new string[] { expectedSha256 });
    }

    public static bool DeleteRegularFilesIfOwned(
        string[] paths,
        string[] expectedIdentities,
        string[] expectedSha256s) {
        if (paths.Length != expectedIdentities.Length ||
            paths.Length != expectedSha256s.Length) {
            throw new ArgumentException("Owned-file arrays must have equal lengths.");
        }
        List<FileStream> streams = new List<FileStream>();
        try {
            for (int index = 0; index < paths.Length; index++) {
                SafeFileHandle handle = CreateFile(
                    paths[index],
                    GenericRead | DeleteAccess,
                    FileShareRead,
                    IntPtr.Zero,
                    OpenExisting,
                    FileFlagOpenReparsePoint,
                    IntPtr.Zero);
                if (handle.IsInvalid) {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    if (error == ErrorFileNotFound) return false;
                    throw new Win32Exception(error);
                }
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information)) {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new Win32Exception(error);
                }
                const uint directoryAttribute = 0x10;
                const uint reparsePointAttribute = 0x400;
                if ((information.FileAttributes &
                    (directoryAttribute | reparsePointAttribute)) != 0 ||
                    !String.Equals(
                        IdentityFromInformation(information),
                        expectedIdentities[index],
                        StringComparison.Ordinal)) {
                    handle.Dispose();
                    return false;
                }
                FileStream stream = new FileStream(handle, FileAccess.Read);
                streams.Add(stream);
                string actualHash;
                using (SHA256 sha = SHA256.Create()) {
                    byte[] hash = sha.ComputeHash(stream);
                    StringBuilder text = new StringBuilder(hash.Length * 2);
                    foreach (byte value in hash) text.Append(value.ToString("x2"));
                    actualHash = text.ToString();
                }
                if (!String.Equals(
                    actualHash,
                    expectedSha256s[index],
                    StringComparison.Ordinal)) {
                    return false;
                }
            }
            for (int index = 0; index < streams.Count; index++) {
                FileDispositionInformation disposition =
                    new FileDispositionInformation { DeleteFile = true };
                if (!SetFileInformationByHandle(
                    streams[index].SafeFileHandle,
                    FileDispositionInfo,
                    ref disposition,
                    (uint)Marshal.SizeOf(typeof(FileDispositionInformation)))) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            return true;
        } finally {
            foreach (FileStream stream in streams) stream.Dispose();
        }
    }

    public static void MoveNoReplace(string source, string destination) {
        File.Move(source, destination);
    }

    public static void WriteUtf8New(string path, string content) {
        byte[] bytes = new UTF8Encoding(false).GetBytes(content);
        using (FileStream stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.Read)) {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
    }

    private static string ReadRegistryString(
        IntPtr key,
        string valueName,
        out uint valueType) {
        uint length = 0;
        int status = RegQueryValueEx(
            key, valueName, IntPtr.Zero, out valueType, null, ref length);
        if (status == ErrorFileNotFound) {
            valueType = RegExpandSz;
            return String.Empty;
        }
        if (status != ErrorSuccess && status != ErrorMoreData) {
            throw new Win32Exception(status);
        }
        byte[] data = new byte[length];
        status = RegQueryValueEx(
            key, valueName, IntPtr.Zero, out valueType, data, ref length);
        if (status != ErrorSuccess) {
            throw new Win32Exception(status);
        }
        if (valueType != RegSz && valueType != RegExpandSz) {
            throw new InvalidDataException("User PATH registry value is not a string.");
        }
        string value = Encoding.Unicode.GetString(data, 0, (int)length);
        return value.TrimEnd('\0');
    }

    private static bool SamePathEntry(string left, string right) {
        return String.Equals(
            left.Trim().TrimEnd('\\'),
            right.Trim().TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
    }

    public static bool ContainsPathEntry(string value, string binDir) {
        if (value == null) value = String.Empty;
        int start = 0;
        for (int index = 0; index <= value.Length; index++) {
            if (index != value.Length && value[index] != ';') continue;
            if (index > start && SamePathEntry(value.Substring(start, index - start), binDir)) {
                return true;
            }
            start = index + 1;
        }
        return false;
    }

    private static string RemoveLastPathEntry(string value, string binDir) {
        int start = 0;
        int matchStart = -1;
        int matchEnd = -1;
        for (int index = 0; index <= value.Length; index++) {
            if (index != value.Length && value[index] != ';') continue;
            if (index > start && SamePathEntry(value.Substring(start, index - start), binDir)) {
                matchStart = start;
                matchEnd = index;
            }
            start = index + 1;
        }
        if (matchStart < 0) return value;
        if (matchEnd < value.Length) {
            // Remove this entry and its following delimiter. This leaves every
            // unrelated empty segment and trailing delimiter byte-for-byte intact.
            return value.Remove(matchStart, matchEnd - matchStart + 1);
        }
        if (matchStart == 0) return String.Empty;
        // The final entry has no following delimiter, so consume its preceding
        // delimiter rather than manufacturing a new trailing separator.
        return value.Remove(matchStart - 1, value.Length - matchStart + 1);
    }

    public static string MutatePathValue(string value, string binDir, bool ensurePresent) {
        if (value == null) value = String.Empty;
        bool present = ContainsPathEntry(value, binDir);
        if (ensurePresent) {
            if (present) return value;
            return value.Length == 0 ? binDir : value + ";" + binDir;
        }
        // Install appends a single managed entry. Remove only the final
        // matching token so pre-existing or subsequently user-added duplicates
        // are never normalized away.
        return RemoveLastPathEntry(value, binDir);
    }

    public static PoloPathMutationResult MutateUserPath(
        string subKey,
        string valueName,
        string binDir,
        bool ensurePresent,
        string expectedValue,
        string replacementValue,
        string testRaceValue) {
        IntPtr transaction = CreateTransaction(
            IntPtr.Zero, IntPtr.Zero, 0, 0, 0, 0, "Polo terminal PATH update");
        if (transaction == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        IntPtr key = IntPtr.Zero;
        bool committed = false;
        try {
            int status = RegOpenKeyTransacted(
                new IntPtr(unchecked((int)0x80000001)),
                subKey,
                0,
                KeyQueryValue | KeySetValue,
                out key,
                transaction,
                IntPtr.Zero);
            if (status != ErrorSuccess) {
                throw new Win32Exception(status);
            }
            uint valueType;
            string before = ReadRegistryString(key, valueName, out valueType);
            if (expectedValue != null &&
                !String.Equals(before, expectedValue, StringComparison.Ordinal)) {
                throw new InvalidOperationException(
                    "User PATH changed before the guarded rollback.");
            }
            bool wasPresent = ContainsPathEntry(before, binDir);
            string after;
            if (replacementValue != null) {
                after = replacementValue;
            } else {
                after = MutatePathValue(before, binDir, ensurePresent);
            }
            bool changed = !String.Equals(before, after, StringComparison.Ordinal);
            if (!changed) {
                RollbackTransaction(transaction);
                return new PoloPathMutationResult {
                    WasPresent = wasPresent,
                    Changed = false,
                    PreviousValue = before,
                    Value = before
                };
            }
            if (testRaceValue != null) {
                using (RegistryKey raceKey = Registry.CurrentUser.OpenSubKey(subKey, true)) {
                    raceKey.SetValue(valueName, testRaceValue, RegistryValueKind.ExpandString);
                }
            }
            byte[] data = Encoding.Unicode.GetBytes(after + "\0");
            status = RegSetValueEx(
                key, valueName, 0, valueType, data, data.Length);
            if (status != ErrorSuccess) {
                throw new Win32Exception(status);
            }
            if (!CommitTransaction(transaction)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            committed = true;
            IntPtr broadcastResult;
            SendMessageTimeout(
                new IntPtr(0xffff),
                0x001a,
                IntPtr.Zero,
                "Environment",
                0x0002,
                5000,
                out broadcastResult);
            return new PoloPathMutationResult {
                WasPresent = wasPresent,
                Changed = true,
                PreviousValue = before,
                Value = after
            };
        } finally {
            if (key != IntPtr.Zero) RegCloseKey(key);
            if (!committed) RollbackTransaction(transaction);
            CloseHandle(transaction);
        }
    }
}
"@
}

function Invoke-TestMutationHook([string]$Step, [string]$Path, [string]$Candidate = "") {
    if ($TestMutationHook) {
        & $TestMutationHook $Step $Path $Candidate
    }
}

function New-PrivatePath([string]$Path, [string]$Kind) {
    return "$Path.polo-$Kind-$PID-$([Guid]::NewGuid().ToString('N'))"
}

function Write-NewUtf8([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [PoloWindowsTerminalAtomic]::WriteUtf8New($Path, $Content)
}

function Get-RegularFileIdentity([string]$Path) {
    try {
        return [PoloWindowsTerminalAtomic]::GetRegularFileIdentity($Path)
    } catch [IO.FileNotFoundException] {
        return $null
    } catch [IO.DirectoryNotFoundException] {
        return $null
    }
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Normalize-LineEndings([string]$Content) {
    return $Content.Replace("`r`n", "`n")
}

function Test-ExactContent([string]$Path, [string[]]$AllowedContents) {
    if (-not (Get-RegularFileIdentity $Path)) {
        return $false
    }
    $actual = Normalize-LineEndings ([IO.File]::ReadAllText($Path))
    foreach ($allowed in $AllowedContents) {
        if ($actual -ceq (Normalize-LineEndings $allowed)) {
            return $true
        }
    }
    return $false
}

function Read-State([string]$Path = $stateFile) {
    if (-not (Get-RegularFileIdentity $Path)) {
        return $null
    }
    try {
        $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ($state.schemaVersion -ne 1 -and $state.schemaVersion -ne 2 -and
            $state.schemaVersion -ne 3) {
            return $null
        }
        return $state
    } catch {
        return $null
    }
}

function Get-StateFileRecord($State, [string]$Path) {
    if (-not $State -or $State.schemaVersion -lt 2 -or -not $State.files) {
        return $null
    }
    return $State.files | Where-Object {
        $_.path -and $_.path.TrimEnd("\") -ieq $Path.TrimEnd("\")
    } | Select-Object -First 1
}

function Assert-PackagedArtifacts {
    foreach ($required in @(
        $exePath,
        $bunPath,
        $cliPath,
        $serverPath,
        $packagePath,
        $launcherTemplate,
        $legacyLauncherTemplate,
        $messageTemplate
    )) {
        if (-not (Test-Path $required)) {
            throw "Required Polo artifact not found: $required"
        }
    }
}

function Get-LauncherContent {
    return [IO.File]::ReadAllText($launcherTemplate)
}

function Get-LegacyShimContent {
    return [IO.File]::ReadAllText($legacyLauncherTemplate)
}

function Get-HistoricalLauncherAllowlist([string]$Path) {
    if ($Path.TrimEnd("\") -ieq $launcher.TrimEnd("\")) {
        # Exact POO-14 pre-template launcher. This allowlist is intentionally
        # generated from its old absolute layout and is only consulted when
        # ownership state is absent.
        $oldContent = @"
@echo off
chcp 65001 >nul 2>&1
setlocal
rem Polo CLI launcher (managed by Polo AI)
set "POLO_AI_BUN=$bunPath"
set "POLO_AI_SERVER_ENTRY=$serverPath"
set "POLO_AI_CLI_ENTRY=$cliPath"
set "POLO_AI_APP_ROOT=$appRoot"
set "POLO_AI_RESOURCES_PATH=$appRoot\resources"
set "POLO_AI_BUNDLED_ASSETS_ROOT=$appRoot"
set "POLO_AI_DESKTOP_EXECUTABLE=$exePath"
set "POLO_AI_IS_PACKAGED=true"
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_RUNTIME=Error: Polo's bundled runtime is missing. Reinstall Polo."
set "POLO_MSG_FILES=Error: Polo terminal files are missing. Reinstall Polo."
if /I "%POLO_LOCALE:~0,2%"=="zh" (
  set "POLO_MSG_RUNTIME=错误：Polo 内置运行时缺失。请重新安装 Polo。"
  set "POLO_MSG_FILES=错误：Polo 终端文件缺失。请重新安装 Polo。"
)
if not exist "$bunPath" (
  echo [POLO_E_BUNDLED_RUNTIME_MISSING] %POLO_MSG_RUNTIME% 1>&2
  exit /b 1
)
if not exist "$cliPath" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)
if not exist "$serverPath" (
  echo [POLO_E_TERMINAL_FILES_MISSING] %POLO_MSG_FILES% 1>&2
  exit /b 1
)
if /I "%~1"=="app" (
  start "" "$exePath"
  exit /b 0
)
"$bunPath" run "$cliPath" %*
exit /b %ERRORLEVEL%
"@
        return @($oldContent, "$oldContent`r`n")
    }
    if ($Path.TrimEnd("\") -ieq $legacyLauncher.TrimEnd("\")) {
        $oldLocalizedShim = @"
@echo off
chcp 65001 >nul 2>&1
setlocal
set "POLO_LOCALE=%POLO_AI_LOCALE%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_ALL%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LC_MESSAGES%"
if not defined POLO_LOCALE set "POLO_LOCALE=%LANG%"
set "POLO_MSG_DEPRECATED=Warning: 'polo-ai' is deprecated; use 'polo' instead."
if /I "%POLO_LOCALE:~0,2%"=="zh" set "POLO_MSG_DEPRECATED=警告：“polo-ai”已弃用；请改用“polo”。"
echo [POLO_W_DEPRECATED_COMMAND] %POLO_MSG_DEPRECATED% 1>&2
call "$launcher" %*
exit /b %ERRORLEVEL%
"@
        $previousShim = "@echo off`r`necho Warning: 'polo-ai' is deprecated; use 'polo' instead. 1>&2`r`ncall `"$launcher`" %*`r`nexit /b %ERRORLEVEL%"
        $oldGui = "@echo off`r`nstart `"`" `"$exePath`" %*"
        return @(
            $oldLocalizedShim,
            "$oldLocalizedShim`r`n",
            $previousShim,
            "$previousShim`r`n",
            $oldGui,
            "$oldGui`r`n"
        )
    }
    return @()
}

function Test-LiteralPathExists([string]$Path) {
    try {
        Get-Item -Force -LiteralPath $Path -ErrorAction Stop | Out-Null
        return $true
    } catch [Management.Automation.ItemNotFoundException] {
        return $false
    }
}

function Get-ManagedFileSpecs {
    return @(
        [PSCustomObject]@{ Path = $launcher; Content = Get-LauncherContent },
        [PSCustomObject]@{ Path = $legacyLauncher; Content = Get-LegacyShimContent },
        [PSCustomObject]@{
            Path = $rootPointer
            Content = Join-Path $InstallDir "resources"
        }
    )
}

function Claim-ExistingPath([string]$Path, [string]$StepPrefix) {
    Invoke-TestMutationHook "$StepPrefix`:before-claim" $Path
    if (-not (Test-LiteralPathExists $Path)) {
        return $null
    }
    $claim = New-PrivatePath $Path "claim"
    [PoloWindowsTerminalAtomic]::MoveNoReplace($Path, $claim)
    Invoke-TestMutationHook "$StepPrefix`:after-claim" $Path $claim
    return [PSCustomObject]@{
        Path = $Path
        Claim = $claim
        Identity = Get-RegularFileIdentity $claim
        Sha256 = Get-Sha256 $claim
    }
}

function Restore-ClaimNoReplace($Claim, [string]$StepPrefix) {
    if (-not $Claim -or -not (Test-LiteralPathExists $Claim.Claim)) {
        return
    }
    Invoke-TestMutationHook "$StepPrefix`:before-restore" $Claim.Path $Claim.Claim
    try {
        [PoloWindowsTerminalAtomic]::MoveNoReplace($Claim.Claim, $Claim.Path)
    } catch {
        Write-Warning "Polo preserved a rollback candidate at $($Claim.Claim) because $($Claim.Path) is occupied."
    }
}

function Test-ClaimMatchesState($State, [string]$OriginalPath, [string]$ClaimPath) {
    $record = Get-StateFileRecord $State $OriginalPath
    if (-not $record -or -not $record.sha256) {
        return $false
    }
    $identity = Get-RegularFileIdentity $ClaimPath
    if (-not $identity) {
        return $false
    }
    if ($State.schemaVersion -ge 3 -and
        (!$record.identity -or $identity -cne [string]$record.identity)) {
        return $false
    }
    $hash = Get-Sha256 $ClaimPath
    return $hash -and $hash -ceq ([string]$record.sha256).ToLowerInvariant()
}

function Test-ClaimOwnedForUpgrade($State, [string]$OriginalPath, [string]$ClaimPath) {
    if ($State -and (Test-ClaimMatchesState $State $OriginalPath $ClaimPath)) {
        return $true
    }
    if (-not $State -and
        (Test-ExactContent $ClaimPath (Get-HistoricalLauncherAllowlist $OriginalPath))) {
        return $true
    }
    return $false
}

function Publish-NewManagedFile(
    [string]$Path,
    [string]$Content,
    [string]$StepPrefix,
    [Collections.Generic.List[object]]$Published
) {
    $stage = New-PrivatePath $Path "stage"
    $validationClaim = $null
    try {
        Write-NewUtf8 $stage $Content
        $identity = Get-RegularFileIdentity $stage
        $hash = Get-Sha256 $stage
        if (-not $identity -or -not $hash) {
            throw "Polo could not create a regular staged file for $Path."
        }
        Invoke-TestMutationHook "$StepPrefix`:before-publish" $Path $stage
        [PoloWindowsTerminalAtomic]::MoveNoReplace($stage, $Path)
        $record = [PSCustomObject]@{
            Path = $Path
            Identity = $identity
            Sha256 = $hash
        }
        $Published.Add($record)

        Invoke-TestMutationHook "$StepPrefix`:after-publish" $Path
        $validationClaim = New-PrivatePath $Path "verify"
        [PoloWindowsTerminalAtomic]::MoveNoReplace($Path, $validationClaim)
        Invoke-TestMutationHook "$StepPrefix`:after-validation-claim" $Path $validationClaim
        if ((Get-RegularFileIdentity $validationClaim) -cne $identity -or
            (Get-Sha256 $validationClaim) -cne $hash) {
            throw "Polo lost ownership of $Path before publication completed."
        }
        [PoloWindowsTerminalAtomic]::MoveNoReplace($validationClaim, $Path)
        $validationClaim = $null
        return $record
    } finally {
        if (Test-LiteralPathExists $stage) {
            Remove-Item -Force -LiteralPath $stage -ErrorAction SilentlyContinue
        }
        if ($validationClaim -and (Test-LiteralPathExists $validationClaim)) {
            try {
                [PoloWindowsTerminalAtomic]::MoveNoReplace($validationClaim, $Path)
            } catch {
                Write-Warning "Polo preserved a publication candidate at $validationClaim because $Path is occupied."
            }
        }
    }
}

function Remove-PublishedForRollback(
    [Collections.Generic.List[object]]$Published,
    [string]$StepPrefix
) {
    for ($index = $Published.Count - 1; $index -ge 0; $index--) {
        $record = $Published[$index]
        if (-not (Test-LiteralPathExists $record.Path)) {
            continue
        }
        $claim = New-PrivatePath $record.Path "rollback"
        try {
            [PoloWindowsTerminalAtomic]::MoveNoReplace($record.Path, $claim)
            Invoke-TestMutationHook "$StepPrefix`:before-delete-published" $record.Path $claim
            if (-not [PoloWindowsTerminalAtomic]::DeleteRegularFileIfOwned(
                $claim,
                $record.Identity,
                $record.Sha256
            )) {
                Restore-ClaimNoReplace ([PSCustomObject]@{
                    Path = $record.Path
                    Claim = $claim
                }) $StepPrefix
            }
        } catch {
            if (Test-LiteralPathExists $claim) {
                Restore-ClaimNoReplace ([PSCustomObject]@{
                    Path = $record.Path
                    Claim = $claim
                }) $StepPrefix
            }
        }
    }
}

function New-StateContent([bool]$PathEntryAddedByPolo, $PublishedRecords) {
    $files = @()
    foreach ($record in $PublishedRecords) {
        $files += @{
            path = $record.Path
            identity = $record.Identity
            sha256 = $record.Sha256
        }
    }
    return @{
        schemaVersion = 3
        pathEntryAddedByPolo = $PathEntryAddedByPolo
        binDir = $BinDir
        files = $files
        updatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Depth 4
}

function Mutate-UserPathFile(
    [bool]$EnsurePresent,
    [string]$ExpectedValue,
    [Collections.Generic.List[object]]$Claims,
    [Collections.Generic.List[object]]$Published
) {
    $claim = Claim-ExistingPath $UserPathFile "path"
    if ($claim) {
        if (-not $claim.Identity) {
            Restore-ClaimNoReplace $claim "path"
            throw "Polo cannot update the user PATH fixture because it is not a regular file."
        }
        $Claims.Add($claim)
        $before = [IO.File]::ReadAllText($claim.Claim)
    } else {
        $before = ""
    }
    if ($null -ne $ExpectedValue -and $before -cne $ExpectedValue) {
        throw "User PATH changed before the guarded rollback."
    }
    $wasPresent = [PoloWindowsTerminalAtomic]::ContainsPathEntry($before, $BinDir)
    $after = [PoloWindowsTerminalAtomic]::MutatePathValue(
        $before,
        $BinDir,
        $EnsurePresent
    )
    $record = Publish-NewManagedFile $UserPathFile $after "path" $Published
    return [PSCustomObject]@{
        WasPresent = $wasPresent
        Changed = $before -cne $after
        PreviousValue = $before
        Value = $after
        Record = $record
    }
}

function Mutate-UserPath(
    [bool]$EnsurePresent,
    [string]$ExpectedValue,
    [Collections.Generic.List[object]]$Claims,
    [Collections.Generic.List[object]]$Published,
    [string]$RaceValue,
    [string]$ReplacementValue = $null
) {
    if ($UserPathFile) {
        return Mutate-UserPathFile $EnsurePresent $ExpectedValue $Claims $Published
    }
    return [PoloWindowsTerminalAtomic]::MutateUserPath(
        $UserPathRegistrySubKey,
        $UserPathRegistryValueName,
        $BinDir,
        $EnsurePresent,
        $ExpectedValue,
        $ReplacementValue,
        $RaceValue
    )
}

function Undo-UserPathMutation($Mutation, [bool]$InstallMutation) {
    if (-not $Mutation -or -not $Mutation.Changed) {
        return
    }
    if ($UserPathFile) {
        # The file-backed native fixture is restored from its exact atomic claim.
        return
    }
    try {
        $throwawayClaims = New-Object 'Collections.Generic.List[object]'
        $throwawayPublished = New-Object 'Collections.Generic.List[object]'
        Mutate-UserPath (-not $InstallMutation) $Mutation.Value `
            $throwawayClaims $throwawayPublished $null $Mutation.PreviousValue | Out-Null
    } catch {
        Write-Warning "Polo did not roll back PATH because it changed concurrently: $($_.Exception.Message)"
    }
}

function Complete-Claims([Collections.Generic.List[object]]$Claims) {
    $paths = @()
    $identities = @()
    $hashes = @()
    foreach ($claim in $Claims) {
        if (-not (Test-LiteralPathExists $claim.Claim)) {
            return $false
        }
        Invoke-TestMutationHook "commit:before-delete-claim" $claim.Path $claim.Claim
        if (-not $claim.Identity -or -not $claim.Sha256) {
            return $false
        }
        $paths += [string]$claim.Claim
        $identities += [string]$claim.Identity
        $hashes += [string]$claim.Sha256
    }
    if ($paths.Count -eq 0) {
        return $true
    }
    return [PoloWindowsTerminalAtomic]::DeleteRegularFilesIfOwned(
        [string[]]$paths,
        [string[]]$identities,
        [string[]]$hashes
    )
}

function Discard-ClaimsAfterCommit(
    [Collections.Generic.List[object]]$Claims,
    [string]$Operation
) {
    try {
        if (-not (Complete-Claims $Claims)) {
            Write-Warning "Polo preserved transaction candidates that changed before $Operation cleanup."
        }
    } catch {
        # Claims have already been removed from every public leaf. Do not turn
        # a post-commit cleanup failure into a partial rollback; preserve any
        # remaining private candidates for a later safe cleanup instead.
        Write-Warning "Polo preserved transaction candidates after $Operation cleanup failed: $($_.Exception.Message)"
    }
}

function Restore-AllClaims([Collections.Generic.List[object]]$Claims, [string]$StepPrefix) {
    for ($index = $Claims.Count - 1; $index -ge 0; $index--) {
        Restore-ClaimNoReplace $Claims[$index] $StepPrefix
    }
}

function Install-Transactional([bool]$CheckCommandConflict) {
    Assert-PackagedArtifacts
    if ($CheckCommandConflict) {
        $existing = Get-Command polo -ErrorAction SilentlyContinue
        if ($existing -and $existing.Source.TrimEnd("\") -ine $launcher.TrimEnd("\")) {
            throw "Another command named polo already exists at $($existing.Source). Polo did not overwrite it."
        }
    }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $claims = New-Object 'Collections.Generic.List[object]'
    $published = New-Object 'Collections.Generic.List[object]'
    $managedPublished = New-Object 'Collections.Generic.List[object]'
    $pathMutation = $null
    $committed = $false
    try {
        $stateClaim = Claim-ExistingPath $stateFile "state"
        $previousState = $null
        if ($stateClaim) {
            $claims.Add($stateClaim)
            $previousState = Read-State $stateClaim.Claim
            if (-not $previousState) {
                throw "Polo cannot repair terminal integration because its ownership state is invalid."
            }
        }

        $legacyLauncherWasHistorical = $false
        foreach ($spec in Get-ManagedFileSpecs) {
            $claim = Claim-ExistingPath $spec.Path "install"
            if ($claim) {
                $claims.Add($claim)
                if (-not (Test-ClaimOwnedForUpgrade $previousState $spec.Path $claim.Claim)) {
                    throw "Polo cannot replace $($spec.Path) because it is modified or user-owned."
                }
                if (-not $previousState -and
                    $spec.Path.TrimEnd("\") -ieq $legacyLauncher.TrimEnd("\")) {
                    $legacyLauncherWasHistorical = $true
                }
            }
        }

        foreach ($spec in Get-ManagedFileSpecs) {
            $record = Publish-NewManagedFile $spec.Path $spec.Content "install" $published
            $managedPublished.Add($record)
        }

        $pathMutation = Mutate-UserPath $true $null $claims $published $TestRegistryRaceValue
        $pathEntryOwned = [bool](
            ($previousState -and $previousState.pathEntryAddedByPolo) -or
            (-not $pathMutation.WasPresent) -or
            ($legacyLauncherWasHistorical -and $pathMutation.WasPresent)
        )
        $stateContent = New-StateContent $pathEntryOwned $managedPublished
        Publish-NewManagedFile $stateFile $stateContent "state" $published | Out-Null
        $committed = $true
    } finally {
        if (-not $committed) {
            Remove-PublishedForRollback $published "install-rollback"
            Undo-UserPathMutation $pathMutation $true
            Restore-AllClaims $claims "install-rollback"
        } else {
            Discard-ClaimsAfterCommit $claims "install"
        }
    }
}

function Uninstall-Transactional {
    $claims = New-Object 'Collections.Generic.List[object]'
    $published = New-Object 'Collections.Generic.List[object]'
    $pathMutation = $null
    $committed = $false
    try {
        $stateClaim = Claim-ExistingPath $stateFile "state"
        if (-not $stateClaim) {
            Write-Warning "Polo left terminal files unchanged because ownership state is absent."
            return
        }
        $claims.Add($stateClaim)
        $state = Read-State $stateClaim.Claim
        if (-not $state) {
            throw "Polo cannot uninstall terminal integration because its ownership state is invalid."
        }

        foreach ($spec in Get-ManagedFileSpecs) {
            $claim = Claim-ExistingPath $spec.Path "uninstall"
            if (-not $claim) {
                throw "Polo cannot uninstall terminal integration because $($spec.Path) is missing."
            }
            $claims.Add($claim)
            if (-not (Test-ClaimMatchesState $state $spec.Path $claim.Claim)) {
                throw "Polo left modified or user-owned file unchanged: $($spec.Path)"
            }
        }

        if ($state.pathEntryAddedByPolo) {
            $pathMutation = Mutate-UserPath $false $null $claims $published $TestRegistryRaceValue
        }

        foreach ($claim in $claims) {
            Invoke-TestMutationHook "uninstall:before-commit" $claim.Path $claim.Claim
            if (-not $claim.Identity -or
                (Get-RegularFileIdentity $claim.Claim) -cne $claim.Identity -or
                (Get-Sha256 $claim.Claim) -cne $claim.Sha256) {
                throw "Polo stopped uninstall because a claimed file changed concurrently: $($claim.Path)"
            }
        }
        # Every public leaf is now atomically claimed and fully revalidated.
        # That is the uninstall commit point. Cleanup may delete the private
        # claims only after this point: a later filesystem error can therefore
        # leave recoverable private candidates, but can never force a rollback
        # that restores only a prefix of the old installation.
        $committed = $true
        Discard-ClaimsAfterCommit $claims "uninstall"
        $claims.Clear()
    } finally {
        if (-not $committed) {
            Remove-PublishedForRollback $published "uninstall-rollback"
            Undo-UserPathMutation $pathMutation $false
            Restore-AllClaims $claims "uninstall-rollback"
        }
    }
}

if ($Mode -eq "Validate") {
    Assert-PackagedArtifacts
    $validationRoot = Join-Path ([IO.Path]::GetTempPath()) "polo-launcher-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        $BinDir = $validationRoot
        $launcher = Join-Path $BinDir "polo.cmd"
        $legacyLauncher = Join-Path $BinDir "polo-ai.cmd"
        $rootPointer = Join-Path $BinDir "polo-install-root.txt"
        $stateFile = Join-Path $BinDir "terminal-integration.json"
        $UserPathFile = Join-Path $validationRoot "user-path.txt"
        Install-Transactional $false
        $actualContent = Get-Content $launcher -Raw
        if ((Normalize-LineEndings $actualContent) -cne
            (Normalize-LineEndings ([IO.File]::ReadAllText($launcherTemplate)))) {
            throw "Installed launcher differs from the checked-in canonical template."
        }
        $expectedVersion = (Get-Content $packagePath -Raw | ConvertFrom-Json).version
        $output = & $launcher --version 2>&1
        if ($LASTEXITCODE -ne 0 -or (($output -join "`n").Trim() -ne $expectedVersion)) {
            throw "Generated launcher validation failed: $($output -join "`n")"
        }
    } finally {
        Remove-Item $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

if ($Mode -eq "Install") {
    Install-Transactional (-not $SkipCommandConflict)
    return
}

Uninstall-Transactional

if ((Test-Path $BinDir) -and -not (Get-ChildItem $BinDir -Force | Select-Object -First 1)) {
    Remove-Item $BinDir -Force
}
