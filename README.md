# Panda 汇报与内容编排

Panda 现有本地客户端中的内容编排能力：理解用户上传的图片、文档、图纸与品牌资料，设计内容结构，再按用途制作可编辑 PPT、项目展示网页或杂志图片。未来网页客户端复用项目与任务协议。

**当前为 v0.7 本地制作试用版：支持上传、文本提取、规则编排、逐页修改和真实 PPTX / 离线网页 / 页面 PNG 导出。尚未连接大模型与正式 Panda 客户端；CAD、扫描文字与固定母版完整继承仍待实现。**

## 从这里开始

- [启动本地工作台](docs/本地工作台.md)：上传、编排、修改与真实导出，项目保存在本机。

- [产品事实与边界](docs/产品定位与证据.md)：从用户记忆恢复了什么、当前客户端是什么、哪些接口仍未知。
- [完整工作流程](docs/从资料到交付.md)：理解、叙事、品牌、设计、制作、复核与改稿。
- [架构与接入](docs/架构与客户端接入.md)：在现有 Panda 中增加能力，保持本地与未来网页端可复用。
- [外部流程怎样借鉴](docs/外部流程与选型.md)：已有模板路线、原生新稿路线和设计方法的分工。
- [下一阶段验收](docs/实施与验收.md)：用真实材料做一组可编辑试排，再定渲染器。
- [设计卡目录](resources/design-library/README.md)：逐页研究方法与可检索数据；原稿通过本机资源绑定查找。
- [交互原型](prototype/index.html)：下载后直接打开，查看三种输出如何共享内容、分别排版。
- [专业 Skill](skills/panda-content-layout/SKILL.md)：后续规则开发主入口。

## 运行

需要 Node.js 22 或以上。核心规则无第三方运行依赖；制作工作台需要 `@oai/artifact-tool`、`sharp` 与带 `pypdf` 的 Python，使用已有运行时或自己的安装环境。模型未连接，不向外部服务上传项目文件。

```text
npm test
node scripts/start-studio.mjs
node --test test/core.test.mjs
node scripts/verify-resources.mjs
node scripts/local-library.mjs status
```

工作台默认打开 `http://127.0.0.1:4317`。配置方法见[本地工作台](docs/本地工作台.md)。`prototype/index.html` 保留为旧概念原型，仍没有上传和导出功能；实际制作使用新工作台。

本机资料关联方式见 [本地资源使用](docs/本地资源使用.md)。`local/library.local.json` 仅用于开发机定位原稿，不提交 Git；其他电脑可用自己的资源根目录创建绑定。仓库无需这些私人文件也能运行核心测试与界面原型。

## 文件职责

| 位置 | 维护内容 |
|---|---|
| `skills/` | 专业规则与按需参考，当前规则主版本 |
| `resources/design-library/` | 来源页码、视觉观察、设计推导、适用与反例、阅读范围 |
| `resources/sources/` | 外部工具来源与本地清单格式；实际原件清单只保存在忽略的 local 目录 |
| `src/core/` | 可测试的任务采用、参考候选与交付检查规则 |
| `docs/` | 产品事实、流程、接口、阶段验收 |
| `prototype/` | 可点击的界面示意，不连接生产服务 |
| `studio/` | 实际本地工作台界面 |
| `src/intake/`、`src/planner/` | 原件保存、受限文本读取与可解释规则编排 |
| `src/renderers/`、`src/server/` | 真实导出与本机服务，不连接生产客户端 |
| `examples/` | 明确标注的虚构数据 |
| `scripts/` | 资源校验与本机原稿定位 |

对外复用的是经过整理的设计方法。第三方案例不是客户新项目的素材，也不能把研究卡命中当成已经完成设计。Panda 自身界面遵循其品牌，客户成品遵循客户的 Logo 和固定版面。

仓库地址：[yxb1187851322-ship-it/panda-presentation-studio](https://github.com/yxb1187851322-ship-it/panda-presentation-studio)。用户创建的仓库当前公开可见；代码不自动部署，本机原稿与客户文件不自动上传。详见 [来源与使用范围](NOTICE.md)。
