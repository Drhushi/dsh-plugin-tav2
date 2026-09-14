#requires -Version 5.1
<#
  uninstall-plugin.ps1 — 把 dsh-plugin-tav2 从 dsh profile 摘除（install-plugin.ps1 的逆操作）。

  为什么需要它：插件的挂载点是 profile 的 package.json（dependencies + dsh.profile.bundles），
  光在 cordis.patch.yml 里写 `- id: tav2 / disabled: true` 只是压住加载行，插件仍留在 bundles 里；
  设置卡里的「翻译模式」开关**不是加载门控**（插件按工作区自动安装翻译作用域，开关已废弃）。
  要彻底停止影响所有会话，必须从 profile 摘除挂载 + 重启 harness。

  本脚本做四件事：
    1. package.json：从 dependencies 与 dsh.profile.bundles 移除 dsh-plugin-tav2；
    2. cordis.patch.yml：删掉所有 `- id: tav2` 块（含其缩进子行与紧邻的插件注释行），其余条目不动；
    3. node_modules/<插件>：junction/符号链接只删重解析点（绝不用 Remove-Item -Recurse，
       Windows PowerShell 5.1 下那会删进链接目标，把插件仓库本身删掉）；
       未加 -SkipPnpmInstall 时改跑 pnpm install 收敛 lockfile 与 node_modules；
    4. -PurgeState：把插件持久状态与历史遗留**移进隔离目录** `~/.dsh/_tav2-removed-<时间戳>/`
       （state.json 会记着你的游戏目录绝对路径、翻译渠道、Ren'Py SDK 路径）：
         dsh-plugin-tav2/、.agent-presets/tav2-translator/、profiles/translation.bak-*、
         profiles/*/cordis.patch.yml.bak-tav2-*、settings.yaml 的 tav2: 命名空间块（改前留备份）。

  **不碰凭据**：`.credentials.yaml` 里的 `TAV2_*` / `tav2:*` 密钥属于你，脚本只报告名称并提示
  删除 + 轮换，绝不代删。也**不碰游戏目录里的翻译产物**（那是 tav2kit / tav2_uninstall 的职责）。

  安全约定：默认只做 dry-run 预览（不写任何文件）；只有显式加 -Apply 才落盘。幂等，可连跑。

  .PARAMETER ProfileDir
  dsh profile 目录，默认 $env:USERPROFILE\.dsh\profiles\web。

  .PARAMETER DshHome
  dsh home（放 state.json / settings.yaml / .credentials.yaml 的地方）。
  默认取 $env:DSH_HOME，缺省 $env:USERPROFILE\.dsh。

  .PARAMETER Apply
  真正写文件。缺省（或只加 -WhatIf）= 只预览不落盘。

  .PARAMETER SkipPnpmInstall
  -Apply 时不跑 pnpm install，改为直接删 node_modules 里的插件链接（离线场景用）。

  .PARAMETER PurgeState
  连同插件持久状态与历史遗留一起隔离（见上第 4 条）。

  .EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1
  # 预览将做的改动，不写文件。

  .EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1 -PurgeState -Apply
  # 真正卸载并隔离状态残留，然后彻底重启 harness。
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web",
    # 注意：默认值里不能用 $PSScriptRoot——Windows PowerShell 5.1 在参数默认值求值阶段它是空的。
    [string]$DshHome = '',
    [switch]$Apply,
    [switch]$SkipPnpmInstall,
    [switch]$PurgeState
)

$ErrorActionPreference = 'Stop'
$Write = $Apply -and -not $WhatIfPreference  # -WhatIf 也走预览
$PluginId = 'dsh-plugin-tav2'
$PatchId = 'tav2'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Change([string]$msg) {
    if ($Write) { Write-Host "    [将写入] $msg" -ForegroundColor Yellow }
    else        { Write-Host "    [预览]   $msg" -ForegroundColor Green }
}
function Write-Done([string]$msg) { Write-Host "    [已处理] $msg" -ForegroundColor DarkGray }
function Write-Warn2([string]$msg) { Write-Host "警告: $msg" -ForegroundColor Magenta }

# ── 1. 解析并校验路径（缺 profile / package.json 一律报错，不猜） ──────────────
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" } }
$resolvedProfile = Resolve-Path $ProfileDir -ErrorAction SilentlyContinue
if (-not $resolvedProfile) { throw "profile 目录不存在: $ProfileDir" }
$ProfileDir = $resolvedProfile.Path

$packageJsonPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $packageJsonPath)) { throw "找不到 profile 的 package.json: $packageJsonPath" }

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$settingsPath = Join-Path $DshHome 'settings.yaml'
$credentialsPath = Join-Path $DshHome '.credentials.yaml'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Step "profile: $ProfileDir"
Write-Step "dsh home: $DshHome"
if ($Write) {
    Write-Host ''
    Write-Host "!!!! 即将写文件到 profile: $ProfileDir !!!!" -ForegroundColor Red
    Write-Host '     卸载完成后必须彻底重启 harness（重开会话不算）才生效。' -ForegroundColor Red
    Write-Host ''
} else {
    Write-Host '（dry-run：只预览，不写文件。确认无误后加 -Apply 真正卸载。）'
}

# ── 1b. 预检：patch 里的「嵌套」tav2 条目不能安全自动改写 ───────────────────
# 条目识别容忍引号与行尾注释（`- id: tav2` / `- id: "tav2"` / `- id: tav2  # 注释`）；
# 旧的 `\s*$` 写法会让带注释的写法静默漏删，等于卸载器假报成功。
$Tav2EntryPattern = '^\s*-\s*id:\s*[''"]?{0}[''"]?\s*(#.*)?$' -f [regex]::Escape($PatchId)
$Tav2NestedPattern = '^\s+-\s*id:\s*[''"]?{0}[''"]?\s*(#.*)?$' -f [regex]::Escape($PatchId)

if (Test-Path $patchPath) {
    $preLines = [System.IO.File]::ReadAllLines($patchPath)
    $nested = @(for ($i = 0; $i -lt $preLines.Count; $i++) {
            if ($preLines[$i] -notmatch '^\s*#' -and $preLines[$i] -match $Tav2NestedPattern) { $i + 1 }
        })
    if ($nested.Count -gt 0) {
        # 注意：PowerShell 不支持「以 + 开头的续行」，多段拼接必须用 += 逐句累加
        $msg = "检测到 $PatchId 条目位于嵌套列表内（第 $($nested -join '、') 行，例如 insert: 块）："
        $msg += '自动删除会在父条目下留下空壳、破坏 patch 语义，脚本拒绝改写。'
        $msg += "请手工删除这些行后重跑（本次未写任何文件）。"
        throw $msg
    }
}

# ── 2. package.json：两处挂载点 ─────────────────────────────────────────────
Write-Step 'package.json：移除依赖与 bundle 挂载'
$json = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$pkgChanged = $false

$depNames = @($json.PSObject.Properties.Name)
if ($depNames -contains 'dependencies' -and @($json.dependencies.PSObject.Properties.Name) -contains $PluginId) {
    Write-Change "dependencies 移除 $PluginId"
    if ($Write) { $json.dependencies.PSObject.Properties.Remove($PluginId) | Out-Null }
    $pkgChanged = $true
} else {
    Write-Done "dependencies 未含 $PluginId（已就绪）"
}

$hasBundles = $depNames -contains 'dsh' -and
    @($json.dsh.PSObject.Properties.Name) -contains 'profile' -and
    @($json.dsh.profile.PSObject.Properties.Name) -contains 'bundles'
if (-not $hasBundles) {
    Write-Warn2 "profile 的 package.json 缺 dsh.profile.bundles 结构——跳过 bundle 清理，请手工确认这是正确的 dsh profile。"
} elseif (@($json.dsh.profile.bundles) -contains $PluginId) {
    Write-Change "dsh.profile.bundles 移除 $PluginId（当前共 $(@($json.dsh.profile.bundles).Count) 个）"
    if ($Write) {
        $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $PluginId })
    }
    $pkgChanged = $true
} else {
    Write-Done "dsh.profile.bundles 未含 $PluginId（已就绪）"
}

if ($pkgChanged -and $Write) {
    Copy-Item $packageJsonPath "$packageJsonPath.bak-uninstall-$stamp" -Force
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($packageJsonPath, ($json | ConvertTo-Json -Depth 20), $utf8NoBom)
    Write-Host "    已写入 $packageJsonPath（备份 .bak-uninstall-$stamp）" -ForegroundColor Yellow
}

# ── 3. cordis.patch.yml：删除顶层 `- id: tav2` 条目 ─────────────────────────
# 边界规则（防越界吃掉无关条目）：向上吸收紧邻的含 tav2/翻译插件 的注释行，向下只吃
# 「缩进更深的行」；遇到下一个 `- ` 列表项或列 0 的非空行即停。模式见 1b 的预检块。
function Get-PatchDropInfo([string[]]$lines, [string]$entryPattern) {
    # 返回单个 PSCustomObject（不是集合）——PowerShell 会把函数返回的集合解包：
    # 单条目时哈希被拆成键、多条目时属性访问又会被展开成数组（曾导致 $r.end 变成 @(2,6)）。
    $drop = New-Object 'System.Collections.Generic.HashSet[int]'
    $entries = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $entryPattern) {
            $entries++
            $start = $i
            $j = $i - 1
            while ($j -ge 0 -and $lines[$j] -match '^\s*#.*(tav2|翻译插件)') { $start = $j; $j-- }
            $end = $i
            $k = $i + 1
            while ($k -lt $lines.Count) {
                $line = $lines[$k]
                if ($line -match '^\s*$') { $k++; continue }     # 空行不视为块内容
                if ($line -match '^\s*-\s') { break }            # 下一个列表项
                if ($line -match '^\S') { break }                # 列 0 的新键/注释
                $end = $k; $k++
            }
            for ($n = $start; $n -le $end; $n++) { [void]$drop.Add($n) }
            $i = $end
        }
    }
    return [pscustomobject]@{ Entries = $entries; Drop = $drop }
}

Write-Step "cordis.patch.yml：删除 - id: $PatchId 条目"
if (-not (Test-Path $patchPath)) {
    Write-Done 'cordis.patch.yml 不存在（无需清理）'
} else {
    $patchLines = [System.IO.File]::ReadAllLines($patchPath)
    $info = Get-PatchDropInfo $patchLines $Tav2EntryPattern
    if ($info.Entries -eq 0) {
        Write-Done "未发现 - id: $PatchId 条目（已就绪）"
    } else {
        $drop = $info.Drop
        $kept = @(for ($i = 0; $i -lt $patchLines.Count; $i++) { if (-not $drop.Contains($i)) { $patchLines[$i] } })
        Write-Change "删除 $($info.Entries) 处 - id: $PatchId 条目（共 $($drop.Count) 行），保留其余 $($kept.Count) 行"
        if ($Write) {
            $content = ($kept -join "`n")
            if (-not ($kept | Where-Object { $_ -match '^\s*-\s' })) {
                # patch 层必须仍是顶层 YAML 数组：条目被清空时写空数组，避免留下 null 语义
                $content = '[]'
                Write-Warn2 "patch 层已无任何条目，写入空数组 []（原为纯注释/空文件时会成为无效 YAML）"
            }
            Copy-Item $patchPath "$patchPath.bak-uninstall-$stamp" -Force
            $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($patchPath, ($content.TrimEnd() + "`n"), $utf8NoBom)
            Write-Host "    已写入 $patchPath（备份 .bak-uninstall-$stamp）" -ForegroundColor Yellow

            # 收尾自检：写盘后不得再有任何插件加载条目，否则宁可报错也不许假报成功
            $residual = @(Select-String -LiteralPath $patchPath -Pattern $Tav2EntryPattern -ErrorAction SilentlyContinue)
            if ($residual.Count -gt 0) {
                throw "patch 写盘后仍残留 $PatchId 条目（第 $(($residual | ForEach-Object { $_.LineNumber }) -join '、') 行）——卸载未达目标。原文件已备份为 .bak-uninstall-$stamp，请手工核对 $patchPath。"
            }
        }
    }
}

# ── 4. node_modules：链接只删重解析点 ───────────────────────────────────────
Write-Step 'node_modules：移除插件链接'
$linkPath = Join-Path $ProfileDir "node_modules\$PluginId"
if (-not $SkipPnpmInstall) {
    if ($Write) {
        Write-Step '在 profile 目录运行 pnpm install 收敛 lockfile 与 node_modules …'
        Push-Location $ProfileDir
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm install 失败（exit $LASTEXITCODE）：node_modules/lockfile 可能仍有残留，可手工删 $linkPath" }
        } finally { Pop-Location }
    } else {
        Write-Change '运行 pnpm install（收敛 node_modules 与 pnpm-lock.yaml）'
    }
} elseif (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    if ($item.LinkType) {
        # junction / symlink：只删重解析点本身。绝不能用 Remove-Item -Recurse ——
        # Windows PowerShell 5.1 会沿着链接删进目标，把插件仓库整个删掉。
        Write-Change "删除 $($item.LinkType) 链接 $linkPath → $($item.Target)（不动链接目标）"
        if ($Write) { [System.IO.Directory]::Delete($item.FullName, $false) }
    } else {
        Write-Change "删除 node_modules 下的安装副本 $linkPath（真实目录，非链接）"
        if ($Write) { Remove-Item -LiteralPath $linkPath -Recurse -Force }
    }
} else {
    Write-Done "node_modules\$PluginId 不存在（已就绪）"
}

# ── 5. -PurgeState：状态与历史遗留移进隔离目录 ─────────────────────────────
if ($PurgeState) {
    Write-Step '状态残留：隔离（不是硬删）'
    $quarantine = Join-Path $DshHome "_tav2-removed-$stamp"
    $targets = New-Object System.Collections.ArrayList
    foreach ($p in @(
            (Join-Path $DshHome $PluginId),
            (Join-Path $DshHome '.agent-presets\tav2-translator'),
            (Join-Path $DshHome 'profiles\translation.bak-*'),
            (Join-Path $ProfileDir 'cordis.patch.yml.bak-tav2-*')
        )) {
        foreach ($hit in @(Get-Item -Path $p -Force -ErrorAction SilentlyContinue)) {
            if ($hit) { [void]$targets.Add($hit) }
        }
    }
    if ($targets.Count -eq 0) {
        Write-Done '未发现插件状态残留（已就绪）'
    } else {
        foreach ($t in $targets) {
            Write-Change "隔离 $($t.FullName) → $quarantine\"
            if ($Write) {
                if (-not (Test-Path $quarantine)) { New-Item -ItemType Directory -Force -Path $quarantine | Out-Null }
                $dest = Join-Path $quarantine $t.Name
                $n = 2
                while (Test-Path -LiteralPath $dest) { $dest = Join-Path $quarantine ("$($t.Name).$n"); $n++ }
                Move-Item -LiteralPath $t.FullName -Destination $dest -Force
            }
        }
        if ($Write) { Write-Host "    残留已隔离到 $quarantine（确认无误后可自行删除）" -ForegroundColor Yellow }
    }

    # settings.yaml：只删 tav2: 顶层块，改前备份整个文件
    Write-Step 'settings.yaml：删除 tav2 命名空间块'
    if (-not (Test-Path $settingsPath)) {
        Write-Done 'settings.yaml 不存在（无需清理）'
    } else {
        $sLines = [System.IO.File]::ReadAllLines($settingsPath)
        $sStart = -1
        for ($i = 0; $i -lt $sLines.Count; $i++) {
            if ($sLines[$i] -match "^$PatchId`:\s*$") { $sStart = $i; break }
        }
        if ($sStart -lt 0) {
            Write-Done 'settings.yaml 无 tav2 块（已就绪）'
        } else {
            $sEnd = $sStart
            $k = $sStart + 1
            while ($k -lt $sLines.Count) {
                if ($sLines[$k] -match '^\s*$') { $k++; continue }
                if ($sLines[$k] -match '^\S') { break }
                $sEnd = $k; $k++
            }
            $sKept = @(for ($i = 0; $i -lt $sLines.Count; $i++) { if ($i -lt $sStart -or $i -gt $sEnd) { $sLines[$i] } })
            Write-Change "删除 settings.yaml 第 $($sStart + 1)-$($sEnd + 1) 行（tav2: 块）"
            if ($Write) {
                Copy-Item $settingsPath "$settingsPath.bak-uninstall-$stamp" -Force
                $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
                [System.IO.File]::WriteAllText($settingsPath, (($sKept -join "`n").TrimEnd() + "`n"), $utf8NoBom)
                Write-Host "    已写入 $settingsPath（备份 .bak-uninstall-$stamp）" -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host '    （未加 -PurgeState：插件状态残留保留——state.json / .agent-presets / settings.yaml 的 tav2 块）' -ForegroundColor DarkGray
}

# ── 5b. 其它相关残留：只报告，不动别的插件的状态文件 ───────────────────────
Write-Step '其它相关残留（只报告，不代改）'
$extras = New-Object System.Collections.ArrayList
$marketState = Join-Path $ProfileDir '.dsh-market\state.json'
if ((Test-Path $marketState) -and @(Select-String -LiteralPath $marketState -Pattern $PluginId -ErrorAction SilentlyContinue).Count -gt 0) {
    [void]$extras.Add("$marketState —— 插件市场的开关记录里仍列着 $PluginId（market 自己的库，脚本不代改；可在市场界面里卸掉该条）")
}
foreach ($shim in @(Get-ChildItem -Path (Join-Path $ProfileDir 'node_modules\.bin\tav2kit*') -Force -ErrorAction SilentlyContinue)) {
    [void]$extras.Add("$($shim.FullName) —— 指向已删除的 dist/cli/main.js 的失效 CLI 垫片")
}
foreach ($bak in @(Get-Item -Path (Join-Path $ProfileDir 'node_modules.bak-*') -Force -ErrorAction SilentlyContinue)) {
    if (Test-Path (Join-Path $bak.FullName $PluginId)) {
        [void]$extras.Add("$($bak.FullName)\$PluginId —— 历史 node_modules 备份里的旧链接（可整体删掉该备份目录）")
    }
}
foreach ($own in @(Get-ChildItem -Path "${settingsPath}.bak-uninstall-*", "${patchPath}.bak-uninstall-*" -Force -ErrorAction SilentlyContinue)) {
    [void]$extras.Add("$($own.FullName) —— 本次卸载的备份，确认新配置无误后可删")
}
if ($extras.Count -eq 0) {
    Write-Done '未发现其它相关残留'
} else {
    foreach ($e in $extras) { Write-Host "    [待处理] $e" -ForegroundColor Yellow }
}

# ── 6. 凭据：只报告，绝不代删 ───────────────────────────────────────────────
if (Test-Path -LiteralPath $credentialsPath) {
    $refs = @(Select-String -LiteralPath $credentialsPath -Pattern '^\s*([A-Za-z0-9_.-]*(tav2|TAV2)[A-Za-z0-9_.-]*)\s*:' -AllMatches |
            ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -Unique)
    if ($refs.Count -gt 0) {
        Write-Step '凭据：需要你手工处理（脚本不改密钥）'
        foreach ($r in $refs) { Write-Host "    [待处理] $credentialsPath 里的凭据「$r」——如不再使用请删除，并到渠道服务商处轮换/吊销。" -ForegroundColor Yellow }
    }
}

# ── 7. 收尾 ─────────────────────────────────────────────────────────────────
Write-Host ''
if ($Write) {
    Write-Step '完成。接下来：'
    Write-Host '  1. 彻底重启 harness（重开会话不算——插件是在进程启动时挂载的）；'
    Write-Host '  2. 重启后确认插件已消失：设置 → 插件 无 dsh-plugin-tav2 卡片；'
    Write-Host '     /tav2-mode 命令不存在、新会话不再出现翻译 persona 与 tav2_* 工具；'
    Write-Host '  3. 游戏翻译产物不在本次范围：需要清理由 tav2kit / tav2_uninstall 按 manifest 处理。'
} else {
    Write-Step 'dry-run 预览结束，未写任何文件。'
    Write-Host '  加 -Apply 才会真正写入；可先加 -Apply -SkipPnpmInstall 只改文件不跑 pnpm install。'
}
