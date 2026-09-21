import { THEME_OPTIONS, savePreferences, type ReaderPreferences } from "../core/preferences";
import type { ImageFit, ReaderFlow, ReaderSpread, ReaderTheme } from "../types";
import { pageShell, toast } from "../ui/common";

export function renderSettings(root: HTMLElement, preferences: ReaderPreferences, onChange: () => void): void {
  root.innerHTML = pageShell("settings", `
    <section class="page-heading"><p class="eyebrow">READING PREFERENCES</p><h1>阅读设置</h1><p>设置会保存在当前浏览器，并立即应用到 EPUB、TXT 与阅读器界面。</p></section>
    <section class="settings-layout">
      <div class="panel setting-block"><div><p class="eyebrow">BACKGROUND</p><h2>阅读背景</h2></div><div class="theme-grid">${THEME_OPTIONS.map((theme) => `<button class="theme-choice ${preferences.theme === theme.id ? "active" : ""}" data-theme-choice="${theme.id}"><span class="theme-preview theme-${theme.id}"></span><b>${theme.label}</b><small>${theme.hint}</small></button>`).join("")}</div></div>
      <div class="panel setting-block"><div><p class="eyebrow">TYPE SIZE</p><h2>正文字号</h2></div><div class="font-control"><button class="button secondary" id="font-down">A−</button><strong id="font-value">${preferences.fontSize}%</strong><button class="button secondary" id="font-up">A＋</button><button class="button ghost" id="font-reset">恢复默认</button></div><div class="font-sample" id="font-sample" style="font-size:${preferences.fontSize}%">春日的风从窗边经过，翻动了故事的第一页。</div></div>
      <div class="panel setting-block"><div><p class="eyebrow">PAGE LAYOUT</p><h2>分页与版式</h2></div><div class="preference-groups"><div><label>阅读方式</label><div class="segment-control"><button data-flow="paginated" class="${preferences.flow === "paginated" ? "active" : ""}">分页翻页</button><button data-flow="scrolled" class="${preferences.flow === "scrolled" ? "active" : ""}">上下滚动</button></div></div><div><label>EPUB / TXT 分页</label><div class="segment-control"><button data-spread="single" class="${preferences.spread === "single" ? "active" : ""}">单页</button><button data-spread="double" class="${preferences.spread === "double" ? "active" : ""}">双页</button></div></div><div><label>正文行距 <strong id="line-height-value">${preferences.lineHeight.toFixed(2)}</strong></label><input id="line-height" type="range" min="1.35" max="2.4" step="0.05" value="${preferences.lineHeight}"></div></div></div>
      <div class="panel setting-block"><div><p class="eyebrow">ILLUSTRATIONS</p><h2>EPUB 配图</h2></div><div><div class="segment-control three"><button data-image-fit="contain" class="${preferences.imageFit === "contain" ? "active" : ""}">整图放大</button><button data-image-fit="width" class="${preferences.imageFit === "width" ? "active" : ""}">适应宽度</button><button data-image-fit="original" class="${preferences.imageFit === "original" ? "active" : ""}">原始尺寸</button></div><p class="setting-hint">“整图放大”会自动识别插画页并尽量铺满阅读区域，同时保持图片比例。</p></div></div>
      <div class="panel setting-block shortcut-block"><div><p class="eyebrow">SHORTCUTS</p><h2>翻页方式</h2></div><div class="shortcut-list"><span><kbd>←</kbd><kbd>→</kbd> 键盘翻页</span><span><kbd>PgUp</kbd><kbd>PgDn</kbd> 上一页 / 下一页</span><span>点击阅读区左右两侧翻页</span><span>手机左右滑动翻页</span></div></div>
    </section>`);

  const commit = () => {
    savePreferences(preferences);
    root.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach((node) => node.classList.toggle("active", node.dataset.themeChoice === preferences.theme));
    const value = root.querySelector<HTMLElement>("#font-value");
    const sample = root.querySelector<HTMLElement>("#font-sample");
    if (value) value.textContent = `${preferences.fontSize}%`;
    if (sample) sample.style.fontSize = `${preferences.fontSize}%`;
    onChange();
  };
  root.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((button) => button.addEventListener("click", () => {
    preferences.theme = button.dataset.themeChoice as ReaderTheme;
    commit();
    toast(`已切换为${button.textContent?.trim() || "新"}背景`);
  }));
  root.querySelector("#font-down")?.addEventListener("click", () => { preferences.fontSize = Math.max(75, preferences.fontSize - 10); commit(); });
  root.querySelector("#font-up")?.addEventListener("click", () => { preferences.fontSize = Math.min(180, preferences.fontSize + 10); commit(); });
  root.querySelector("#font-reset")?.addEventListener("click", () => { preferences.fontSize = 100; commit(); });
  root.querySelectorAll<HTMLButtonElement>("[data-spread]").forEach((button) => button.addEventListener("click", () => {
    preferences.spread = button.dataset.spread as ReaderSpread;
    root.querySelectorAll<HTMLElement>("[data-spread]").forEach((node) => node.classList.toggle("active", node.dataset.spread === preferences.spread));
    commit();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-flow]").forEach((button) => button.addEventListener("click", () => {
    preferences.flow = button.dataset.flow as ReaderFlow;
    root.querySelectorAll<HTMLElement>("[data-flow]").forEach((node) => node.classList.toggle("active", node.dataset.flow === preferences.flow));
    commit();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-image-fit]").forEach((button) => button.addEventListener("click", () => {
    preferences.imageFit = button.dataset.imageFit as ImageFit;
    root.querySelectorAll<HTMLElement>("[data-image-fit]").forEach((node) => node.classList.toggle("active", node.dataset.imageFit === preferences.imageFit));
    commit();
  }));
  root.querySelector<HTMLInputElement>("#line-height")?.addEventListener("input", (event) => {
    preferences.lineHeight = Number((event.target as HTMLInputElement).value);
    const label = root.querySelector("#line-height-value");
    if (label) label.textContent = preferences.lineHeight.toFixed(2);
    commit();
  });
}
