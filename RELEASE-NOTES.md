# dsh-plugin-tav2 0.2.3

发布日期：2026-09-14

> 0.2.3 = **0.2.2 的全部内容** + 新增**插件卸载路径**（脚本 + 文档 + 发布面接线）。
> 本版**没有**修改插件的翻译注入行为——它给的是一条可靠的手动出口，见下面「本版不改什么」。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | **≥ 0.1.5-rc.1**（0.1.5-rc.2 实机验证） |
| Node.js | ≥ 22.19 |
| 引擎 | Ren'Py（其他引擎待适配） |

## 本次新增：卸载（`scripts/uninstall-plugin.ps1`）

**为什么需要专门的卸载路径**：插件的挂载点是 profile 的 `package.json`
（`dependencies` + `dsh.profile.bundles`）。设置卡里的「翻译模式」开关**不是加载门控**——
插件在 `agent/created` 上**无条件**按工作区自动安装翻译作用域（游戏工作区装全套、
普通工作区装轻量引导包），`/tav2-mode off` 是兼容空操作。所以在应用里点开关**不会**
停止它的影响；唯一可靠的关闭方式是**从 profile 摘除 + 彻底重启 harness**。

而此前仓库只有安装脚本（`scripts/install-plugin.ps1`）、没有卸载脚本：用户只能手工逆向
安装步骤（删两处挂载点、删 patch 条目、清链接），容易漏。0.2.3 补上这条出口。

**脚本做什么**（默认 dry-run 预览，`-Apply` 才落盘，幂等，可连跑）：

1. `package.json`：从 `dependencies` 与 `dsh.profile.bundles` **两处**移除 `dsh-plugin-tav2`
   （改前留 `.bak-uninstall-<时间戳>` 备份）；
2. `cordis.patch.yml`：删掉所有 `- id: tav2` 条目（含 `disabled: true` 那条），
   其余条目与注释原样保留。条目识别容忍 `- id: tav2` / `- id: "tav2"` / `- id: tav2  # 注释`
   三种写法，**写盘后还会复查残留**——仍在就报错退出，绝不打印「已就绪」假报成功；
   若条目**嵌套**在 `- insert:` 之类的列表里，脚本拒绝改写（避免留下悬空父条目破坏
   patch 语义），提示手工删除后重跑，此时不写任何文件；
3. `node_modules`：删链接时用 `Directory::Delete(path, $false)` 只删重解析点，
   **不会**沿 junction 删进插件目录（Windows PowerShell 5.1 下 `Remove-Item -Recurse`
   会删进链接目标，这正是要避开的）；
4. `-PurgeState`：把插件状态与历史遗留**移进** `~/.dsh/_tav2-removed-<时间戳>/`（可恢复，不硬删）：
   `state.json`（里面记着你的游戏目录、翻译渠道、Ren'Py SDK 路径）、旧 agent preset、
   旧 profile 备份、patch 备份，以及 `settings.yaml` 的 `tav2:` 命名空间块；
   并列出它**不动**的其它残留供你自行处置（插件市场的开关记录、失效的 `node_modules/.bin/tav2kit*`
   垫片、历史 `node_modules.bak-*` 备份、本次产生的 `.bak-uninstall-*`）。

**不碰 `~/.dsh/.credentials.yaml`**：里面 `TAV2_*` 密钥只列出名称并提示删除 + 轮换，
脚本绝不代删。

文档与发布面：README 新增「卸载」章节与两条常见问题；`package.json` 的 `files`
与 `scripts/publish-stable.ps1` 白名单同步纳入该脚本（否则用户拿不到）。

## 本版不改什么（重要）

- **不改注入行为**：`agent/created` 仍按工作区自动安装翻译作用域，设置卡里的开关仍是历史字段。
  也就是说「装了就每个工作区都生效」这一点不变——本版给的是**可靠的手动出口**，
  不是行为修复。若你希望"开关真的能关"或"注入改为显式 opt-in"，那是另一个议题。
- 不自动删凭据/密钥，不自动重启 harness。
- 不动游戏里的翻译产物：交付物按 manifest 精确清理（`tav2_uninstall`），与卸载插件互不影响。

## 从旧版彻底退出（升级后建议做一次）

```powershell
# 1. 预览将做的改动（不写文件）
powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1

# 2. 真正卸载，并把状态残留隔离到 ~/.dsh/_tav2-removed-<时间戳>/
powershell -ExecutionPolicy Bypass -File scripts/uninstall-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" -PurgeState -Apply
```

3. **彻底重启 harness**（重开会话不算——插件是进程启动时挂载的），确认「设置 → 插件」
   里不再有卡片、`/tav2-mode` 命令消失。

## 0.2.2 的内容（包含在本版）

设置卡「点添加渠道后面板消失」修复：卡片草稿跨重挂载保留（折叠状态 / 渠道列表 / 密钥输入）、
渲染期不再抛错（畸形渠道数据也必须能画出一行）、「添加渠道」改用函数式状态更新。
详见仓库历史 `RELEASE-NOTES-0.2.2`。

## 0.2.1 的内容（包含在本版）

dsh 0.1.5 适配（`remote.settings` / `remote.credentials` Remote 设置通道、`snapshotEvents()`、
`deployment:persona-prefix` 段落名、`agents.create` 的 `parentAgent`）。
