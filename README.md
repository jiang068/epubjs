# Neko Reader

一个纯前端、本地优先的二次元漫画与小说阅读器。工程源码在 `epubjs/`，Node/Vite 环境在上一级目录。应用使用适合静态托管的 Hash 子路由：`#/library`、`#/import`、`#/settings`、`#/read/<书籍ID>`。

## 支持格式

- EPUB：章节目录、单/双页切换、50%–200% 字号、7 种主题、行距、插画页自动放大、阅读进度与 URL 定位
- PDF：左右分页与连续滚动、缩放/适应宽度、页码跳转、阅读进度
- CBZ/ZIP：单页、双页与连续滚动，支持缩放和移动端手势
- 图片目录：桌面端选择文件夹后按自然序阅读，阅读模式与图片漫画一致
- TXT：UTF-8/GB18030 自动兜底、分页、字体大小

本地文件不会上传服务器。默认会在浏览器的 IndexedDB 中保留最近 3 本书的文件本体，因此刷新或重新打开浏览器后仍可继续阅读；可在“阅读设置”中改为不保留、最近 1 / 3 / 5 / 10 本或不限数量。超过上限时只释放最久未打开的文件本体，书名、格式、阅读进度和定位仍会保留，也可以在书架中释放单本或在设置中清空全部本体。远程文件必须满足浏览器的 HTTPS 和 CORS 规则，并以 `no-store` 模式读取。

普通文件选择使用标准的 `<input type="file">`，可用于现代 iOS Safari、Android 浏览器及桌面浏览器。文件夹选择使用 `webkitdirectory`；新版主流浏览器支持直接选择文件夹，不支持该能力的旧版浏览器会自动退化为“多选漫画图片”。为了保持跨平台一致性，项目不依赖支持范围有限的持久文件句柄 API。

阅读设置保存在浏览器本地。旧版的“默认 / 护眼绿 / 暖黄 / 夜间”设置会自动迁移；新版另外提供纸张、樱花和 OLED 纯黑主题。EPUB 配图支持整图放大、适应宽度与原始尺寸三种模式。

## 开发与构建

完整工作区在外层目录执行：

```bash
npm install
npm run dev
npm run build
```

单独克隆本仓库时也可以直接执行：

```bash
npm ci
npm run dev
npm run build
```

从完整工作区构建时产物在外层 `dist/`；单独克隆本仓库构建时产物在项目自己的 `dist/`。两者都可用于 Cloudflare Pages 或 GitHub Pages。项目使用相对资源路径和 Hash 路由，适合 GitHub Pages 的仓库子路径部署，复制或刷新阅读地址不会触发静态主机 404。

## 自动部署

### GitHub Pages

仓库已经包含 `.github/workflows/deploy-pages.yml`。推送到 `main` 后，GitHub Actions 会依次执行依赖安装、类型检查、生产构建和 Pages 发布。

首次使用时，在 GitHub 仓库打开 `Settings > Pages`，将 `Build and deployment > Source` 设为 `GitHub Actions`。以后只要推送 `main` 即可自动更新；也可以在 `Actions > Deploy GitHub Pages` 中手动运行。

默认地址为：

```text
https://<GitHub用户名>.github.io/<仓库名>/
```

GitHub Pages 只发布静态 `dist/`，不会运行 `functions/`，因此 `/api/proxy` 在 GitHub Pages 上不可用。

### Cloudflare Pages Git 直连

在 Cloudflare 控制台进入 `Workers & Pages > Create application > Pages > Connect to Git`，授权并选择这个 GitHub 仓库，然后填写：

| 配置项 | 值 |
| --- | --- |
| Production branch | `main` |
| Framework preset | `Vite`，也可以选 `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | 留空 |

仓库根目录的 `.node-version` 会让 GitHub Actions 和 Cloudflare Pages 都使用 Node.js 24。保存后，推送 `main` 会发布生产版本，其他分支和 Pull Request 会生成独立预览地址。项目不提交绑定特定项目名的 `wrangler.toml`，避免它覆盖 Cloudflare 控制台中实际的 Pages 项目配置；Pages Functions 会从 `functions/` 自动识别。

如果需要使用仓库内的受限远程文件代理，在 Cloudflare Pages 项目的变量设置中添加：

```text
READER_PROXY_ALLOWLIST=files.example.com,openlist.example.com
```

只填写你信任的文件源域名，不要把代理配置成允许任意主机。

## 项目结构

```text
functions/       Cloudflare Pages Functions（可选代理）
public/          PWA、嵌入脚本与静态托管配置
src/core/        路由、存储、文件源与阅读偏好
src/engines/     EPUB、PDF、图片漫画与 TXT 引擎
src/views/       书库、导入、阅读和设置页面
```

## 外部预览

直接入口：

```text
https://your-reader.example/#/open?url=<encoded-file-url>&name=<encoded-file-name>
```

OpenList / Alist 的 Iframe 预览可以配置：

```json
{
  "epub,pdf,txt,cbz": {
    "Neko Reader": "https://your-reader.example/?url=$e_url&name=$e_name&embed=1"
  }
}
```

也可以嵌入普通网页：

```html
<div id="reader" style="height: 720px"></div>
<script src="https://your-reader.example/embed.js"></script>
<script>
  NekoReader.mount("#reader", {
    url: "https://files.example.com/book.epub",
    name: "book.epub"
  });
</script>
```

HTTP 文件不能被 HTTPS 页面直接读取。需要将文件源升级为 HTTPS、启用 OpenList 代理，或另行提供受限的 Cloudflare Worker 代理；不要部署无限制的公共代理。

本仓库附带可选的 Cloudflare Pages Function：`functions/api/proxy.ts`。部署 Pages 时设置环境变量 `READER_PROXY_ALLOWLIST`，值为允许访问的域名列表（逗号分隔），然后将阅读地址改成：

```text
https://your-reader.example/api/proxy?url=$e_url
```

GitHub Pages 不运行 Functions；纯静态部署仍然只支持 HTTPS+CORS 文件。

## 依赖版本

仓库内的 `package-lock.json` 锁定了当前验证过的依赖版本；完整工作区的外层锁文件只服务于本地 workspace。当前使用 EPUB.js 0.3.93、PDF.js 6.3.289、zip.js 2.16.0、Vite 8.3.0 和 TypeScript 7.0.2。PDF.js 的 worker 会随静态产物一起发布。
