param(
    [string]$Prompt,
    [string]$Profile,
    [switch]$ListProfiles,
    [string]$Size,
    [int]$Count,
    [long]$Seed,
    [int]$Steps,
    [string]$NegativePrompt,
    [string]$Config,
    [string]$Result
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $Config) { $Config = $env:IMAGEGEN_CONFIG }
if (-not $Config) { $Config = Join-Path $env:LOCALAPPDATA 'imagegen\config.json' }
$Config = [IO.Path]::GetFullPath($Config)
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$python = $env:IMAGEGEN_PYTHON
if (-not $python) { $python = $settings.comfyPython }
if (-not $python) { throw 'Set IMAGEGEN_PYTHON or comfyPython in the config.' }
if (-not [IO.Path]::IsPathRooted($python)) { $python = Join-Path (Split-Path $Config) $python }
$cliArgs = @('-s', '-X', 'utf8', (Join-Path $PSScriptRoot 'gen-image-profile.py'), '--config', $Config)
if ($ListProfiles) { $cliArgs += '--list' }
else {
    if ($PSBoundParameters.ContainsKey('Prompt')) { $env:GEN_IMAGE_PROMPT = $Prompt }
    if ($PSBoundParameters.ContainsKey('NegativePrompt')) { $env:GEN_IMAGE_NEGATIVE = $NegativePrompt }
    foreach ($pair in @(@('Profile','profile'), @('Size','size'), @('Count','count'), @('Seed','seed'), @('Steps','steps'), @('Result','result'))) {
        if ($PSBoundParameters.ContainsKey($pair[0])) { $cliArgs += "--$($pair[1])=$($PSBoundParameters[$pair[0]])" }
    }
}
& $python @cliArgs
exit $LASTEXITCODE
