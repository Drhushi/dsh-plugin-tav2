# dsh-plugin-tav2 0.2.2

发布日期：2026-09-12

> 0.2.2 = **0.2.1 的全部内容**（dsh 0.1.5 适配）+ 本次设置卡交互修复。
> 已经装了 0.2.1 的用户建议升到 0.2.2；0.2.0 及更早版本请直接升 0.2.2。

## 兼容性

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | **≥ 0.1.5-rc.1**（0.1.5-rc.2 实机验证；rc.1 经逐符号核对通过） |
| Node.js | ≥ 22.19 |
| 引擎 | Ren'Py（其他引擎待适配） |

dsh < 0.1.5 上服务端工具仍可用，但设置卡会显示「Remote 通道缺失」降级提示
（0.1.5 起客户端才提供 `remote.settings` / `remote.credentials` 通道）。

## 本次修复：设置卡「点添加渠道后面板消失」

**症状**：在「设置 → 插件 → dsh-plugin-tav2」卡片里点「＋ 添加渠道」后，面板（卡片正文）
消失；刷新页面后配置仍在（服务器数据没丢，丢的是界面状态）。

**根因**：宿主/父级重渲染会**重新挂载**这张卡片，组件内 state 随之复位——折叠标记
`open` 变回 false（面板收起，看起来就是「配置消失」），刚添加的渠道行与已输入的密钥草稿一并丢失。
顺带修掉同一类隐患：渠道名校验函数对畸形数据会抛错（`(7).trim()` → TypeError），
而它在渲染期逐行调用——**渲染期抛错会让 React 卸载整张卡片**，表现同样是「面板消失」。

**改法**：

- 卡片草稿（展开状态 / 渠道列表 / 当前渠道 / SDK 路径 / 各渠道展开状态 / 密钥输入 / 保存基线）
  缓存到模块级，重挂载时先恢复；只有草稿**不脏**时才允许用服务器状态覆盖
  （`draftIsDirty`：只填了密钥也算脏，否则刷新会把密钥输入冲掉）。
- 渠道行渲染改为消费纯函数视图 `channelRowViewsOf`（永不抛错）：畸形渠道数据也必须能画出一行。
- `channelProblem` 防御化：非字符串字段先转换再 trim。
- 「添加渠道」改用函数式状态更新取长度（重挂载/快速连点时闭包里的列表可能已过期），
  新行照旧默认展开便于直接填写。

## 0.2.1 的内容（包含在本版）

1. **设置卡不可用（「命名空间 tav2 不可用」）**：客户端半迁移到 dsh 0.1.5 的 Remote 设置通道
   （`ctx.remote.settings` / `ctx.remote.credentials`、`{ok,value}` 信封、方法签名按宿主参数表
   严格校验实参个数），并把「通道缺失 / 读取失败 / 命名空间未注册」三类问题分开提示。
2. **子代理译文被吞（静默失败）**：`session.events` 已被 `snapshotEvents()` 取代；
   旧写法让分批翻译（`tav2_translate_batch`）整批报「子代理运行失败」。
3. **persona 段落名**：对齐 `deployment:persona-prefix` / `-suffix`（否则两段 persona 并存）。
4. **子代理运行期归属**：`agents.create` 补 `parentAgent`。
5. **依赖版本对齐**：devDeps 精确锁到宿主实际版本，运行时依赖写成显式 `peerDependencies`。
6. **发布面补齐 `skills/`**：`skills/tav2/{SKILL.md,AGENTS.md}` 此前不在发布白名单里。

## 安装 / 升级

### 方式 A：本 Release 的预构建资产（推荐，无需自己构建）

```powershell
$ver = '0.2.2'
$tgz = "https://github.com/Drhushi/dsh-plugin-tav2/releases/download/v$ver/dsh-plugin-tav2-$ver.tgz"
pnpm -C "$env:USERPROFILE\.dsh\profiles\web" add $tgz
```

> 首次安装后确认 profile 放行了原生模块构建：`pnpm.onlyBuiltDependencies` 含 `better-sqlite3`
> （或 `pnpm-workspace.yaml` 里 `allowBuilds: better-sqlite3: true`），否则启动报 sqlite 绑定错误。

### 方式 B：从仓库安装（改代码/跟 main）

```powershell
pnpm install && pnpm build
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\web" -PluginPath "<本仓库路径>" -Apply
```

### 升级后必须做的一步

**彻底重启 harness**（客户端 bundle 是启动时的快照，只重开聊天/新建会话不算），然后**刷新页面**。

## 验证清单

- 设置 → 插件 → dsh-plugin-tav2：卡片能显示渠道列表与 Ren'Py SDK 路径，可保存；
- 点「＋ 添加渠道」：面板保持展开、新行默认展开（本版修复点）；
- 任意问一句：应为简体中文（插件 persona 生效）；
- 跑一次 `tav2_status`：引擎/项目/翻译通道/运行时层字段齐全。

## 资产内容

`dsh-plugin-tav2-0.2.2.tgz` 由 `npm pack` 生成，含 `dist/`（含 `dist/client.js` 客户端 bundle）、
`skills/tav2/`、`python/tav2/`、`cordis.patch.yml`、`README.md`；发布脚本逐个校验必需条目与
版本号后才创建 Release。
