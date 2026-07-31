param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactName,
    [Parameter(Mandatory = $true)]
    [string]$Output
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Error "::error::$Message"
    exit 1
}

foreach ($name in @(
    "GITHUB_REPOSITORY",
    "PREVIOUS_RELEASE_TAG",
    "PREVIOUS_RELEASE_VERSION",
    "PREVIOUS_RELEASE_COMMIT_SHA",
    "EXPECTED_PREVIOUS_ARTIFACT_SHA256",
    "POLO_AI_PREVIOUS_ARTIFACT"
)) {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
        Fail "Missing immutable previous-release contract field: $name"
    }
}
if ($env:GITHUB_REPOSITORY -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    Fail "Invalid repository contract."
}
if ($env:PREVIOUS_RELEASE_TAG -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$') {
    Fail "Previous release must be a semantic immutable tag."
}
if ($env:PREVIOUS_RELEASE_VERSION -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$') {
    Fail "Invalid previous release version."
}
if ($env:PREVIOUS_RELEASE_COMMIT_SHA -notmatch '^[0-9a-fA-F]{40}$') {
    Fail "Previous commit SHA must contain 40 hex characters."
}
if ($env:EXPECTED_PREVIOUS_ARTIFACT_SHA256 -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Previous artifact SHA-256 must contain 64 hex characters."
}
if ($ArtifactName -notmatch '^[A-Za-z0-9._-]+$') {
    Fail "Invalid artifact name."
}

git fetch --force --no-tags origin `
    "refs/tags/$($env:PREVIOUS_RELEASE_TAG):refs/tags/$($env:PREVIOUS_RELEASE_TAG)"
if ($LASTEXITCODE -ne 0) { Fail "Unable to fetch the pinned previous tag." }
$resolvedCommit = (git rev-list -n 1 $env:PREVIOUS_RELEASE_TAG).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -cne $env:PREVIOUS_RELEASE_COMMIT_SHA) {
    Fail "Previous tag commit does not match the pinned commit SHA."
}

$releaseTag = (gh release view $env:PREVIOUS_RELEASE_TAG `
    --repo $env:GITHUB_REPOSITORY --json tagName --jq '.tagName').Trim()
$releaseUrl = (gh release view $env:PREVIOUS_RELEASE_TAG `
    --repo $env:GITHUB_REPOSITORY --json url --jq '.url').Trim()
$releaseDraft = (gh release view $env:PREVIOUS_RELEASE_TAG `
    --repo $env:GITHUB_REPOSITORY --json isDraft --jq '.isDraft').Trim()
if ($releaseTag -cne $env:PREVIOUS_RELEASE_TAG -or $releaseDraft -cne "false") {
    Fail "Previous release tag provenance is invalid or the release is a draft."
}
$expectedReleaseUrl = "https://github.com/$($env:GITHUB_REPOSITORY)/releases/tag/$($env:PREVIOUS_RELEASE_TAG)"
if ($releaseUrl -cne $expectedReleaseUrl) {
    Fail "Previous release URL provenance does not match the pinned repository and tag."
}

$previousPackage = git show "$($env:PREVIOUS_RELEASE_TAG):apps/electron/package.json" `
    | Out-String | ConvertFrom-Json
$currentPackage = Get-Content apps/electron/package.json -Raw | ConvertFrom-Json
$resolvedVersion = [string]$previousPackage.version
$currentVersion = [string]$currentPackage.version
if ($resolvedVersion -cne $env:PREVIOUS_RELEASE_VERSION) {
    Fail "Previous tag package version does not match the pinned version."
}
if ($resolvedVersion -ceq $currentVersion) {
    Fail "Previous release version must differ from current $currentVersion."
}

$artifactParent = Split-Path -Parent $env:POLO_AI_PREVIOUS_ARTIFACT
$outputParent = Split-Path -Parent $Output
New-Item -ItemType Directory -Force $artifactParent, $outputParent | Out-Null
$downloadDir = Join-Path $env:RUNNER_TEMP "polo-previous-$PID-$([Guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Force $downloadDir | Out-Null
    gh release download $env:PREVIOUS_RELEASE_TAG `
        --repo $env:GITHUB_REPOSITORY `
        --pattern $ArtifactName `
        --dir $downloadDir
    if ($LASTEXITCODE -ne 0) { Fail "Previous release artifact download failed." }
    $downloaded = Join-Path $downloadDir $ArtifactName
    if (-not (Test-Path -LiteralPath $downloaded -PathType Leaf)) {
        Fail "Previous release artifact was not downloaded."
    }
    $artifactHash = (Get-FileHash -LiteralPath $downloaded -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($artifactHash -cne $env:EXPECTED_PREVIOUS_ARTIFACT_SHA256.ToLowerInvariant()) {
        Fail "Previous artifact SHA-256 mismatch."
    }
    Move-Item -LiteralPath $downloaded -Destination $env:POLO_AI_PREVIOUS_ARTIFACT -Force

    $contract = [ordered]@{
        schemaVersion = 1
        repository = $env:GITHUB_REPOSITORY
        tag = $env:PREVIOUS_RELEASE_TAG
        version = $resolvedVersion
        commitSha = $resolvedCommit
        releaseUrl = $releaseUrl
        artifact = [ordered]@{
            name = $ArtifactName
            sha256 = $artifactHash
        }
        installer = $null
    }
    $contract | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $Output -Encoding UTF8
} finally {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($env:GITHUB_ENV) {
    @(
        "RESOLVED_PREVIOUS_COMMIT_SHA=$resolvedCommit"
        "RESOLVED_PREVIOUS_VERSION=$resolvedVersion"
        "CURRENT_ELECTRON_VERSION=$currentVersion"
    ) | Add-Content -LiteralPath $env:GITHUB_ENV -Encoding UTF8
}

Write-Host "Verified immutable previous release $($env:PREVIOUS_RELEASE_TAG) ($resolvedCommit) before runtime setup."
