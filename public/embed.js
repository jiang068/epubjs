(function () {
  var loadedScript = document.currentScript;
  var defaultBase = loadedScript ? new URL("./", loadedScript.src).toString() : window.location.href;
  function mount(target, options) {
    var node = typeof target === "string" ? document.querySelector(target) : target;
    if (!node) throw new Error("NekoReader.mount: target not found");
    options = options || {};
    var base = options.baseUrl || defaultBase;
    var url = new URL(base);
    var route = new URLSearchParams();
    route.set("url", options.url || "");
    if (options.name) route.set("name", options.name);
    route.set("embed", "1");
    url.hash = "/open?" + route.toString();
    var frame = document.createElement("iframe");
    frame.src = url.toString();
    frame.title = options.title || "Neko Reader";
    frame.loading = "lazy";
    frame.allow = "fullscreen";
    frame.style.cssText = "width:100%;height:100%;min-height:480px;border:0;border-radius:12px;background:#110d1c";
    node.replaceChildren(frame);
    return frame;
  }
  window.NekoReader = { mount: mount };
})();
