# 内容工作流核心合同

`src/core/content-workflow.mjs` 是无第三方依赖的纯函数模块。它保存读资料与持续对话后得到的**明确结构化判断**，核对引用，计算影响并使旧复核失效。它不从关键词猜意图，不调用模型，不证明资料已真实读取，也不生成或验收 PPT、图片和网页。读取范围由可信读取适配器或实际操作者提交；客户端自由声明不是读取真实性证据。

## 三个入口

```js
import { createContentWorkflow, applyContentWorkflow, inspectContentWorkflow }
  from '../src/core/content-workflow.mjs';

let workflow = createContentWorkflow({
  brief: { mode: 'existing', audience: '业主', purpose: '解释已定入口方案', outputs: ['ppt'] },
  assets: [{ id: 'plan', roles: ['project-asset'], readStatus: 'partial', readScope: ['page:1'] }],
});

workflow = applyContentWorkflow(workflow, { operations: [
  { type: 'appendDialogue', value: { id: 'message-1', role: 'user', text: '这次只解释已定方案。' } },
  { type: 'upsertSource', value: { id: 'source-plan', assetId: 'plan' } },
  { type: 'upsertStatement', value: {
    id: 'entry-fact', kind: 'fact', scope: 'project', text: '入口名称为迎宾厅',
    evidence: [{ sourceId: 'source-plan', locator: 'page:1' }],
  } },
  { type: 'upsertContentUnit', value: {
    id: 'entry', purpose: '说明入口位置和名称', statementIds: ['entry-fact'],
    decisionIds: [], assetIds: ['plan'], protectedDetails: ['保留图纸边界和原图例'],
  } },
  { type: 'upsertMapping', value: {
    id: 'entry-slide', medium: 'ppt', locator: 'slide:2', contentUnitIds: ['entry'], templateAssetIds: [],
  } },
] }, { expectedRevision: workflow.revision });

const inspection = inspectContentWorkflow(workflow);
// { readyForProduction: true, issues: [], revision: 1 }
// true 只表示结构可进入制作规划；未证明事实正确、实际制作完成或用户认可。
```

`applyContentWorkflow` 也接收单个 `{ type, value }`。一个批次原子提交；跨记录引用按整个批次结束后的状态校验，可在同批中先声明引用再新增来源。所有入口返回独立 JSON；不会原地修改调用方对象。没有时间、随机数、文件或网络副作用。

## 状态与记录

顶层含 `schemaVersion:1`、`revision`、`brief`、`assets`、`dialogue`、`sources`、`statements`、`decisions`、`contentUnits`、`mappings`、`reviews`、`feedback`、`history`、`lastImpact`。每个实体自动得到 `version` 与 `updatedRevision`。同一实体有实质变化才递增实体版本；每个成功批次都递增工作流 `revision`。历史保存原始明确操作、修订号与依赖影响，初次创建也保存原始 brief 和素材。

| 记录 | 必需字段与枚举 |
| --- | --- |
| `brief` | `mode`: `existing / co-create / layout`；`audience`、`purpose`；`outputs`: `ppt / web / images` 数组。创建允许缺少前三项；未填写时检查不就绪。 |
| `assets[]` | `id`、`roles`、`readStatus`、`readScope`。角色为 `project-asset / design-case / visual-reference / fixed-template`，可多选。读状态为 `unread / partial / read`。创建时未写读状态默认 `unread`。 |
| `dialogue[]` | `id`、`role`: `user / assistant`、`text`。仅追加，不允许以相同 ID 覆盖历史话语。 |
| `sources[]` | `id`，以及 `assetId` 或 `dialogueId` 中恰好一项。 |
| `statements[]` | `id`、`kind`: `fact / observation / interpretation / proposal`、`scope`: `project / reference`、`text`、`evidence`。 |
| `decisions[]` | `id`、`need`、`response`、非空 `actions` 字符串数组、`status`: `existing / interpretation / proposed`、`statementIds`、`decisionIds`、`evidence`。`decisionIds` 是上游依赖，不允许循环。 |
| `contentUnits[]` | `id`、`purpose`、`statementIds`、`decisionIds`、`assetIds`、`protectedDetails` 字符串数组；至少引用一种内容或资产。 |
| `mappings[]` | `id`、`medium`: `ppt / web / images`、`locator`、非空 `contentUnitIds`、`templateAssetIds`。内容资产与模板绑定分开。 |
| `reviews[]` | 由 `recordReview` 写入 `{id,scope,status,record}`，状态仅可提交 `reviewed / needs_changes`。自动加 `reviewedRevision`，依赖变化时变为 `stale` 并加 `invalidatedRevision`。它是操作者声明的复核记录，不是用户认可状态。 |
| `feedback[]` | 由 `feedback` 追加 `{id,dialogueId,scope,layer,note}`，必须指向用户话语；`layer`: `intent / content / evidence / visual / medium`。反馈登记影响，不自动改写事实或页面。 |

`evidence` 为 `{sourceId, locator}` 数组。部分读取时，定位必须与对应资产 `readScope` 中某项精确相同，例如 `page:12`；不要用含糊范围文本冒充已读取位置。完整读取 `read` 允许引用任一明确定位，真实性仍由上游读取证据保证。

非建议陈述必须有证据。`fact` 的项目范围只接受项目资产或用户对话来源，不能直接把案例或模板内容移植过来。观察要求实际资产来源。助手话语不能成为独立证据。`existing` 决策要求项目或用户证据，不能由解释/建议陈述证明原设计理由；这只能阻止显式身份混用，不能自动识别文本中的虚假因果。`layout` 模式不允许新提议的设计决定。

## 变更、反馈与失效

明确操作有 `setBrief`、`upsertAsset`、`appendDialogue`、`upsertSource`、`upsertStatement`、`upsertDecision`、`upsertContentUnit`、`upsertMapping`、`recordReview`、`feedback`。全部用 `value` 传记录。`setBrief` 合并所给字段；各 `upsert` **整记录替换**，不能省略原有数组或读取状态来做隐式补丁。模块暂不提供删除操作；避免删除后留下隐含引用。撤回某依据时，需要在同一批次明确重写受影响陈述与引用。

反馈和复核的 `scope` 为 `{kind,ids}`。`kind` 可为 `workflow / asset / template / statement / decision / contentUnit / mapping`；`workflow` 的 `ids` 必须为空，其余至少一个存在 ID。`template` 只接受有 `fixed-template` 角色的资产。

依赖传播顺序为“素材 → 来源 → 陈述 → 决策（递归）→ 内容单元 → 输出映射”。源直接支持的决策和直接使用素材的内容也会纳入。模板反馈只影响采用该模板的映射，不改项目资产或内容单元。映射反馈只影响选定输出，事实与分析更新则影响所有引用它的媒介。`setBrief` 的实质变化使全工作流复核失效。新聊天本身不触发语义变化；需由可信适配器提交对应明确操作。

`lastImpact` 和历史里的 `impact` 含 `workflow`、`sourceIds`、`assetIds`、`templateIds`、`statementIds`、`decisionIds`、`contentUnitIds`、`mappingIds`、`reviewIds`。工作流级复核在任何实际内容或定向反馈变化后失效。改变同一条记录但内容相同是无影响操作。显式 `recordReview` 在本批次最终状态上记新复核；它不能代替实际看图或核对来源。

## 校验、冲突和接入边界

- 结构或引用错误抛 `Error`，`code: WORKFLOW_INVALID`，`issues: [{code,path,message}]`。不提交部分状态。
- `expectedRevision` 与当前版本不同，抛 `code: WORKFLOW_CONFLICT`，附 `expectedRevision` 与 `actualRevision`。持久化宿主应同时做数据库/文件层 CAS；纯函数检查不能解决跨请求写入竞态。
- `inspectContentWorkflow(state)` 返回 `{readyForProduction,issues,revision}`；无效状态返回问题，不宣称部分结构可用。完整 brief、可用内容、已读生产资产/模板、每个内容单元到请求媒介的映射，以及无待改/过期复核，才是结构就绪。当前模型要求每个单元覆盖 brief 中的全部请求媒介；按媒介裁减内容时应提交适当的独立工作流，或后续显式扩展覆盖合同。
- `readyForProduction` 不要求伪造复核记录，也不表示自动理解、事实通过、审美通过、用户认可、真实渲染或软件目标端实测。
- 服务应仅让可信读取/理解适配器提升读取状态与证据声明，并限制请求大小；本模块不处理账户授权、上传文件检查、模型工具执行或费用。

验证命令：`node --test test/content-workflow.test.mjs`。测试数据均为虚构合同数据；不作为真实资料或制作实测。
