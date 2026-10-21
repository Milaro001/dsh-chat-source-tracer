# 发布与市场收录

GitHub Release 用于分发插件安装包，社区市场收录需另行提交。当前发布版本为 `0.3.1`，对应 tag 为 `v0.3.1`。社区市场收录通过目录 PR 另行审核。

## 仓库与分发文件

- 仓库地址：[Milaro001/dsh-chat-source-tracer](https://github.com/Milaro001/dsh-chat-source-tracer)。仓库应公开可访问，并配置 `dsh-plugin` topic。
- `package.json` 的版本、lockfile、Release tag 与分发文件名应一致，`repository` 应指向本仓库。
- 安装包需包含 `dsh.bundle`、对应 patch、运行代码、图标、语言文件、许可证和必要说明。
- `.tgz` 用于插件安装，ZIP 用于源码分发。发布文件按 `package.json` 的 `files` 清单生成。
- 截图使用虚构会话；个人会话导出、密钥、浏览器档案、本地备份和 `node_modules` 不应进入分发文件。

## 打包与发布检查

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

检查打包清单后，将安装包附到对应的 GitHub Release，并核验下载链接、干净安装、Host 路由与客户端入口。具体测试范围见 [验证说明](docs/TESTING.md)。

当前采用 GitHub 源码和 Release 分发。若另行发布 npm 包，包内的 `repository` 必须准确回指本仓库；npm 发布与市场收录分别进行。

## 社区市场提交

提交前核对最新的 [贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 和 [提交检查器](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs)。以下为 2026-10-21 核对的检查项：

| 检查项 | 要求 |
| --- | --- |
| 仓库 | 公开可访问，创建满 1 天，包含可用源码、准确描述和 `dsh-plugin` topic |
| 插件配置 | `dsh.bundle` 指向有效 patch，patch 包名与项目名一致 |
| 市场条目 | 使用 `catalog/Milaro001__dsh-chat-source-tracer.yml`，分类为 `session`，描述与功能一致 |
| 提交路径 | 在市场仓库新增 `data/plugins/Milaro001__dsh-chat-source-tracer.yml`，不修改生成的 README 或其他插件条目 |
| 截图 | 在本仓库的 `screenshots.json` 中声明有效图片路径，不向旧的截图汇总文件添加条目 |
| 安装来源 | 源码应可直接安装；否则必须提供预构建 `.tgz` |
| `tarball` | 使用 GitHub Release 的 HTTPS `.tgz` 链接，ZIP 不用于此字段 |
| npm 映射 | npm 分发可选；条目不添加 `npm:` 字段，包的 `repository` 应与仓库一致 |
| 依赖 | 当前无运行时 npm 依赖；新增官方 DSH 包时按指南配置 `peerDependencies` 与版本范围 |
| 验证 | 完成干净安装、运行检查和同类条目核对，通过目录 CI 后接受人工评审 |

本插件提交 1 个条目；单个 PR 最多 3 个条目。带版本的资产名应配合固定 Release tag；使用 `latest/download/` 时，资产名应保持不带版本。

功能描述应与实际版本一致，明确测试版与兼容范围。归因分析不应描述为真实生成过程追踪，长对话支持也不应宣称无限上下文。市场收录以目录 CI 和维护者评审结果为准。
