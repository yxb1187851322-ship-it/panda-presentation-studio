# 风格资产合同

实现：`src/core/style-profile.mjs`。仅使用 Node 内置模块，无第三方依赖。它记录风格资产及选择条件，不生成页面、不评价审美、不鉴定反馈真实性。样式数据由调用者提供，没有默认“高级”模板。

## 三个接口

### createStyleProfile(input)

始终建立 `candidate`，忽略外部附带的认可状态。必需字段：

```js
{
  id, name, version, // 非空字符串
  origin: {
    kind: 'authored' | 'licensed-template' | 'research-case',
    sourceRef,
    productionAllowed: true, // 缺失时视为未确认
    licenseRef // licensed-template 用于生产时必需
  },
  tokens: {
    typography: { fontFamily, headingPt, bodyPt, captionPt },
    colors: { background: '#FFFFFF', foreground: '#202020', accent? },
    spacing: { marginRatio, gutterRatio }
  },
  layout: {
    canvas: { width, height },
    slots: [{ id, role: 'image' | 'drawing' | 'logo' | 'text',
      x, y, width, height, // 0–1 归一化，矩形须在画布内
      fit: 'contain' | 'cover' | 'none', required? }]
  },
  constraints: {
    contentTasks: [/* 页内容任务标识 */],
    outputs: ['pptx' | 'html' | 'png'],
    requiredAssetKinds?, minImageWidth?, minImageHeight?,
    imageAspectRatios?, aspectRatioTolerance?
  }
}
```

`research-case` 原资产始终不能作为生产模板，即使提供了 `productionAllowed: true`。研究方法可以形成另一个自行编写的 `authored` 风格定义，但不能借改标签转移原图片、字体、代码或模板的使用权。来源和许可字段的真实性由宿主核验。

### recordStyleFeedback(profile, event)

- `action: 'trial'`：提供 `taskId` 和 `sample`，进入试用；新试用清除旧认可。
- `action: 'accept'`：仅从试用进入认可，提供当前完全一致的 `sample` 和 `feedback`。
- `action: 'reject'`：提供 `feedback`，进入拒绝并清除认可。不可用普通 trial 把被拒资产重新变为可推荐状态；修改后应建立新版本候选。

`sample = { id, version, profileVersion, artifactRef, renderRef }`。

`feedback = { id, actorRole: 'user', actorId, evidenceRef, quote, recordedAt }`。

所有这些字段均须非空；时间须能解析。重复反馈 ID 报错。试用和认可绑定具体样页、渲染记录与风格定义的 SHA-256 指纹。即使调用者漏升风格版本，tokens、布局、条件等发生变化也使旧认可失效；改变定义后需要新的样页版本。

字段完整只说明记录结构完整。宿主仍须验证用户身份、真实反馈、引用的具体页面与渲染文件存在，以及事件授权；模块不是签名服务或鉴定器。

### inspectStyleFit(profile, request)

```js
{
  taskId, contentTask, output,
  assets: [{ id, kind: 'image' | 'drawing' | 'logo', width, height, noCrop? }],
  placements: [{ assetId, slotId }],
  explicitStyleRequest?: {
    profileId, profileVersion, taskId, actorRole: 'user', evidenceRef, quote
  }
}
```

assets 是拟放到本页的素材，不是全项目素材库。尺寸采用原图像素；placement 指向确切槽位。所选素材均需有去处，必需槽位均需填充，角色必须对应。`text` 槽位不由此接口做文字溢出检测。

返回 `{ profileId, profileVersion, profileState, taskId, eligible, decision, scope, reasons, evidenceStatus, reviewRequired }`。

- `decision: 'candidate'`：条件匹配，可进入样页设计；即使历史状态为 accepted，也不会返回“审美通过”。
- `decision: 'task-trial'`：明确指定该版本且带用户证据的本次例外；不改写原状态，不转为认可。
- `decision: 'blocked'`：拒稿、过期认可、研究原资产、许可未确认或素材条件不匹配。
- `reasons` 为 `{code, message}` 数组，可由 UI 展示。输入结构错误抛带字段路径的 `TypeError`。

明确指定可以允许本次试用被拒风格，不能越过研究来源、素材和图纸保护条件。Logo 与图纸强制 `contain`；图片 `noCrop` 与 `cover` 的兼容性使用原图宽高和具体槽位宽高计算，不用宽泛比例容差掩盖裁切。原件颜色、内容、标注是否保持仍需渲染器和实际视觉复核。

不根据年龄、性别、肤色推断风格偏好；传入的 audience 元数据不参与选择。未来偏好匹配应使用用户明确表达及其证据。

三个接口均不原地修改入参，结果递归冻结。更换风格内容应创建新版本，不能把修改后的数据继续挂在旧认可之上。

## 验证

运行 `node --test test/style-profile.test.mjs`。测试覆盖状态迁移、失效认可、同版本定义变更、反馈结构、研究/生产边界、拒稿例外范围、适用条件、具体尺寸与 no-crop、Logo/图纸保护、人口信息独立及错误输入。测试通过只代表这些代码规则通过。
