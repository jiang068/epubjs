import "./styles.css";
import { NekoApp } from "./app";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("找不到应用挂载节点 #app");

new NekoApp(root).start();
