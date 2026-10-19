# 发布与市场收录

2026-10-20 核对。V0.1 测试版的包版本为 `0.1.0-beta.1`，对应 tag 为 `v0.1.0-beta.1`。GitHub 发行与社区市场收录分别进行；市场尚未提交。

## 当前状态

- 公开仓库：[Milaro001/dsh-provenance-lens](https://github.com/Milaro001/dsh-provenance-lens)。
- 源码包含安装 manifest、patch、Host、客户端、检索模块、许可证、Issue 模板和截图声明。
- V0.1 包名与仓库名一致；版本、lockfile、Release tag 及交付文件使用 `0.1.0-beta.1`。
- 后端 27 项测试通过；最新客户端深浅主题各 19 项浏览器检查通过，标签排序另有 DSH 实机验收。范围见 [验证说明](docs/TESTING.md)。
- 采用 GitHub 源码和 Release 分发，不要求 npm 发布。
- 真实模型、DSH 原生极长会话和更多版本的兼容性仍需持续验收。

## GitHub

确认目标仓库公开可访问，添加 `dsh-plugin` topic。只上传插件项目；不要上传导出的会话 ZIP、浏览器档案、密钥、原始个人对话截图或 `node_modules`。`.review-backups/` 已被忽略，市场预览使用虚构会话截图。

如果本目录位于其他工作区仓库中，应单独准备插件仓库，避免把父目录里的文档一并上传。仓库声明与 npm 包内的 `repository` 指向应一致。

Issues 模板已准备于 `.github/ISSUE_TEMPLATE/`，包括报错、功能建议和使用反馈。模板上传到默认分支后，还需核对仓库 Features、Watch 和个人通知投递；见 [SUPPORT.md](SUPPORT.md)。不在仓库中公开私人邮箱；账号通知配置与实际邮件送达分别核验。

## 安装包与 npm

```sh
npm ci
npm run check
npm test
npm pack --dry-run
npm pack
```

将来如果另行选择 npm 分发，`npm publish` 不会自动让社区市场上架。也可以不发 npm，采用 GitHub 源码安装；推荐额外提供 GitHub Release 的预构建 `.tgz`。若源码不能直接安装，预构建 `.tgz` 则必须提供。用户要求的 ZIP 可作为交付附件，不能冒充目录 `tarball` 字段要求的 `.tgz`。上述命令用于发布阶段，不应把登录信息提交到 Git。

## 社区目录

以用户指定的 [贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 为提交依据。本轮通过 GitHub API 读取并核对了主分支提交 `358982ee81eb6399e0bee8bd22944abf39f4554c` 上的版本，指南 blob SHA 为 `d92b1763242a95029fb6e2677c820ec25824933f`；同时阅读了 [实际提交检查器](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/358982ee81eb6399e0bee8bd22944abf39f4554c/scripts/check-submission.mjs)。本次 GitHub 上传前已重新读取最新指南；发市场 PR 前还应再次核对。

| 核对项目 | 当前结论 |
| --- | --- |
| `dsh.bundle` 和其指向的 patch | 本地通过；patch 的包名与项目名一致 |
| 可用源码与如实描述 | 有实际实现和测试；真实模型与超长会话仍有独立待验项，介绍不能写成无限上下文或真实生成过程追踪 |
| 公开仓库与创建满 1 天 | 创建时间为 2026-10-19 19:38:22 UTC；北京时间 2026-10-21 03:38:22 后满 1 天，达到后再提交 |
| `dsh-plugin` topic | 已在线配置并核对 `dsh-plugin`，包的 keywords 另行保留 |
| 市场条目 | 已准备 `catalog/Milaro001__dsh-provenance-lens.yml`；`session` 分类、双语描述和路径命名已核对 |
| 市场 PR 的实际路径 | 提交时放在市场仓库的 `data/plugins/Milaro001__dsh-provenance-lens.yml`；只新增本插件这一条，不手改生成 README 或其他条目 |
| 截图 | `screenshots.json` 声明 1 张仓库内相对路径图片，文件存在，已同步当前 UI 的虚构会话预览 |
| npm 与安装包映射 | npm 可选；若发布，`repository` 必须准确回指本仓库，不向条目添加 `npm:` 字段 |
| Release 的 `tarball` | 使用固定 tag 的 GitHub Release HTTPS `.tgz` 链接；ZIP 不用于此字段，发市场 PR 前核验可下载 |
| 依赖 | 当前无运行时 npm 依赖，未把官方 DSH 包放进 dependencies；将来新增官方包时按指南处理 peerDependencies 与预发布版本范围 |
| 干净安装、同类条目对照 | 已在干净目录安装当前 `.tgz` 并验证 Host 导入及 5 条路由；DSH 原生公开包端到端安装与同类条目对照仍需核验 |
| 目录 CI 与人工评审 | 尚未提交；本地测试和试算不等于目录 CI 通过，也不等于维护者批准 |

单个 PR 最多 3 个条目，本插件只提交 1 条。若使用带版本的资产名，采用固定 release tag 的下载路径；若使用 `latest/download/`，资产名应保持不带版本，避免下次发版后链接失效。截图只维护在本仓库声明，不向目录旧的截图汇总文件添加条目。

CI 通过之后仍有人工评审，重点包括功能与描述一致、是否重复已有条目、源码及维护情况。可以逐项消除已知缺漏，不能在提交前保证一定收录。自动检查或评审指出问题时，在同一 PR 分支修复并复查，不把待办改写成已通过。

## 后续验收

更新插件并重载 DSH 后，分别检查：AI 历史结论、用户原话、外部工具材料、跨段落选区、较早轮次、原有摘录跳转、关闭和收起，以及默认收纳设置。确认没有重复的「溯源」入口。

最终公开包还需核验：从源码或 Release 安装、安装后路由与 UI 加载正常、版本与兼容范围准确、ZIP/`.tgz` 都包含正确文件。仓库上传、Issue 通知送达、Release 可下载和市场收录是四个独立结果，应分别记录证据。
