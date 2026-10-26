param(
    [Parameter(Mandatory)][string]$Prompt,
    [string]$Negative,
    [ValidateSet('portrait', 'landscape', 'square')][string]$Size = 'portrait',
    [ValidateRange(1,4)][int]$Count = 1,
    [long]$Seed = -1,
    [ValidateRange(1,100)][int]$Steps = 25,
    [double]$Cfg = 2.5,
    [string]$Sampler = 'er_sde',
    [string]$Scheduler = 'beta',
    [string]$OutDir = '',
    [switch]$Open,
    [switch]$Watch,
    # 設定ファイル。省略時は環境変数 IMAGEGEN_CONFIG、なければ %LOCALAPPDATA%\imagegen\config.json。
    [string]$Config = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
try {
    . (Join-Path $PSScriptRoot 'ImageGenConfig.ps1')
    $imageConfig = Read-ImageGenConfig $Config
    $base = ([string]$imageConfig.strata.url).TrimEnd('/')
    if (-not $base) { throw '設定に strata.url がありません。' }
    $comfyPort = if ($imageConfig.qwen.comfyPort) { [int]$imageConfig.qwen.comfyPort } else { 8188 }
    $llamaPort = Get-UrlPort $imageConfig.legacyLlm.url
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners.Port -contains $comfyPort) { throw "手動ComfyUI（$comfyPort）を閉じてから実行してください。" }
    if ($llamaPort -and $listeners.Port -contains $llamaPort) { throw "${llamaPort}のLLMも動いています。GPU競合を避けるため画像生成を開始しません。" }
    $health = Invoke-RestMethod "$base/health" -TimeoutSec 10
    if ($health.service -ne 'strata' -or -not $health.image_generation) {
        throw '稼働中のStrataに画像生成の接続設定がありません。画像対応profileを起動してください。'
    }
    if (-not $OutDir) { $OutDir = $imageConfig.outputDir }
    $null = New-Item -ItemType Directory -Force -Path $OutDir
    if ($Seed -lt 0) { $Seed = Get-Random -Minimum 0 -Maximum 2000000000 }
    $sizes = @{ portrait='832x1248'; landscape='1248x832'; square='1024x1024' }
    $body = @{ prompt=$Prompt; negative_prompt=$Negative; size=$sizes[$Size]; n=$Count; seed=$Seed; steps=$Steps;
               cfg_scale=$Cfg; sampler=$Sampler; scheduler=$Scheduler; response_format='b64_json' } | ConvertTo-Json -Compress
    Write-Host '[1/2] Qwenで画像生成中（5060 Ti: 画像本体 / 4060: テキスト処理）。Strataが会話キャッシュを保存し、生成後に復元します。'
    # 別のpiやブラウザの要求も、会話の復元が終わるまでFIFOで待たせる。
    $requestFile = Join-Path ([IO.Path]::GetTempPath()) ('qwen-request-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($requestFile, $body, [Text.UTF8Encoding]::new($false))
        $clientArgs = @('-u', '-X', 'utf8', (Join-Path $PSScriptRoot 'gen-image-strata-client.py'),
                        '--request', $requestFile, '--out-dir', $OutDir, '--base', $base)
        if ($env:GEN_IMAGE_PROGRESS_EVENTS -eq '1') { $clientArgs += '--events' }
        & $imageConfig.strata.python @clientArgs |
            ForEach-Object {
                $line = [string]$_
                Write-Output $line
                if ($Open -and $line -match '^画像:\s+(.+\.png)（seed \d+）$') { Invoke-Item -LiteralPath $Matches[1] }
            }
        if ($LASTEXITCODE -ne 0) { throw 'Qwen画像生成に失敗しました。上のエラーを確認してください。' }
    } finally {
        Remove-Item -LiteralPath $requestFile -ErrorAction SilentlyContinue
    }
} catch {
    $message = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Host $message -ForegroundColor Red
    exit 1
}
