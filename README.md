# EPUB.js 阅读器

一个基于 [EPUB.js](https://github.com/intity/epub-js) 的现代化网页EPUB电子书阅读器，支持多种阅读模式和主题。  

可应用于Alist/Openlist的Epub文件预览。



## ✨ 特性

### 基本操作
- **翻页**: 点击工具栏的 `←` `→` 按钮或使用键盘方向键
- **目录**: 点击 `目录` 按钮显示/隐藏章节目录
- **字体**: 使用 `A+` `A-` 按钮调整字体大小
- **主题**: 点击主题按钮（🌙/☀）切换不同的阅读主题
- **单/双页切换** - 支持单页/双页模式切换，支持桌面/移动端

## 界面预览

![双页-暖黄](pics/demo1.jpg)
![夜间模式](pics/demo2.jpg)

## 🚀 使用指南

### 直接使用
可以直接使用本仓库的github-pages;  

但是如果连不上github可能就用不了：
```url
# Alist/Openlist使用这个：
https://jiang068.github.io/epubjs/test.html?url=$durl

# 其他用途使用这种，请自己拼接链接：
https://jiang068.github.io/epubjs/test.html?url=你的EPUB文件地址
```
### 在线部署
1. 将项目文件部署到Web服务器
2. 在浏览器中访问 `test.html?url=你的EPUB文件地址`即可

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
├── style.css          # 样式文件
├── README.md          # 项目说明
├── js/                # JavaScript文件目录
│   ├── reader.js      # 核心阅读器逻辑
│   ├── epub.min.js    # EPUB.js 核心库
│   ├── jszip.min.js   # ZIP解压库
│   ├── localforage.min.js # 本地存储库
│   └── marked.min.js  # Markdown解析库
└── pics/              # 图片资源目录
    ├── demo1.jpg      # 界面预览图1
    └── demo2.jpg      # 界面预览图2
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
3. 在 `js/reader.js` 中实现功能逻辑

## 📋 Todo

- 某些复杂的EPUB可能丢样式
- 部分浏览器的CORS策略可能影响远程文件加载
- 窗口大小变化时，内容页面不能动态响应
- 调整单/双页时不能保留阅读进度（对于Epub可能无解）
- 字号设置没有缓存，切章失效

## 🙏 致谢

- [EPUB.js](https://github.com/intity/epub-js)

---
