# imagegen の設定を読む。場所は -Config 引数 > 環境変数 IMAGEGEN_CONFIG > %LOCALAPPDATA%\imagegen\config.json。
# このPC固有の値（フォルダ・モデル・ポート）はすべて設定から受け取り、スクリプトには書かない。

function Read-ImageGenConfig {
    param([string]$Path)
    if (-not $Path) { $Path = $env:IMAGEGEN_CONFIG }
    if (-not $Path) { $Path = Join-Path $env:LOCALAPPDATA 'imagegen\config.json' }
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "imagegen の設定ファイルが無い: $Path（config.example.json を写して直す）"
    }
    $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.outputDir) {
        $config | Add-Member -NotePropertyName outputDir -NotePropertyValue (Join-Path ([Environment]::GetFolderPath('MyPictures')) 'imagegen') -Force
    }
    return $config
}

# 設定に無いサービスは 0 を返す。待ち受けポート 0 は存在しないので「動いていない」扱いになる。
function Get-UrlPort {
    param([string]$Url)
    if (-not $Url) { return 0 }
    return ([uri]$Url).Port
}
