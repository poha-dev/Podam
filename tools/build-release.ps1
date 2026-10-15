# 포담 배포판 만들기 (윈도우 x64)
#
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1 -Version 1.0.0 -ModulesFrom ..\podam-modules\modules
#
# 하는 일: 의존성 정리 → better-sqlite3 군살 빼기 → Node 동봉 → 공식 모듈 담기 → zip.
# GitHub Actions 도 이 스크립트를 부른다 — 손으로 만든 것과 올라가는 것이 같아야 하기 때문이다.

param(
  [string]$Version = '0.1.0',
  [string]$ModulesFrom = '',          # 공식 모듈이 있는 폴더 (modules/verdict ... 가 들어 있는 곳)
  [string]$NodeVersion = ''           # 비워 두면 지금 돌고 있는 Node 와 같은 판
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $NodeVersion) { $NodeVersion = "v$(node -p 'process.versions.node')" }
$name = "포담-$Version-win-x64"
$out  = Join-Path $root "dist\$name"
$work = Join-Path $root 'dist'

Write-Host "포담 $Version · Node $NodeVersion" -ForegroundColor Cyan

# ── 자리 치우기 ──────────────────────────────────────────────────────────────
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force "$out\app" | Out-Null

# ── 프로그램 ─────────────────────────────────────────────────────────────────
Write-Host '  프로그램 담는 중…'
Copy-Item -Recurse src,public,tools,package.json "$out\app\"
Remove-Item -Recurse -Force "$out\app\tools\build-release.ps1" -ErrorAction SilentlyContinue
Copy-Item -Recurse node_modules "$out\app\node_modules"

# better-sqlite3 는 sqlite 원본과 빌드 찌꺼기가 10MB 넘게 따라온다.
# 정작 쓰는 것은 build\Release\better_sqlite3.node 와 lib\ 뿐이다.
$b = "$out\app\node_modules\better-sqlite3"
foreach ($junk in 'deps', 'src', 'build\Release\obj', 'build\deps', 'prebuilds') {
  Remove-Item -Recurse -Force "$b\$junk" -ErrorAction SilentlyContinue
}
Get-ChildItem "$b\build" -Recurse -Include *.pdb,*.lib,*.exp,*.iobj,*.ipdb,*.vcxproj*,*.tlog `
  -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
if (-not (Test-Path "$b\build\Release\better_sqlite3.node")) {
  throw 'better_sqlite3.node 가 없습니다 — npm ci 를 먼저 하세요'
}

# ── 모듈 ────────────────────────────────────────────────────────────────────
# `modules` 는 **비워 둔다** — 받자마자 모든 기능이 켜져 있는 것을 원하지 않는 사람도 있다.
# 공식 모듈은 옆에 따로 두고, 쓸 것만 끌어다 넣게 한다.
New-Item -ItemType Directory -Force "$out\modules" | Out-Null
$guide = @"
여기에 모듈 폴더를 넣고 포담을 다시 켜면 그 기능이 붙습니다.

- 옆의 「모듈 모음」 폴더에 공식 모듈이 들어 있습니다. 쓸 것만 이리로 옮기세요.
- 잠깐 끄고 싶으면 폴더 이름 앞에 _ 를 붙이세요 (기록은 남습니다).
- 새 모듈은 받아서 여기에 풀면 됩니다.
"@
Set-Content "$out\modules\여기에 넣으세요.txt" -Value $guide -Encoding utf8

if ($ModulesFrom -and (Test-Path $ModulesFrom)) {
  Write-Host '  공식 모듈 담는 중…'
  New-Item -ItemType Directory -Force "$out\모듈 모음" | Out-Null
  Get-ChildItem $ModulesFrom -Directory | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object {
    Copy-Item -Recurse $_.FullName "$out\모듈 모음\"
  }
}

# ── Node 동봉 ────────────────────────────────────────────────────────────────
Write-Host '  Node 가져오는 중…'
$zip = Join-Path $work 'node.zip'
Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath "$work\node"
New-Item -ItemType Directory -Force "$out\runtime" | Out-Null
Copy-Item "$work\node\node-$NodeVersion-win-x64\node.exe" "$out\runtime\"
Remove-Item -Recurse -Force "$work\node", $zip

# ── 바깥에 두는 것 ───────────────────────────────────────────────────────────
Copy-Item '포담 시작.cmd',LICENSE,README.md "$out\"
Copy-Item '읽어주세요.txt' "$out\" -ErrorAction SilentlyContinue

# ── 꾸리기 ───────────────────────────────────────────────────────────────────
Write-Host '  압축하는 중…'
Compress-Archive "$out" "$work\$name.zip" -Force
$mb = [math]::Round((Get-Item "$work\$name.zip").Length / 1MB, 1)
Write-Host ""
Write-Host "  됐습니다 — dist\$name.zip  ($mb MB)" -ForegroundColor Green
