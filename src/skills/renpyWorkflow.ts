import type {} from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'

/** 注册 tav2-renpy-workflow 技能：dsh 模型按此流程编排翻译。 */
export function registerRenpyWorkflowSkill(ctx: Context): void {
  ctx.skills.register({
    name: 'tav2-renpy-workflow',
    description: '用 tav2 工具完成 Ren\'Py 视觉小说的中文化标准流程。',
    whenToUse: '用户要求翻译或汉化 Ren\'Py 视觉小说时',
    source: 'runtime',
    content: `# Ren'Py 汉化标准流程（tav2）

换游戏 = 新建工作区；不要在会话里做项目切换。

## 第一步：初始化（仅当工作区还没有 config.yaml 时）

当前工作区还没有 config.yaml 时，先向用户确认要翻译哪个游戏，然后：
- 用 tav2_init（不传参数）探测工作区及其子目录里的 Ren'Py 游戏；发现多个候选时
  把列表给用户确认，再 tav2_init <游戏目录> 指定。
- tav2_init 会生成最小 config.yaml（engine: renpy + game_dir + lang: chinese）到
  游戏根目录，写盘前会请求审批；成功后全套工具与本流程自动就绪。
- 已有 config.yaml 的工作区跳过本步，直接看下面的流程。

## 新工作区第一轮（确认协议）

1. 只读跑 tav2_detect（确认引擎）与 tav2_status（项目进度），不写任何东西。
1.5 翻译开始前先 tav2_fingerprint snapshot 记录游戏版本指纹基线（写操作，需审批）；
    之后 tav2_status / tav2_fingerprint check 会在源文件变化时提示「游戏可能已更新」。
2. 用原生 todo 列出完整翻译计划：步骤 1..N、每步范围、要做的动作、
   哪些是写操作（会请求审批）、预估 token/成本。
3. 等用户明确确认后再开始；用户确认前不做任何写操作。

## 后续轮次

- 从 todo 续接进度，不要重复出计划。
- 模板未生成时从 tav2_prepare 开始。

## 流程

1. tav2_prepare（后台任务）——生成 tl/<lang> 翻译模板。
1.5 tav2_font——中文字体挑选与落地：list 枚举候选（游戏自带/系统已装/手动路径）→ pick <id>
    复制字体到 tl/<lang>/font/、自动生成样式覆盖 fonts.rpy（先确认 gui.text_font 存在，确认不了只复制不写覆盖）、
    写 config fonts.default/map（写操作需审批；重复 pick 幂等替换）。字体随 tl/<lang> 一起被打包/部署。
2. tav2_terms——快扫术语候选（范围宽：人名/地名/专有世界观名词/玩梗词等）。
3. tav2_terms apply——从候选中锁定关键术语（写操作，需审批；作为世界书与推敲的译名约束）。
4. tav2_worldbook——提案世界书条目（注入已锁定术语作译名约束，proposed 入库）；
   用 tav2_worldbook_edit confirm/update/delete/add 半交互确认（写操作需审批）。
4. tav2_worldbook——按名字做资料卡：种子 = 人名代码（Character 定义）→ 锁定术语 → 快扫候选；
   每个名字要么出卡、要么标「没料/失败」，不再静默吞错误；
   用 limit（最多处理几个名字）/terms（指定名字）/force（强制重跑）控制范围，报告按名字算覆盖；
   用 tav2_worldbook_edit confirm/update/delete/add 半交互确认（写操作需审批）。
5. tav2_deliberate——推敲（注入确认过的世界书背景，按用典/玩梗/文化/韵律/双关/短习俚多维判定，
   高置信无冲突自动锁，其余待决）；用 tav2_deliberate_confirm list/approve/reject/update 定论（需审批）。
6. tav2_translate_batch（后台任务）——分批双阶段翻译，自动按 limit/batch 语义切批，
   最多同时派 {{tav2_subagent_max_workers}} 个子代理并行翻译（原生子代理视图可见）；
   先用小 limit 试跑，质量稳定再扩大。所有批次完成后由主代理汇总。
7. 审校：translate_batch review=true 产出审校 CSV；用户确认后 tav2_review_backfill 回填（需审批）。
8. tav2_check——标识符/标签完整性 + 世界书↔术语一致性校验，全部通过才算。
9. tav2_report——生成覆盖率/风险/审校队列/成本报表，向用户汇报进度。
10. 涉及公开发布前：tav2_compliance 检查/记录 G-1 授权（status=authorized, authorized=true），
    未授权时 tav2_deploy 只能用本地部署（public 缺省）。
11. tav2_deploy——部署 tl 到目标游戏（需审批；public=true 会过 G-1 闸门）。
12. tav2_verify——运行验证：格式/覆盖对账/字体检查 + 启动截图核对指引（人工执行）。

## 规则

- 后台任务用 job_output / job_list / job_kill 管理，不要 busy-poll。
- 回填与部署是写操作，会经过审批；被拒则停止并向用户说明原因。
- 每轮翻译用 limit 控制范围，先小批量试跑再扩大（limit 是场景数）。
- 最终答复前必须跑一次 tav2_check，并给出 tav2_report 摘要。
- 游戏版本更新时用 tav2_diff 对账新旧差异，只翻新增/修改句。
- 需要人工判断的内容（文化梗、双关、低置信、flagged 句）交给用户，不静默跳过。
- 世界书与推敲是半交互：tav2_worldbook_edit / tav2_deliberate_confirm 的写操作都走审批；
  人物名、世界观核心名词、可能玩梗/双关的条目与译名，确认/定论前先呈现给用户，不静默自动锁定。
- 只增量写 tl/<lang>，绝不修改原游戏文件；交付用 tav2_pack 打包成 <游戏名>/game/ 补丁。
- 游戏内语言切换默认走 Ren'Py 原生语言菜单（设置→语言，零代码）。确需在设置界面新增语言切换控件时，
  按 docs/RENPY-LANGUAGE-SWITCH-RECIPE.md 决策：
  ① 游戏自带语言切换器 → 守卫式注册进游戏机制（如 language_titles["chinese"]="中文"，带 globals() 守卫）；
  ② 否则 → init offset = 1 整屏覆盖设置界面 + 标准 Language("chinese") / Language(None) action。
  硬条件：先读原源码确认真实屏名（ShowMenu 指向的那个）、逐行完整复制原屏、语言按钮无条件渲染
  （所有语言可见，否则切不回原文）、标签包 _()、只交付 .rpy 不带 .rpyc；覆盖屏是「写入≠生效」高危改动，
  必须 tav2_verify 运行时层 + 实机确认「按钮真的出现在设置里」，不能把文件写对当生效。
- 非侵入契约：交付物全部为新增文件，绝不覆盖/修改任何原游戏文件；tav2_pack 会自动在补丁包内生成
  tav2-manifest.json 与 README 路径清单，删除清单所列路径即可完全还原（可用 tav2_uninstall 按清单删除，需审批）。
- 运行时前置条件（未用 tav2_font 挑选时用户自装的 CJK 字体）不属补丁包、不登记进 manifest；
  已用 tav2_font 挑选落地的 tl/<lang>/font/ 属补丁包产物，随 rpa 交付、可随补丁卸载还原。
`,
  })
}
