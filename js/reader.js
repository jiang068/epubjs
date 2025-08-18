// Origin by https://github.com/jiang068/epubjs
(function(){
console.log("EPUB Reader initializing...");

// 检查必要的依赖库
if (typeof ePub === 'undefined') {
    alert("错误：epub.min.js 未正确加载");
    return;
}

function getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
}

const url = getUrlParam('url');
console.log("Target URL:", url);

if (!url) {
    alert("请在地址栏传入 ?url=epub文件地址");
    return;
}

const tocList = document.getElementById('toc-list');
const titleEl = document.getElementById('title');
const viewport = document.getElementById('viewport');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const fontIncreaseBtn = document.getElementById('fontIncreaseBtn');
const fontDecreaseBtn = document.getElementById('fontDecreaseBtn');
const modeToggleBtn = document.getElementById('modeToggleBtn');
const pageToggleBtn = document.getElementById('pageToggleBtn');
const tocToggleBtn = document.getElementById('tocToggleBtn');
const tocPanel = document.getElementById('toc');

let fontSize = 100;
let flow = "paginated";
let manager = "default";
let currentLocation = null;

// 文字颜色主题数组 - 现在集成到夜间/日间模式中
const textColorThemes = [
    {
        name: "默认",
        styles: {
            "body": { "color": "", "background": "" }
        }
    },
    {
        name: "护眼",
        styles: {
            "body": { "color": "#2d4a2b", "background": "#e8f5e8" },
            "p, div, span, h1, h2, h3, h4, h5, h6": { "color": "#2d4a2b" }
        }
    },
    {
        name: "暖黄",
        styles: {
            "body": { "color": "#5d4037", "background": "#fef9e7" },
            "p, div, span, h1, h2, h3, h4, h5, h6": { "color": "#5d4037" }
        }
    },
    {
        name: "深蓝",
        styles: {
            "body": { "color": "#1a237e", "background": "#e8eaf6" },
            "p, div, span, h1, h2, h3, h4, h5, h6": { "color": "#1a237e" }
        }
    }
];

// 当前模式：0=日间默认, 1=日间护眼绿, 2=日间暖黄, 3=日间深蓝, 4=夜间
let currentMode = 0;
let modeLoaded = false; // 标志：是否已经从localStorage加载过模式
let rendition = null;
let book = null;

// 新增：spine列表与使用目录标志
let spineItems = [];
let useToc = true;

console.log("Creating ePub instance...");
try {
    book = ePub(url, { 
    restore: true,
    requestMethod: "GET",
    requestCredentials: "omit"
    });
    console.log("ePub instance created:", book);
    console.log("Available properties:", Object.keys(book));
    
    // 检查不同版本的ePub.js的ready属性
    if (book.ready) {
    console.log("book.ready found:", typeof book.ready);
    } else if (book.opened) {
    console.log("book.opened found:", typeof book.opened);
    book.ready = book.opened; // 兼容性处理
    } else if (typeof book.isOpen === 'function') {
    console.log("book.isOpen method found");
    // 创建一个假的ready Promise
    book.ready = new Promise((resolve, reject) => {
        const checkOpen = () => {
        if (book.isOpen && book.isOpen()) {
            resolve();
        } else {
            setTimeout(checkOpen, 100);
        }
        };
        checkOpen();
    });
    } else {
    console.log("No standard ready property found, using alternative initialization");
    // 对于某些版本的ePub.js，可能需要手动触发加载
    book.ready = new Promise((resolve) => {
        setTimeout(() => {
        resolve();
        }, 1000);
    });
    }
    
    console.log("Final ready property type:", typeof book.ready);
} catch (initError) {
    console.error("Failed to create ePub instance:", initError);
    titleEl.textContent = "EPUB初始化失败: " + (initError.message || initError);
    tocList.innerHTML = "<li>初始化失败</li>";
    return;
}

function getViewportSize() {
    return {
    width: window.innerWidth - (window.innerWidth > 768 ? 220 : 0),
    height: window.innerHeight - document.getElementById('toolbar').offsetHeight
    };
}

// 保护EPUB原始样式的函数
function preserveOriginalStyles(rendition) {
    if (!rendition) return;
    
    // 监听渲染完成事件，确保不会过度覆盖原始样式
    rendition.on("rendered", (section) => {
    try {
        // 获取iframe文档
        const iframe = document.querySelector('#viewport iframe');
        if (iframe && iframe.contentDocument) {
        const doc = iframe.contentDocument;
        
        // 添加一个温和的基础样式，只在必要时覆盖
        let baseStyle = doc.getElementById('epub-base-style');
        if (!baseStyle) {
            baseStyle = doc.createElement('style');
            baseStyle.id = 'epub-base-style';
            baseStyle.textContent = `
            /* 确保文本可读性，但不强制覆盖 */
            body { 
                line-height: 1.4; 
            }
            `;
            doc.head.appendChild(baseStyle);
        }
        
        // 在基础样式应用后，重新应用当前主题
        setTimeout(() => {
            applyThemeMode(currentMode);
        }, 50);
        }
    } catch (e) {
        console.warn("Failed to preserve original styles:", e);
    }
    });
}

// 应用综合主题模式（包含文字颜色和夜间模式）
function applyThemeMode(mode) {
    if (!rendition || !rendition.themes) return;
    
    try {
        const isNightMode = mode === 4;
        const colorThemeIndex = isNightMode ? 0 : mode;
        
        if (isNightMode) {
            // 夜间模式
            document.body.classList.add("night");
            
            if (typeof rendition.themes.dark === 'function') {
                rendition.themes.dark();
            } else if (rendition.themes.select) {
                rendition.themes.select('dark');
            } else if (rendition.themes.register) {
                rendition.themes.register("darkMode", {
                    "body": {
                        "color": "#e0e0e0",
                        "background": "#1a1a1a"
                    },
                    "p, div, span, h1, h2, h3, h4, h5, h6": {
                        "color": "#e0e0e0"
                    },
                    "a": {
                        "color": "#66b3ff"
                    }
                });
                rendition.themes.select("darkMode");
            }
            
            // iframe样式注入
            setTimeout(() => {
                try {
                    const iframes = document.querySelectorAll('#viewport iframe');
                    iframes.forEach(iframe => {
                        try {
                            const doc = iframe.contentDocument || iframe.contentWindow.document;
                            if (doc) {
                                let style = doc.getElementById('epub-theme-style');
                                if (!style) {
                                    style = doc.createElement('style');
                                    style.id = 'epub-theme-style';
                                }
                                style.textContent = `
                                    body { 
                                        background: #1a1a1a; 
                                        color: #e0e0e0; 
                                    }
                                    p, div, span, h1, h2, h3, h4, h5, h6, li, td, th { 
                                        color: #e0e0e0; 
                                    }
                                    a { 
                                        color: #66b3ff; 
                                    }
                                `;
                                doc.head.appendChild(style);
                            }
                        } catch (e) {
                            console.warn("Cannot access iframe content:", e);
                        }
                    });
                } catch (e) {
                    console.warn("Failed to inject dark mode styles:", e);
                }
            }, 300);
            
        } else {
            // 日间模式（含颜色主题）
            document.body.classList.remove("night");
            
            const theme = textColorThemes[colorThemeIndex];
            if (theme) {
                // 注册并应用主题
                const themeName = `colorTheme${colorThemeIndex}`;
                rendition.themes.register(themeName, theme.styles);
                rendition.themes.select(themeName);
                
                // iframe样式注入
                setTimeout(() => {
                    try {
                        const iframes = document.querySelectorAll('#viewport iframe');
                        iframes.forEach(iframe => {
                            try {
                                const doc = iframe.contentDocument || iframe.contentWindow.document;
                                if (doc) {
                                    // 移除之前的主题样式
                                    const oldStyle = doc.getElementById('epub-theme-style');
                                    if (oldStyle) {
                                        oldStyle.remove();
                                    }
                                    
                                    // 如果不是默认主题，添加新的颜色样式
                                    if (colorThemeIndex > 0) {
                                        const colorStyle = doc.createElement('style');
                                        colorStyle.id = 'epub-theme-style';
                                        
                                        let cssText = '';
                                        for (const [selector, styles] of Object.entries(theme.styles)) {
                                            cssText += `${selector} { `;
                                            for (const [property, value] of Object.entries(styles)) {
                                                if (value) {
                                                    cssText += `${property}: ${value}; `;
                                                }
                                            }
                                            cssText += `}\n`;
                                        }
                                        
                                        colorStyle.textContent = cssText;
                                        doc.head.appendChild(colorStyle);
                                    }
                                }
                            } catch (e) {
                                console.warn("Cannot access iframe content:", e);
                            }
                        });
                    } catch (e) {
                        console.warn("Failed to apply color theme to iframe:", e);
                    }
                }, 300);
            }
        }
        
        // 更新按钮显示
        updateModeButtonDisplay(mode);
        
    } catch (error) {
        console.warn("Failed to apply theme mode:", error);
    }
}

// 更新模式按钮显示
function updateModeButtonDisplay(mode) {
    const modeNames = ["默认", "护眼绿", "暖黄", "深蓝", "夜间"];
    const isNightMode = mode === 4;
    
    if (isNightMode) {
        modeToggleBtn.textContent = "🌙";
        modeToggleBtn.title = "当前：夜间模式，点击切换";
    } else {
        modeToggleBtn.textContent = `☀${modeNames[mode]}`;
        modeToggleBtn.title = `当前：${modeNames[mode]}，点击切换`;
    }
}

function renderBook() {
    console.log("Starting renderBook...");
    
    if(rendition) {
    rendition.destroy();
    rendition = null;
    }
    
    if (!book) {
    console.error("Book not initialized");
    return;
    }
    
    const size = getViewportSize();
    let rendWidth = size.width;
    if(document.body.classList.contains("double-page") && window.innerWidth > 768){
    rendWidth = rendWidth / 2;
    }

    try {
    rendition = book.renderTo("viewport", {
        width: rendWidth,
        height: size.height,
        flow,
        manager,
        styles: {
        "font-size": fontSize + "%"
        },
        allowScriptedContent: true,
        sandbox: ["allow-same-origin", "allow-scripts"],
        // 保护原始样式设置
        preserveOriginalCSS: true
    });

    console.log("Rendition created, attempting to display...");

    // 保护原始样式
    preserveOriginalStyles(rendition);

    // 根据是否使用目录决定显示哪个章节
    let displayPromise;
    if(useToc && book.navigation && book.navigation.toc && book.navigation.toc.length > 0) {
        let startLocation;
        if (currentLocation) {
        // 处理currentLocation可能是对象的情况
        if (typeof currentLocation === 'object' && currentLocation.href) {
            startLocation = currentLocation.href;
        } else if (typeof currentLocation === 'string') {
            startLocation = currentLocation;
        } else {
            startLocation = book.navigation.toc[0].href;
        }
        } else {
        startLocation = book.navigation.toc[0].href;
        }
        console.log("Displaying with TOC:", startLocation);
        displayPromise = rendition.display(startLocation);
    } else if (spineItems.length > 0) {
        // 无目录时用 spine 顺序的第一个
        const startLocation = currentLocation || spineItems[0];
        console.log("Displaying with spine:", startLocation);
        displayPromise = rendition.display(startLocation);
    } else {
        // 最后尝试显示第一个可用内容
        console.log("Displaying first available content");
        displayPromise = rendition.display();
    }

    displayPromise.then(() => {
        console.log("Content displayed successfully");
        
        // 直接使用第一个TOC项目设置标题
        if (book.navigation && book.navigation.toc && book.navigation.toc.length > 0) {
            const firstTocItem = book.navigation.toc[0];
            titleEl.textContent = firstTocItem.label || "第一章";
            console.log("Title set to:", titleEl.textContent);
        } else {
            titleEl.textContent = book.metadata?.title || "EPUB内容已加载";
        }
        
        // 只在首次加载时从localStorage读取用户保存的模式偏好
        if (!modeLoaded) {
            try {
                const savedMode = localStorage.getItem('epub-theme-mode');
                if (savedMode !== null) {
                    currentMode = parseInt(savedMode, 10) || 0;
                }
                modeLoaded = true; // 标记已加载，避免后续重复加载
            } catch (e) {
                console.warn("Failed to load mode preference:", e);
            }
        }
        
        // 应用当前主题模式
        setTimeout(() => {
            applyThemeMode(currentMode);
        }, 500);
        
    }).catch(displayError => {
        console.error("Display failed:", displayError);
        titleEl.textContent = "内容显示失败";
        
        // 尝试备用显示方法
        if (book.spine && book.spine.items && book.spine.items.length > 0) {
        console.log("Trying fallback display method...");
        rendition.display(book.spine.items[0].href).catch(fallbackError => {
            console.error("Fallback display also failed:", fallbackError);
        });
        }
    });

    rendition.on("relocated", location => {
        try {
        currentLocation = location.start;
        updateTitle(location.start);
        updateNavButtons();
        highlightToc(location.start?.href);
        } catch (relocatedError) {
        console.warn("Error in relocated handler:", relocatedError);
        }
    });

    // 尝试监听其他可能的位置更新事件
    rendition.on("locationChanged", location => {
        try {
            updateTitle(location);
        } catch (e) {
            console.warn("Error in locationChanged handler:", e);
        }
    });

    rendition.on("moved", location => {
        console.log("Moved event fired:", location);
        try {
            updateTitle(location);
        } catch (e) {
            console.warn("Error in moved handler:", e);
        }
    });

    rendition.on("displayed", location => {
        try {
            if (location && location.href) {
                updateTitle(location);
            }
        } catch (e) {
            console.warn("Error in displayed handler:", e);
        }
    });

    // 添加渲染错误监听
    rendition.on("rendered", () => {
        // 在每次页面渲染完成后重新应用当前主题模式
        setTimeout(() => {
            applyThemeMode(currentMode);
        }, 100);
        
        // 在页面渲染完成后尝试更新标题
        setTimeout(() => {
            if (rendition && rendition.location) {
                updateTitle(rendition.location.start || rendition.location);
            } else {
                // 使用当前显示的位置信息
                const currentHref = book.navigation?.toc?.[0]?.href || "cover.xhtml";
                updateTitle({ href: currentHref });
            }
        }, 200);
    });

    // 添加错误监听
    rendition.on("error", (error) => {
        console.error("Rendition error:", error);
    });

    } catch (error) {
    console.error("Failed to create rendition:", error);
    titleEl.textContent = "渲染器创建失败";
    }
}

// 新增：带位置信息的渲染函数
function renderBookWithLocation(targetLocation) {
    console.log("Starting renderBookWithLocation with:", targetLocation);
    
    if(rendition) {
    rendition.destroy();
    rendition = null;
    }
    
    if (!book) {
    console.error("Book not initialized");
    return;
    }
    
    const size = getViewportSize();
    let rendWidth = size.width;
    if(document.body.classList.contains("double-page") && window.innerWidth > 768){
    rendWidth = rendWidth / 2;
    }

    try {
    rendition = book.renderTo("viewport", {
        width: rendWidth,
        height: size.height,
        flow,
        manager,
        styles: {
        "font-size": fontSize + "%"
        },
        allowScriptedContent: true,
        sandbox: ["allow-same-origin", "allow-scripts"],
        // 保护原始样式设置
        preserveOriginalCSS: true
    });

    console.log("Rendition created, attempting to display at saved location...");

    // 保护原始样式
    preserveOriginalStyles(rendition);

    // 显示到指定位置 - 处理不同格式的位置对象
    let displayPromise;
    if (targetLocation) {
        if (typeof targetLocation === 'object' && targetLocation.start && targetLocation.start.cfi) {
        // 新格式：{atStart: true, atEnd: false, start: {cfi: "...", href: "..."}, end: {...}}
        console.log("Using start.cfi for precise location:", targetLocation.start.cfi);
        displayPromise = rendition.display(targetLocation.start.cfi);
        } else if (typeof targetLocation === 'object' && targetLocation.start && targetLocation.start.href) {
        // 新格式但没有CFI，使用href
        console.log("Using start.href for location:", targetLocation.start.href);
        displayPromise = rendition.display(targetLocation.start.href);
        } else if (typeof targetLocation === 'object' && targetLocation.cfi) {
        // 旧格式：{cfi: "...", href: "..."}
        console.log("Using CFI for precise location:", targetLocation.cfi);
        displayPromise = rendition.display(targetLocation.cfi);
        } else if (typeof targetLocation === 'object' && targetLocation.href) {
        // 旧格式但没有CFI
        console.log("Using href for location:", targetLocation.href);
        displayPromise = rendition.display(targetLocation.href);
        } else if (typeof targetLocation === 'string') {
        console.log("Using string location:", targetLocation);
        displayPromise = rendition.display(targetLocation);
        } else {
        console.log("No valid location found, using default");
        displayPromise = rendition.display();
        }
    } else {
        displayPromise = rendition.display();
    }

    displayPromise.then(() => {
        console.log("Content displayed at saved location successfully");
        titleEl.textContent = book.metadata?.title || "EPUB内容已加载";
        
        // 应用保存的主题模式
        setTimeout(() => {
            applyThemeMode(currentMode);
        }, 500);
    }).catch(displayError => {
        console.error("Display at saved location failed:", displayError);
        // 如果恢复位置失败，则显示第一页
        renderBook();
    });

    rendition.on("relocated", location => {
        try {
        console.log("Relocated event fired with location:", location);
        currentLocation = location.start;
        console.log("Current location set to:", currentLocation);
        updateTitle(location.start);
        updateNavButtons();
        highlightToc(location.start?.href);
        } catch (relocatedError) {
        console.warn("Error in relocated handler:", relocatedError);
        }
    });

    // 尝试监听其他可能的位置更新事件
    rendition.on("locationChanged", location => {
        console.log("LocationChanged event fired:", location);
        try {
            updateTitle(location);
        } catch (e) {
            console.warn("Error in locationChanged handler:", e);
        }
    });

    rendition.on("moved", location => {
        console.log("Moved event fired:", location);
        try {
            updateTitle(location);
        } catch (e) {
            console.warn("Error in moved handler:", e);
        }
    });

    rendition.on("displayed", location => {
        console.log("Displayed event fired:", location);
        try {
            if (location && location.href) {
                updateTitle(location);
            }
        } catch (e) {
            console.warn("Error in displayed handler:", e);
        }
    });

    rendition.on("rendered", () => {
        console.log("Page rendered successfully");
        
        // 在每次页面渲染完成后重新应用当前主题模式
        setTimeout(() => {
            applyThemeMode(currentMode);
        }, 100);
        
        // 在页面渲染完成后尝试更新标题
        setTimeout(() => {
            console.log("Trying to update title after render...");
            if (rendition && rendition.location) {
                console.log("Found rendition.location:", rendition.location);
                updateTitle(rendition.location.start || rendition.location);
            } else {
                console.log("No rendition.location found, using display location");
                // 使用当前显示的位置信息
                const currentHref = book.navigation?.toc?.[0]?.href || "cover.xhtml";
                updateTitle({ href: currentHref });
            }
        }, 200);
    });

    rendition.on("error", (error) => {
        console.error("Rendition error:", error);
    });

    } catch (error) {
    console.error("Failed to create rendition with location:", error);
    titleEl.textContent = "渲染器创建失败";
    }
}

function updateTitle(location) {
    let title = "无标题";
    
    if(useToc && book.navigation && book.navigation.toc && book.navigation.toc.length > 0){
        if(location && location.href){
            // 尝试从目录匹配标题
            let hrefNoHash = location.href.split('#')[0];
            
            // 递归搜索所有目录项（包括子项）
            function findTocItem(tocItems, targetHref) {
                for (let item of tocItems) {
                    let itemHref = item.href ? item.href.split('#')[0] : '';
                    
                    if (itemHref === targetHref) {
                        return item;
                    }
                    
                    // 也尝试匹配完整的href（包含hash）
                    if (item.href === location.href) {
                        return item;
                    }
                    
                    // 检查子项
                    if (item.subitems && item.subitems.length > 0) {
                        let found = findTocItem(item.subitems, targetHref);
                        if (found) return found;
                    }
                }
                return null;
            }
            
            const tocItem = findTocItem(book.navigation.toc, hrefNoHash);
            if(tocItem){
                title = tocItem.label;
            } else {
                // 如果找不到精确匹配，尝试部分匹配
                const partialMatch = book.navigation.toc.find(item => {
                    if (!item.href) return false;
                    let itemHref = item.href.split('#')[0];
                    return hrefNoHash.includes(itemHref) || itemHref.includes(hrefNoHash);
                });
                
                if (partialMatch) {
                    title = partialMatch.label;
                } else {
                    // 使用文件名作为标题
                    let filename = hrefNoHash.split('/').pop();
                    title = filename || hrefNoHash;
                }
            }
        }
    } else {
        // 无目录用 spine href 或 cfi
        if (location?.href) {
            let filename = location.href.split('/').pop().split('#')[0];
            title = filename || location.href;
        } else if (location?.cfi) {
            title = "第 " + (spineItems.findIndex(href => location.cfi.includes(href)) + 1) + " 页";
        } else {
            title = "无标题";
        }
    }
    
    // 手机端限制标题长度，确保按钮可见
    if (window.innerWidth <= 768) {
        if (title.length > 15) {
            title = title.substring(0, 15) + "...";
        }
    } else if (window.innerWidth <= 480) {
        if (title.length > 10) {
            title = title.substring(0, 10) + "...";
        }
    }
    
    titleEl.textContent = title;
}

function highlightToc(href) {
    if(!useToc) return;
    if(!href) return;
    const lis = tocList.querySelectorAll("li");
    lis.forEach(li => {
    li.classList.toggle("active", li.dataset.href === href.split('#')[0]);
    });
}

function updateNavButtons() {
    if(!rendition) return;

    // 简单禁用规则，添加容错处理
    try {
    if (rendition.locations && typeof rendition.locations.then === 'function') {
        rendition.locations.then(locations => {
        if(!locations){
            prevBtn.disabled = false;
            nextBtn.disabled = false;
            return;
        }
        const atStart = rendition.location && rendition.location.atStart;
        const atEnd = rendition.location && rendition.location.atEnd;
        prevBtn.disabled = atStart;
        nextBtn.disabled = atEnd;
        }).catch(() => {
        prevBtn.disabled = false;
        nextBtn.disabled = false;
        });
    } else {
        // 备用方法：基于当前位置简单判断
        if (rendition.location) {
        prevBtn.disabled = rendition.location.atStart || false;
        nextBtn.disabled = rendition.location.atEnd || false;
        } else {
        prevBtn.disabled = false;
        nextBtn.disabled = false;
        }
    }
    } catch (error) {
    console.warn("updateNavButtons failed:", error);
    // 发生错误时启用所有按钮
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    }
}

function buildToc(navigation) {
    console.log("Building TOC with navigation:", navigation);
    tocList.innerHTML = "";
    
    if(!navigation || !navigation.toc || navigation.toc.length === 0){
    // 无目录时隐藏目录面板，启用无目录模式
    console.log("No TOC found, using spine-only mode");
    tocList.innerHTML = "<li>无目录</li>";
    if (window.innerWidth > 768) {
        tocPanel.style.display = "none";
    }
    useToc = false;
    return;
    }
    
    console.log("TOC found with", navigation.toc.length, "items");
    useToc = true;
    if (window.innerWidth > 768) {
    tocPanel.style.display = "block";
    } else {
    // 手机端默认隐藏目录，通过按钮显示
    tocPanel.style.display = "none";
    }
    
    function renderItems(items, container){
    items.forEach((item, index) => {
        try {
        const li = document.createElement("li");
        li.textContent = item.label || `章节 ${index + 1}`;
        li.dataset.href = (item.href || '').split('#')[0];
        li.onclick = () => {
            if (rendition && item.href) {
            rendition.display(item.href).then(() => {
                // 直接使用点击的项目更新标题
                updateTitle({ href: item.href });
            }).catch(navError => {
                console.error("Navigation failed:", navError);
            });
            
            // 手机端点击目录项后自动关闭目录
            if (window.innerWidth <= 768) {
                closeMobileToc();
            }
            }
        };
        container.appendChild(li);
        
        if(item.subitems && item.subitems.length){
            const ul = document.createElement("ul");
            renderItems(item.subitems, ul);
            container.appendChild(ul);
        }
        } catch (itemError) {
        console.warn("Failed to render TOC item:", item, itemError);
        }
    });
    }
    
    try {
    renderItems(navigation.toc, tocList);
    
    // 添加收起目录按钮 - 简约样式
    const closeBtn = document.createElement("li");
    closeBtn.innerHTML = '<button style="width: 100%; margin-top: 10px; background: #6c757d; color: white; border: none; padding: 6px; border-radius: 3px; cursor: pointer; font-size: 12px;">收起目录</button>';
    closeBtn.style.listStyle = "none";
    closeBtn.onclick = () => {
        if (window.innerWidth > 768) {
        // 桌面端隐藏整个目录面板
        tocPanel.style.display = "none";
        tocToggleBtn.textContent = "显示目录";
        } else {
        // 手机端使用统一的关闭函数
        closeMobileToc();
        }
    };
    tocList.appendChild(closeBtn);
    
    console.log("TOC rendered successfully");
    } catch (tocError) {
    console.error("Failed to render TOC:", tocError);
    tocList.innerHTML = "<li>目录渲染失败</li>";
    useToc = false;
    }
}

prevBtn.onclick = () => {
    if(!rendition) return;
    if(useToc){
    rendition.prev();
    } else {
    // 无目录时用 spine 顺序翻页
    const currentIndex = spineItems.findIndex(href => href === currentLocation?.href?.split('#')[0]);
    if(currentIndex > 0){
        rendition.display(spineItems[currentIndex - 1]);
    }
    }
};

nextBtn.onclick = () => {
    if(!rendition) return;
    if(useToc){
    rendition.next();
    } else {
    const currentIndex = spineItems.findIndex(href => href === currentLocation?.href?.split('#')[0]);
    if(currentIndex >= 0 && currentIndex < spineItems.length - 1){
        rendition.display(spineItems[currentIndex + 1]);
    }
    }
};

fontIncreaseBtn.onclick = () => {
    if (!rendition || !rendition.themes) return;
    fontSize += 10;
    if (fontSize > 200) fontSize = 200;
    
    // 温和地调整字体大小，不破坏原始样式
    try {
    if (rendition.themes.fontSize) {
        rendition.themes.fontSize(fontSize + "%");
    } else if (rendition.themes.override) {
        rendition.themes.override("fontSize", fontSize + "%");
    } else if (rendition.themes.register) {
        rendition.themes.register("fontSizeAdjust", {
        "body": { "font-size": fontSize + "%" },
        "p": { "font-size": "inherit" },
        "div": { "font-size": "inherit" }
        });
        rendition.themes.select("fontSizeAdjust");
    }
    } catch (fontError) {
    console.warn("Failed to adjust font size:", fontError);
    }
};

fontDecreaseBtn.onclick = () => {
    if (!rendition || !rendition.themes) return;
    fontSize -= 10;
    if (fontSize < 50) fontSize = 50;
    
    // 温和地调整字体大小，不破坏原始样式
    try {
    if (rendition.themes.fontSize) {
        rendition.themes.fontSize(fontSize + "%");
    } else if (rendition.themes.override) {
        rendition.themes.override("fontSize", fontSize + "%");
    } else if (rendition.themes.register) {
        rendition.themes.register("fontSizeAdjust", {
        "body": { "font-size": fontSize + "%" },
        "p": { "font-size": "inherit" },
        "div": { "font-size": "inherit" }
        });
        rendition.themes.select("fontSizeAdjust");
    }
    } catch (fontError) {
    console.warn("Failed to adjust font size:", fontError);
    }
};

// 综合主题模式切换按钮（日间颜色主题 + 夜间模式）
modeToggleBtn.onclick = () => {
    if (!rendition || !rendition.themes) return;
    
    // 循环切换模式：默认 -> 护眼绿 -> 暖黄 -> 深蓝 -> 夜间 -> 默认
    currentMode = (currentMode + 1) % 5;
    applyThemeMode(currentMode);
    
    // 保存用户选择
    try {
        localStorage.setItem('epub-theme-mode', currentMode.toString());
    } catch (e) {
        console.warn("Failed to save mode preference:", e);
    }
};

// 页面模式切换按钮（所有设备都可用）
pageToggleBtn.onclick = () => {
    // 手机端提示双页模式无效果但仍允许切换
    if (window.innerWidth <= 768 && !document.body.classList.contains("double-page")) {
    // 手机端切换到双页时给个提示
    console.log("手机端双页模式不会改变显示效果");
    }
    
    // 尝试获取当前精确位置
    let savedLocation = currentLocation;
    
    // 尝试获取当前viewport的scroll位置或其他精确位置信息
    if (rendition && typeof rendition.currentLocation === 'function') {
    try {
        savedLocation = rendition.currentLocation();
    } catch (e) {
        console.warn("Failed to get currentLocation:", e);
        savedLocation = currentLocation;
    }
    } else if (rendition && rendition.location) {
    savedLocation = rendition.location;
    }
    
    console.log("Saving current location before page mode change:", savedLocation);
    
    if(document.body.classList.contains("double-page")){
    // 当前是双页，切换为单页
    document.body.classList.remove("double-page");
    pageToggleBtn.textContent = "双页";
    pageToggleBtn.title = "切换为双页模式";
    } else {
    // 当前是单页，切换为双页
    document.body.classList.add("double-page");
    pageToggleBtn.textContent = "单页";
    pageToggleBtn.title = "切换为单页模式";
    }
    
    // 延迟一点点再重新渲染，确保获取到正确位置
    setTimeout(() => {
    // 重新渲染并恢复位置
    if(rendition) {
        rendition.destroy();
        rendition = null;
    }
    
    renderBookWithLocation(savedLocation);
    }, 50);
};

// 目录切换按钮（所有设备都可用）
tocToggleBtn.onclick = () => {
    if (window.innerWidth > 768) {
    // 桌面端：简单显示/隐藏目录面板
    if (tocPanel.style.display === "none") {
        tocPanel.style.display = "block";
        tocToggleBtn.textContent = "隐藏目录";
    } else {
        tocPanel.style.display = "none";
        tocToggleBtn.textContent = "显示目录";
    }
    } else {
    // 手机端：使用固定定位的覆盖层
    if(tocPanel.style.display === "none" || tocPanel.style.display === ""){
        // 显示目录
        tocPanel.style.display = "block";
        tocPanel.style.position = "fixed";
        tocPanel.style.top = "0";
        tocPanel.style.left = "0";
        tocPanel.style.width = "80%";
        tocPanel.style.height = "100%";
        tocPanel.style.zIndex = "1000";
        tocPanel.style.boxShadow = "2px 0 5px rgba(0,0,0,0.3)";
        tocToggleBtn.textContent = "关闭";
    } else {
        // 隐藏目录，恢复原样式
        closeMobileToc();
    }
    }
};

// 桌面端不再需要额外的显示目录按钮，因为工具栏已有目录按钮
// 移除了桌面端的悬浮显示目录按钮功能

// 关闭手机端目录的函数
function closeMobileToc() {
    tocPanel.style.display = "none";
    tocPanel.style.position = "";
    tocPanel.style.top = "";
    tocPanel.style.left = "";
    tocPanel.style.width = "";
    tocPanel.style.height = "";
    tocPanel.style.zIndex = "";
    tocPanel.style.boxShadow = "";
    tocToggleBtn.textContent = "目录";
}

// 点击阅读区域关闭目录（仅手机端）
document.getElementById('main').onclick = (e) => {
    if (window.innerWidth <= 768 && 
        tocPanel.style.position === "fixed" && 
        tocPanel.style.display !== "none") {
    // 如果点击的不是目录按钮，则关闭目录
    if (!tocToggleBtn.contains(e.target)) {
        closeMobileToc();
    }
    }
};

// 防抖处理resize事件，避免频繁重新渲染
let resizeTimeout;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (rendition) {
            console.log("Window resized, updating rendition size...");
            const size = getViewportSize();
            let rendWidth = size.width;
            if(document.body.classList.contains("double-page") && window.innerWidth > 768){
                rendWidth = rendWidth / 2;
            }
            // 只更新尺寸，不重新渲染整个书本
            rendition.resize(rendWidth, size.height);
            
            // 窗口大小变化时重新计算标题长度
            if (currentLocation) {
                updateTitle(currentLocation);
            }
        }
    }, 250);
});

// 设置加载超时
const loadingTimeout = setTimeout(() => {
    console.error("EPUB加载超时");
    titleEl.textContent = "加载超时，请检查文件格式";
    tocList.innerHTML = "<li>加载超时</li>";
}, 30000);

// 检查book.ready是否存在并且是Promise或函数
if (!book || !book.ready) {
    clearTimeout(loadingTimeout);
    console.error("book.ready is not available:", book.ready);
    titleEl.textContent = "EPUB对象无效";
    tocList.innerHTML = "<li>EPUB对象创建失败</li>";
    return;
}

console.log("Starting book.ready promise chain...");

// 确保ready是Promise
let readyPromise = book.ready;
if (typeof readyPromise.then !== 'function') {
    if (typeof readyPromise === 'function') {
    readyPromise = new Promise((resolve) => {
        readyPromise(resolve);
    });
    } else {
    readyPromise = Promise.resolve();
    }
}

readyPromise.then(() => {
    clearTimeout(loadingTimeout);
    console.log("Book ready, loading spine...");
    
    // 获取 spine 顺序用于无目录翻页，添加容错处理
    try {
    if (book.spine && book.spine.each) {
        book.spine.each(item => {
        if (item && item.href) {
            spineItems.push(item.href.split('#')[0]);
        }
        });
    } else if (book.spine && book.spine.items) {
        // 备用方法：直接访问spine.items
        book.spine.items.forEach(item => {
        if (item && item.href) {
            spineItems.push(item.href.split('#')[0]);
        }
        });
    }
    console.log("Spine items loaded:", spineItems.length);
    } catch (spineError) {
    console.warn("Failed to load spine items:", spineError);
    // 即使spine加载失败也继续执行
    }

    // 加载导航信息
    if (book.loaded && book.loaded.navigation) {
    return book.loaded.navigation.then(nav => {
        console.log("Navigation loaded:", nav);
        return nav;
    }).catch(navError => {
        console.warn("Failed to load navigation:", navError);
        return null; // 返回null而不是抛出错误
    });
    } else if (book.navigation) {
    // 直接访问navigation属性
    console.log("Using direct navigation access");
    return Promise.resolve(book.navigation);
    } else {
    console.warn("book.loaded.navigation not available");
    return null;
    }
}).then(nav => {
    console.log("Building TOC...");
    buildToc(nav);
    console.log("Rendering book...");
    renderBook();
    
    // 更新标题显示加载成功
    if (!titleEl.textContent || titleEl.textContent === "加载中...") {
    titleEl.textContent = (book.metadata && book.metadata.title) || "EPUB阅读器";
    }
}).catch(e => {
    clearTimeout(loadingTimeout);
    console.error("EPUB加载失败:", e);
    
    // 更详细的错误信息
    let errorMsg = "加载失败";
    if (e && e.message) {
    if (e.message.includes("404") || e.message.includes("Not Found")) {
        errorMsg = "文件未找到";
    } else if (e.message.includes("CORS")) {
        errorMsg = "跨域访问被拒绝";
    } else if (e.message.includes("Invalid")) {
        errorMsg = "文件格式无效";
    } else {
        errorMsg = "加载失败: " + e.message.substring(0, 50);
    }
    }
    
    titleEl.textContent = errorMsg;
    tocList.innerHTML = `<li>${errorMsg}</li>`;
    tocPanel.style.display = "none";
    useToc = false;
    
    // 即使加载失败也尝试渲染，可能部分内容可用
    if (book && spineItems.length > 0) {
    console.log("Attempting to render with available spine items...");
    try {
        renderBook();
    } catch (renderError) {
        console.error("Final render attempt failed:", renderError);
    }
    }
});

// 备用初始化方法：如果Promise方式失败，尝试直接初始化
setTimeout(() => {
    if (titleEl.textContent === "加载中..." || titleEl.textContent.includes("失败")) {
    console.log("Attempting direct initialization as fallback...");
    try {
        // 直接尝试获取spine
        if (book && book.spine) {
        console.log("Direct spine access:", book.spine);
        if (book.spine.items) {
            spineItems = book.spine.items.map(item => item.href);
            console.log("Direct spine items:", spineItems.length);
        }
        }
        
        // 直接尝试渲染
        if (spineItems.length > 0 || (book && book.spine)) {
        console.log("Attempting direct render...");
        buildToc(null); // 无目录模式
        renderBook();
        titleEl.textContent = "EPUB已加载（备用模式）";
        }
    } catch (directError) {
        console.error("Direct initialization also failed:", directError);
    }
    }
}, 5000);

})();
