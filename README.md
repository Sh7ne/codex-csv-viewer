# CSV Viewer · CSV 表格查看器

**sh7ne 出品，与 Codex 协作开发**

在 Codex / ChatGPT 桌面应用中，直接把 CSV 原文件显示为可搜索、排序的表格。只读查看，不转换、不修改原文件。

A local, read-only CSV table viewer for Codex / ChatGPT desktop. Search, sort and inspect the original file without converting or modifying it. Chinese interface; built by sh7ne in collaboration with Codex.

## 功能

- 固定表头、记录序号、搜索、自然排序、每页 100 条记录。
- 自动识别或手动选择逗号、分号、Tab、竖线分隔符。
- 自动识别 UTF-8 / UTF-16 BOM；可手动选择 GB18030 等编码。
- 支持带引号的逗号、多行字段、不齐列、空字段及无表头文件。
- 保留前导零、长数字和公式原文，不执行单元格中的 HTML 或公式。
- HTTP(S) 链接可点击，长单元格可展开，支持手动刷新及宿主文件更新通知。

## 环境要求

- 支持 MCP 文件查看器入口和宿主资源读取 API 的 Codex / ChatGPT 桌面版本。
- 本机安装 **Node.js 22.16 或更新版本**，`node --version` 可正常运行。
- 使用下面的命令安装时，需要 Codex CLI。

本项目已在 macOS、桌面应用 `26.1111.21308`、Node.js `22.16.0` 验证。其他桌面版本及 Windows / Linux 的原生查看器流程尚未人工验证；CI 测试范围见仓库 Actions。插件只在本地运行的聊天中使用。

## 安装

### 从 GitHub 安装

```sh
codex plugin marketplace add Sh7ne/codex-csv-viewer --ref v1.0.3
codex plugin add csv-viewer@sh7ne-local-viewers
```

### 从 ZIP 安装

在 [Releases](https://github.com/Sh7ne/codex-csv-viewer/releases) 下载 `codex-csv-viewer-1.0.3.zip` 并解压。进入解压目录后运行：

```sh
cd codex-csv-viewer-1.0.3
codex plugin marketplace add .
codex plugin add csv-viewer@sh7ne-local-viewers
```

ZIP 已包含打包后的服务和界面，使用插件无需运行 `npm install` 或构建。保留解压目录作为本地插件目录来源。`SHA256SUMS` 提供发行包的 SHA-256 校验值。

### 打开 CSV

1. 安装后完全退出并重新打开桌面应用。
2. 关闭旧的 CSV 文本预览标签，再重新点击 CSV 文件。
3. 如有查看器选择菜单，选择 **CSV 表格查看器**；宿主会记住文件类型的选择。
4. 如果宿主要求访问该文件，确认后即可查看。

可以用随附的 [虚构示例 CSV](examples/sample.csv) 测试。它包含中文、前导零、空字段、引号和多行单元格；示例链接使用保留的 `example.invalid` 域名，不是可访问的视频。

如果找不到查看器，在插件目录中查找来源 **Sh7ne Plugins**，确认插件已启用，并检查 Node.js 是否可用。旧式插件包的启动配置使用相对路径；不要将其中的 `.` 改为 `${PLUGIN_ROOT}`。

## 数据与容量

插件通过宿主授予的资源接口读取用户打开的文件，没有保存或文件写入接口。排序、筛选、编码和分隔符选择仅影响内存中的显示。插件不设上传服务、遥测或分析接口；点击外部链接时由宿主打开网站。详见 [数据处理说明](PRIVACY.md)。

单文件最多 32 MiB，解析上限为 100,000 条记录、1,000,000 个单元格，最多显示 500 列。达到限制会显示提示。这是只读查看器，不提供表格编辑或导出。

## 开发

```sh
git clone https://github.com/Sh7ne/codex-csv-viewer.git
cd codex-csv-viewer
npm ci
npm run typecheck
npm run build
npm test
npm run package
```

`npm run package` 输出可安装 ZIP 和 `SHA256SUMS` 到 `release/`。打包使用明确的文件清单，排除本机诊断、开发依赖和无关文件。构建时生成第三方许可声明。

测试使用仓库自带的虚构数据，覆盖解析边界、表格交互、原文件不变、真实启动配置、MCP 文件入口、宿主资源桥接和并发文件切换。运行测试不需要账户、API 密钥或个人素材。

目录：`src/` 为查看器和 MCP 服务源码；`plugins/csv-viewer/` 为预构建插件；`.agents/plugins/marketplace.json` 为安装目录；`examples/` 为公开示例。

## 反馈与许可

请通过 [GitHub Issues](https://github.com/Sh7ne/codex-csv-viewer/issues) 报告问题，附桌面版本、系统、Node.js 版本和脱敏示例。不要上传私密 CSV。

[MIT License](LICENSE)。发行包包含 [第三方许可声明](plugins/csv-viewer/THIRD-PARTY-NOTICES.txt)。版本变化见 [CHANGELOG](CHANGELOG.md)。

实现基于 OpenAI MCP Extensions 的 [文件查看器入口](https://developers.openai.com/plugins/build/extensions#file-viewers-and-editors)。这是由 sh7ne 发布的社区插件。
