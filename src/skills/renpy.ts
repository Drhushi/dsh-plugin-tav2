import type {} from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Ren'Py 运行时分册技能：语言切换与字体样式的 HOW-TO 内嵌进插件、随 dist 交付。
 * 内容必须自包含——docs/ 不随 npm 包发布（package.json files 无 docs），引用仓库 docs 路径
 * 在用户机器上是死链。知识提炼自 docs/RENPY-LANGUAGE-SWITCH-RECIPE.md（Eternum 0.9.5 与
 * Hazelnut Latte 0.12.4 两个真实简中补丁复盘）与 tav2_font 的 fail-closed 语义。
 */

/** 字体与样式分册：豆腐块/字体挑选/gui 变量与自定义 style 的按语言覆盖。 */
const FONT_BOOKLET = `# Ren'Py 中文字体与样式落地（补丁式）

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
  否则按钮自身显示方框。`

/** 语言切换分册：原生菜单 → 游戏自带切换器 → 整屏覆盖，含屏名陷阱。 */
const LANGSWITCH_BOOKLET = `# Ren'Py 设置界面语言切换（补丁式）

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
- 多个改屏补丁共用 init offset = 1 会互相撞：动手前排查游戏是否已有同类改屏补丁。`

/** 收尾分册：模板外残留（角色显示名 / renpy.input 提示词）的机制、门禁与手工兜底配方。 */
const CLOSURE_BOOKLET = `# Ren'Py 模板外残留收尾（角色名 / 输入提示词）

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
- 人名补丁是 translate python 块：切回原文语言自动还原英文名，属预期行为（不是没生效）。`

/** 注册 Ren'Py 运行时分册（与主流程技能同批注册；内容自包含，不引用仓库 docs 路径）。 */
export function registerRenpyBookletSkills(ctx: Context): void {
  ctx.skills.register({
    name: 'tav2-renpy-langswitch',
    description: 'Ren\'Py 游戏内语言切换接入配方：原生语言菜单 → 游戏自带切换器 → 整屏覆盖，含屏名陷阱与验证。',
    whenToUse: '用户提到语言切换、在设置界面加语言选项、preferences/设置屏、语言菜单缺失，或翻译完成后要让玩家在游戏里切换语言时',
    source: 'runtime',
    content: LANGSWITCH_BOOKLET,
  })
  ctx.skills.register({
    name: 'tav2-renpy-font',
    description: "Ren'Py 中文字体与样式落地配方：tav2_font 标准路径、gui 变量与自定义 style 的按语言覆盖、fail-closed 前置。",
    whenToUse: '用户提到字体、豆腐块/方框、样式、style、中文显示异常，或翻译完成后要设置各界面中文字体时',
    source: 'runtime',
    content: FONT_BOOKLET,
  })
  ctx.skills.register({
    name: 'tav2-renpy-closure',
    description: "Ren'Py 模板外残留收尾：角色显示名（translate python 重定义）与 renpy.input 提示词的机制、门禁语义与手工兜底。",
    whenToUse: 'check/pack 报模板外残留、对话翻了但角色名还是英文、起名/输入提示没翻，或需要理解人名补丁 zzz_character_names.rpy 时',
    source: 'runtime',
    content: CLOSURE_BOOKLET,
  })
}
