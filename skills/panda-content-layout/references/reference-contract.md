# 内容、参考与制作记录

由代理维护，用户只需提供资料、对话和反馈。记录服务于改稿、对照与复用，不替代看图和设计，也不是要求用户填写的表单。简单单页按实际内容简化，不为填字段编造关系。

## 内容单元

每条进入成品的信息对应来源与身份：

- `fact`：来自用户或资料的明确陈述，保留来源页/段落和原文依据。
- `observation`：从实际画面观察到的现象，保留对应图像；不升级为精确规格。
- `proposal`：Panda 提出的编辑或设计建议，在成品语境中不伪装为既有事实。

“浅木外观”可以是观察，“橡木饰面、用于某墙面”需要明确来源。内容单元须保留相关材料代码、方案状态、图像身份和未知项；不因新标题好看就改变它们。

Panda 功能介绍区分已实现、本轮代理实际完成和规划。第三方案例文案仅因版面被选中，不能成为 Panda 产品事实。

## 参考绑定

参考记录包括真实可见页、读取范围、观察与约束。每个成品页绑定实际参考，使用三种状态：

| 状态 | 意义 | 所需证据 |
| --- | --- | --- |
| `candidate` | 仅检索或选择为候选 | 实际来源与阅读范围；不能声称已经复用 |
| `applied` | 对输出真正应用了具体关系 | 成品路径、对应约束及逐项对照结果 |
| `preserved` | 沿用原页的保真展示 | 原页与输出、画幅与完整边界检查；不等于可编辑重建 |

约束写成可检查的关系：主图完整范围、标题与图边的共同轴线、背景与原页边缘、文字层级、允许替换对象和不允许改动对象。避免“高级”“大气”或统一图片占比作为唯一约束。

未核对时保持 `candidate`，对应约束可记 `unchecked`。进入 `applied` 后，`constraintChecks` 逐项对应参考约束，`result` 使用 `matched` 或 `deviated` 并提供证据。证据指出实际画面的位置或文件，不以“已按提示词执行”代替对照；发现偏离记录原因和修订，不反写约束迎合成品。

配套检查工具对 `preserved` 有更窄的执行定义：仅限 `source-facsimile`，且参考预览图与样页须逐字节一致。原 PDF 的页面渲染、重新编码或其他不同字节产物使用 `applied` 并提供对照记录；视觉保真不能冒充字节相同。

## 保真资产

资产身份与风格参考分开。`protectedAssets.originalAsset` 引用 `assets[].id`；`mayRegenerate:false` 表示禁止生成替换，不能独自证明资产已被保护。实际放置后才记录 `placement`，包括 `x/y/width/height/unit`；`fit:contain` 仅表示等比完整容纳，仍须核对图像实际边界与必要标签。

原始 CAD、Logo、工程标注、真实图表和需要忠实的项目图片保留原件，转换、提取和裁切用派生件并关联来源。若有授权裁切，记录允许裁切范围；图纸的几何、尺寸和必要边界不能靠普通照片裁切规则处理。

## 样张与检查状态

`sample.status` 为 `draft`、`changes_requested` 或 `accepted`。`accepted` 必须有用户针对该样张的真实反馈及定位；“可以开始”“先做”“读过参考”不等于认可。一般制作授权不必重复索取，也不等于可以伪造接受状态。

`review.visual.status` 为 `pending`、`reviewed` 或 `needs_changes`。`reviewed` 只表示已做视觉检查，不自动代表用户满意；记录具体结果和未解决问题。技术检查、内容核对、视觉检查、用户反馈和目标软件实测分别记录，不能互相推导。

## 与制作清单的字段约定

配套仓库的独立制作清单使用以下字段。以实际脚本支持范围为准；独立复制此 Skill 时没有脚本也可保存同等信息。现有工作台的项目 API 不一定接受这些字段，应单独保存制作清单，不能直接覆盖项目状态。

| 字段 | 内容 |
| --- | --- |
| `schemaVersion / id / title / revision` | 清单结构版本、项目标识、名称和本轮版本 |
| `sources[]` | 来源 `id / label`、路径或 `locator`、实际 `readScope`、摘要；公开包不带私人原件索引 |
| `assets[]` | `id / path / sourceId / role`；原资产和风格参考分别说明 |
| `references[]` | `id / path / observations / constraints`；事实与观察依据可定位 |
| `contentUnits[]` | `id / text / kind / sourceRefs`；引用 `{sourceId, locator}` |
| `pages[]` | `id / title / mode / imagePath / assetIds / contentUnitIds / referenceBinding / protectedAssets / notes` |
| `sample` | `pageIds / status / userEvidence`；无用户认可时保持草稿 |
| `review.visual` | `status / record`；实际检查记录或记录路径 |
| `exports[]` | `path / format / type / editabilityEvidence`；`format` 为 `pptx / pdf`，`type` 为 `image_based / editable`；后者须有 `{path, scope}` 指向真实对象检查记录 |

`pages.mode` 取值及适用情况见[制作路线](production-routes.md)。配套仓库脚本仅封装已有样页和明确列出的 PPTX/PDF，并生成等比样页查看器；`semantic-web` 模式字段本身不使查看器成为响应式内容网站。对已存在文件的检查和封装可以继续，即使样张仍待审阅；输出应明确为草稿。缺来源、未应用参考或缺编辑证据不能靠“打包成功”升级为成品。

## 本地工作文件与复用

一个项目保存本轮内容底稿、选定参考、样张提示/制作配置、实际渲染、清单和复核记录即可；不为了目录齐全复制整份私有资料库。原始文件保持只读，成果和制作记录用新的版本路径。

保存可复用风格时绑定经认可样张、适合的内容任务、字数/图幅容量、保留项与允许变化、所需资产、失败条件及用户反馈。参考作品许可与代码许可分别记录。复用该风格时仍重新理解新项目事实，不把旧项目内容随样张一起迁入。
