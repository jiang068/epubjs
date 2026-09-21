import type { ImageFit, ReaderDirection, ReaderFlow, ReaderSpread, ReaderTheme } from "../types";

export interface ReaderPreferences {
  theme: ReaderTheme;
  fontSize: number;
  spread: ReaderSpread;
  flow: ReaderFlow;
  lineHeight: number;
  imageFit: ImageFit;
  scrollZoom: number;
  direction: ReaderDirection;
}

export const THEME_OPTIONS: Array<{ id: ReaderTheme; label: string; hint: string }> = [
  { id: "original", label: "原版", hint: "保留书籍配色" },
  { id: "sakura", label: "樱花", hint: "柔和粉色" },
  { id: "paper", label: "纸张", hint: "暖白护眼" },
  { id: "sepia", label: "暖黄", hint: "复古米黄色" },
  { id: "eye", label: "护眼绿", hint: "淡绿低对比" },
  { id: "night", label: "夜间", hint: "低亮深紫" },
  { id: "oled", label: "纯黑", hint: "OLED 黑色" }
];

const validThemes = new Set<ReaderTheme>(THEME_OPTIONS.map((item) => item.id));

export function loadPreferences(): ReaderPreferences {
  let storedTheme = localStorage.getItem("neko-theme") as ReaderTheme | null;
  if (!storedTheme) {
    const oldMode = localStorage.getItem("epub-theme-mode");
    storedTheme = ({ "0": "original", "1": "eye", "2": "sepia", "3": "night" } as Record<string, ReaderTheme>)[oldMode || ""] || null;
  }
  const storedFontSize = Number(localStorage.getItem("neko-font-size") || 100);
  const storedSpread = localStorage.getItem("neko-spread");
  const storedFlow = localStorage.getItem("neko-flow");
  const storedLineHeight = Number(localStorage.getItem("neko-line-height") || 1.85);
  const storedImageFit = localStorage.getItem("neko-image-fit");
  const storedScrollZoom = Number(localStorage.getItem("neko-scroll-zoom") || 90);
  const storedDirection = localStorage.getItem("neko-direction");
  return {
    theme: storedTheme && validThemes.has(storedTheme) ? storedTheme : "sakura",
    fontSize: Number.isFinite(storedFontSize) ? Math.max(50, Math.min(200, storedFontSize)) : 100,
    spread: storedSpread === "double" ? "double" : "single",
    flow: storedFlow === "scrolled" ? "scrolled" : "paginated",
    lineHeight: Number.isFinite(storedLineHeight) ? Math.max(1.35, Math.min(2.4, storedLineHeight)) : 1.85,
    imageFit: storedImageFit === "width" || storedImageFit === "original" ? storedImageFit : "contain",
    scrollZoom: Number.isFinite(storedScrollZoom) ? Math.max(30, Math.min(100, storedScrollZoom)) : 90,
    direction: storedDirection === "reverse" ? "reverse" : "forward"
  };
}

export function savePreferences(preferences: ReaderPreferences): void {
  localStorage.setItem("neko-theme", preferences.theme);
  localStorage.setItem("neko-font-size", String(preferences.fontSize));
  localStorage.setItem("neko-spread", preferences.spread);
  localStorage.setItem("neko-flow", preferences.flow);
  localStorage.setItem("neko-line-height", String(preferences.lineHeight));
  localStorage.setItem("neko-image-fit", preferences.imageFit);
  localStorage.setItem("neko-scroll-zoom", String(preferences.scrollZoom));
  localStorage.setItem("neko-direction", preferences.direction);
  document.body.dataset.theme = preferences.theme;
}

export function applyPreferences(preferences: ReaderPreferences): void {
  document.body.dataset.theme = preferences.theme;
}
