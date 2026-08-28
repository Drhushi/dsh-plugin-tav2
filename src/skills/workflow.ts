import type {} from '@deepseek-ai/dsh-skill'
import type { Context } from '@deepseek-ai/cordis'
import { registerRenpyBookletSkills } from './renpy'

/**
 * 注册 tav2 技能组：主流程技能（tav2-workflow）+ Ren'Py 运行时分册
 * （tav2-renpy-langswitch / tav2-renpy-font，HOW-TO 知识自包含、随 dist 交付）。
 * dsh 模型按主技能编排翻译，涉及语言切换/字体样式时按 whenToUse 命中分册。
 */
export function registerWorkflowSkill(ctx: Context): void {
  ctx.skills.register({
    name: 'tav2-workflow',
    description: '用 tav2 工具完成游戏汉化的标准流程（当前完整适配 Ren\'Py）。',
    whenToUse: '用户要求翻译或汉化视觉小说时',
    source: 'runtime',
    content: `# 游戏翻译标准流程（tav2）

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
`,
  })
  registerRenpyBookletSkills(ctx)
}
