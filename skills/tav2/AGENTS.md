# tav2kit agent 使用指南

游戏本地化独立 CLI（引擎无关；当前完整适配 Ren'Py）。主流程工作流与 dsh 插件同源。

## 工具名 ↔ CLI 命令映射

主流程下文中的工具名是 dsh 插件形态（`tav2_detect`、`tav2_status` 等）。
用 CLI 时：**去掉 `tav2_` 前缀即子命令**（`tav2_detect` → `tav2kit detect`，`tav2_init` → `tav2kit init`）。
dsh 会话/面板专属（select_project / scope_track / panel 等）在 CLI 无对应命令。

## 命令参考（与 `tav2kit --help` 同源）

```
tav2kit — 独立 agent 驱动的游戏本地化工具（当前完整适配 Ren'Py）

用法：tav2kit <命令> [参数] [选项]

命令：
  detect [游戏目录]            探测引擎类型与文件布局（识别到 Unity/Yarn 会明确提示暂不可用）
  init [游戏目录]              初始化翻译项目：探测游戏 → dry-run 预览将写 config.yaml；--yes 生成
  status                       项目状态总览（需项目 config.yaml）
  font list|pick <id>          字体候选（list 只读）；pick 落地到 tl/<lang>/font/（写操作，需 --yes）
  terms list|apply|update|delete  术语管理（apply/update/delete 为写操作，需 --yes）
  prepare                      生成翻译模板（.rpy 走 TS 原生；.rpyc 或 --sdk 走 Python 前台）
  check                        标识符/标签完整性 + 世界书↔术语一致性 + 模板外残留对账
  verify                       三层运行验证（文件层 / 运行时层 / 实机确认指引）
  report                       覆盖率 / 风险 / 审校队列 / 成本报表
  fingerprint [check|snapshot] 版本指纹比对（默认 check）；snapshot 记录基线（写操作，需 --yes）
  diff <旧目录> <新目录>       对账新旧游戏目录翻译文件差异（--lang 指定语言，默认 chinese）
  config get|set <key> <value> 读/写项目 config.yaml（set 支持 lang 与 translationApi.*，需 --yes）
  worldbook [nominate|accept|dismiss]  世界书提名制（需 LLM 渠道；accept/dismiss 需提名 id）
  deliberate                  术语多方位推敲（需 LLM 渠道；CLI 无联网查证）
  translate [场景id…]        双阶段翻译：进程内并发池按窗口并行（--limit 窗口数，--workers 并行上限）
  review --file <xlsx>        审校表回填 tl + 同步 DB（--force 忽略状态）
  pack [--out <dir>]          补丁打包 + manifest（closure 收尾门禁 fail-closed）
  migrate [--yes]             游戏更新增量迁移（写操作；未 --yes 预览计划退出码 4）
  deploy <目标目录> [--public]  复制 tl/<lang> 到目标游戏（public 需 G-1 授权）
  uninstall [--yes]           按补丁清单精确卸载（写操作；未 --yes 预览退出码 4）
  compliance get|set <status> 读/写 G-1 授权合规记录（set 为写操作，需 --yes）
  skill print [--booklet 名]   输出 agent 工作流知识（默认主流程；分册：font / langswitch / closure）
  doctor                       环境自检（node / python / tav2 后端 / 项目）
  version                      版本与加载来源

选项：
  --json            机器可读输出（结构化结果 JSON，字段与 dsh 工具一致）
  --project <dir>   项目目录（含 config.yaml；缺省用当前目录）
  --yes             确认写操作（init / font pick / terms 写 / config set 等；未给时 dry-run 预览并退出码 4）
  --python <exe>    Python 可执行文件（缺省 python）
  --sdk <path>      Ren'Py SDK 路径（prepare；传入后强制走 Python 官方路线）
  --dir <dir>       额外手动字体目录（font list/pick）

退出码：0 成功；1 业务失败；2 用法错误；4 需要确认（写操作未给 --yes）。
说明：当前覆盖 TS 后端只读命令 + init/font/terms/prepare/config 写路径；翻译 / 世界书 / 推敲等
其余写路径见 docs/SPEC-STANDALONE.md（Phase 2 后续批次）。
```


## 工作流（与 `tav2kit skill print` 同源）

# 游戏翻译标准流程（tav2）

> 定位：dsh-plugin-tav2 是引擎无关的对话式游戏汉化插件；当前完整适配 Ren'Py（非侵入补丁/字体/语言切换
> 机制均以 Ren'Py 实现为准），其他引擎需实现对应适配器后接入。

换游戏 = 新建工作区；不要在会话里做项目切换。
（编译版游戏 prepare 重构后模板直接写入真实游戏目录，同样无需切换项目。）

## 开场：先确认意图（不要一上来推全流程）

第一轮只读跑 tav2_detect（确认引擎）与 tav2_status（项目进度，含「已有翻译」字段），然后向用户确认
本轮意图，按分支路由；用户确认前不做任何写操作。

- **a) 全流程一口气翻译**：仅当用户明确要「全部/一口气/直接全翻」时才按下方「全流程」完整流水线执行；
- **b) 续接上次进度**：从 status/todo 断点继续，不重复初始化、不重复出计划；
- **c) 小任务**：用户指定范围，只跑对应「分册」，不触发无关写操作；
- **d) 已有翻译处理**：游戏已带/已有翻译（status 显示）时，先 tav2_import_existing 摄入基线，
  再在其上重译/审校/风格，不清空已有译文。

## 初始化（仅当工作区还没有 config.yaml 时）

用 tav2_init（不传参数）探测工作区及其子目录里的游戏；发现多个候选时把列表给用户确认，
再 tav2_init <游戏目录> 指定。tav2_init 生成最小 config.yaml（engine + game_dir + lang）到游戏根目录，
写盘前请求审批；成功后全套工具与本流程自动就绪。

## 全流程（仅用户明示「一口气」时按依赖顺序执行）

1. tav2_fingerprint snapshot——记录游戏版本指纹基线（写操作，需审批）。
2. tav2_prepare（后台任务）——生成 tl/<lang> 翻译模板（对已有翻译增量合并，不清空）。
   **编译版游戏（仅 .rpa/.rpyc，无 .rpy 源码）**：prepare 走 Python SDK 路线，模板直接写入
   真实游戏目录 game/tl/<lang>（全部为新增文件，符合非侵入契约），反编译源码参考在
   <游戏根>/tav2_src（引擎不加载它，仅供 gui 变量确认与排查）。无需切换项目，
   status/check/translate 直接绑定原游戏目录；语言切换可立即实机验证（设置→语言），
   确认通过后再封包。封包时传 clean_source=true 清理源码参考目录。
3. tav2_font——中文字体挑选与落地：list 枚举候选 → pick <id> 复制字体到 tl/<lang>/font/、
   自动生成样式覆盖 fonts.rpy（先确认 gui.text_font 存在，确认不了只复制不写覆盖）、
   写 config fonts.default/map（写操作需审批；重复 pick 幂等替换）。
   编译版游戏：gui 变量确认会自动读 <游戏根>/tav2_src 反编译源码，无需手工介入。
4. tav2_terms / tav2_terms apply——快扫术语候选并锁定关键术语（apply 写操作需审批）。
5. tav2_worldbook / tav2_worldbook_edit——世界书提名制：tav2_worldbook 聚合证据（时序跨度/
   出现分布）并按三问判据（设定级实体/跨场景分散/缺背景会翻错）推荐候选，理解沉淀通道还会从
   场景理解记录提取规则/关系类设定；**不自动出卡**。把推荐清单呈现给用户挑选，
   accept=<ids> 生成卡片草案（proposed），tav2_worldbook_edit confirm 确认（需审批）；
   dismiss=<ids> 驳回不值得出卡的提名。俚语/玩梗词/低频集中出现的词不出卡，译法靠术语链路。
6. tav2_deliberate / tav2_deliberate_confirm——术语推敲（高置信无冲突自动锁，其余待决，需审批）。
7. tav2_translate_batch（后台任务）——分批双阶段翻译，最多同时派 {{tav2_subagent_max_workers}}
   个子代理并行（原生子代理视图可见）；先用小 limit 试跑，质量稳定再扩大。
8. 审校：translate_batch review=true 产出审校 CSV；用户确认后 tav2_review_backfill 回填（需审批）。
9. tav2_check——标识符/标签完整性 + 世界书↔术语一致性 + **模板外残留对账**（裸角色显示名/
   renpy.input 提示词这类模板不覆盖的玩家可见文本），全部通过才算；对账报出未锁定译名的人名时，
   用 tav2_deliberate_confirm 锁定术语后重跑（详见 tav2-renpy-closure 分册）。
10. tav2_report——生成覆盖率/风险/审校队列/成本报表，向用户汇报进度。
11. 涉及公开发布前：tav2_compliance 检查/记录 G-1 授权（status=authorized, authorized=true），
    未授权时 tav2_deploy 只能用本地部署（public 缺省）。
12. 实机验证语言切换——在游戏内确认「设置→语言」出现目标语言且译文/字体正常显示；
    有问题就在游戏目录的松散 tl/<lang> 上排查修改（游戏直接加载松散 tl，无需重新封包）。
13. tav2_pack——封包交付（结项动作）：把 tl/<lang> 导出为 <游戏名>/game/<游戏名>_tl_<lang>.rpa；
    打包前自动做收尾对账（fail-closed，残留未收口会拒绝打包），通过且有人名译名时自动生成
    角色名重定义补丁 zzz_character_names.rpy 进包。封包后要改动译文，直接改松散 tl 再重跑 tav2_pack
    （可传 clean_source=true 清理源码参考目录）。
    需要把 tl 拷到另一个游戏安装目录时用 tav2_deploy（需审批；public=true 过 G-1 闸门）。
14. tav2_verify——运行验证：格式/覆盖对账/字体检查 + 启动截图核对指引（人工执行）。

## 分册（小任务独立路由，不要求全流程前置）

| 册 | 触发 | 前置 |
|---|---|---|
| 初始化 | 无 config.yaml | — |
| 准备 | 模板缺失 | config 就绪 |
| 术语 / 世界书 / 推敲 | 用户点名 | 模板就绪 |
| 翻译（全量 / 局部 / 单场景重译） | translate_batch limit/scenes | 模板就绪 |
| 审校 | 审校 CSV | 翻译完成 |
| 校验 / 报表 | check / report | 任意 |
| 打包 / 部署 / 验证 | pack / deploy / verify | 翻译完成 |
| 迁移 | 游戏更新 | 指纹基线 |
| 已有翻译导入 | import_existing | config 就绪 |

## 规则

- 后台任务用 job_output / job_list / job_kill 管理，不要 busy-poll。
- 回填与部署是写操作，会经过审批；被拒则停止并向用户说明原因。
- 每轮翻译用 limit 控制范围，先小批量试跑再扩大（limit 是场景数）。
- 最终答复前必须跑一次 tav2_check，并给出 tav2_report 摘要。
- 游戏版本更新时用 tav2_diff 对账新旧差异，只翻新增/修改句；确需迁移用 tav2_migrate。
- 需要人工判断的内容（文化梗、双关、低置信、flagged 句）交给用户，不静默跳过。
- 世界书与推敲是半交互：tav2_worldbook_edit / tav2_deliberate_confirm 的写操作都走审批；
  人物名、世界观核心名词、可能玩梗/双关的条目与译名，确认/定论前先呈现给用户，不静默自动锁定。
- 只增量写 tl/<lang>，绝不修改原游戏文件；交付用 tav2_pack 打包成 <游戏名>/game/ 补丁。
- 游戏内语言切换默认走 Ren'Py 原生语言菜单（设置→语言，零代码）。确需在设置界面新增语言切换控件、
  或设置/排查中文字体与样式、或收尾阶段处理角色名/输入提示词残留时，先加载对应分册技能再动手：
  tav2-renpy-langswitch（语言切换与设置界面）、tav2-renpy-font（字体与样式）、
  tav2-renpy-closure（模板外残留收尾：角色名/输入提示词）。分册知识自包含（决策树 + 代码配方 + 验证步骤），按分册执行，
  不要凭记忆自由发挥；尤其覆盖设置屏前必须先读游戏源码确认真实屏名（如 preferences vs preferences_screen）。
- 非侵入契约：交付物全部为新增文件，绝不覆盖/修改任何原游戏文件；tav2_pack 会自动在补丁包内生成
  tav2-manifest.json 与 README 路径清单，删除清单所列路径即可完全还原（可用 tav2_uninstall 按清单删除，需审批）。
- 运行时前置条件（未用 tav2_font 挑选时用户自装的 CJK 字体）不属补丁包、不登记进 manifest；
  已用 tav2_font 挑选落地的 tl/<lang>/font/ 属补丁包产物，随 rpa 交付、可随补丁卸载还原。


## 运行时分册（`tav2kit skill print --booklet <名>` 取用）

### langswitch：Ren'Py 设置界面语言切换接入配方：原生语言菜单 → 游戏自带切换器 → 整屏覆盖，含屏名陷阱与验证。

# Ren'Py 设置界面语言切换（补丁式）

非侵入契约：所有产物都是 tl/<lang>/ 下的新增 .rpy 文件，绝不修改原游戏文件；
只交付 .rpy、不带 .rpyc（带 .rpyc 会因版本不匹配静默用旧码或要求重编译，是「改了不生效」事故源）。

## 决策树：先选机制，再动手

1. 设置→语言里已有目标语言（Ren'Py 原生语言菜单可见）→ **零代码**：只写 tl/<lang> 译文，不加任何控件。
2. 游戏自带语言切换器（自定义字典/UI 驱动）→ **配方 A**：守卫式注册进游戏机制。
3. 都没有、确需设置内控件 → **配方 B**：init offset = 1 整屏覆盖 + 标准 Language action。

优先级 1 永远最优（零风险）；A/B 动手前必须先做「通用前置」。

## 通用前置（A/B 都适用）

1. **先读原游戏源码，不要猜**：解开 rpa 或直接读 game/ 目录，找到设置界面真正被打开的 screen 名
   （ShowMenu("...") / call screen 指向的那个）。屏名猜错 = 覆盖静默失效。
   真实案例：游戏真实屏是 preferences_screen，补丁却覆盖 preferences——玩家看不到任何按钮，也无报错。
2. **整屏复制必须逐行照搬原屏**：漏掉任何原设置项，覆盖后玩家就看不到它了（等于把设置弄坏）。
3. **语言切换按钮必须无条件渲染**：不能包在 if 当前语言==中文 里，否则切过去就切不回来。
4. **标签包 _()**：label _("Language") / textbutton _("English")，让 translate strings 能翻它们；
   顺带把切换器自身标签翻成中文（"Language"→"语言"、"English"→"英语"），
   否则玩家在英文菜单里找到切换器也看不懂。
5. 覆盖文件放进 tl/<lang>/ 即可被当普通脚本解析；产物由 tav2_pack 登记进补丁包 manifest（可删还原）。

## 配方 A：注册进游戏自带语言机制

适用：游戏自带切换器且以字典驱动（字典名随游戏而异，必须先读源码确认）。

    # tl/<lang>/screens_patch.rpy（新增文件）
    init python:
        # 仅当游戏真定义了该字典才注册；globals() 守卫，无此机制时跳过，绝不让 init 崩掉
        if "language_titles" in globals():
            language_titles["chinese"] = "中文"
        if "language_title_fonts" in globals():
            language_title_fonts["chinese"] = "tl/chinese/font/Thin.ttf"

不要硬编码游戏专属字典名而无守卫——没有该字典的游戏 init 直接 NameError。

## 配方 B：init offset = 1 整屏覆盖设置界面

核心机制：init offset = 1 让本文件所有 init 级定义（含 screen）后于游戏原定义执行，
同名 screen 即替换原屏——不碰原文件即可「重写」。

    # tl/<lang>/zzz.rpy（新增文件）
    init offset = 1

    screen preferences():          # 屏名必须是游戏真正打开的那个（见通用前置 1）
        tag menu
        use game_menu(_("Options"), scroll="viewport"):
            vbox:
                # ===== 以下整段 = 游戏原设置界面逐行复制，一项都不能少 =====
                # ...（照搬原屏全部设置项）...
                # ===== 贴合原 UI 的位置插入语言切换（无条件渲染）=====
                vbox:
                    style_prefix "radio"
                    label _("Language")
                    textbutton _("English") action Language(None)
                    textbutton _("中文") text_font "tl/chinese/font/Regular.ttf" action Language("chinese")

要点：Language("chinese") / Language(None) 是 Ren'Py 标准 action，任何游戏通用；
中文按钮必须给 CJK 字体，否则「中文」两字显示成豆腐块。

## 配套与验证

- 一次性强制中文（首次安装体验）：persistent 旗标只推一次，避免每次启动都强制；
  刻意不用 config.default_language（它只在玩家从未启动过游戏时才生效）。

    init python:
        if persistent.force_chi_once is None or persistent.force_chi_once:
            persistent.force_chi_once = False
            config.language = "chinese"

- 覆盖屏是「写入 ≠ 生效」最高危改动：必须 tav2_verify 运行时层 + 实机确认
  「按钮真的出现在设置里、点了真的切换、能切回原文」，不能把文件写对当生效。
- 游戏更新后原屏可能新增/改布局，覆盖需随版本重建（tav2_fingerprint 检测到源文件变化时提示）。
- 多个改屏补丁共用 init offset = 1 会互相撞：动手前排查游戏是否已有同类改屏补丁。

### font：Ren'Py 中文字体与样式落地配方：tav2_font 标准路径、gui 变量与自定义 style 的按语言覆盖、fail-closed 前置。

# Ren'Py 中文字体与样式落地（补丁式）

非侵入契约：字体与样式产物全部是 tl/<lang>/ 下的新增文件（字体本体 + 覆盖脚本），
绝不修改游戏原 gui.rpy、原脚本或原字体文件。只有落地进 tl/<lang>/font/ 的字体随补丁包交付；
用户自装的运行时字体不属于补丁包。

## 决策树：先走标准工具，再考虑手工配方

1. **标准路径（优先）**：tav2_font list 枚举候选（游戏自带 / 系统已装 CJK / 手动路径，含家族/字重/版权），
   tav2_font pick <id> 落地：复制字体到 tl/<lang>/font/、自动生成按语言条件的样式覆盖 fonts.rpy、
   写 config.yaml fonts.default/map（写操作需审批；重复 pick 幂等替换）。
   覆盖这些标准 gui 变量：gui.text_font（对话框正文）、gui.name_text_font（说话人名）、
   gui.interface_text_font（界面）、gui.button_text_font、gui.choice_button_text_font（选项）、
   gui.system_font。游戏走标准 gui 变量体系时，这一步就够了。
2. **自定义 style 残留**：若游戏源码里有 style 定义直接写 font（不经过 gui 变量，
   如 style say_dialogue: font "..."，或某屏幕的专属字体），标准路径覆盖不到——用配方 2 补。
3. **fail-closed 前置**：写任何覆盖前，先读游戏源码确认 gui.text_font 赋值真实存在；
   确认不了就只复制字体、不写覆盖 rpy，并明确告诉用户（不要猜变量名硬写）。

## 配方 1：按语言覆盖 gui 变量（tav2_font 自动生成的形态，手工补写时照此）

    # tl/<lang>/font/fonts.rpy（新增文件）
    translate chinese python:
        gui.text_font = "tl/chinese/font/Regular.ttf"
        gui.name_text_font = gui.text_font
        gui.interface_text_font = gui.text_font
        gui.choice_button_text_font = gui.text_font
        gui.button_text_font = gui.interface_text_font
        gui.system_font = "tl/chinese/font/Regular.ttf"

translate <lang> python: 块只在切到该语言时执行，切回原文自动还原——这就是「按语言条件」的机制。

## 配方 2：按语言覆盖自定义 style（gui 变量之外的残留样式）

    # tl/<lang>/font/styles.rpy（新增文件；样式名从游戏源码里抄，不要猜）
    translate chinese style say_dialogue:
        font "tl/chinese/font/Regular.ttf"

先在游戏源码里找到真正用了独立字体的 style 名再写；一次只覆盖确认过的样式。
写错样式名是静默无效（Ren'Py 不会报错），必须实机验证。

## 验证（写对 ≠ 生效）

- tav2_verify：文件层确认字体文件 + 覆盖 rpy 就位（fonts.default 已设时会核对）。
- 实机确认（人工）：对话框正文、说话人名、按钮/选项/设置界面都不再有豆腐块。
- 语言切换按钮上的「中文」两字本身也要给 CJK 字体（textbutton 的 text_font 参数），
  否则按钮自身显示方框。

### closure：Ren'Py 模板外残留收尾：角色显示名（translate python 重定义）与 renpy.input 提示词的机制、门禁语义与手工兜底。

# Ren'Py 模板外残留收尾（角色名 / 输入提示词）

背景（两轮实机事故复盘）：翻译模板由官方 translate 机制生成，只覆盖 say 对话与 _()/菜单字符串；
「覆盖率 100%」是**对模板自身单元集**算的自指指标——模板外的玩家可见文本漏译不会被发现，
曾连续两个游戏交付后仍然英文名/英文提示。收尾对账把这类残留补进绿门。

## 两类残留的机制与标准处理

1. **角色显示名**（define ro = Character("Robin")）：
   - Ren'Py 对 say 语句的 who **不查字符串翻译表**（读引擎 character.py 实证）——
     往 strings 里加 old "Robin" 救不了名字显示。
   - 名字包了 __()/_() 的（如 Character(__("Sparrow"))）走延迟字符串翻译，prepare 的 _() 扫描
     已提取、正常翻即可。
   - **裸字符串名**：唯一非侵入修法是 translate <lang> python: 重定义 Character。标准产物：
     tl/<lang>/zzz_character_names.rpy，tav2_pack 会**自动生成**（译名来自锁定术语，
     所以人名译名要先走术语/推敲链路锁定），无需手写。
   - 动态名（None 旁白、变量、[插值]、label 内 $ 运行时赋值）不进补丁也不该手补——
     init 级重定义会被运行时赋值覆盖，处理需个案分析。
2. **renpy.input 提示词**（renpy.input("Enter your name...")）：
   - 裸字符串首参官方模板不提取；prepare/模板补入已把字面量形态写入 strings（可译）。
   - 若实机仍显示英文（个别引擎版本/自定义 input 屏），按配方：init offset = 1 覆盖该游戏
     的 input screen，text prompt 处给译文或包 __()（先读游戏源码确认 input 屏名与结构）。

## 门禁语义（怎么读 check/pack 的对账输出）

- tav2_check：「模板外残留对账」段——未收口会列出每条 issue（人名缺译名 / 提示词未入字符串表）；
  编译版游戏需要 <游戏根>/tav2_src 源码参考目录在场才能对账（pack clean_source=true 清场后无法再对账）。
- tav2_pack：对账未通过 = fail-closed 拒绝打包，提示先锁术语/补提示词；通过则自动生成人名补丁进包。
- 补救顺序：锁定人名术语（tav2_deliberate_confirm，写操作需审批）→ 重跑 tav2_check → tav2_pack。

## 验证（写对 ≠ 生效）

- 人名：进游戏看对话框说话人名是否中文（切到目标语言后）。
- 提示词：跑到起名/输入环节看输入框标题。
- 人名补丁是 translate python 块：切回原文语言自动还原英文名，属预期行为（不是没生效）。
