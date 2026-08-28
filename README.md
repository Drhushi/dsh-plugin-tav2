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

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（Web 版，Node.js ≥ 22.19）；
- 一个游戏（当前需为 Ren'Py 游戏，目录内含 `game/`；其他引擎支持情况见「引擎支持」）；
- 可用的 **LLM 翻译通道**：DeepSeek API Key，或一个本地 OpenAI 兼容端点（在「设置 → 插件 → 翻译渠道」配置）。

## 快速开始

```powershell
# 1. 安装插件（一次性；先不加 -Apply 可预览改动，确认后再真正安装）
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" `
  -PluginPath "<本仓库绝对路径>" -Apply
```

安装完成后**重启 GUI**，设置 → 插件应出现 dsh-plugin-tav2 卡片。

```
2. 新建工作区：把工作区文件夹设为游戏根目录（含 game/）
3. 对助手说「初始化游戏翻译」→ 生成最小配置，全套翻译工具自动就绪
4. 助手先只读侦察（tav2_detect / tav2_status），列出翻译计划等你确认
5. 翻译：助手按场景分批翻译（tav2_translate_batch），完成后自动校验
6. 打包部署：tav2_pack 生成补丁包 → 把 <游戏名> 目录合并进游戏根目录
7. 游戏内语言菜单选中文，启动游戏核对（tav2_verify 可复查）
```

> 翻译是补丁式非破坏产物，只增量写目标语言目录；卸载用 `tav2_uninstall` 按清单精确删除。

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
  需包含 `better-sqlite3`（安装脚本会自动处理）。
- **翻译报「LLM 调用失败」**：检查翻译通道——设置 → 插件 → 翻译渠道，
  baseUrl 与密钥配好，或确保本地端点已启动。
- **游戏更新后**：跑 `tav2_migrate` 增量迁移，保留未变译文、只补译变化部分。
- **版权**：翻译前请确认你拥有翻译 / 发布该游戏的授权（G-1 授权记录：`tav2_compliance`）。
- **非侵入**：插件不修改任何原游戏文件，交付物均为新增补丁，删除即还原。

## 许可

[MIT](LICENSE)
