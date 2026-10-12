# 已渲染样稿的清单与封装

`production-manifest.mjs` 是独立的本地辅助工具，不替代内容理解、图片生成、PPT 作者工具或看图复核，也未接入当前工作台 API。

```text
node scripts/production-manifest.mjs check manifest.json
node scripts/production-manifest.mjs bundle manifest.json --out new-empty-delivery
```

路径相对于清单所在目录，也可使用本机绝对路径。`bundle` 只复制实际样页和明确列出的 PPTX/PDF，生成保持样页原比例的离线 `index.html`、`notes.md`、`production-receipt.json`。不复制原资料，也不生成或重新排版 PPT。输出目录须新建或为空。

草稿允许缺少内容分析、参考应用或视觉复核，但检查结果会明确警告。`accepted`、`applied`、`editable` 等积极声明需要对应证据；工具核对记录与文件存在，不替用户批准，也不能自动判定事实正确、设计高级或编辑性真实通过。

## 最小可运行样稿

先将已实际生成的图片存为 `sample.png`。以下是清单格式示例，不是实际项目证据：

```json
{
  "schemaVersion": 1,
  "id": "example",
  "title": "示例样稿",
  "revision": 1,
  "pages": [{
    "id": "sample-1",
    "title": "样页",
    "mode": "reference-visual",
    "imagePath": "sample.png",
    "notes": "本页讲稿。"
  }],
  "sample": { "pageIds": ["sample-1"], "status": "draft" }
}
```

## 逐步补齐的字段

| 字段 | 结构和含义 |
|---|---|
| `sources` | `{id,label,path?,locator?,readScope?,summary?}`；实际来源及阅读范围。远程地址放 locator，不自动下载 |
| `assets` | `{id,path,sourceId?,role?}`；实际素材。originalAsset 引用这里的 id |
| `references` | `{id,path?,observations:[文字],constraints:[文字]}`；具体参考画面与规则，不只有编号 |
| `contentUnits` | `{id,text,kind,sourceRefs:[{sourceId,locator}]}`；kind 为 fact / observation / proposal，分别表示来源事实、观察、建议 |
| `pages[].contentUnitIds` | 本页使用的内容单元 id |
| `pages[].assetIds` | 本页使用的素材 id |
| `pages[].referenceBinding` | `{referenceId,status,constraintChecks}`；status 为 candidate / applied / preserved |
| `constraintChecks` | `[{constraint,result,evidence}]`；applied 必须逐项对应 references.constraints，result 为 matched / deviated，evidence 写真实样页对照 |
| `pages[].protectedAssets` | `[{originalAsset,fit:"contain",mayRegenerate:false,placement?}]`；placement 可为 `{x,y,width,height,unit:"px"或"pt"或"normalized"}`，仅在实际放置后填写 |
| `sample` | `{pageIds,status,userEvidence?}`；status 为 draft / changes_requested / accepted；accepted 必须有明确采用页与用户证据 |
| `review.visual` | `{status,record?}`；status 为 pending / reviewed / needs_changes；reviewed 须记录具体看图结论 |
| `exports` | `[{path,format,type,editabilityEvidence?}]`；format 为 pptx / pdf；type 为 image_based / editable |
| `editabilityEvidence` | `{path,scope}`；引用真实编辑性检查文件，并说明具体可编辑对象。工具仅检查文件存在 |

页面 mode：native-authoring / native-template / source-facsimile / reference-visual / editable-reconstruction / semantic-web / magazine-native。`native-authoring` 用于无固定模板的新建原生 PPT，仍需实际制作与编辑性验证。

`preserved` 只适用于 `source-facsimile`，且工具将逐字节比较参考图片和输出样页；PDF 页面渲染或重新编码导致字节不同的，需使用 applied 加人工对照记录。材料标签、技术图纸、Logo 的 `mayRegenerate:false` 只是约束，实际保真仍需看图，不能冒称工具已验证。

打包清单省略来源原文件路径，但讲稿、内容来源定位、复核记录按输入保留。它是本地项目交付包，分享前仍需检查这些文字是否包含私人信息。

验证：`node --test test/production-manifest.test.mjs`。这些测试检查错误声明、引用完整性与文件封装，不为审美或 PPT 兼容性背书。
