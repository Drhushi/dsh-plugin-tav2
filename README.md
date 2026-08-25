<div align="center">
  <img src="icon-tav-96x96.png" alt="dsh-plugin-tav2" width="96"/>
  <h1>dsh-plugin-tav2</h1>
  <p>DeepSeek Harness 插件 —— 对话式汉化 Ren'Py 视觉小说</p>
</div>

## 这是什么

一个装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件，
帮你把一个 Ren'Py 视觉小说翻译成中文。翻译由 AI 模型完成，你只需要跟助手对话，
从初始化、翻译到打包部署，全程由标准工作流推进。

- **对话式引导**：说一句「初始化游戏翻译」，助手探测游戏、生成配置、给出翻译计划，你确认后才动手；
- **补丁式交付**：产出可合并的补丁包（含清单），合并进游戏根目录即用，删除清单所列文件即可完全还原；
- **安全非侵入**：不碰原游戏任何文件，只增量写翻译目录 `tl/<lang>`；
- **智能增量迁移**：游戏更新后只补译变化的部分，已有译文自动保留；
- **完整工具链**：术语管理、术语推敲、世界书、审校队列、完整性校验、运行时验证，一站到底。

## 前置要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（Web 版，Node.js ≥ 22.19）；
- 一个 **Ren'Py** 视觉小说（游戏目录内含 `game/`）；
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
7. 游戏内 Ren'Py 语言菜单选中文，启动游戏核对（tav2_verify 可复查）
```

> 翻译是补丁式非破坏产物，只增量写 `tl/<lang>`；卸载用 `tav2_uninstall` 按清单精确删除。

## 常用工具

| 工具 | 用途 |
| --- | --- |
| `tav2_init` | 初始化翻译项目（对话式引导，生成最小配置） |
| `tav2_status` | 项目状态：场景 / 单元 / 待译 / 翻译通道 / 授权 |
| `tav2_prepare` | 生成翻译模板（`tl/chinese`） |
| `tav2_terms` / `tav2_deliberate` | 术语管理：扫描候选、推敲并锁定译名 |
| `tav2_worldbook` | 生成世界书条目（人名/术语资料卡） |
| `tav2_translate_batch` | 分批翻译（后台任务，完成自动通知） |
| `tav2_check` | 完整性校验（标识符 / 标签 / 说话人） |
| `tav2_pack` | 打包补丁式交付物（含 manifest 清单） |
| `tav2_verify` | 运行验证（格式 / 覆盖 / 字体 / 实机核对指引） |
| `tav2_migrate` | 游戏更新后增量迁移译文 |
| `tav2_uninstall` | 按清单精确卸载补丁 |

## 常见问题

- **装完启动报 sqlite 绑定错误**：profile 的 `package.json` 里 `pnpm.onlyBuiltDependencies`
  需包含 `better-sqlite3`（安装脚本会自动处理）。
- **遇到 `.rpyc` 已编译游戏**：需要 Ren'Py SDK，配置 `renpySdk` 后 prepare 走官方路线。
  普通 `.rpy` 源码游戏无需任何额外配置。
- **翻译报「LLM 调用失败」**：检查翻译通道——设置 → 插件 → 翻译渠道，
  baseUrl 与密钥配好，或确保本地端点已启动。
- **游戏更新后**：跑 `tav2_migrate` 增量迁移，保留未变译文、只补译变化部分。
- **版权**：翻译前请确认你拥有翻译 / 发布该游戏的授权（G-1 授权记录：`tav2_compliance`）。
- **非侵入**：插件不修改任何原游戏文件，交付物均为新增补丁，删除即还原。

## 许可

[MIT](LICENSE)
