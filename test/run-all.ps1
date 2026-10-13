# 一次跑完所有测试：先测仓库源码，再测 profile 里**已安装**的那份。
#
# 为什么要测两份：修复点只有真的进了 profile 的 node_modules 才算修好。
#
# 顺带一条实测结论（改已安装副本时有用）：这个 profile 用 `nodeLinker: hoisted`，
# git 依赖的**文件**是硬链接到 pnpm store 的 —— 未改过的 browser-use 用
# `fsutil hardlink list` 能看到 2 个链接（profile 路径 + store 路径）。
# 所以**直接 Copy-Item 覆盖会写穿到 store**，污染其他 profile。
# 正确做法：先 Copy 到临时文件 → Remove 原文件（断开链接）→ Move 回来。
# 改完之后 `fsutil hardlink list` 只剩 1 个链接，且 store 里仍是旧内容。
#
# 跑法：pwsh -File test/run-all.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$harness = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$installed = 'C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-persona-memory'

if (-not (Test-Path $harness)) { throw "找不到 Harness：$harness" }

# 在 Electron 的 node 下跑一个 .mjs，并把结果写进临时文件再回读。
# （Electron 以 ELECTRON_RUN_AS_NODE 运行时 stdout 会被吞掉，所以不能靠管道取结果。）
function Invoke-Mjs {
    param([string]$Script, [string]$Entry)

    $result = Join-Path $env:TEMP ("pm-test-" + [guid]::NewGuid().ToString('N') + '.txt')
    $env:ELECTRON_RUN_AS_NODE = '1'
    if ($Entry) { $env:PERSONA_MEMORY_ENTRY = $Entry } else { Remove-Item Env:PERSONA_MEMORY_ENTRY -ErrorAction SilentlyContinue }

    $scriptUrl = 'file:///' + ($Script -replace '\\', '/')
    $js = "const fs=require('fs');import('$scriptUrl').then(()=>fs.appendFileSync(process.env.PM_TEST_OUT,'PASS')).catch(e=>fs.appendFileSync(process.env.PM_TEST_OUT,'FAIL: '+(e&&e.stack||e)))"
    $env:PM_TEST_OUT = $result

    & $harness -e $js | Out-Null
    # 等结果文件出现（动态 import 是异步的）
    for ($i = 0; $i -lt 100 -and -not (Test-Path $result); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $result)) { throw "测试未产出结果：$Script" }
    Start-Sleep -Milliseconds 300
    $text = Get-Content $result -Raw
    Remove-Item $result -ErrorAction SilentlyContinue
    return $text
}

$plainNode = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$failures = @()

Write-Host '=== 1/9 scope.test.mjs（仓库源码，纯 node）' -ForegroundColor Cyan
& $plainNode (Join-Path $repo 'test\scope.test.mjs')
if ($LASTEXITCODE -ne 0) { $failures += 'scope.test.mjs (repo)' }

Write-Host '=== 2/9 fact-limit.test.mjs（仓库源码，纯 node：FACT.md 行数硬上限）' -ForegroundColor Cyan
& $plainNode (Join-Path $repo 'test\fact-limit.test.mjs')
if ($LASTEXITCODE -ne 0) { $failures += 'fact-limit.test.mjs (repo)' }

Write-Host '=== 3/9 fact-bytes.test.mjs（仓库源码，纯 node：FACT.md 字节硬上限）' -ForegroundColor Cyan
& $plainNode (Join-Path $repo 'test\fact-bytes.test.mjs')
if ($LASTEXITCODE -ne 0) { $failures += 'fact-bytes.test.mjs (repo)' }

Write-Host '=== 4/9 project-limit.test.mjs（仓库源码，纯 node：项目 MEMORY.md 字符硬上限）' -ForegroundColor Cyan
& $plainNode (Join-Path $repo 'test\project-limit.test.mjs')
if ($LASTEXITCODE -ne 0) { $failures += 'project-limit.test.mjs (repo)' }

Write-Host '=== 5/9 host-interpolate.test.mjs（仓库源码，真实宿主渲染器）' -ForegroundColor Cyan
$r = Invoke-Mjs -Script (Join-Path $repo 'test\host-interpolate.test.mjs')
Write-Host $r
if ($r -notmatch 'PASS') { $failures += 'host-interpolate.test.mjs (repo)' }

Write-Host '=== 6/9 cordis-integration.test.mjs（仓库源码，真实 cordis 全链路）' -ForegroundColor Cyan
$r = Invoke-Mjs -Script (Join-Path $repo 'test\cordis-integration.test.mjs')
Write-Host $r
if ($r -notmatch 'PASS') { $failures += 'cordis-integration.test.mjs (repo)' }

Write-Host '=== 7/9 real-data.test.mjs（用用户真实记忆数据跑真实渲染）' -ForegroundColor Cyan
$r = Invoke-Mjs -Script (Join-Path $repo 'test\real-data.test.mjs')
Write-Host $r
if ($r -notmatch 'PASS') { $failures += 'real-data.test.mjs (repo)' }

Write-Host '=== 8/9 snapshot-resume.test.mjs（已固化快照路径）' -ForegroundColor Cyan
$r = Invoke-Mjs -Script (Join-Path $repo 'test\snapshot-resume.test.mjs')
Write-Host $r
if ($r -notmatch 'PASS') { $failures += 'snapshot-resume.test.mjs (repo)' }

Write-Host '=== 9/9 同样几项跑 profile 里已安装的那份' -ForegroundColor Cyan
if (-not (Test-Path $installed)) {
    Write-Host "跳过：未安装 $installed" -ForegroundColor Yellow
} else {
    $entry = 'file:///' + (($installed -replace '\\', '/') + '/lib/index.js')

    foreach ($pure in @('fact-limit', 'fact-bytes', 'project-limit')) {
        $env:PERSONA_MEMORY_ENTRY = $entry
        & $plainNode (Join-Path $repo "test\$pure.test.mjs")
        if ($LASTEXITCODE -ne 0) { $failures += "$pure.test.mjs (installed)" }
        Remove-Item Env:PERSONA_MEMORY_ENTRY -ErrorAction SilentlyContinue
    }

    $r = Invoke-Mjs -Script (Join-Path $repo 'test\host-interpolate.test.mjs') -Entry $entry
    Write-Host "host-interpolate: $r"
    if ($r -notmatch 'PASS') { $failures += 'host-interpolate.test.mjs (installed)' }

    $r = Invoke-Mjs -Script (Join-Path $repo 'test\cordis-integration.test.mjs') -Entry $entry
    Write-Host "cordis-integration: $r"
    if ($r -notmatch 'PASS') { $failures += 'cordis-integration.test.mjs (installed)' }

    $r = Invoke-Mjs -Script (Join-Path $repo 'test\real-data.test.mjs') -Entry $entry
    Write-Host "real-data: $r"
    if ($r -notmatch 'PASS') { $failures += 'real-data.test.mjs (installed)' }

    $r = Invoke-Mjs -Script (Join-Path $repo 'test\snapshot-resume.test.mjs') -Entry $entry
    Write-Host "snapshot-resume: $r"
    if ($r -notmatch 'PASS') { $failures += 'snapshot-resume.test.mjs (installed)' }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("✗ 失败：" + ($failures -join '、')) -ForegroundColor Red
    exit 1
}
Write-Host '✓ 全部通过' -ForegroundColor Green
