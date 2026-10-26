# Strataは画像APIにGPU縮小・復帰を任せる。旧LLM経路は停止・復帰する。
# 旧経路はpause-llm.ps1を使い、Strataはサーバー内のFIFOで会話要求を待たせる。
#
# 参照画像（実在の人の顔など）を取る入口は作っていない。文章からだけ描く。
#
# pi からは pi-imagegen の拡張ツール generate_image_qwen が呼ぶ。
#
# -Watchは旧LLM経路専用（見ながら描く）: 生成役の代わりに設定 qwen.root の ComfyUI をサーバとして立てて描く。ブラウザで
# http://127.0.0.1:<qwen.comfyPort> を開いておくと、ノードの進み具合と step ごとのプレビューが見える（開いたままのタブはつなぎ直る）。
# 描き終わったらサーバを落として LLM を戻す。常駐させないのは、LLM が VRAM をほぼ使い切っていて（5060 Ti の空き約 0.9GB）、
# ComfyUI が CUDA を握ったままだと LLM が戻れないため。起動のぶん 5〜10 秒遅い。
#
# 使い方:
#   gen-image-qwen21.bat "A photograph of ..."                 # 縦長 1枚。出力は設定の outputDir\<時刻>-qwen21.png
#   powershell -File gen-image-qwen21.ps1 -Prompt "..." -Size landscape -Count 2 -Seed 42 -Open
# プロンプトは英語の文章で書く（タグ列より文章のほうが効く。日本語も通るが、英語のほうが安定する）。

param(
    # 省略すると環境変数 GEN_IMAGE_PROMPT から読む（pi のツールはこちら。文章に入る " がコマンドラインの引用で壊れるため）。
    [string]$Prompt = $env:GEN_IMAGE_PROMPT,
    # ネガティブプロンプト。画質の部分。
    [string]$Negative = 'low quality, blurry, jpeg artifacts, deformed, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, text, watermark, signature',
    [ValidateSet('portrait', 'landscape', 'square')]
    [string]$Size = 'portrait',
    [ValidateRange(1, 4)]
    [int]$Count = 1,
    [long]$Seed = -1,
    [ValidateRange(1, 100)]
    [int]$Steps = 25,
    # 1 だとネガティブが効かない（ComfyUI は CFG 1 で負の側を計算しない）。
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

. (Join-Path $PSScriptRoot 'ImageGenConfig.ps1')
$imageConfig = Read-ImageGenConfig $Config
$StrataPort = Get-UrlPort $imageConfig.strata.url

$strataListener = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $StrataPort }
if ($StrataPort -and $strataListener) {
    & (Join-Path $PSScriptRoot 'gen-image-strata.ps1') -Prompt $Prompt -Negative $Negative -Size $Size -Count $Count `
        -Seed $Seed -Steps $Steps -Cfg $Cfg -Sampler $Sampler -Scheduler $Scheduler -OutDir $OutDir -Open:$Open -Watch:$Watch -Config $Config
    exit $LASTEXITCODE
}

# python_embeded は gen-image（SDXL）と共有。ComfyUI のコードは 0.42.4 を別に置いてある（詳しくは gen-image-qwen21-runner.py）。
$Python    = $imageConfig.comfyPython
$QwenRoot  = $imageConfig.qwen.root
$RunnerPy  = Join-Path $PSScriptRoot 'gen-image-qwen21-runner.py'
# HDD から読むとエンコーダの読み込みだけで 46〜53 秒、DiT で約 27 秒かかったので、このPCでは NVMe へ写したものを設定で指している。
$UnetDir   = Split-Path -Parent $imageConfig.qwen.unet
$Unet      = Split-Path -Leaf $imageConfig.qwen.unet
$ClipDir   = Split-Path -Parent $imageConfig.qwen.clip
$Clip      = Split-Path -Leaf $imageConfig.qwen.clip
$VaeDir    = Split-Path -Parent $imageConfig.qwen.vae
$Vae       = Split-Path -Leaf $imageConfig.qwen.vae
$ComfyArgs = '--use-sage-attention'
# 旧 llama-server 経路（止めて描いて戻す）は設定に legacyLlm がある時だけ使う。
$LlamaUrl  = [string]$imageConfig.legacyLlm.url
$StateFile = [string]$imageConfig.legacyLlm.stateFile
$PausePs1  = [string]$imageConfig.legacyLlm.pauseScript
$WorkDir   = Join-Path $env:TEMP 'gen-image-qwen21'
$ServerPy  = Join-Path $PSScriptRoot 'comfyui-qwen21-server.py'
$ComfyPort = if ($imageConfig.qwen.comfyPort) { [int]$imageConfig.qwen.comfyPort } else { 8188 }
$ComfyUrl  = "http://127.0.0.1:$ComfyPort"
# 画面で開くワークフロー。-Watch ではこれに今回の値を入れて PNG へ埋める（画面に落とせば同じものが開く）。
$UiWorkflow = "$QwenRoot\ComfyUI\user\default\workflows\qwen21-t2i.json"
$Timeline  = Join-Path $env:TEMP 'gen-image-qwen21-timeline.log'
# 公式テンプレートの既定は 1MP。縦横比は 2:3 / 3:2 で、32 の倍数。
$Sizes = @{ portrait = @(832, 1248); landscape = @(1248, 832); square = @(1024, 1024) }
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

# 誰か（ブラウザのタブ）がこのポートのサーバへつながっているか。待ち受け側のポートが $Port の接続を探す。
function Test-ClientConnected {
    param([int]$Port)
    return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections() |
        Where-Object { $_.LocalEndPoint.Port -eq $Port -and $_.State -eq 'Established' })
}

function Write-Mark {
    param([string]$Label, [datetime]$At = (Get-Date))
    try { Add-Content -Path $Timeline -Value ("{0:HH:mm:ss.fff}`t{1}" -f $At, $Label) -Encoding ASCII } catch {}
}

function Get-Seconds {
    param([datetime]$Since)
    return ((Get-Date) - $Since).TotalSeconds
}

# -Watch で ComfyUI へ送るつなぎ。生成役と同じ。ノード番号は画面のワークフロー qwen21-t2i と揃える（開いているタブのノードが光る）。
function New-ApiPrompt {
    param([long]$S, [string]$Prefix)
    return [ordered]@{
        '1' = @{ class_type = 'UnetLoaderGGUF'; inputs = @{ unet_name = $Unet } }
        '2' = @{ class_type = 'CLIPLoader'; inputs = @{ clip_name = $Clip; type = 'qwen_image'; device = 'default' } }
        '3' = @{ class_type = 'VAELoader'; inputs = @{ vae_name = $Vae } }
        '4' = @{ class_type = 'TextEncodeQwenImage21'; inputs = @{ clip = @('2', 0); prompt = $job.prompt; negative_prompt = $job.negative; resolution = 1024 } }
        '5' = @{ class_type = 'EmptyLatentImage'; inputs = @{ width = $w; height = $h; batch_size = 1 } }
        '6' = @{ class_type = 'KSampler'; inputs = @{ model = @('1', 0); positive = @('4', 0); negative = @('4', 1); latent_image = @('5', 0)
                 seed = $S; steps = $Steps; cfg = $Cfg; sampler_name = $Sampler; scheduler = $Scheduler; denoise = 1.0 } }
        '7' = @{ class_type = 'VAEDecode'; inputs = @{ samples = @('6', 0); vae = @('3', 0) } }
        '8' = @{ class_type = 'SaveImage'; inputs = @{ images = @('7', 0); filename_prefix = $Prefix } }
    }
}

# 画面用のワークフローに今回の値を入れたもの。画面で編集して保存し、ノードの並びが変わっていたら埋めない。
function New-UiWorkflow {
    param([long]$S, [string]$Prefix)
    try { $wf = Get-Content $UiWorkflow -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
    $byId = @{}
    foreach ($n in $wf.nodes) { $byId["$($n.id)"] = $n }
    $want = @{ '4' = 'TextEncodeQwenImage21'; '5' = 'EmptyLatentImage'; '6' = 'KSampler'; '8' = 'SaveImage' }
    foreach ($k in $want.Keys) {
        if (-not $byId[$k] -or $byId[$k].type -ne $want[$k]) { return $null }
    }
    $byId['4'].widgets_values = @($job.prompt, $job.negative, 1024)
    $byId['5'].widgets_values = @($w, $h, 1)
    $byId['6'].widgets_values = @($S, 'fixed', $Steps, $Cfg, $Sampler, $Scheduler, 1)
    $byId['8'].widgets_values = @($Prefix)
    return $wf
}

# -Watch の本体。立てたサーバへ枚数ぶん送り、順に終わるのを待つ。結果は生成役の result.json と同じ形にする。
function Invoke-WatchGeneration {
    param($Server, [datetime]$Deadline)
    $files = @()
    $err = $null
    $drawSec = 0.0
    while (-not (Test-Listening $ComfyPort) -and -not $Server.HasExited -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Listening $ComfyPort)) {
        return [pscustomobject]@{ ok = $false; files = $files; error = 'ComfyUI が起動しなかった' }
    }
    Write-Mark 'gen.server_ready'
    # 開いたままのタブは、サーバが立つとつなぎ直る。つながる前に送ると実行開始の通知を取りこぼし、タブが途中のプレビューを
    # どのノードのものか結び付けられない（2026-10-23、途中から開いたタブではノードは光ったがプレビューが出なかった）。
    # タブが無ければ（見ていなければ）待ちきってそのまま描く。
    $tabWait = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $tabWait -and -not (Test-ClientConnected $ComfyPort)) { Start-Sleep -Milliseconds 200 }
    Write-Mark $(if (Test-ClientConnected $ComfyPort) { 'gen.tab_connected' } else { 'gen.no_tab' })
    $ids = @()
    for ($i = 0; $i -lt $Count; $i++) {
        $prefix = if ($Count -eq 1) { "$stamp-qwen21" } else { '{0}-qwen21-{1}' -f $stamp, ($i + 1) }
        $extra = @{}
        $ui = New-UiWorkflow $seeds[$i] $prefix
        if ($ui) { $extra.extra_pnginfo = @{ workflow = $ui } }
        $body = @{ prompt = (New-ApiPrompt $seeds[$i] $prefix); client_id = 'llm-watch'; extra_data = $extra } | ConvertTo-Json -Depth 40 -Compress
        try {
            $r = Invoke-RestMethod -Uri "$ComfyUrl/prompt" -Method Post -ContentType 'application/json; charset=utf-8' `
                -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
            $ids += [pscustomobject]@{ id = $r.prompt_id; seed = $seeds[$i] }
        } catch {
            $msg = $_.ErrorDetails.Message
            if (-not $msg) { $msg = $_.Exception.Message }
            return [pscustomobject]@{ ok = $false; files = $files; error = "ComfyUI が受け付けなかった: $msg" }
        }
    }
    foreach ($p in $ids) {
        $entry = $null
        while ((Get-Date) -lt $Deadline -and -not $Server.HasExited) {
            try { $entry = (Invoke-RestMethod "$ComfyUrl/history/$($p.id)" -TimeoutSec 10).($p.id) } catch { $entry = $null }
            if ($entry -and ($entry.status.completed -or $entry.status.status_str -eq 'error')) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not ($entry -and $entry.status.completed)) {
            $why = if ($Server.HasExited) { 'ComfyUI が途中で終わった' } elseif ((Get-Date) -ge $Deadline) { '20 分で終わらなかった' } else { '描画に失敗' }
            $e = @($entry.status.messages | Where-Object { $_[0] -eq 'execution_error' }) | Select-Object -First 1
            if ($e) { $why += ": $($e[1].node_type): $($e[1].exception_message)" }
            return [pscustomobject]@{ ok = $false; files = $files; error = $why }
        }
        $stamps = @{}
        foreach ($m in $entry.status.messages) { $stamps[$m[0]] = $m[1].timestamp }
        if ($stamps['execution_start'] -and $stamps['execution_success']) { $drawSec += ($stamps['execution_success'] - $stamps['execution_start']) / 1000 }
        foreach ($img in $entry.outputs.'8'.images) {
            $files += [pscustomobject]@{ path = (Join-Path (Join-Path $OutDir $img.subfolder) $img.filename); seed = $p.seed }
        }
        Write-Mark ('gen.watch_done_' + $files.Count)
    }
    return [pscustomobject]@{ ok = ($files.Count -eq $Count); files = $files; error = $(if ($files.Count -ne $Count) { '画像が足りない' }); draw = $drawSec }
}

if (-not $Prompt -or -not $Prompt.Trim()) {
    Write-Host 'プロンプトが空。-Prompt か環境変数 GEN_IMAGE_PROMPT で渡して。' -ForegroundColor Red
    exit 2
}
Set-Content -Path $Timeline -Value $null
$env:LLM_TIMELINE = $Timeline
Write-Mark 'gen.process_start' ([Diagnostics.Process]::GetCurrentProcess().StartTime)
$t0 = Get-Date

# gen-image.ps1 と同じ名前の mutex。SDXL と Qwen が同時に LLM を止め戻しするとぶつかる。
$mutex = New-Object Threading.Mutex($false, 'Local\gen-image-llm')
if (-not $mutex.WaitOne(0)) {
    Write-Host '別の画像生成が動いている。終わってから実行して。' -ForegroundColor Red
    exit 1
}
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
    if ($Count -eq 1) { Join-Path $OutDir "$stamp-qwen21.png" } else { Join-Path $OutDir ("{0}-qwen21-{1}.png" -f $stamp, ($_ + 1)) }
})
$w, $h = $Sizes[$Size]

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir | Out-Null }
$go = Join-Path $WorkDir 'go'
$abort = Join-Path $WorkDir 'abort'
$jobFile = Join-Path $WorkDir 'job.json'
$resultFile = Join-Path $WorkDir 'result.json'
$runOut = Join-Path $WorkDir 'runner.out'
$runErr = Join-Path $WorkDir 'runner.err'
Remove-Item $go, $abort, $resultFile, $runOut, $runErr -ErrorAction SilentlyContinue
$job = [ordered]@{
    comfy_dir = "$QwenRoot\ComfyUI"; site_dir = "$QwenRoot\site"; gguf_dir = "$QwenRoot\ComfyUI-GGUF"
    unet_dir = $UnetDir; unet = $Unet; clip_dir = $ClipDir; clip = $Clip; vae_dir = $VaeDir; vae = $Vae
    prompt = $Prompt
    negative = $Negative
    seeds = $seeds; outs = $outs; steps = $Steps; cfg = $Cfg
    sampler = $Sampler; scheduler = $Scheduler; width = $w; height = $h
    go = $go; abort = $abort; result = $resultFile; timeline = $Timeline; comfy_args = $ComfyArgs
}
[IO.File]::WriteAllText($jobFile, ($job | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))

$env:PYTHONUTF8 = '1'
$runner = $null
$server = $null
$srvErr = Join-Path $WorkDir 'server.err'
$llmWasUp = Test-Endpoint "$LlamaUrl/health"
$pauseLog = ''
$nSaved = 0
$ok = $false
$result = $null
$llmBack = $true
try {
    if ($llmWasUp) {
        $tp = Get-Date
        Write-Host '[1/3] LLM を一時停止' -NoNewline
        $pauseLog = & $PausePs1 -Phase pause -NoPrompt *>&1 | Out-String
        if (Test-Endpoint "$LlamaUrl/health") {
            throw "LLM を止められなかったので描かない。`n$pauseLog"
        }
        try { $nSaved = [int](Get-Content $StateFile -Raw | ConvertFrom-Json).n_saved } catch {}
        Write-Host (' … {0:N1} 秒（KV {1:N0} トークンを保存）' -f (Get-Seconds $tp), $nSaved)
    } else {
        Write-Host '[1/3] LLM は動いていない（止めずに描く）'
    }
    # 8.7GB のエンコーダを LLM と同時に読み込むと、ホストのメモリまで競合する。
    if ($Watch) {
        $env:IMAGEGEN_QWEN_ROOT = $QwenRoot
        $server = Start-Process -FilePath $Python -WorkingDirectory "$QwenRoot\ComfyUI" -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $WorkDir 'server.out') -RedirectStandardError $srvErr -ArgumentList @(
            '-s', '-u', '-X', 'utf8', '-X', 'faulthandler', "`"$ServerPy`"", '--listen', '127.0.0.1', '--port', "$ComfyPort", '--use-sage-attention', '--preview-method', 'auto',
            '--output-directory', "`"$OutDir`"")
        Write-Mark 'gen.server_start'
    } else {
        $runner = Start-Process -FilePath $Python -ArgumentList @('-s', '-u', '-X', 'utf8', '-X', 'faulthandler', "`"$RunnerPy`"", "`"$jobFile`"") `
            -WorkingDirectory $QwenRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $runOut -RedirectStandardError $runErr
        Write-Mark 'gen.runner_cold'
    }
    Set-Content $go 'x'
    Write-Mark 'gen.go'

    $tg = Get-Date
    $deadline = (Get-Date).AddSeconds(1200)
    if ($Watch) {
        Write-Host ('[2/3] 描画（Qwen-Image 2.1、ComfyUI で見ながら。{0} 枚、{1}x{2}、{3} steps。{4} を開いておくと見える）' -f $Count, $w, $h, $Steps, $ComfyUrl) -NoNewline
        $result = Invoke-WatchGeneration $server $deadline
        # VRAM を返すため、描き終わったらすぐ落とす（開いているタブは「再接続中」になるだけで、出た絵は残る）。
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
        $null = $server.WaitForExit(15000)
        Write-Mark 'gen.server_stopped'
        $ok = [bool]$result.ok
        if ($ok) {
            Write-Host (' … {0:N1} 秒（うち ComfyUI の中で描いていた時間 {1:N1} 秒）' -f (Get-Seconds $tg), $result.draw)
        } else {
            Write-Host " … 失敗: $($result.error)" -ForegroundColor Red
            if (Test-Path $srvErr) { Get-Content $srvErr -Tail 12 | ForEach-Object { Write-Host "    $_" } }
        }
    } else {
        Write-Host ('[2/3] 描画（Qwen-Image 2.1、{0} 枚、{1}x{2}、{3} steps）' -f $Count, $w, $h, $Steps) -NoNewline
        while (-not (Test-Path $resultFile) -and -not $runner.HasExited -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        $finished = (Test-Path $resultFile) -or $runner.HasExited
        if (-not $finished) {
            $runner.Kill()
            $null = $runner.WaitForExit(10000)
        }
        $result = $null
        try { $result = (Get-Content $resultFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch {}
        if (-not ($result -and $result.gpu_released)) { $null = $runner.WaitForExit(30000) }
        Write-Mark 'gen.runner_done'
        $ok = [bool]($result -and $result.ok)
        if ($ok) {
            $tm = $result.timings
            Write-Host (' … {0:N1} 秒（読み込み {1:N1}、エンコード {2:N1}、サンプリング {3} 秒）' -f (Get-Seconds $tg),
                ($tm.load_unet + $tm.load_te + $tm.load_vae), $tm.encode, (($tm.sample | ForEach-Object { '{0:N1}' -f $_ }) -join ' / '))
        } else {
            $why = if (-not $finished) { '20 分で終わらなかった' } elseif ($result) { $result.error } else {
                $runner.Refresh()
                'Python が結果を残さず終了（exit 0x{0:X8}）。ログ: {1}' -f ([long]$runner.ExitCode -band 0xffffffffL), $runErr
            }
            Write-Host " … 失敗: $why" -ForegroundColor Red
            if (Test-Path $runErr) { Get-Content $runErr -Tail 12 | ForEach-Object { Write-Host "    $_" } }
        }
    }
} catch {
    $ok = $false
    Write-Host " … 失敗: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    # 結果待ちや JSON の読み取りが例外になっても、生成役を残したまま LLM を起動しない。
    $generationStopped = $true
    foreach ($child in @($runner, $server)) {
        if ($null -eq $child) { continue }
        try {
            if (-not $child.HasExited) {
                Stop-Process -Id $child.Id -Force -ErrorAction Stop
                if (-not $child.WaitForExit(15000)) { $generationStopped = $false }
            }
        } catch {
            $generationStopped = $false
            Write-Host "生成役を終了できなかった: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    if (-not $generationStopped) {
        $llmBack = $false
        Write-Host '生成役が残っているので LLM の二重起動を避ける。KV は保存済み。' -ForegroundColor Red
    } else {
        if ($llmWasUp -and (Test-Path $StateFile)) {
            $tr = Get-Date
            Write-Host '[3/3] LLM を再開' -NoNewline
            $resumeLog = ''
            try { $resumeLog = & $PausePs1 -Phase resume -NoPrompt *>&1 | Out-String }
            catch { $resumeLog += $_.Exception.Message }
            $llmBack = (Test-Endpoint "$LlamaUrl/health") -and -not (Test-Path $StateFile)
            if ($llmBack) {
                $nBack = if ($resumeLog -match '([\d,]+) トークン /') { $Matches[1] } else { '0' }
                Write-Host (' … {0:N1} 秒（KV {1} トークンを復元）' -f (Get-Seconds $tr), $nBack)
            } else {
                Write-Host ' … 失敗。pause-llm.bat resume で戻せる（KV は残してある）' -ForegroundColor Red
                Write-Host (($resumeLog -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15) -join "`n")
            }
        }
    }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
Write-Mark 'gen.end'

if ($ok) {
    foreach ($f in $result.files) { Write-Host ('画像: {0}（seed {1}）' -f $f.path, $f.seed) -ForegroundColor Green }
    Write-Host ('全体 {0:N0} 秒' -f (Get-Seconds $t0))
    if ($Open) { foreach ($f in $result.files) { Invoke-Item $f.path } }
}
if (-not ($ok -and $llmBack)) { exit 1 }
