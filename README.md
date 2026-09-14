<div align="center">
  <img src="icon-tav-96x96.png" alt="dsh-plugin-tav2" width="96"/>
  <h1>dsh-plugin-tav2</h1>
  <p>DeepSeek Harness 插件 —— 对话式游戏本地化：跟 AI 助手说说话，从侦察、术语、翻译到打包验证一站完成</p>
</div>

## 这是什么

一个装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件，
把 AI 翻译流水线接进对话：翻译由模型完成，你只需要跟助手说话，
从初始化、翻译到打包部署，全程由标准工作流推进。

- **对话式全流程**：说一句「初始化游戏翻译」，助手探测游戏、生成配置、给出翻译计划，你确认后才动手；
- **补丁式非侵入**：不碰原游戏任何文件，交付物是可合并的补丁包（含 manifest 清单与版本指纹），
  删除清单所列文件即可完全还原；
- **游戏更新不怕**：按版本指纹与稳定 ID 做增量迁移，已有译文自动保留，只补译变化的部分；
- **翻译质量基建**：术语扫描与推敲锁定、世界书提名制（按三问判据推荐值得出卡的设定级实体）、
  审校队列、完整性校验、运行时三层验证（文件层 / 运行时层 / 实机确认），一站到底；
- **多引擎适配器架构**：一套工作流对接不同游戏引擎，新引擎以适配器形式接入；
  当前已落地 Ren'Py 适配器（见下方「引擎支持」）。

## 引擎支持

| 引擎 | 状态 | 说明 |
| --- | --- | --- |
| Ren'Py | ✅ 完整支持 | 非侵入写 `tl/<lang>`、CJK 字体配方、游戏内语言菜单切换 |
| Unity（Yarn Spinner 等对话系统） | 布局可识别，适配器待落地 | 探测能认出 Unity 布局并明确提示「暂未适配」，不会误报成探测失败 |
| 其他引擎 | 暂未适配 | 识别不到时明确提示；欢迎提 issue 讨论适配 |

Ren'Py 补充说明：

- 普通 `.rpy` 源码游戏开箱即用；遇到 `.rpyc` 已编译游戏需要 Ren'Py SDK，
  配置 `renpySdk` 后 prepare 走官方路线——自动反编译、模板直接写入游戏目录
  `game/tl/<lang>`，无需切换项目，语言切换可立即进游戏验证；
  反编译源码参考放 `<游戏根>/tav2_src/`（工作材料，不进补丁包，封包时可传
  `clean_source=true` 清理）；
- 交付物为 `game/tl/<lang>` 下的增量文件，游戏内语言菜单选中文即可生效；
- CJK 字体等运行时组件属于「运行时前置条件」，需用户自行安装，
  不进补丁包、`tav2_verify` 会做存在性自检。

## 前置要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **≥ 0.1.5-rc.1**（Web 版，Node.js ≥ 22.19）。
  0.1.5-rc.2 为实机验证版本；0.1.5-rc.1 经逐符号核对（本插件用到的 `ToolCallId`、`snapshotEvents`、
  `dsh-persona.prefix`、Remote 设置通道均在该版本的包内）。更早的 dsh 上服务端工具仍可用，
  但设置卡会显示「Remote 通道缺失」降级提示（0.1.5 起才有 `remote.settings` / `remote.credentials` 通道）；
- 一个游戏（当前需为 Ren'Py 游戏，目录内含 `game/`；其他引擎支持情况见「引擎支持」）；
- 可用的 **LLM 翻译通道**：DeepSeek API Key，或一个本地 OpenAI 兼容端点（在「设置 → 插件 → 翻译渠道」配置）。

## 安装

### 方式 A：从 GitHub Release 安装（推荐）

每个版本在 [Releases](https://github.com/Drhushi/dsh-plugin-tav2/releases) 页有一份**预构建资产**
（`.tgz`，已含 `dist/` 与客户端 bundle），装它不需要 clone 仓库、也不需要自己构建：

```powershell
$ver = '0.2.1'   # 换成你要装的版本
$tgz = "https://github.com/Drhushi/dsh-plugin-tav2/releases/download/v$ver/dsh-plugin-tav2-$ver.tgz"
pnpm -C "$env:USERPROFILE\.dsh\profiles\web" add $tgz
```

> 首次安装（或换 profile）后，确认 profile 的 `package.json`（或 `pnpm-workspace.yaml`）放行了
> 原生模块构建：`pnpm.onlyBuiltDependencies` 含 `better-sqlite3`，否则启动会报 sqlite 绑定错误。
> 方式 B 的安装脚本会自动处理这一步。

### 方式 B：从仓库安装（适合改代码/跟着 main 走）

```powershell
# 先在仓库里构建（link: 安装加载的是构建产物 dist，不构建会加载缺失/旧的 dist）
pnpm install
pnpm build

# 再把插件挂进 profile（先不加 -Apply 可预览改动，确认后再真正安装）
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" `
  -PluginPath "<本仓库绝对路径>" -Apply
```

安装完成后**重启 GUI**（客户端 bundle 是 harness 启动时的快照，只重开聊天不生效），
设置 → 插件应出现 dsh-plugin-tav2 卡片。

```
2. 新建工作区：把工作区文件夹设为游戏根目录（含 game/）
3. 对助手说「初始化游戏翻译」→ 生成最小配置，全套翻译工具自动就绪
4. 助手先只读侦察（tav2_detect / tav2_status），列出翻译计划等你确认
5. 翻译：助手按场景分批翻译（tav2_translate_batch），完成后自动校验
6. 打包部署：tav2_pack 生成补丁包 → 把 <游戏名> 目录合并进游戏根目录
7. 游戏内语言菜单选中文，启动游戏核对（tav2_verify 可复查）
```

> 翻译是补丁式非破坏产物，只增量写目标语言目录；卸载用 `tav2_uninstall` 按清单精确删除。

## 卸载

插件的挂载点是 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）。
**在 `cordis.patch.yml` 里写 `- id: tav2 / disabled: true` 只是压住加载行**，插件仍留在 bundles 里；
要彻底停止它对所有会话的影响，必须从 profile 摘除挂载并重启 harness。

> ⚠️ 设置卡里的「翻译模式」开关**不是加载门控**：插件按工作区自动安装翻译作用域
> （游戏工作区全套 / 普通工作区轻量引导包），关掉开关不会阻止它在新会话里生效。
> 真正能关掉它的只有「卸载 + 重启」。

用仓库自带的卸载脚本（默认 dry-run，先预览再 `-Apply`）：

```powershell
# 1. 预览将做的改动（不写任何文件）
powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1

# 2. 真正卸载，并把插件状态残留隔离到 ~/.dsh/_tav2-removed-<时间戳>/
powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" -PurgeState -Apply
```

脚本做四件事：

1. `package.json`：从 `dependencies` 与 `dsh.profile.bundles` 移除 `dsh-plugin-tav2`（改前留 `.bak-uninstall-<时间戳>`）；
2. `cordis.patch.yml`：删掉所有 `- id: tav2` 块（含 `disabled: true` 那条）及其紧邻的插件注释行，其余条目原样保留；
3. `node_modules`：删除插件链接——junction / 符号链接只删链接本身，**不会**沿链接删进插件目录；
4. `-PurgeState`：把插件持久状态与历史遗留**移进隔离目录**（可恢复，不硬删）：
   `~/.dsh/dsh-plugin-tav2/`（记着你的游戏目录、翻译渠道、Ren'Py SDK 路径）、
   `.agent-presets/tav2-translator/`、`profiles/translation.bak-*`、`cordis.patch.yml.bak-tav2-*`、
   以及 `settings.yaml` 里的 `tav2:` 命名空间块。

它**不碰 `~/.dsh/.credentials.yaml`**：里面 `TAV2_*` 密钥请自行删除，并到渠道服务商处轮换；
脚本只列出凭据名，绝不代删。

脚本**宁可报错也不假报成功**：条目识别容忍 `- id: tav2` / `- id: "tav2"` / `- id: tav2  # 注释`
三种写法，写盘后还会复查残留（仍在就报错退出，而不是打印「已就绪」）。若 tav2 条目位于嵌套列表里
（例如写在 `- insert:` 块内），自动删除会在父条目下留下空壳、破坏 patch 语义，脚本**拒绝改写**并
提示手工删除这些行后重跑——此时不会写任何文件。

`-PurgeState` 还会列出它**不动**的残留，供你按需处理：插件市场自己的开关记录
（`profiles/web/.dsh-market/state.json`）、失效的 `node_modules/.bin/tav2kit*` 垫片、
`node_modules.bak-*` 里的旧链接、以及本次卸载产生的 `.bak-uninstall-*` 备份。

装的是 Release 资产（方式 A）时也可以手工等价操作：
`pnpm -C "$env:USERPROFILE\.dsh\profiles\web" remove dsh-plugin-tav2`，再删掉 `cordis.patch.yml`
里的 `- id: tav2` 块，然后重启。

最后**彻底重启 harness**（重开会话不算——插件是在进程启动时挂载的），确认「设置 → 插件」里
不再有卡片、`/tav2-mode` 命令消失、新会话不再出现翻译 persona 与 `tav2_*` 工具。

> 游戏里的翻译补丁是另一回事：交付物按 manifest 精确清理（`tav2_uninstall`），与本节的
> 「卸载插件」互不影响。卸载插件不会动你已交付的翻译产物。

## 常用工具

| 工具 | 用途 |
| --- | --- |
| `tav2_init` | 初始化翻译项目（对话式引导，生成最小配置） |
| `tav2_status` | 项目状态：场景 / 单元 / 待译 / 翻译通道 / 授权 |
| `tav2_prepare` | 生成翻译模板 |
| `tav2_terms` / `tav2_deliberate` | 术语管理：扫描候选、推敲并锁定译名 |
| `tav2_worldbook` | 世界书提名制：聚合证据按三问判据推荐候选实体，确认后才生成资料卡 |
| `tav2_translate_batch` | 分批翻译（后台任务，完成自动通知） |
| `tav2_check` | 完整性校验（标识符 / 标签 / 说话人）+ 模板外残留对账（角色名 / 输入提示词） |
| `tav2_pack` | 打包补丁式交付物（含 manifest 清单；打包前自动收尾对账，自动生成角色名补丁） |
| `tav2_verify` | 运行验证（格式 / 覆盖 / 字体 / 实机核对指引） |
| `tav2_migrate` | 游戏更新后增量迁移译文 |
| `tav2_uninstall` | 按清单精确卸载补丁 |

## 常见问题

- **装完启动报 sqlite 绑定错误**：profile 的 `package.json` 里 `pnpm.onlyBuiltDependencies`
  需包含 `better-sqlite3`（方式 B 的安装脚本会自动处理）。
- **升级 dsh 后设置卡显示「Remote 通道缺失」**：dsh < 0.1.5 没有 Remote 设置通道；
  升到 ≥ 0.1.5-rc.1 后**重启 harness** 即可（服务端工具不受影响）。
- **更新插件后看不到变化**：客户端 bundle 是 harness 启动时的快照 —— 先确认 `dist/` 是新的
  （方式 A 的资产自带 `dist/`；方式 B 要自己 `pnpm build`），再**彻底重启 harness**，
  然后刷新页面。
- **翻译报「LLM 调用失败」**：检查翻译通道——设置 → 插件 → 翻译渠道，
  baseUrl 与密钥配好，或确保本地端点已启动。
- **游戏更新后**：跑 `tav2_migrate` 增量迁移，保留未变译文、只补译变化部分。
- **版权**：翻译前请确认你拥有翻译 / 发布该游戏的授权（G-1 授权记录：`tav2_compliance`）。
- **非侵入**：插件不修改任何原游戏文件，交付物均为新增补丁，删除即还原。
- **在设置卡里关掉「翻译模式」，新会话却仍按翻译流程走**：该开关不是加载门控（插件按工作区
  自动分级安装，开关字段已废弃），要停止影响只能卸载插件并重启 harness，见「卸载」。
- **装了插件后每个工作区都被当成翻译现场**：插件对普通工作区只装轻量引导包（`tav2_detect` /
  `tav2_init` / `tav2_select_project` / `tav2_status` + 引导 persona），这也是它会影响所有新会话的原因；
  不想要就按「卸载」摘除。

## 许可

[MIT](LICENSE)
