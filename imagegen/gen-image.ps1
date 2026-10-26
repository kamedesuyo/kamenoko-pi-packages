# Strataでは専用4060でSDXLを並行実行。従来LLMでは停止・KV復帰を使う。
#
# 以下は従来LLMの共有GPU経路。専用4060では停止・復帰と待機役の再利用を省く。
#   1. 生成役（gen-image-runner.py）に job を渡す。前回の終わりに起動しておいた待機役がいればそれに、いなければ起動する。
#      生成役が開始合図を待っている間に、
#   2. pause-llm.ps1 pause で LLM の KV を保存して止める
#   3. 生成役に go を出し、描き終わって終わるのを待つ
#   4. pause-llm.ps1 resume で LLM を起動し直して KV を戻す
# 生成に失敗しても 4 は必ず通す。LLM を止めたままにしない。
#
# pi からは拡張ツール generate_image（~/.pi/agent/extensions/generate-image.ts）が呼ぶ。
# pi はツールの終わりを待つだけでその間サーバに話しかけないので、自分自身を止めて戻ってこられる。
#
# 使い方:
#   gen-image.bat "1girl, fox ears, smile"                    # 縦長 1枚。出力は設定の outputDir\<時刻>.png
#   powershell -File gen-image.ps1 -Prompt "..." -Size landscape -Count 4 -Seed 42 -Open

param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,
    # 画質の部分。ユーザーが自由に指定する。
    [string]$Negative = 'lowres, bad quality, worst quality, worst detail, sketch, censor, bad anatomy, bad hands, extra fingers, text, watermark, signature',
    [ValidateSet('portrait', 'landscape', 'square')]
    [string]$Size = 'portrait',
    # 1 回の停止で何枚描くか。seed は Seed, Seed+1, ... で、1 枚ずつ -Seed で描き直せる。2 枚目からは 1 枚 約5秒。
    [ValidateRange(1, 8)]
    [int]$Count = 1,
    [long]$Seed = -1,
    # 28・20・16・14 を等倍で見比べて質の差が見えなかった（2026-10-22、サンプリング 8.0 / 5.8 / 4.7 / 4.1 秒）。
    # 14 でも崩れなかったが、見比べたのは 1 プロンプトなので、手や込み入った場面の余裕を残して 16 にした。
    [ValidateRange(1, 100)]
    [int]$Steps = 16,
    [double]$Cfg = 5.5,
    [string]$OutDir = '',
    # 描き終わったら画像を開く（gen-image.bat が付ける）。
    [switch]$Open,
    [ValidateSet('auto', 'shared', 'rtx4060')]
    [string]$Gpu = 'auto',
    # 設定ファイル。省略時は環境変数 IMAGEGEN_CONFIG、なければ %LOCALAPPDATA%\imagegen\config.json。
    [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'ImageGenConfig.ps1')
$imageConfig = Read-ImageGenConfig $Config

# ComfyUI portable の python_embeded（._pth で ComfyUI が sys.path に入る）。HDD に置くと起動だけで 95 秒かかったので、
# このPCでは C:（NVMe）へ写したものを設定で指している。コアノードしか使わないので、元の ComfyUI の更新には追従しなくてよい。
$Python    = $imageConfig.comfyPython
# 生成役の作業フォルダ。portable 版では python_embeded の1つ上（ComfyUI_windows_portable）。
$ComfyDir  = Split-Path -Parent (Split-Path -Parent $Python)
$RunnerPy  = Join-Path $PSScriptRoot 'gen-image-runner.py'
$CkptDir   = Split-Path -Parent $imageConfig.sdxl.checkpoint
$Ckpt      = Split-Path -Leaf $imageConfig.sdxl.checkpoint
# fp16 accumulation と sage attention で 28 steps のサンプリングが 10.3→8.0 秒。絵の構図・質は変わらない
# （euler_ancestral は途中で乱数を足すので細部の柄は変わる。2026-10-22 に等倍で見比べた）。
$ComfyArgs = '--fast fp16_accumulation --use-sage-attention'
# 旧 llama-server 経路（止めて描いて戻す）は設定に legacyLlm がある時だけ使う。
$LlamaUrl  = [string]$imageConfig.legacyLlm.url
$StateFile = [string]$imageConfig.legacyLlm.stateFile
$PausePs1  = [string]$imageConfig.legacyLlm.pauseScript
$LlamaPort = Get-UrlPort $LlamaUrl
$StrataPort = Get-UrlPort $imageConfig.strata.url
$ComfyPort = if ($imageConfig.qwen.comfyPort) { [int]$imageConfig.qwen.comfyPort } else { 8188 }
$WorkDir   = Join-Path $env:TEMP 'gen-image'
# 段階ごとの時刻（どこが遅いかを測るため）。pause-llm.ps1 と生成役も $env:LLM_TIMELINE を見て同じファイルへ書く。
# llama-server の内部は WSL の ~/llama-manager/run/server.log（起動からの経過時間付き）で見る。
$Timeline  = Join-Path $env:TEMP 'gen-image-timeline.log'
# 品質タグの後に足す固定タグ。今は何も足さない（画風や内容はプロンプトのタグで決める）。
$SafePositive = ''
$Sizes = @{ portrait = @(832, 1216); landscape = @(1216, 832); square = @(1024, 1024) }

# 待ち受けの無いポートへ接続すると、Windows は拒否されても再試行するので 1回 2.04秒かかる（2026-10-22 実測）。
# 待ち受け一覧を先に見て、無ければ接続しない（1ミリ秒）。WSL のポートは wslrelay が待ち受けとして出る。
function Test-Listening {
    param([int]$Port)
    return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port })
}

function Test-Endpoint {
    param([string]$Url, [int]$TimeoutSec = 3)
    if ($Url -notmatch '^https?://') { return $false }
    if (-not (Test-Listening ([uri]$Url).Port)) { return $false }
    try {
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

# 生成役と同じファイルへ書くので、たまたま同時に開いて失敗しても無視する（記録のために生成を止めない）。
function Write-Mark {
    param([string]$Label, [datetime]$At = (Get-Date))
    try { Add-Content -Path $Timeline -Value ("{0:HH:mm:ss.fff}`t{1}" -f $At, $Label) -Encoding ASCII } catch {}
}

function Get-Seconds {
    param([datetime]$Since)
    return ((Get-Date) - $Since).TotalSeconds
}

# Strataは停止・復帰の対象外。専用GPUを選べない場合は元のGPUへフォールバックしない。
$strataUp = Test-Listening $StrataPort
if ($Gpu -eq 'auto') { $Gpu = if ($strataUp) { 'rtx4060' } else { 'shared' } }
$dedicated = $Gpu -eq 'rtx4060'
$gpuUuid = ''
if ($dedicated) {
    if (Test-Listening $LlamaPort) { throw "${LlamaPort}のLLMは4060を使用する可能性があります。専用GPU生成は開始しません。" }
    $gpuRows = @(& nvidia-smi --query-gpu=uuid,name,memory.free --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0) { throw 'GPU情報を取得できませんでした。' }
    $matches4060 = @($gpuRows | ConvertFrom-Csv -Header uuid,name,free | Where-Object { $_.name.Trim() -eq 'NVIDIA GeForce RTX 4060' })
    if ($matches4060.Count -ne 1) { throw '専用のRTX 4060を一意に特定できませんでした。' }
    $gpuUuid = $matches4060[0].uuid.Trim()
    # 直前生成の VRAM 解放を待って再チェックする。連続生成で一瞬足りないだけのケースで落とさない。
    $freeNow = [int]$matches4060[0].free
    $waited = $false
    $deadline = (Get-Date).AddSeconds(20)
    while ($freeNow -lt 6144 -and (Get-Date) -lt $deadline) {
        if (-not $waited) { Write-Host "RTX 4060の空きが ${freeNow}MiB。解放を最大20秒待ちます。" -ForegroundColor Yellow; $waited = $true }
        Start-Sleep -Milliseconds 1000
        $freeNow = [int](& nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits --id=$gpuUuid)
    }
    if ($freeNow -lt 6144) { throw "RTX 4060の空きVRAMが6GiB未満です（待機後 ${freeNow}MiB）。使用中の画像生成アプリを確認してください。" }
    $WorkDir = Join-Path $env:TEMP 'gen-image-4060'
    $Timeline = Join-Path $env:TEMP 'gen-image-4060-timeline.log'
} elseif ($strataUp) {
    throw 'Strata動作中は -Gpu rtx4060 を使用してください。共有GPU生成は開始しません。'
}

Set-Content -Path $Timeline -Value $null
$env:LLM_TIMELINE = $Timeline
Write-Mark 'gen.process_start' ([Diagnostics.Process]::GetCurrentProcess().StartTime)
$t0 = Get-Date

# 二重に走ると LLM の止め戻しがぶつかる。
$mutex = New-Object Threading.Mutex($false, 'Local\gen-image-llm')
if (-not $mutex.WaitOne(0)) {
    Write-Host '別の画像生成が動いている。終わってから実行して。' -ForegroundColor Red
    exit 1
}
# 手で立てた ComfyUI が VRAM を握っていると、描けないうえに LLM を戻せなくなる。
if (Test-Listening $ComfyPort) {
    Write-Host "ComfyUI（$ComfyPort）が動いている。閉じてから実行して（VRAM を握ったままだと LLM を戻せない）。" -ForegroundColor Red
    exit 1
}

if (-not $OutDir) { $OutDir = $imageConfig.outputDir }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
if ($Seed -lt 0) { $Seed = Get-Random -Minimum 0 -Maximum 2000000000 }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$seeds = @(0..($Count - 1) | ForEach-Object { $Seed + $_ })
$outs = @(0..($Count - 1) | ForEach-Object {
    if ($Count -eq 1) { Join-Path $OutDir "$stamp.png" } else { Join-Path $OutDir ("{0}-{1}.png" -f $stamp, ($_ + 1)) }
})
$w, $h = $Sizes[$Size]

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir | Out-Null }
$go = Join-Path $WorkDir 'go'
$abort = Join-Path $WorkDir 'abort'
$jobFile = Join-Path $WorkDir 'job.json'
$resultFile = Join-Path $WorkDir 'result.json'
$runOut = Join-Path $WorkDir 'runner.out'
$runErr = Join-Path $WorkDir 'runner.err'
$warmReady = Join-Path $WorkDir 'warm.ready'
$warmJob = Join-Path $WorkDir 'warm.job'
$warmLog = Join-Path $WorkDir 'warm.log'
$progressFile = Join-Path $WorkDir 'progress.jsonl'
$emitEvents = $env:GEN_IMAGE_PROGRESS_EVENTS -eq '1'
$Pythonw = Join-Path (Split-Path -Parent $Python) 'pythonw.exe'
Remove-Item $go, $abort, $resultFile, $runOut, $runErr, $progressFile -ErrorAction SilentlyContinue
$job = [ordered]@{
    ckpt_dir = $CkptDir; ckpt = $Ckpt
    prompt = ("masterpiece, best quality, amazing quality" + $(if ($SafePositive) { ", $SafePositive" } else { '' }) + ", $Prompt")
    negative = $Negative
    seeds = $seeds; outs = $outs; steps = $Steps; cfg = $Cfg
    sampler = 'euler_ancestral'; scheduler = 'normal'; width = $w; height = $h
    go = $go; abort = $abort; result = $resultFile; timeline = $Timeline; comfy_args = $ComfyArgs
    gpu_mode = $Gpu; gpu_uuid = $gpuUuid
    progress_file = $(if ($emitEvents) { $progressFile } else { $null })
}
[IO.File]::WriteAllText($jobFile, ($job | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))

# 前回の生成が起動しておいた待機役（外部ライブラリを読み終えて job を待っている）がいれば渡す。import 5.3 秒が 1.1 秒になる。
function Get-WarmRunner {
    if (-not (Test-Path $warmReady)) { return $null }
    $warmPid = 0
    $null = [int]::TryParse((Get-Content $warmReady -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$warmPid)
    $p = Get-Process -Id $warmPid -ErrorAction SilentlyContinue
    if ($p -and $p.Path -eq $Pythonw) { return $p }
    Remove-Item $warmReady -ErrorAction SilentlyContinue
    return $null
}

$runner = $null
$runnerLog = $runErr
$warm = if (-not $dedicated) { Get-WarmRunner } else { $null }
if ($warm) {
    Copy-Item $jobFile "$warmJob.tmp" -Force
    Move-Item "$warmJob.tmp" $warmJob -Force
    # 待機役は 0.1 秒ごとに見ている。3 時間で自分から終わるので、終わり際と行き違うと誰も掴まない。その時は取り下げて自分で起動する。
    $deadline = (Get-Date).AddSeconds(2)
    while ((Test-Path $warmJob) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
    if (Test-Path $warmJob) {
        Remove-Item $warmJob -ErrorAction SilentlyContinue
    } else {
        $runner = $warm
        $runnerLog = $warmLog
    }
}
if (-not $runner) {
    $env:PYTHONUTF8 = '1'
    # このスクリプトの終わりで必ず終わる（自分で抜ける）ので、親のジョブに巻き込まれても困らない。Start-Process でよい。
    $runner = Start-Process -FilePath $Python -ArgumentList @('-s', "`"$RunnerPy`"", "`"$jobFile`"") `
        -WorkingDirectory $ComfyDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $runOut -RedirectStandardError $runErr
}
Write-Mark ('gen.runner_' + $(if ($runnerLog -eq $warmLog) { 'warm' } else { 'cold' }))

$llmWasUp = (-not $dedicated) -and (Test-Endpoint "$LlamaUrl/health")
$pauseLog = ''
$nSaved = 0
if ($llmWasUp) {
    $tp = Get-Date
    Write-Host '[1/3] LLM を一時停止' -NoNewline
    $pauseLog = & $PausePs1 -Phase pause -NoPrompt -NoGpuWait *>&1 | Out-String
    if (Test-Endpoint "$LlamaUrl/health") {
        Set-Content $abort 'x'
        Write-Host ' … 止められなかったので描かない' -ForegroundColor Red
        Write-Host $pauseLog
        exit 1
    }
    try { $nSaved = [int](Get-Content $StateFile -Raw | ConvertFrom-Json).n_saved } catch {}
    Write-Host (' … {0:N1} 秒（KV {1:N0} トークンを保存）' -f (Get-Seconds $tp), $nSaved)
} elseif ($dedicated) {
    Write-Host '[1/3] RTX 4060で描画（LLMは停止しません）'
} else {
    Write-Host '[1/3] LLM は動いていない（止めずに描く）'
}
Set-Content $go 'x'
Write-Mark 'gen.go'

$tg = Get-Date
Write-Host ('[2/3] 描画（{0} 枚、{1}x{2}、{3} steps）' -f $Count, $w, $h, $Steps) -NoNewline
# 生成役は結果を書く前に VRAM を返す。プロセスの終了（0.9 秒）は待たずに、結果が出た時点で LLM の再開へ進む。
$deadline = (Get-Date).AddSeconds(900)
$progressReader = $null
$progressBuffer = @{ pending = '' }
function Read-ImageProgress {
    if (-not $progressReader -or $progressBuffer.failed) { return }
    # 最後の行が書きかけでも、次の読み取りまで保持してJSONを途中で切らない。
    try { $progressBuffer.pending += $progressReader.ReadToEnd() } catch {
        $progressBuffer.failed = $true
        Write-Warning '途中表示の読み取りに失敗しました。画像生成は継続します。'
        return
    }
    while (($end = $progressBuffer.pending.IndexOf("`n")) -ge 0) {
        $line = $progressBuffer.pending.Substring(0, $end).TrimEnd("`r")
        $progressBuffer.pending = $progressBuffer.pending.Substring($end + 1)
        if ($line) { Write-Host ("`nIMAGE_EVENT " + $line) }
    }
}
try {
    if ($emitEvents) {
        $stream = $null
        try {
            $stream = [IO.File]::Open($progressFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Read,
                ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            $progressReader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
            Write-Host ("`nIMAGE_EVENT " + (@{ type='progress'; phase='queued'; index=1; count=$Count } | ConvertTo-Json -Compress))
        } catch {
            # 表示のために共有GPU経路のLLM復帰を飛ばさない。
            if ($stream) { $stream.Dispose() }
            Write-Warning '途中表示を開始できませんでした。画像生成は継続します。'
        }
    }
    while (-not (Test-Path $resultFile) -and -not $runner.HasExited -and (Get-Date) -lt $deadline) {
        Read-ImageProgress
        Start-Sleep -Milliseconds 50
    }
    $finished = (Test-Path $resultFile) -or $runner.HasExited
    if (-not $finished) {
        $runner.Kill()
        $null = $runner.WaitForExit(10000)
    }
    Read-ImageProgress
} finally {
    if ($progressReader) { $progressReader.Dispose() }
    Remove-Item -LiteralPath $progressFile -ErrorAction SilentlyContinue
}
$result = $null
try { $result = (Get-Content $resultFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch {}
if (-not ($result -and $result.gpu_released)) { $null = $runner.WaitForExit(30000) }
Write-Mark 'gen.runner_done'
$ok = [bool]($result -and $result.ok)
if ($ok) {
    $tm = $result.timings
    Write-Host (' … {0:N1} 秒（モデル読み込み {1:N1}、サンプリング {2} 秒）' -f (Get-Seconds $tg), ($tm.load_ckpt + $tm.clip),
        (($tm.sample | ForEach-Object { '{0:N1}' -f $_ }) -join ' / '))
} else {
    $why = if (-not $finished) { '15 分で終わらなかった' } elseif ($result) { $result.error } else { '結果が無い' }
    Write-Host " … 失敗: $why" -ForegroundColor Red
    if (Test-Path $runnerLog) { Get-Content $runnerLog -Tail 12 | ForEach-Object { Write-Host "    $_" } }
}

# 生成役のプロセスが終わった時点で VRAM は返っている（nvidia-smi に出るのが少し遅れるだけ）。
# llama-server が VRAM を確保するのは起動から 1 秒以上あとなので、減りきるのを待たずに LLM を戻す。

$llmBack = $true
if ($llmWasUp -and (Test-Path $StateFile)) {
    if ($emitEvents) { Write-Host 'IMAGE_EVENT {"type":"progress","phase":"resuming"}' }
    $tr = Get-Date
    Write-Host '[3/3] LLM を再開' -NoNewline
    $resumeLog = & $PausePs1 -Phase resume -NoPrompt *>&1 | Out-String
    $llmBack = (Test-Endpoint "$LlamaUrl/health") -and -not (Test-Path $StateFile)
    if ($llmBack) {
        $nBack = if ($resumeLog -match '([\d,]+) トークン /') { $Matches[1] } else { '0' }
        Write-Host (' … {0:N1} 秒（KV {1} トークンを復元）' -f (Get-Seconds $tr), $nBack)
    } else {
        Write-Host ' … 失敗。pause-llm.bat resume で戻せる（KV は残してある）' -ForegroundColor Red
        Write-Host (($resumeLog -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15) -join "`n")
    }
}
Write-Mark 'gen.end'

# 次の生成のために待機役を起動しておく（外部ライブラリだけ読んで待つ。VRAM は使わない。3 時間で自分から終わる）。
# pi のツールから呼ばれた時にツールのジョブごと消されないよう、Win32_Process.Create で親と縁を切る。
if (-not $dedicated -and -not (Get-WarmRunner)) {
    $cmd = '"{0}" -s -X utf8 "{1}" --warm "{2}"' -f $Pythonw, $RunnerPy, $WorkDir
    try { $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $ComfyDir } } catch {}
}

if ($ok) {
    # 画像ビューア（imgpane.py）へ送る。開いていれば横の枠にすぐ出る。開いていなくても履歴に残る。
    try {
        $q = Join-Path $env:LOCALAPPDATA 'imgpane\queue.txt'
        New-Item -ItemType Directory -Force (Split-Path $q) | Out-Null
        [IO.File]::AppendAllText($q, (($result.files | ForEach-Object { $_.path + "`n" }) -join ''), (New-Object Text.UTF8Encoding $false))
    } catch {}
    foreach ($f in $result.files) { Write-Host ('画像: {0}（seed {1}）' -f $f.path, $f.seed) -ForegroundColor Green }
    Write-Host ('全体 {0:N0} 秒' -f (Get-Seconds $t0))
    if ($Open) { foreach ($f in $result.files) { Invoke-Item $f.path } }
}
if (-not ($ok -and $llmBack)) { exit 1 }
