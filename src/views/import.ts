import { detectFormat, isImageFile, recordFromFile, recordFromImages, recordFromUrl, sortNaturally } from "../core/source";
import { saveBook } from "../core/storage";
import { navigate, readerPath } from "../core/router";
import type { BookRecord, StoredImage } from "../types";
import { pageShell, toast } from "../ui/common";

async function persistFiles(files: FileList | File[]): Promise<BookRecord[]> {
  const items = [...files].filter((file) => file.size || isImageFile(file));
  if (!items.length) throw new Error("没有选中可导入的文件");
  const images = items.filter(isImageFile);
  if (images.length > 1 && images.length === items.length) {
    const stored: StoredImage[] = sortNaturally(images).map((file) => ({ name: file.webkitRelativePath || file.name, blob: file }));
    const title = stored[0].name.includes("/") ? stored[0].name.split("/")[0] : "图片漫画";
    const comic = recordFromImages(stored, title);
    await saveBook(comic);
    return [comic];
  }
  const records = items.map((file) => recordFromFile(file, detectFormat(file.name, file.type)));
  await Promise.all(records.map(saveBook));
  return records;
}

export function renderImport(root: HTMLElement): void {
  root.innerHTML = pageShell("import", `
    <section class="page-heading"><p class="eyebrow">ADD TO LIBRARY</p><h1>导入作品</h1><p>选择本地文件、整套漫画图片，或粘贴 OpenList / Alist 文件地址。</p></section>
    <section class="import-grid">
      <button class="import-card" id="pick-file"><span class="import-icon">＋</span><strong>本地文件</strong><small>EPUB、PDF、TXT、CBZ、ZIP 或图片</small></button>
      <button class="import-card" id="pick-folder"><span class="import-icon">▧</span><strong>漫画文件夹</strong><small>自动按文件名自然排序，适合一话一文件夹</small></button>
    </section>
    <section class="panel remote-panel"><div><p class="eyebrow">REMOTE URL</p><h2>外部文件链接</h2><p>HTTPS + CORS 可直接读取；Cloudflare Pages 部署时，HTTP 会自动走项目的白名单代理。</p></div><form id="url-form" class="stack-form"><label>文件地址<input id="url-input" type="url" placeholder="https://example.com/book.epub" required></label><label>显示名称（可选）<input id="name-input" type="text" placeholder="例如：第一卷.epub"></label><button class="button primary" type="submit">打开远程文件</button></form></section>
    <section class="panel tips"><h2>导入说明</h2><div class="feature-list"><p><b>图片漫画</b><span>多选图片或选择文件夹，阅读器会合并为一本漫画。</span></p><p><b>可控的本地保留</b><span>默认保留最近 3 本的文件本体；可在“阅读设置”中改为不保留、1 / 3 / 5 / 10 本或不限数量。</span></p><p><b>静态部署</b><span>GitHub Pages 无服务端代理，远程源必须支持 HTTPS 与 CORS。</span></p></div></section>
    <input id="file-input" hidden type="file" multiple accept=".epub,.pdf,.txt,.cbz,.zip,image/*">
    <input id="folder-input" hidden type="file" multiple webkitdirectory directory accept="image/*">`);

  const importAndOpen = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const records = await persistFiles(files);
      toast(`已导入 ${records.length} 本作品`);
      if (records.length === 1) navigate(readerPath(records[0].id));
      else navigate("/library");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };
  const fileInput = root.querySelector<HTMLInputElement>("#file-input");
  const folderInput = root.querySelector<HTMLInputElement>("#folder-input");
  const supportsDirectoryPicker = folderInput && typeof (folderInput as unknown as Record<string, unknown>).webkitdirectory === "boolean";
  if (folderInput && !supportsDirectoryPicker) {
    folderInput.removeAttribute("webkitdirectory");
    folderInput.removeAttribute("directory");
    const hint = root.querySelector<HTMLElement>("#pick-folder small");
    if (hint) hint.textContent = "当前浏览器请多选漫画图片，阅读器会自动排序";
  }
  root.querySelector("#pick-file")?.addEventListener("click", () => fileInput?.click());
  root.querySelector("#pick-folder")?.addEventListener("click", () => folderInput?.click());
  fileInput?.addEventListener("change", () => void importAndOpen(fileInput.files));
  folderInput?.addEventListener("change", () => void importAndOpen(folderInput.files));
  root.querySelector("#url-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = root.querySelector<HTMLInputElement>("#url-input")?.value.trim() || "";
    const name = root.querySelector<HTMLInputElement>("#name-input")?.value.trim() || undefined;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("只支持 HTTP 或 HTTPS 文件地址");
      const record = recordFromUrl(parsed.toString(), name);
      void saveBook(record).then(() => navigate(readerPath(record.id))).catch((error) => toast(String(error), true));
    } catch (error) {
      toast(error instanceof Error ? error.message : "请输入有效的文件地址", true);
    }
  });
}
