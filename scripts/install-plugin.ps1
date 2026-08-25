<#
.SYNOPSIS
把 dsh-plugin-tav2 一键挂进 dsh 的 web profile（设置卡片 + bundle + 构建脚本放行）。

.DESCRIPTION
脚本自动完成四件事（与 README「手动接入 web profile」等价）：
  1. 把插件加进 profile package.json 的 dependencies（link: 符号链接，不触发构建）
    与 dsh.profile.bundles；
  2. 给 pnpm.onlyBuiltDependencies 补 better-sqlite3 / esbuild —— 关键一步，
    缺了 pnpm 会静默跳过原生模块构建，插件一加载就报 sqlite 绑定错误；
  3. 在 cordis.patch.yml 追加 `- id: tav2` 配置块（已存在则跳过）；
  4. 运行 pnpm install（可用 -SkipPnpmInstall 跳过，便于在副本上测试）。

安全约定：默认只做 dry-run 预览（不写任何文件）；只有显式加 -Apply 才落盘。
适合「另一个对话正在改仓库/环境」的场景——先看脚本要改什么，确认无冲突再 Apply。

.PARAMETER ProfileDir
dsh profile 目录，默认 $env:USERPROFILE\.dsh\profiles\web。

.PARAMETER PluginPath
插件仓库绝对路径，默认取本脚本所在目录的上一级（即本仓库）。

.PARAMETER Apply
真正写文件。缺省（或只加 -WhatIf）= 只预览不落盘。

.PARAMETER SkipPnpmInstall
-Apply 时不跑 pnpm install（用于在临时副本上端到端验证文件改动）。

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1
# 预览将做的改动，不写文件。

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" `
  -PluginPath "C:/.../dsh-plugin-tav2" -Apply
# 真正安装到 web profile。
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\web",
    # 注意：默认值里不能用 $PSScriptRoot——Windows PowerShell 5.1 在参数默认值
    # 求值阶段它是空的（pwsh 7 才可用），会导致端用户按 README 命令直接报错。
    [string]$PluginPath = '',
    [switch]$Apply,
    [switch]$SkipPnpmInstall
)

$ErrorActionPreference = 'Stop'
$Write = $Apply -and -not $WhatIfPreference  # -WhatIf 也走预览

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Change([string]$msg) {
    if ($Write) { Write-Host "    [将写入] $msg" -ForegroundColor Yellow }
    else        { Write-Host "    [预览]   $msg" -ForegroundColor Green }
}
function Write-Warn([string]$msg) { Write-Host "警告: $msg" -ForegroundColor Magenta }

# 路径含空格时转 8.3 短路径（与现有 profile 的 link: 规格一致，
# 规避 pnpm 对含空格 link:/file: 规格在 Windows 上的不确定性），统一用正斜杠。
function Get-LinkPath([string]$p) {
    $p = (Resolve-Path $p).Path
    if ($p -match ' ') {
        $short = (cmd /c "for %I in (`"$p`") do @echo %~sI" 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $short -and $short -notmatch ' ') { $p = $short }
    }
    return $p -replace '\\', '/'
}

# ── 1. 校验输入 ──────────────────────────────────────────────
# $PSScriptRoot 在脚本体内两种 host（pwsh / Windows PowerShell 5.1 -File）都可用，
# 在此解析默认插件路径（不要在 param 默认值里用，见上方注释）。
if (-not $PluginPath) { $PluginPath = Join-Path $PSScriptRoot '..' }
$PluginPath = (Resolve-Path $PluginPath -ErrorAction SilentlyContinue).Path
if (-not $PluginPath) { throw "插件路径不存在: $PluginPath" }
$ProfileDir = (Resolve-Path $ProfileDir -ErrorAction SilentlyContinue).Path
if (-not $ProfileDir) { throw "profile 目录不存在: $ProfileDir" }
if (-not (Test-Path "$ProfileDir\package.json")) {
    throw "找不到 profile 的 package.json: $ProfileDir\package.json"
}

Write-Step "profile: $ProfileDir"
Write-Step "插件仓库: $PluginPath"
if (-not (Test-Path "$PluginPath\dist\index.js")) {
    Write-Warn "插件还没构建 dist（$PluginPath\dist\index.js 不存在）。link: 安装加载的是构建产物，需先在仓库跑 pnpm build 后再安装。"
}
if ($Write) {
    Write-Host ''
    Write-Host "!!!! 即将写文件到 profile: $ProfileDir !!!!" -ForegroundColor Red
    Write-Host '     确认另一个会话没有在改这些文件，并确认无误后再继续。' -ForegroundColor Red
    Write-Host ''
}
if (-not $Write) { Write-Host '（dry-run：只预览，不写文件。确认无误后加 -Apply 真正安装。）' }

# ── 2. 准备 JSON 结构改动 ────────────────────────────────────
$packageJsonPath = "$ProfileDir\package.json"
$json = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

# 2a. dependencies 加插件（link: 符号链接，不触发 prepare 构建）
$spec = 'link:' + (Get-LinkPath $PluginPath)
# 用 Get-Item.FullName 归一（能把长/短/混合路径写法统一为同一长路径），供已安装判断
$pluginFsPath = (Get-Item $PluginPath).FullName
if (-not $json.PSObject.Properties.Name.Contains('dependencies')) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([ordered]@{}) -Force
}
$depObj = $json.dependencies
$depNames = @($depObj.PSObject.Properties.Name)
if ('dsh-plugin-tav2' -in $depNames) {
    # 已有依赖：把其 link 目标解析到同一目录即视为已安装（兼容短路径/长路径写法）
    $existing = $depObj.'dsh-plugin-tav2'
    $existingResolved = $null
    if ($existing -like 'link:*') {
        $existingPath = ($existing.Substring(5) -replace '/', '\')
        if (Test-Path $existingPath) { $existingResolved = (Get-Item $existingPath).FullName }
    }
    if ($existingResolved -and $existingResolved -eq $pluginFsPath) {
        Write-Host "    [已就绪] 依赖 dsh-plugin-tav2 已指向同一目录" -ForegroundColor DarkGray
    } else {
        Write-Change "依赖 dsh-plugin-tav2 已是 $existing，本次不改（如需更新请手动改）"
    }
} else {
    Write-Change "dependencies 增加 dsh-plugin-tav2 = $spec"
    $depObj | Add-Member -NotePropertyName 'dsh-plugin-tav2' -NotePropertyValue $spec -Force
}

# 2b. dsh.profile.bundles 加插件
if (-not $json.PSObject.Properties.Name.Contains('dsh') -or
    -not $json.dsh.PSObject.Properties.Name.Contains('profile') -or
    -not $json.dsh.profile.PSObject.Properties.Name.Contains('bundles')) {
    throw "profile 的 package.json 缺少 dsh.profile.bundles 结构，请先确认这是正确的 dsh profile。"
}
$bundles = @($json.dsh.profile.bundles)
if ('dsh-plugin-tav2' -in $bundles) {
    Write-Host "    [已就绪] bundles 已含 dsh-plugin-tav2" -ForegroundColor DarkGray
} else {
    Write-Change "bundles 增加 dsh-plugin-tav2（当前共 $($bundles.Count) 个）"
    $bundles += 'dsh-plugin-tav2'
    $json.dsh.profile.bundles = $bundles
}

# 2c. pnpm.onlyBuiltDependencies 放行 better-sqlite3 / esbuild
if (-not $json.PSObject.Properties.Name.Contains('pnpm')) {
    Write-Change "新增 pnpm.onlyBuiltDependencies = [better-sqlite3, esbuild]"
    $json | Add-Member -NotePropertyName pnpm -NotePropertyValue ([ordered]@{ onlyBuiltDependencies = @('better-sqlite3', 'esbuild') }) -Force
} else {
    if (-not $json.pnpm.PSObject.Properties.Name.Contains('onlyBuiltDependencies')) {
        Write-Change "pnpm.onlyBuiltDependencies = [better-sqlite3, esbuild]"
        $json.pnpm | Add-Member -NotePropertyName onlyBuiltDependencies -NotePropertyValue @('better-sqlite3', 'esbuild') -Force
    } else {
        $built = @($json.pnpm.onlyBuiltDependencies)
        foreach ($pkg in @('better-sqlite3', 'esbuild')) {
            if ($pkg -in $built) {
                Write-Host "    [已就绪] onlyBuiltDependencies 已含 $pkg" -ForegroundColor DarkGray
            } else {
                Write-Change "onlyBuiltDependencies 增加 $pkg"
                $built += $pkg
            }
        }
        $json.pnpm.onlyBuiltDependencies = $built
    }
}

# ── 3. 准备 cordis.patch.yml 改动 ────────────────────────────
$patchPath = "$ProfileDir\cordis.patch.yml"
$hasTav2Block = $false
if (Test-Path $patchPath) {
    $patchText = Get-Content $patchPath -Raw
    $hasTav2Block = [regex]::IsMatch($patchText, '(?m)^\s*-\s*id:\s*tav2\s*$')
} else {
    $patchText = ''
}
$patchBlock = @'
# ── 翻译插件配置（dsh-plugin-tav2，由 scripts/install-plugin.ps1 追加）────────
- id: tav2
  config:
    # projectDir: 你的引擎 config.yaml 所在目录，例如 C:/Games/MyGame
    engineBackend: ts
    llmProvider: deepseek-official
    approval: ask
'@
if ($hasTav2Block) {
    Write-Host "    [已就绪] cordis.patch.yml 已有 - id: tav2 块，跳过追加（可手动补 config 覆盖）" -ForegroundColor DarkGray
} else {
    Write-Change "cordis.patch.yml 追加 - id: tav2 配置块"
}

# ── 4. 落盘（仅 -Apply 时）──────────────────────────────────
if ($Write) {
    # 4a. package.json：UTF-8 无 BOM
    $newJson = $json | ConvertTo-Json -Depth 20
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($packageJsonPath, $newJson, $utf8NoBom)
    Write-Host "    已写入 $packageJsonPath" -ForegroundColor Yellow

    # 4b. cordis.patch.yml：不存在则新建带注释头，存在则仅追加（不覆盖原内容）
    if (-not $hasTav2Block) {
        $content = if (Test-Path $patchPath) { (Get-Content $patchPath -Raw).TrimEnd() + "`n`n" } else { "# dsh profile patch layer`n" }
        $content += $patchBlock + "`n"
        [System.IO.File]::WriteAllText($patchPath, $content, $utf8NoBom)
        Write-Host "    已写入 $patchPath" -ForegroundColor Yellow
    }

    # 4c. pnpm install（除非 -SkipPnpmInstall）
    if ($SkipPnpmInstall) {
        Write-Host "    （-SkipPnpmInstall：未运行 pnpm install，请自行在 profile 目录执行）"
    } else {
        Write-Step "在 profile 目录运行 pnpm install …"
        Push-Location $ProfileDir
        try { pnpm install; if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（exit $LASTEXITCODE）" } }
        finally { Pop-Location }
    }
}

# ── 5. 收尾提示 ─────────────────────────────────────────────
Write-Host ''
if ($Write) {
    Write-Step "完成。接下来："
    Write-Host '  1. 重启 GUI（重开会话不算，进程内模块缓存是旧的）；'
    Write-Host '  2. 设置 → 插件 应出现 dsh-plugin-tav2 卡片；'
    Write-Host '  3. /tav2-mode status 确认插件版本与加载来源；'
    Write-Host '  4. 若报 sqlite 绑定错误 → 确认 onlyBuiltDependencies 含 better-sqlite3 后重跑 pnpm install。'
} else {
    Write-Step 'dry-run 预览结束，未写任何文件。'
    Write-Host '  加 -Apply 才会真正写入并跑 pnpm install；可先加 -Apply -SkipPnpmInstall 只写文件不装依赖。'
}
