# dsh-plugin-tav2 0.2.1

发布日期：2026-09-12

## 兼容性（重要）

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | **≥ 0.1.5-rc.1**（0.1.5-rc.2 实机验证；rc.1 经逐符号核对通过） |
| Node.js | ≥ 22.19 |
| 引擎 | Ren'Py（其他引擎待适配） |

dsh < 0.1.5 上服务端工具仍可用，但**设置卡会显示「Remote 通道缺失」降级提示**——
0.1.5 起客户端才提供 Remote 设置通道（`remote.settings` / `remote.credentials`）。
如果你在设置卡上看到与「通道」「命名空间」相关的提示，请先升级 dsh 并重启 harness。

## 本次修复

0.1.5 把宿主的一批 API 改名/替换了，其中几处**不报错、只是行为错或界面不可用**，
本版本把它们全部对齐（并补了离线单测钉住契约）：

1. **设置卡不可用（用户可见症状：「命名空间 tav2 不可用」）**
   客户端半的调用通道已随 dsh 升级更换：`connection.api` 被移除，改为 Remote 命名空间
   `ctx.remote.settings` / `ctx.remote.credentials`，结果信封由 `{result:{value}}` 改为
   `{ok,value}`，且方法签名按宿主参数表严格校验实参个数。本版本迁移完毕，并把
   「通道缺失 / 读取失败 / 命名空间未注册」三类问题分开提示（旧版把它们混成一句，
   最误导排查）。
2. **子代理译文被吞（静默失败）**：`session.events` 在 0.1.5 已被 `snapshotEvents()` 取代；
   旧写法读到 `undefined`，导致分批翻译（`tav2_translate_batch`）的子代理结果被判为
   「子代理运行失败」，**整批报失败**。
3. **persona 段落名**：0.1.5 把部署 persona 拆成 `deployment:persona-prefix` / `-suffix`；
   插件若沿用旧名就不再遮蔽宿主 persona，模型会同时读到两段 persona（职责/语气冲突）。
4. **子代理运行期归属**：`agents.create` 补 `parentAgent`（不传则子代理成为运行时根，
   父会话卸载不连带回收，异常路径会留下孤儿 agent）。
5. **依赖版本对齐**：devDeps 精确锁到宿主实际版本（`dsh-*@0.1.5-rc.2`、`cordis@4.0.2`、
   `schemastery@3.18.2`），并把三个运行时依赖的 dsh 包写成显式 `peerDependencies`
   （`>=0.1.5-rc.1 <0.2.0`）——此前它们只声明为 devDeps，装机后靠宿主模块兜底解析，
   失败时只会在运行时报 `ERR_MODULE_NOT_FOUND`。
6. **发布面补齐 `skills/`**：`skills/tav2/SKILL.md`（zcode skill 形态）与
   `skills/tav2/AGENTS.md`（codex 等通用 agent 形态）此前不在发布白名单里，仓库与 Release 资产
   都缺这两个文件，而 `package.json.files` 声明要发它们。本次连同发布链路一起修：
   正式面 README 改由 `docs/PLUGIN-README.md` 复制（此前发布脚本会把 dev 的 tav2kit CLI 文档
   覆盖到插件的用户文档上），并新增预构建资产 + `gh release` 联动、dist 新鲜度闸门、
   资产条目与版本号校验。

## 安装 / 升级

### 方式 A：本 Release 的预构建资产（推荐，无需自己构建）

```powershell
$ver = '0.2.1'
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

**彻底重启 harness**（客户端 bundle 是启动时的快照，只重开聊天/新建会话不算），
然后**刷新页面**。否则你会继续看到旧界面——这也是旧版「改了不生效」类问题的根源。

## 验证清单

- 设置 → 插件 → dsh-plugin-tav2：卡片能显示渠道列表与 Ren'Py SDK 路径，可保存；
- 任意问一句：应为简体中文（插件 persona 生效）；
- 跑一次 `tav2_status`：引擎/项目/翻译通道/运行时层字段齐全。

## 资产校验

Release 资产为 `npm pack` 产物（`dsh-plugin-tav2-0.2.1.tgz`），内含：
`dist/`（含 `dist/client.js` 客户端 bundle）、`skills/tav2/`、`python/tav2/`、
`cordis.patch.yml`、`README.md`。发布脚本会逐条校验这些必需条目与版本号后才创建 Release。
