# 온라인 세션 시작: 서버 + Cloudflare 터널을 함께 띄우고 공개 주소를 알려준다.
#
#   실행:  start-session.bat 을 더블클릭  (또는 PowerShell에서 .\start-session.ps1)
#   종료:  이 창에서 Ctrl+C
#
# 창을 X로 닫아도 괜찮다 — 다음에 실행할 때 남은 프로세스를 알아서 정리한다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3000

$logDir = Join-Path $env:TEMP 'podam'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serverOut = Join-Path $logDir 'server.out.log'
$serverErr = Join-Path $logDir 'server.err.log'
$tunnelLog = Join-Path $logDir 'tunnel.log'

$server = $null
$tunnel = $null
$failed = $false

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Fail($msg, $hint) {
    Write-Host ""
    Write-Host "  X  $msg" -ForegroundColor Red
    if ($hint) { Write-Host "     $hint" -ForegroundColor Yellow }
    Write-Host ""
    throw $msg
}

# 이 폴더의 서버로 돌고 있는 node 프로세스만 골라낸다.
# (Claude Code 등 다른 node를 건드리면 안 되므로 명령줄을 반드시 확인한다)
function Get-OurServers {
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -match 'src[\\/]server\.js' -and
                $_.CommandLine -notmatch 'e2e'
            }
    } catch { @() }
}

# 우리 포트로 향하던 cloudflared만 골라낸다.
function Get-OurTunnels {
    try {
        Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match "localhost:$port" }
    } catch { @() }
}

function Stop-Leftovers {
    $stopped = 0
    foreach ($p in @(Get-OurServers) + @(Get-OurTunnels)) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { }
    }
    if ($stopped -gt 0) {
        Say "  지난 실행에서 남은 프로세스 $stopped 개를 정리했습니다." 'DarkYellow'
        Start-Sleep -Seconds 2
    }
}

try {
    # winget으로 막 설치한 경우 현재 세션의 PATH에 아직 없을 수 있다.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')

    # ── 준비 확인 ────────────────────────────────────────────────────────────
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail "node가 설치되어 있지 않습니다." "https://nodejs.org 에서 LTS를 설치하세요."
    }
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Fail "cloudflared가 없습니다." "winget install --id Cloudflare.cloudflared"
    }
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Fail "의존성이 설치되지 않았습니다." "이 폴더에서 npm install 을 먼저 실행하세요."
    }

    # ── 남은 프로세스 정리 ───────────────────────────────────────────────────
    # 창을 X로 닫으면 서버와 터널이 살아남아 다음 실행을 막는다. 물어보지 않고
    # 우리 것만 정리한다 (다른 프로그램의 node는 건드리지 않는다).
    Stop-Leftovers

    # 그래도 포트를 쓰는 게 있으면 남의 프로그램이므로 손대지 않고 알려준다.
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($busy) {
        $pids = @($busy | Select-Object -ExpandProperty OwningProcess -Unique)
        $names = ($pids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }) -join ', '
        Fail "$port 포트를 다른 프로그램이 쓰고 있습니다 (PID $($pids -join ', ') / $names)." `
             "그 프로그램을 끄거나, 이 창에서 `$env:PORT=3100 을 설정하고 다시 실행하세요."
    }

    # ── 서버 ─────────────────────────────────────────────────────────────────
    Say "`n서버를 켜는 중..." 'Cyan'
    Remove-Item $serverOut, $serverErr -Force -ErrorAction SilentlyContinue
    $server = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' `
        -WorkingDirectory $root -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $ready = $false
    foreach ($i in 1..60) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { break }
        try {
            Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $ready = $true; break
        } catch { }
    }
    if (-not $ready) {
        $err = if (Test-Path $serverErr) { (Get-Content $serverErr -Raw).Trim() } else { '' }
        if ($err) { Write-Host "`n서버가 남긴 오류:`n$err" -ForegroundColor Red }
        Fail "서버가 $port 포트에서 응답하지 않습니다." "로그: $serverErr"
    }
    Say "서버 준비됨 (localhost:$port)" 'Green'

    # ── 터널 ─────────────────────────────────────────────────────────────────
    # trycloudflare는 무료 회선이라 가끔 주소를 못 받는다. 두 번까지 다시 해본다.
    $url = $null
    $localDnsOk = $true
    foreach ($attempt in 1..2) {
        Say ("터널을 여는 중..." + $(if ($attempt -gt 1) { " (다시 시도 $attempt/2)" } else { "" })) 'Cyan'
        Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue
        $tunnel = Start-Process -FilePath 'cloudflared' `
            -ArgumentList 'tunnel', '--url', "http://localhost:$port", '--logfile', $tunnelLog `
            -PassThru -WindowStyle Hidden

        $candidate = $null
        foreach ($i in 1..70) {
            Start-Sleep -Milliseconds 500
            if ($tunnel.HasExited) { break }
            if (Test-Path $tunnelLog) {
                $hit = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' `
                        -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($hit) { $candidate = $hit.Matches[0].Value; break }
            }
        }

        if ($candidate) {
            $tunnelHost = ([Uri]$candidate).Host
            Say "  주소를 받았습니다. 실제로 열리는지 확인하는 중..."

            # 주소가 인터넷에 퍼졌는지는 공개 DNS로 확인한다.
            # 이 PC의 DNS(통신사)가 새 주소를 못 찾는 경우가 있는데,
            # 그건 터널 문제가 아니라 이 PC만의 문제라서 따로 구분해야 한다.
            $publicOk = $false
            foreach ($i in 1..30) {
                try {
                    $null = Resolve-DnsName $tunnelHost -Type A -Server 1.1.1.1 -ErrorAction Stop
                    $publicOk = $true; break
                } catch { }
                Start-Sleep -Milliseconds 1000
            }

            if ($publicOk) {
                $url = $candidate
                # 이제 이 PC에서도 열리는지 본다.
                $localDnsOk = $false
                foreach ($i in 1..12) {
                    try {
                        $null = Resolve-DnsName $tunnelHost -Type A -ErrorAction Stop
                        $localDnsOk = $true; break
                    } catch { }
                    Start-Sleep -Milliseconds 1000
                }
                break
            }
            Say "  주소가 아직 인터넷에 퍼지지 않았습니다." 'DarkYellow'
        }

        if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
        if (-not $url) { Say "  다시 열어보겠습니다." 'DarkYellow' }
    }
    if (-not $url) {
        Fail "터널 주소를 받지 못했습니다." "인터넷 연결을 확인하고 잠시 뒤 다시 실행하세요. 로그: $tunnelLog"
    }

    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "  세션 주소" -ForegroundColor Green
    Write-Host ""
    Write-Host "    $url" -ForegroundColor White
    Write-Host ""
    Write-Host "  이 주소로 접속해서 방을 만드세요." -ForegroundColor Gray
    Write-Host "  localhost로 만들면 플레이어 링크가 안 열립니다." -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host ""

    if (-not $localDnsOk) {
        Write-Host ""
        Write-Host "  !! 이 PC의 DNS가 위 주소를 찾지 못합니다." -ForegroundColor Red
        Write-Host "     터널은 정상입니다. 다른 사람은 접속되지만 이 PC에서만 안 열립니다." -ForegroundColor Yellow
        Write-Host "     (브라우저의 '보안 DNS' 기능이 켜져 있으면 그래도 열릴 수 있습니다)" -ForegroundColor Gray
        Write-Host ""
        Write-Host "     고치려면 관리자 PowerShell에서:" -ForegroundColor Yellow
        Write-Host "       netsh interface ip set dns name=\"이더넷\" static 1.1.1.1 primary" -ForegroundColor White
        Write-Host "       netsh interface ip add dns name=\"이더넷\" 8.8.8.8 index=2" -ForegroundColor White
        Write-Host "     되돌리기: netsh interface ip set dns name=\"이더넷\" dhcp" -ForegroundColor Gray
        Write-Host ""
    }

    try { Set-Clipboard -Value $url; Say "주소를 클립보드에 복사했습니다." } catch { }
    Start-Process $url

    Say "`n세션 진행 중... 끝나면 이 창에서 Ctrl+C 를 누르세요.`n" 'Cyan'
    while ($true) {
        Start-Sleep -Seconds 5
        if ($server.HasExited) {
            $err = if (Test-Path $serverErr) { (Get-Content $serverErr -Raw).Trim() } else { '' }
            if ($err) { Write-Host "`n서버가 남긴 오류:`n$err" -ForegroundColor Red }
            Fail "서버가 종료되었습니다." "다시 실행하세요."
        }
        if ($tunnel.HasExited) { Fail "터널이 끊어졌습니다." "다시 실행하면 새 주소가 나옵니다." }
    }
}
catch {
    $failed = $true
    if ($Host.Name -eq 'ConsoleHost') {
        Write-Host "아무 키나 누르면 창이 닫힙니다." -ForegroundColor Gray
        try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 15 }
    }
}
finally {
    Write-Host "`n정리하는 중..." -ForegroundColor Cyan
    foreach ($p in @($tunnel, $server)) {
        if ($p) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
    }
    Stop-Leftovers
    # 실패했을 때는 원인을 볼 수 있게 로그를 남겨둔다.
    if (-not $failed) {
        Remove-Item $serverOut, $serverErr, $tunnelLog -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "로그는 여기에 남겨두었습니다: $logDir" -ForegroundColor Gray
    }
    Write-Host "종료되었습니다. 대화 기록은 data\ 폴더에 그대로 남아 있습니다.`n" -ForegroundColor Gray
}
