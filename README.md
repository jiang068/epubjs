# EPUB.js 阅读器

一个基于 [EPUB.js](https://github.com/intity/epub-js) 的现代化网页EPUB电子书阅读器，支持多种阅读模式和主题。

## ✨ 特性

### 基本操作
- **翻页**: 点击工具栏的 `←` `→` 按钮或使用键盘方向键
- **目录**: 点击 `目录` 按钮显示/隐藏章节目录
- **字体**: 使用 `A+` `A-` 按钮调整字体大小
- **主题**: 点击主题按钮（🌙/☀）切换不同的阅读主题

### 🎨 界面定制
- **多种主题模式**
  - 默认模式（白底黑字）
  - 护眼绿模式（绿色背景，护眼舒适）
  - 暖黄模式（暖黄背景，温和阅读）
  - 深蓝模式（蓝色背景，专业感）
  - 夜间模式（深色背景，夜晚阅读）
- **字体大小调节** - A+/A- 按钮快速调整字体大小
- **页面布局切换** - 支持单页/双页模式切换，支持桌面/移动端

## 🚀 部署指南

### 在线部署
1. 将项目文件部署到Web服务器
2. 在浏览器中访问 `test.html?url=你的EPUB文件地址`
3. 开始阅读！

### 本地运行
```bash
# 克隆项目
git clone https://github.com/jiang068/epubjs.git

# 启动本地服务器（以Python为例）
cd epubjs
python -m http.server 8000

# 在浏览器中访问
http://127.0.0.1:8000/test.html?url=path/to/your/book.epub

# 也可以接在线地址
http://127.0.0.1:8000/test.html?url=https://example.com/sample.epub
```

## 📁 项目结构

```
epubjs/
├── test.html          # 主页面文件
├── reader.js          # 核心阅读器逻辑
├── style.css          # 样式文件
├── epub.min.js        # EPUB.js 核心库
├── jszip.min.js       # ZIP解压库
├── localforage.min.js # 本地存储库
├── marked.min.js      # Markdown解析库
└── README.md          # 项目说明
```

## 🔧 技术细节

### 核心依赖：[EPUB.js](https://github.com/intity/epub-js)
- **epub.min.js** - EPUB文件解析和渲染
- **jszip.min.js** - JS文件压缩
- **localforage.min.js** - 本地数据存储
- **marked.min.js** - Markdown内容解析

### 功能分布：本仓库
1. 在 `test.html` 中添加UI元素
2. 在 `style.css` 中添加样式
3. 在 `reader.js` 中实现功能逻辑

## 📋 Todo

- 某些复杂的EPUB样式可能丢样式
- 部分浏览器的CORS策略可能影响远程文件加载

## 🙏 致谢

- [EPUB.js](https://github.com/intity/epub-js)

---
