# 会話の中の画像（WezTerm + Herdr + pi + このパッケージの pi/image-pane.ts）が、更新の後も動くかを裏で確かめる。
#
#   check-inline-image.bat            画像を描く・1 回クリックで拡大・もう 1 回で戻る・ダブルクリックで畳む・
#                                     畳んだ行のクリックで開く・alt+i で全部畳む／開く、を順に試す（LLM は使わない）
#   check-inline-image.bat -WithLLM   加えて、LLM に画像を read させ、ツールの結果の画像も会話に描けるかを見る（LLM を 30 秒ほど使う）
#
# Herdr に使い捨てのワークスペースを裏で作り（フォーカスは移さない）、その中で pi を開いて試す。終わったら閉じる。
# 画面を見る代わりに、image-pane.ts が環境変数 IMAGE_PANE_DEBUG_LOG のファイルへ書く「画像ごとの状態と行数」で判定する。
# クリックは Herdr 経由でペインへ SGR のマウス入力を送る（WezTerm の上の実際のマウスとは経路が少し違う）。
#
# -LlmHealthUrl を渡すと、-WithLLM の前にそのURLでLLMの起動を確かめ、止まっていれば SKIP にする。
param([switch]$WithLLM, [string]$LlmHealthUrl = $env:IMGPANE_CHECK_LLM_HEALTH)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source
if (-not $herdr) { $herdr = "$env:LOCALAPPDATA\Programs\Herdr\bin\herdr.exe" }
# バージョン表示にだけ使う。nightly版はPATHに入らないことがあるので、既定の置き場も見る。
$wezterm = (Get-Command wezterm -ErrorAction SilentlyContinue).Source
if (-not $wezterm) { $wezterm = "$env:LOCALAPPDATA\Programs\WezTerm-nightly\app\wezterm.exe" }
$piSettings = "$env:USERPROFILE\.pi\agent\settings.json"
$work = Join-Path $env:TEMP "check-inline-image-$PID"
$log = Join-Path $work 'image-pane.log'
$png = Join-Path $work 'check-landscape.png'
$esc = [char]27
$results = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[string]

function Add-Result([string]$name, [bool]$ok, [string]$detail) {
    $results.Add([pscustomobject]@{ Name = $name; OK = $ok; Detail = $detail })
    '{0}  {1}  {2}' -f $(if ($ok) { 'OK' } else { 'NG' }), $name, $detail
}

function Invoke-Herdr {
    $out = & $herdr @args 2>&1 | Out-String
    try { return $out | ConvertFrom-Json } catch { return [pscustomobject]@{ raw = $out } }
}

function Read-Pane([string]$pane) { & $herdr pane read $pane 2>&1 }

# 画像の状態の最後の記録（mode と lines）。image-pane.ts が状態の変わるたびに 1 行書く
function Get-View {
    if (-not (Test-Path -LiteralPath $log)) { return $null }
    $line = Get-Content -LiteralPath $log -Encoding UTF8 | Where-Object { $_ -match ' view check-landscape\.png ' } | Select-Object -Last 1
    if ($line -match 'mode=(\S+) lines=(\d+)') { return [pscustomobject]@{ Mode = $Matches[1]; Lines = [int]$Matches[2] } }
    return $null
}

# 条件を満たす状態になるまで待つ（最長 $ms ミリ秒）。満たさなければ最後の状態を返す
function Wait-View([scriptblock]$cond, [int]$ms = 3000) {
    $deadline = (Get-Date).AddMilliseconds($ms)
    do {
        $v = Get-View
        if ($v -and (& $cond $v)) { return $v }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    return Get-View
}

function Format-View($v) { if ($v) { "mode=$($v.Mode) lines=$($v.Lines)" } else { '記録なし' } }

function Click([string]$pane, [int]$row) {
    & $herdr pane send-text $pane "$esc[<0;10;${row}M$esc[<0;10;${row}m" 2>&1 | Out-Null
}

# --- 版と設定 ---
''
'== 版と設定'
"pi:      $((& pi --version 2>&1 | Out-String).Trim())"
"Herdr:   $((& $herdr --version 2>&1 | Out-String).Trim())"
"WezTerm: $(if (Test-Path -LiteralPath $wezterm) { (& $wezterm --version 2>&1 | Out-String).Trim() } else { '(app が無い)' })"
try {
    $s = Get-Content -LiteralPath $piSettings -Raw -Encoding UTF8 | ConvertFrom-Json
    $show = if ($null -ne $s.terminal -and $null -ne $s.terminal.showImages) { $s.terminal.showImages } else { '(既定 true)' }
    "pi 設定: tuiMode=$($s.tuiMode)  terminal.showImages=$show"
} catch { "pi 設定を読めない: $_" }

''
'== 試験'
$status = & $herdr status server 2>&1 | Out-String
if ($status -notmatch 'status: running') {
    Add-Result 'Herdr のサーバ' $false 'Herdr が動いていない。open-wezterm-herdr.cmd で開いてから実行する' | Out-Host
    exit 1
}

New-Item -ItemType Directory -Force $work | Out-Null
# 試験用の横長の画像（1248x832）
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1248, 832
$g = [System.Drawing.Graphics]::FromImage($bmp)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Rectangle 0, 0, 1248, 832), [System.Drawing.Color]::SteelBlue, [System.Drawing.Color]::Orange, 30)
$g.FillRectangle($brush, 0, 0, 1248, 832)
$g.DrawString('inline image check', (New-Object System.Drawing.Font 'Segoe UI', 64), [System.Drawing.Brushes]::White, 120, 340)
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $brush.Dispose()

$agent = "inline-check-$PID"
$ws = Invoke-Herdr workspace create --cwd $work --label inline-image-check --env "IMAGE_PANE_DEBUG_LOG=$log" --no-focus
$wsId = $ws.result.workspace.workspace_id
if (-not $wsId) { $wsId = ((Invoke-Herdr workspace list).result.workspaces | Where-Object { $_.label -eq 'inline-image-check' } | Select-Object -Last 1).workspace_id }
$pane = ((Invoke-Herdr pane list).result.panes | Where-Object { $_.workspace_id -eq $wsId } | Select-Object -First 1).pane_id
try {
    if (-not $pane) { throw "試験用のワークスペースを作れなかった: $($ws | ConvertTo-Json -Compress)" }
    Start-Sleep -Seconds 2
    $started = Invoke-Herdr agent start $agent --kind pi --pane $pane --timeout 90000
    $ok = $started.result.type -eq 'agent_started'
    Add-Result 'pi の起動' $ok $(if ($ok) { "Herdr の裏のワークスペース（$wsId）で起動" } else { ($started | ConvertTo-Json -Compress -Depth 5) }) | Out-Host
    if (-not $ok) { throw 'pi が起動しない' }

    $text = Read-Pane $pane
    $loaded = [bool]($text | Select-String 'image-pane\.ts')
    $extErr = $text | Select-String -Pattern 'image-pane' | Where-Object { $_.Line -match '(?i)error|failed|失敗' }
    Add-Result '拡張の読み込み' ($loaded -and -not $extErr) $(if ($extErr) { $extErr[0].Line.Trim() } elseif ($loaded) { '読み込み一覧に image-pane.ts がある' } else { '読み込み一覧に image-pane.ts が無い' }) | Out-Host

    # 1. 画像を描く
    Invoke-Herdr agent prompt $agent "/imgshow $png" | Out-Null
    $v = Wait-View { param($x) $x.Mode -eq 'normal' } 5000
    $normalLines = if ($v) { $v.Lines } else { 0 }
    if ($v -and $v.Lines -eq 1) {
        Add-Result '画像を描く' $false 'ファイル名の 1 行になった（pi がこの端末を画像対応と判定していない。Herdr の kitty_graphics や pi の端末判定を確かめる）' | Out-Host
        throw '画像が描けない'
    }
    Add-Result '画像を描く' ($normalLines -ge 5) (Format-View $v) | Out-Host

    # クリックする行: 入力欄の上の罫線から上へたどり、画像（空行の並び）の上端から 3 行下
    $text = Read-Pane $pane
    $borders = @($text | Select-String '^─{20,}' | ForEach-Object { $_.LineNumber })
    $editorTop = $borders[-2]
    $row = $editorTop - 1
    while ($row -gt 1 -and -not $text[$row - 1].Trim()) { $row-- }
    $clickRow = $row + 4

    # 2. 1 回クリックで拡大
    Click $pane $clickRow
    $v = Wait-View { param($x) $x.Mode -eq 'large' } 2000
    Add-Result '1 回クリックで拡大' ($v -and $v.Mode -eq 'large' -and $v.Lines -gt $normalLines) "$(Format-View $v)（普通は $normalLines 行）" | Out-Host
    $largeLines = if ($v) { $v.Lines } else { 0 }

    # 3. もう 1 回で元の大きさ（縮めた直後 0.5 秒は空行で高さを保つので、その後の行数で見る）
    Start-Sleep -Milliseconds 700
    Click $pane $clickRow
    $v = Wait-View { param($x) $x.Mode -eq 'normal' -and $x.Lines -eq $normalLines } 3000
    Add-Result 'もう 1 回で元の大きさ' ($v -and $v.Mode -eq 'normal' -and $v.Lines -eq $normalLines) (Format-View $v) | Out-Host

    # 4. ダブルクリックで畳む（間 0.12 秒と 0.3 秒、普通の大きさからと拡大中から）
    $cases = @(
        @{ From = 'normal'; Gap = 120 }, @{ From = 'normal'; Gap = 300 },
        @{ From = 'large'; Gap = 120 }, @{ From = 'large'; Gap = 300 }
    )
    foreach ($c in $cases) {
        Start-Sleep -Milliseconds 700
        if ($c.From -eq 'large') {
            Click $pane $clickRow
            Wait-View { param($x) $x.Mode -eq 'large' } 2000 | Out-Null
            Start-Sleep -Milliseconds 700
        }
        Click $pane $clickRow; Start-Sleep -Milliseconds $c.Gap; Click $pane $clickRow
        $v = Wait-View { param($x) $x.Mode -eq 'folded' } 2000
        $folded = [bool]((Read-Pane $pane) | Select-String '▸ 画像')
        Add-Result "ダブルクリックで畳む（$($c.From) から、間 $($c.Gap) ms）" ($v -and $v.Mode -eq 'folded' -and $folded) (Format-View $v) | Out-Host

        # 5. 畳んだ行のクリックで開く
        $fold = (Read-Pane $pane) | Select-String '▸ 画像' | Select-Object -First 1
        if ($fold) { Click $pane $fold.LineNumber }
        $v = Wait-View { param($x) $x.Mode -eq 'normal' -and $x.Lines -eq $normalLines } 3000
        if (-not ($v -and $v.Mode -eq 'normal')) {
            Add-Result '畳んだ行のクリックで開く' $false (Format-View $v) | Out-Host
        }
    }
    Add-Result '畳んだ行のクリックで開く' ($v -and $v.Mode -eq 'normal' -and $v.Lines -eq $normalLines) (Format-View $v) | Out-Host

    # 6. alt+i で全部畳む・開く
    & $herdr pane send-keys $pane alt+i 2>&1 | Out-Null
    $v = Wait-View { param($x) $x.Mode -eq 'folded' } 2000
    $status = [bool]((Read-Pane $pane) | Select-String '畳み中')
    Add-Result 'alt+i で全部畳む' ($v -and $v.Mode -eq 'folded' -and $status) "$(Format-View $v)$(if (-not $status) { '（下の欄に「畳み中」が出ない）' })" | Out-Host
    & $herdr pane send-keys $pane alt+i 2>&1 | Out-Null
    $v = Wait-View { param($x) $x.Mode -eq 'normal' } 2000
    Add-Result 'alt+i で全部開く' ($v -and $v.Mode -eq 'normal') (Format-View $v) | Out-Host

    # 7. （-WithLLM）ツールの結果の画像を会話に描く。LLM が止まっている時は試せないので、NG ではなく SKIP にする
    $llmUp = [bool]$WithLLM
    if ($WithLLM -and $LlmHealthUrl) {
        try { $llmUp = (Invoke-WebRequest $LlmHealthUrl -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { $llmUp = $false }
        if (-not $llmUp) {
            $skipped.Add('read の画像を会話に描く')
            "SKIP  read の画像を会話に描く  LLM（$LlmHealthUrl）が止まっている。起動してから -WithLLM を付けて流し直す"
        }
    }
    if ($WithLLM -and $llmUp) {
        $before = @(Get-Content -LiteralPath $log -Encoding UTF8 | Where-Object { $_ -match ' entry ' }).Count
        Invoke-Herdr agent prompt $agent "read ツールで $png を読んで、何が写っているか一言だけ答えて。" | Out-Null
        Start-Sleep -Seconds 3
        Invoke-Herdr agent wait $agent --until idle --timeout 300000 | Out-Null
        $after = @(Get-Content -LiteralPath $log -Encoding UTF8 | Where-Object { $_ -match ' entry ' })
        $drawn = $after.Count -gt $before
        # 返事 = 入力欄の上の罫線より上にある、最後の 2 行
        $text = Read-Pane $pane
        $borders = @($text | Select-String '^─{20,}' | ForEach-Object { $_.LineNumber })
        $answer = (@($text[0..($borders[-2] - 2)] | Where-Object { $_.Trim() }) | Select-Object -Last 2 | ForEach-Object { $_.Trim() }) -join ' / '
        if ($answer -match 'Connection error') {
            $skipped.Add('read の画像を会話に描く')
            "SKIP  read の画像を会話に描く  LLM につながらなかった（$answer）"
        } else {
            Add-Result 'read の画像を会話に描く' $drawn $(if ($drawn) { 'image-pane.ts が描いた' } else { '描かれていない（terminal.showImages が true なら本体が描くので正常。false なら NG）' }) | Out-Host
            "    LLM の返事: $answer"
        }
    }
} catch {
    Add-Result '試験の途中で止まった' $false "$_" | Out-Host
} finally {
    if ($pane) {
        & $herdr pane send-keys $pane ctrl+d 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }
    if ($wsId) { & $herdr workspace close $wsId 2>&1 | Out-Null }
}

''
$ng = @($results | Where-Object { -not $_.OK })
if ($ng.Count -eq 0) {
    "すべて OK（$($results.Count) 項目$(if ($skipped.Count) { "。試せなかった項目: $($skipped -join '、')" })）"
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}
"NG が $($ng.Count) 項目。記録は $log に残した"
'ヒント:'
'  - 拡張の読み込みが NG     pi の拡張の仕組みが変わった。今は画像が全部出ない状態なので、~/.pi/agent/settings.json の'
'                            terminal.showImages を true に戻すと pi 本体の表示に戻る（畳めはしない）'
'  - 画像を描くが NG         pi が Herdr の中を画像対応と判定していないか、Herdr の [terminal] kitty_graphics が切れている'
'  - ダブルクリックだけ NG   pi のダブルクリックの間隔（500 ms）や文字選択の作りが変わった。image-pane.ts の数値を合わせる'
exit 1
