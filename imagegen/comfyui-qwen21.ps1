# Qwen-Image 2.1 用の ComfyUI（設定の qwen.root、0.42.4）を画面つきで開く。開いている間はローカル LLM を KV ごと止めて
# GPU を空け、閉じたら戻す（設定の legacyLlm がある時だけ）。ワークフロー一覧の「qwen21-t2i」が gen-image-qwen21 と同じつなぎ。
#
# 普段使いの ComfyUI とは別に置いているのは、モデルを速いディスクから読み、LLM の止め戻しまでやるから。
# 見ながら描くモード（gen-image-qwen21 -Watch）もこちらを使う。
#
# 使い方: comfyui-qwen21.bat        （http://127.0.0.1:<qwen.comfyPort> を自分で開く。開いたままのタブはつなぎ直る）
#         comfyui-qwen21.bat open   （既定のブラウザで開く）
# 終わったらこの窓で Enter。ComfyUI の窓を閉じても LLM は戻る。出力は 設定の outputDir\comfyui-qwen21。

param(
    # 省略時は設定の qwen.comfyPort（無ければ 8188）。
    [int]$Port = 0,
    # 既定では開かない。見ながら描くモード用にタブを開きっぱなしにしていると、毎回もう 1 枚開いてしまうため。
    [switch]$Open,
    # 設定ファイル。省略時は環境変数 IMAGEGEN_CONFIG、なければ %LOCALAPPDATA%\imagegen\config.json。
    [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'ImageGenConfig.ps1')
$imageConfig = Read-ImageGenConfig $Config
if (-not $Port) { $Port = if ($imageConfig.qwen.comfyPort) { [int]$imageConfig.qwen.comfyPort } else { 8188 } }
$Python    = $imageConfig.comfyPython
$QwenRoot  = $imageConfig.qwen.root
$ServerPy  = Join-Path $PSScriptRoot 'comfyui-qwen21-server.py'
$OutDir    = Join-Path $imageConfig.outputDir 'comfyui-qwen21'
$LlamaUrl  = [string]$imageConfig.legacyLlm.url
$StateFile = [string]$imageConfig.legacyLlm.stateFile
$PausePs1  = [string]$imageConfig.legacyLlm.pauseScript
$Url       = "http://127.0.0.1:$Port"

function Test-Listening {
    param([int]$P)
    return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $P })
}

function Test-Endpoint {
    param([string]$U, [int]$TimeoutSec = 3)
    if ($U -notmatch '^https?://') { return $false }
    if (-not (Test-Listening ([uri]$U).Port)) { return $false }
    try {
        $null = Invoke-WebRequest -Uri $U -TimeoutSec $TimeoutSec -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Test-EnterPressed {
    # 入力がつながっていない時（ツールから起動した時など）は KeyAvailable が例外になるので、押されていない扱いにする。
    try {
        while ([Console]::KeyAvailable) {
            if ([Console]::ReadKey($true).Key -eq 'Enter') { return $true }
        }
    } catch {}
    return $false
}

# gen-image / gen-image-qwen21 と同じ mutex。開いている間に pi から描かせると、LLM の止め戻しと VRAM がぶつかる。
$mutex = New-Object Threading.Mutex($false, 'Local\gen-image-llm')
if (-not $mutex.WaitOne(0)) {
    Write-Host '画像生成が動いている。終わってから開いて。' -ForegroundColor Red
    exit 1
}
if (Test-Listening $Port) {
    Write-Host "$Port で別の ComfyUI が動いている。閉じてから開いて。" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$llmWasUp = Test-Endpoint "$LlamaUrl/health"
if ($llmWasUp) {
    Write-Host '[1/3] LLM を一時停止' -NoNewline
    $pauseLog = & $PausePs1 -Phase pause -NoPrompt *>&1 | Out-String
    if (Test-Endpoint "$LlamaUrl/health") {
        Write-Host ' … 止められなかったので開かない' -ForegroundColor Red
        Write-Host $pauseLog
        exit 1
    }
    Write-Host ' … 済み'
} else {
    Write-Host '[1/3] LLM は動いていない'
}

$server = $null
try {
    Write-Host "[2/3] ComfyUI を起動（$Url）" -NoNewline
    $env:PYTHONUTF8 = '1'
    $env:IMAGEGEN_QWEN_ROOT = $QwenRoot
    $server = Start-Process -FilePath $Python -PassThru -WorkingDirectory (Join-Path $QwenRoot 'ComfyUI') -ArgumentList @(
        '-s', "`"$ServerPy`"", '--listen', '127.0.0.1', '--port', "$Port", '--use-sage-attention',
        '--output-directory', "`"$OutDir`"")
    $deadline = (Get-Date).AddSeconds(180)
    while (-not (Test-Listening $Port) -and -not $server.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (-not (Test-Listening $Port)) {
        Write-Host ' … 起動できなかった（ComfyUI の窓のログを見て）' -ForegroundColor Red
        return
    }
    Write-Host " … 開いた（$Url）"
    if ($Open) { Start-Process $Url }
    Write-Host '      終わったらこの窓で Enter（ComfyUI の窓を閉じても LLM は戻る）' -ForegroundColor Cyan
    while (-not $server.HasExited) {
        if (Test-EnterPressed) { break }
        Start-Sleep -Milliseconds 300
    }
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        $null = $server.WaitForExit(15000)
    }
    if ($llmWasUp -and (Test-Path $StateFile)) {
        Write-Host '[3/3] LLM を再開' -NoNewline
        $resumeLog = & $PausePs1 -Phase resume -NoPrompt *>&1 | Out-String
        if ((Test-Endpoint "$LlamaUrl/health") -and -not (Test-Path $StateFile)) {
            Write-Host ' … 済み（KV も戻した）' -ForegroundColor Green
        } else {
            Write-Host ' … 失敗。pause-llm.bat resume で戻せる（KV は残してある）' -ForegroundColor Red
            Write-Host (($resumeLog -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15) -join "`n")
        }
    }
    $mutex.ReleaseMutex()
}
