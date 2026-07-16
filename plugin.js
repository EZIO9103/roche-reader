(function () {
  "use strict";

  var PLUGIN_ID = "roche-xhs-forwarder";
  var VERSION = "0.3.1";
  var CONFIG_KEY = "rxf_xhs_config_v1";
  var MARKER_START = "[XHS_CARD_V1]";
  var MARKER_END = "[/XHS_CARD_V1]";
  var ALLOWED_HOSTS = [
    "xhslink.com",
    "www.xhslink.com",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "rednote.com",
    "www.rednote.com"
  ];
  var DEFAULT_CONFIG = {
    baseUrl: "",
    gatewayKey: "",
    ocrEnabled: true,
    maxImages: 9
  };

  if (window.__rocheXhsForwarder && typeof window.__rocheXhsForwarder.destroy === "function") {
    try {
      window.__rocheXhsForwarder.destroy();
    } catch (_) {}
  }

  var state = {
    roche: null,
    config: loadLocalConfig(),
    pending: null,
    overlay: null,
    observer: null,
    style: null,
    listenersInstalled: false,
    bypassSend: false,
    lastInput: null,
    inputSnapshots: new WeakMap(),
    inputFallbackTimer: null,
    ignoreInputDetection: false,
    destroyed: false
  };

  function mergeConfig(value) {
    var next = Object.assign({}, DEFAULT_CONFIG, value || {});
    next.baseUrl = String(next.baseUrl || "").trim().replace(/\/+$/, "");
    next.gatewayKey = String(next.gatewayKey || "").trim();
    next.ocrEnabled = next.ocrEnabled !== false;
    next.maxImages = Math.max(1, Math.min(12, Number(next.maxImages) || 9));
    return next;
  }

  function loadLocalConfig() {
    try {
      return mergeConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"));
    } catch (_) {
      return mergeConfig({});
    }
  }

  function saveLocalConfig(config) {
    state.config = mergeConfig(config);
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    } catch (_) {}
    return state.config;
  }

  async function loadScopedConfig(roche) {
    var stored = null;
    try {
      stored = await roche.storage.get(CONFIG_KEY);
    } catch (_) {}
    var merged = mergeConfig(stored || loadLocalConfig());
    saveLocalConfig(merged);
    return merged;
  }

  async function saveScopedConfig(roche, config) {
    var clean = saveLocalConfig(config);
    try {
      await roche.storage.set(CONFIG_KEY, clean);
    } catch (_) {}
    return clean;
  }

  function toast(message) {
    try {
      if (state.roche && state.roche.ui && state.roche.ui.toast) {
        state.roche.ui.toast(message);
        return;
      }
    } catch (_) {}
    console.log("[小红书转发] " + message);
  }

  function isEditable(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.closest && target.closest(".rxf-settings-root")) return false;
    var tag = String(target.tagName || "").toLowerCase();
    return tag === "textarea" || tag === "input" || target.isContentEditable === true;
  }

  function getEditableValue(input) {
    if (!input) return "";
    if (input.isContentEditable) return input.innerText || input.textContent || "";
    return input.value || "";
  }

  function setEditableValue(input, value) {
    if (!input) return;
    if (input.isContentEditable) {
      input.focus();
      input.textContent = value;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      }));
      return;
    }
    var proto = input.tagName && input.tagName.toLowerCase() === "textarea"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertOrdinaryText(input, text) {
    var existing = getEditableValue(input);
    var next = existing;
    if (next && !/\s$/.test(next)) next += " ";
    next += text;
    state.ignoreInputDetection = true;
    try {
      setEditableValue(input, next);
      state.inputSnapshots.set(input, next);
    } finally {
      state.ignoreInputDetection = false;
    }
    input.focus();
  }

  function insertedText(before, after) {
    var left = 0;
    var maxLeft = Math.min(before.length, after.length);
    while (left < maxLeft && before.charAt(left) === after.charAt(left)) left += 1;
    var right = 0;
    var beforeRemain = before.length - left;
    var afterRemain = after.length - left;
    while (
      right < beforeRemain &&
      right < afterRemain &&
      before.charAt(before.length - 1 - right) === after.charAt(after.length - 1 - right)
    ) {
      right += 1;
    }
    return after.slice(left, after.length - right);
  }

  function stripXhsUrls(text) {
    var original = String(text || "");
    var cleaned = original.replace(/https?:\/\/[^\s<>"']+/gi, function (match) {
      return normalizeCandidateUrl(match) ? "" : match;
    });
    if (/(复制.{0,20}(打开|浏览).{0,12}(小红书|RedNote)|打开.{0,12}(小红书|RedNote).{0,20}(查看|浏览))/i.test(original)) {
      return "";
    }
    return cleaned.replace(/[ \t]{2,}/g, " ").replace(/^\s+|\s+$/g, "");
  }

  function setInputWithoutDetection(input, value) {
    state.ignoreInputDetection = true;
    try {
      setEditableValue(input, value);
      state.inputSnapshots.set(input, value);
    } finally {
      state.ignoreInputDetection = false;
    }
  }

  function beginReadFromInput(input, sourceText, preservedText) {
    if (!input || state.pending) return false;
    var current = getEditableValue(input);
    var source = String(sourceText || current);
    var url = extractXhsUrl(source) || extractXhsUrl(current);
    if (!url) return false;
    if (!state.config.baseUrl) {
      toast("检测到小红书链接，请先打开“小红书转发”设置读取服务");
      return false;
    }
    if (state.inputFallbackTimer) clearTimeout(state.inputFallbackTimer);
    state.inputFallbackTimer = null;
    var remaining = preservedText === undefined ? stripXhsUrls(current) : String(preservedText || "");
    setInputWithoutDetection(input, remaining);
    state.lastInput = input;
    startRead(source, url, input);
    return true;
  }

  function normalizeCandidateUrl(raw) {
    var value = String(raw || "").trim().replace(/[)\]}>，。！？；：、]+$/g, "");
    try {
      var url = new URL(value);
      var host = url.hostname.toLowerCase();
      if (ALLOWED_HOSTS.indexOf(host) === -1) return "";
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function extractXhsUrl(text) {
    var matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (var i = 0; i < matches.length; i += 1) {
      var normalized = normalizeCandidateUrl(matches[i]);
      if (normalized) return normalized;
    }
    return "";
  }

  function encodeBase64Url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function decodeBase64Url(text) {
    var value = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
    while (value.length % 4) value += "=";
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function cleanText(value, maxLength) {
    var text = String(value || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (maxLength && text.length > maxLength) return text.slice(0, maxLength) + "…";
    return text;
  }

  function readableOcr(data) {
    var items = Array.isArray(data.imageOcr) ? data.imageOcr : [];
    return items
      .map(function (item) {
        var text = cleanText(item && item.text, 1400);
        return text ? "第" + (Number(item.index) + 1) + "张图：\n" + text : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function buildOutgoingMessage(data, userNote) {
    var images = Array.isArray(data.images)
      ? data.images.filter(function (url) { return /^https?:\/\//i.test(String(url || "")); }).slice(0, 12)
      : [];
    var display = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
      source: "小红书",
      url: data.canonicalUrl || data.originalUrl || "",
      title: cleanText(data.title, 180) || "小红书笔记",
      author: cleanText(data.author, 80),
      content: cleanText(data.content, 500),
      cover: data.cover || "",
      images: images,
      imageCount: images.length,
      ocrCount: Array.isArray(data.imageOcr)
        ? data.imageOcr.filter(function (item) { return cleanText(item && item.text); }).length
        : 0,
      userNote: cleanText(userNote, 1000)
    };
    var ocr = readableOcr(data);
    var lines = [];
    if (display.userNote) lines.push("用户附言：" + display.userNote, "");
    lines.push("【转发的小红书笔记】");
    lines.push("标题：" + display.title);
    if (display.author) lines.push("作者：" + display.author);
    if (data.content) lines.push("笔记正文：\n" + cleanText(data.content, 6500));
    if (images.length) {
      lines.push("配图原图地址（按笔记顺序）：\n" + images.map(function (url, index) {
        return (index + 1) + ". " + url;
      }).join("\n"));
    }
    if (ocr) lines.push("配图文字识别：\n" + cleanText(ocr, 6500));
    lines.push("原链接：" + display.url);
    lines.push("【小红书笔记结束】");
    lines.push(MARKER_START + encodeBase64Url(JSON.stringify(display)) + MARKER_END);
    return lines.join("\n");
  }

  async function callExtractor(url) {
    var config = state.config;
    if (!config.baseUrl) throw new Error("请先在“小红书转发”插件里设置读取服务地址");
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 90000);
    try {
      var response = await fetch(config.baseUrl + "/extract/xhs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-Key": config.gatewayKey
        },
        body: JSON.stringify({
          url: url,
          ocr: config.ocrEnabled,
          maxImages: config.maxImages
        }),
        signal: controller.signal
      });
      var data = null;
      try {
        data = await response.json();
      } catch (_) {}
      if (!response.ok) {
        throw new Error((data && (data.detail || data.error)) || "读取服务返回 HTTP " + response.status);
      }
      if (!data || data.ok !== true) throw new Error((data && data.error) || "没有取得笔记内容");
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("读取超时，请稍后重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function ensureGlobalStyles() {
    var existing = document.getElementById("rxf-xhs-global-style");
    if (existing) {
      state.style = existing;
      return;
    }
    var style = document.createElement("style");
    style.id = "rxf-xhs-global-style";
    style.textContent = [
      ".rxf-xhs-overlay{position:fixed;left:12px;right:12px;bottom:calc(82px + env(safe-area-inset-bottom));z-index:2147483000;max-width:430px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}",
      ".rxf-xhs-preview{background:rgba(255,255,255,.96);color:#202124;border:1px solid rgba(0,0,0,.08);border-radius:16px;box-shadow:0 10px 32px rgba(0,0,0,.2);overflow:hidden;backdrop-filter:blur(18px);}",
      ".rxf-xhs-preview-head{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid rgba(0,0,0,.07);font-size:13px;font-weight:650;}",
      ".rxf-xhs-logo{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:#ff2442;color:white;font-size:13px;font-weight:800;flex:0 0 auto;}",
      ".rxf-xhs-grow{flex:1;min-width:0;}",
      ".rxf-xhs-state{font-size:12px;color:#73777f;font-weight:500;white-space:nowrap;}",
      ".rxf-xhs-preview-body{padding:12px 13px;display:flex;gap:11px;min-height:76px;}",
      ".rxf-xhs-cover{width:68px;height:68px;border-radius:10px;object-fit:cover;background:#f0f1f3;flex:0 0 auto;}",
      ".rxf-xhs-cover-fallback{display:grid;place-items:center;width:68px;height:68px;border-radius:10px;background:linear-gradient(135deg,#ff2442,#ff8a9d);color:#fff;font-weight:800;flex:0 0 auto;}",
      ".rxf-xhs-copy{min-width:0;flex:1;}",
      ".rxf-xhs-title{font-size:14px;line-height:1.35;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
      ".rxf-xhs-meta{font-size:12px;line-height:1.4;color:#777;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".rxf-xhs-error{padding:12px 13px;color:#b42318;font-size:13px;line-height:1.45;}",
      ".rxf-xhs-actions{display:flex;gap:8px;padding:0 13px 12px;}",
      ".rxf-xhs-btn{border:0;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:650;background:#eceef1;color:#25272a;}",
      ".rxf-xhs-btn.primary{background:#ff2442;color:#fff;flex:1;}",
      ".rxf-xhs-btn:disabled{opacity:.55;}",
      ".rxf-xhs-spinner{width:15px;height:15px;border:2px solid rgba(255,36,66,.25);border-top-color:#ff2442;border-radius:50%;animation:rxfspin .8s linear infinite;}",
      "@keyframes rxfspin{to{transform:rotate(360deg)}}",
      ".rxf-rendered-card{width:min(410px,calc(100vw - 94px));min-width:250px;border-radius:18px;overflow:hidden;background:#fff;color:#202124;border:1px solid rgba(0,0,0,.08);box-shadow:0 5px 18px rgba(24,24,28,.10);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:left;}",
      ".rxf-card-note{padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;line-height:1.45;white-space:pre-wrap;}",
      ".rxf-card-top{display:flex;align-items:center;gap:8px;padding:10px 13px;background:rgba(255,255,255,.96);cursor:pointer;}",
      ".rxf-card-logo{display:grid;place-items:center;width:26px;height:26px;border-radius:9px;background:linear-gradient(135deg,#ff2442,#ff637c);color:#fff;font-size:12px;font-weight:850;letter-spacing:-.5px;box-shadow:0 3px 8px rgba(255,36,66,.22);}",
      ".rxf-card-source{flex:1;font-size:12px;color:#ff2442;font-weight:800;}",
      ".rxf-card-kind{font-size:11px;color:#9a9da3;}",
      ".rxf-card-media{position:relative;background:linear-gradient(145deg,#f3f0f6,#eee9f3);overflow:hidden;}",
      ".rxf-card-hero{display:flex;align-items:center;justify-content:center;width:100%;min-height:260px;background:rgba(255,255,255,.28);}",
      ".rxf-card-hero img{display:block;width:100%;height:auto;max-height:520px;aspect-ratio:3/4;object-fit:contain;background:#f4f1f6;}",
      ".rxf-card-count{position:absolute;right:10px;bottom:10px;padding:4px 8px;border-radius:999px;background:rgba(20,20,24,.68);color:#fff;font-size:10px;font-weight:700;line-height:1;backdrop-filter:blur(8px);pointer-events:none;}",
      ".rxf-card-empty{display:grid;place-items:center;min-height:220px;background:linear-gradient(145deg,#ff2442,#ff91a2);color:#fff;font-size:26px;font-weight:850;letter-spacing:2px;}",
      ".rxf-card-info{padding:12px 14px 13px;cursor:pointer;}",
      ".rxf-card-title{font-size:16px;line-height:1.4;font-weight:760;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
      ".rxf-card-desc{font-size:12px;line-height:1.5;color:#777;margin-top:6px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}",
      ".rxf-card-author{display:flex;align-items:center;gap:6px;margin-top:9px;color:#9a9da3;font-size:11px;}",
      ".rxf-card-author-dot{width:5px;height:5px;border-radius:50%;background:#ff2442;}",
      ".rxf-card-foot{display:flex;align-items:center;gap:6px;padding:10px 14px;background:#f7f7f8;color:#767a80;font-size:11px;border-top:1px solid rgba(0,0,0,.035);cursor:pointer;}",
      ".rxf-card-foot span:first-child{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      "@media(prefers-color-scheme:dark){.rxf-xhs-preview,.rxf-rendered-card{background:rgba(31,32,35,.98);color:#f4f4f5;border-color:rgba(255,255,255,.1)}.rxf-xhs-preview-head,.rxf-card-note{border-color:rgba(255,255,255,.09)}.rxf-card-top{background:#202125}.rxf-card-media,.rxf-card-hero,.rxf-card-hero img{background:#292a2f}.rxf-xhs-meta,.rxf-card-desc,.rxf-card-author,.rxf-card-foot{color:#a8abb2}.rxf-xhs-btn{background:#3b3d42;color:#f4f4f5}.rxf-card-foot{background:#292a2e;border-color:rgba(255,255,255,.05)}}"
    ].join("");
    document.head.appendChild(style);
    state.style = style;
  }

  function clearOverlay() {
    if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    state.overlay = null;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function makeCover(url, fallbackClass) {
    if (!url) return element("div", fallbackClass || "rxf-xhs-cover-fallback", "小红书");
    var img = element("img", "rxf-xhs-cover");
    img.src = url;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.onerror = function () {
      var fallback = element("div", fallbackClass || "rxf-xhs-cover-fallback", "小红书");
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    };
    return img;
  }

  function renderOverlay() {
    clearOverlay();
    if (!state.pending) return;
    var pending = state.pending;
    var wrap = element("div", "rxf-xhs-overlay");
    var box = element("div", "rxf-xhs-preview");
    var head = element("div", "rxf-xhs-preview-head");
    head.appendChild(element("div", "rxf-xhs-logo", "RED"));
    head.appendChild(element("div", "rxf-xhs-grow", "小红书转发"));
    var statusText = pending.status === "loading"
      ? "正在读取…"
      : pending.status === "ready" ? "读取完成" : "读取失败";
    if (pending.status === "loading") head.appendChild(element("div", "rxf-xhs-spinner"));
    head.appendChild(element("div", "rxf-xhs-state", statusText));
    box.appendChild(head);

    if (pending.status === "ready") {
      var body = element("div", "rxf-xhs-preview-body");
      body.appendChild(makeCover(pending.data.cover));
      var copy = element("div", "rxf-xhs-copy");
      copy.appendChild(element("div", "rxf-xhs-title", pending.data.title || "小红书笔记"));
      var metaParts = [];
      if (pending.data.author) metaParts.push(pending.data.author);
      if (Array.isArray(pending.data.imageOcr)) {
        var count = pending.data.imageOcr.filter(function (item) { return cleanText(item && item.text); }).length;
        if (count) metaParts.push("识别了 " + count + " 张配图");
      }
      copy.appendChild(element("div", "rxf-xhs-meta", metaParts.join(" · ") || "内容已准备好"));
      body.appendChild(copy);
      box.appendChild(body);
    } else if (pending.status === "error") {
      box.appendChild(element("div", "rxf-xhs-error", pending.error || "读取失败"));
    } else {
      box.appendChild(element("div", "rxf-xhs-error", "正在打开分享链接并识别配图文字，图片较多时会稍慢。"));
    }

    var actions = element("div", "rxf-xhs-actions");
    var cancel = element("button", "rxf-xhs-btn", "取消");
    cancel.type = "button";
    cancel.onclick = function () {
      state.pending = null;
      clearOverlay();
    };
    actions.appendChild(cancel);

    if (pending.status === "error") {
      var ordinary = element("button", "rxf-xhs-btn primary", "改为普通链接");
      ordinary.type = "button";
      ordinary.onclick = function () {
        var input = pending.input || state.lastInput;
        var original = pending.originalText || pending.url;
        state.pending = null;
        clearOverlay();
        if (input) insertOrdinaryText(input, original);
      };
      actions.appendChild(ordinary);
      var retry = element("button", "rxf-xhs-btn", "重试");
      retry.type = "button";
      retry.onclick = function () { startRead(pending.originalText, pending.url, pending.input); };
      actions.appendChild(retry);
    } else {
      var send = element("button", "rxf-xhs-btn primary", pending.status === "ready" ? "发送转发" : "读取中");
      send.type = "button";
      send.disabled = pending.status !== "ready";
      send.onclick = function () { sendPending(null); };
      actions.appendChild(send);
    }
    box.appendChild(actions);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    state.overlay = wrap;
  }

  async function startRead(originalText, url, input) {
    var token = String(Date.now()) + Math.random().toString(36).slice(2);
    state.pending = {
      token: token,
      status: "loading",
      originalText: originalText,
      url: url,
      input: input,
      data: null,
      error: ""
    };
    state.lastInput = input;
    renderOverlay();
    try {
      var data = await callExtractor(url);
      if (!state.pending || state.pending.token !== token) return;
      state.pending.status = "ready";
      state.pending.data = data;
      renderOverlay();
    } catch (error) {
      if (!state.pending || state.pending.token !== token) return;
      state.pending.status = "error";
      state.pending.error = error && error.message ? error.message : "读取失败";
      renderOverlay();
    }
  }

  function onPaste(event) {
    if (state.destroyed || !isEditable(event.target)) return;
    state.lastInput = event.target;
    state.inputSnapshots.set(event.target, getEditableValue(event.target));
    var text = "";
    try {
      text = event.clipboardData.getData("text/plain");
    } catch (_) {}
    var url = extractXhsUrl(text);
    if (!url) return;
    if (!state.config.baseUrl) {
      toast("检测到小红书链接，请先打开“小红书转发”设置读取服务");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startRead(text, url, event.target);
  }

  function onBeforeInput(event) {
    if (state.destroyed || state.bypassSend || state.ignoreInputDetection || state.pending) return;
    if (!isEditable(event.target)) return;
    var input = event.target;
    state.lastInput = input;
    var before = getEditableValue(input);
    state.inputSnapshots.set(input, before);
    var text = String(event.data || "");
    if (!extractXhsUrl(text) || !state.config.baseUrl) return;
    event.preventDefault();
    event.stopPropagation();
    beginReadFromInput(input, text, before);
  }

  function onFocusIn(event) {
    if (!isEditable(event.target)) return;
    state.lastInput = event.target;
    state.inputSnapshots.set(event.target, getEditableValue(event.target));
  }

  function onInput(event) {
    if (!isEditable(event.target)) return;
    var input = event.target;
    var after = getEditableValue(input);
    var before = state.inputSnapshots.has(input) ? state.inputSnapshots.get(input) : "";
    state.inputSnapshots.set(input, after);
    state.lastInput = input;
    if (state.destroyed || state.bypassSend || state.ignoreInputDetection || state.pending) return;
    var inserted = insertedText(String(before || ""), after);
    var source = extractXhsUrl(inserted) ? inserted : after;
    if (!extractXhsUrl(source)) return;
    if (state.inputFallbackTimer) clearTimeout(state.inputFallbackTimer);
    state.inputFallbackTimer = setTimeout(function () {
      state.inputFallbackTimer = null;
      if (state.destroyed || state.bypassSend || state.ignoreInputDetection || state.pending) return;
      var current = getEditableValue(input);
      if (!extractXhsUrl(current) && !extractXhsUrl(source)) return;
      var preserve = extractXhsUrl(inserted) ? before : stripXhsUrls(current);
      beginReadFromInput(input, source, preserve);
    }, 80);
  }

  function isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false;
    var rect = node.getBoundingClientRect();
    var style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function buttonLabel(button) {
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.getAttribute("data-testid"),
      button.textContent
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function findSendButton(input) {
    if (!input) return null;
    var form = input.closest && input.closest("form");
    if (form) {
      var submit = Array.from(form.querySelectorAll("button[type='submit'],input[type='submit']")).filter(isVisible);
      if (submit.length) return submit[submit.length - 1];
    }
    var root = input.parentElement;
    for (var level = 0; root && level < 6; level += 1, root = root.parentElement) {
      var buttons = Array.from(root.querySelectorAll("button")).filter(function (button) {
        return isVisible(button) && !button.closest(".rxf-xhs-overlay");
      });
      var named = buttons.filter(function (button) {
        return /(^|\s)(send|发送|submit)(\s|$)/i.test(buttonLabel(button));
      });
      if (named.length) return named[named.length - 1];
    }
    return null;
  }

  function looksLikeSendButton(button, input) {
    if (!button || !input || button.closest(".rxf-xhs-overlay")) return false;
    var label = buttonLabel(button);
    if (/(cancel|取消|close|关闭|add|添加|plus|camera|相机|image|图片|emoji|表情|voice|语音)/i.test(label)) {
      return false;
    }
    if (/(send|发送|submit)/i.test(label) || button.type === "submit") return true;
    if (findSendButton(input) === button) return true;
    if (!label.trim()) {
      var buttonRect = button.getBoundingClientRect();
      var inputRect = input.getBoundingClientRect();
      var buttonY = buttonRect.top + buttonRect.height / 2;
      var inputY = inputRect.top + inputRect.height / 2;
      if (buttonRect.left >= inputRect.right - 28 && Math.abs(buttonY - inputY) < 72) return true;
    }
    return false;
  }

  function findLikelyInput(button) {
    if (state.lastInput && isEditable(state.lastInput) && isVisible(state.lastInput)) return state.lastInput;
    if (isEditable(document.activeElement) && isVisible(document.activeElement)) return document.activeElement;
    var root = button && button.parentElement;
    for (var level = 0; root && level < 7; level += 1, root = root.parentElement) {
      var candidates = Array.from(root.querySelectorAll("textarea,input,[contenteditable='true']"))
        .filter(function (node) { return isEditable(node) && isVisible(node); });
      if (candidates.length) return candidates[candidates.length - 1];
    }
    var visible = Array.from(document.querySelectorAll("textarea,input,[contenteditable='true']"))
      .filter(function (node) { return isEditable(node) && isVisible(node); });
    return visible.length ? visible[visible.length - 1] : null;
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }

  async function sendPending(preferredButton) {
    if (!state.pending || state.pending.status !== "ready" || state.bypassSend) return;
    var pending = state.pending;
    var input = pending.input || state.lastInput || document.activeElement;
    if (!isEditable(input)) {
      toast("没有找到 Roche 输入框，请点一下输入框后再发送");
      return;
    }
    var userNote = getEditableValue(input).trim();
    var payload = buildOutgoingMessage(pending.data, userNote);
    state.bypassSend = true;
    setEditableValue(input, payload);
    await nextFrame();
    await new Promise(function (resolve) { setTimeout(resolve, 40); });

    var button = preferredButton || findSendButton(input);
    state.pending = null;
    clearOverlay();
    try {
      if (button) {
        button.click();
      } else {
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }));
      }
    } finally {
      setTimeout(function () { state.bypassSend = false; }, 250);
    }
  }

  function onKeyDown(event) {
    if (state.destroyed || state.bypassSend) return;
    if (!isEditable(event.target)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (!state.pending) {
        if (!extractXhsUrl(getEditableValue(event.target))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        beginReadFromInput(event.target, getEditableValue(event.target));
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.pending.status === "ready") sendPending(null);
      else toast("小红书内容还在读取，请稍等");
    }
  }

  function onClick(event) {
    if (state.destroyed || state.bypassSend) return;
    var button = event.target && event.target.closest ? event.target.closest("button") : null;
    if (!button) return;
    var input = state.pending ? (state.pending.input || state.lastInput) : findLikelyInput(button);
    if (!looksLikeSendButton(button, input)) return;
    if (!state.pending) {
      if (!input || !extractXhsUrl(getEditableValue(input))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      beginReadFromInput(input, getEditableValue(input));
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.pending.status === "ready") sendPending(button);
    else toast("小红书内容还在读取，请稍等");
  }

  function cardFromPayload(payload) {
    var card = element("div", "rxf-rendered-card");
    if (payload.userNote) card.appendChild(element("div", "rxf-card-note", payload.userNote));

    var images = Array.isArray(payload.images) ? payload.images.slice(0, 9) : [];
    if (!images.length && payload.cover) images.push(payload.cover);
    var imageCount = Number(payload.imageCount) || images.length;
    var cover = images[0] || payload.cover || "";

    var top = element("div", "rxf-card-top");
    top.appendChild(element("div", "rxf-card-logo", "RED"));
    top.appendChild(element("div", "rxf-card-source", "小红书 · 转发"));
    top.appendChild(element("div", "rxf-card-kind", imageCount ? "图文 · " + imageCount + " 张" : "图文笔记"));
    card.appendChild(top);

    var media = element("div", "rxf-card-media");
    if (cover) {
      var hero = element("div", "rxf-card-hero");
      var image = element("img", "");
      image.src = cover;
      image.alt = "小红书首图";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.onerror = function () {
        hero.replaceChildren(element("div", "rxf-card-desc", "首图暂时无法显示"));
      };
      hero.appendChild(image);
      media.appendChild(hero);
      media.appendChild(element("div", "rxf-card-count", imageCount > 1 ? "首图 · 共 " + imageCount + " 张" : "1 张"));
    } else {
      media.appendChild(element("div", "rxf-card-empty", "小红书"));
    }
    card.appendChild(media);

    var info = element("div", "rxf-card-info");
    info.appendChild(element("div", "rxf-card-title", payload.title || "小红书笔记"));
    if (payload.content) info.appendChild(element("div", "rxf-card-desc", payload.content));
    if (payload.author) {
      var author = element("div", "rxf-card-author");
      author.appendChild(element("span", "rxf-card-author-dot"));
      author.appendChild(element("span", "", payload.author));
      info.appendChild(author);
    }
    card.appendChild(info);

    var foot = element("div", "rxf-card-foot");
    var label = payload.imageCount
      ? "正文 · " + payload.imageCount + " 张原图"
      : "已读取笔记正文";
    if (payload.ocrCount) label += " · 识别 " + payload.ocrCount + " 张图中文字";
    foot.appendChild(element("span", "", label));
    foot.appendChild(element("span", "", "打开原文 ›"));
    card.appendChild(foot);

    function open() {
      if (payload.url) window.open(payload.url, "_blank", "noopener,noreferrer");
    }
    [top, info, foot].forEach(function (node) {
      node.setAttribute("role", "link");
      node.tabIndex = 0;
      node.addEventListener("click", open);
      node.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") open();
      });
    });
    return card;
  }

  function findReplaceTarget(textNode) {
    var current = textNode.parentElement;
    var candidate = null;
    for (var i = 0; current && current !== document.body && i < 10; i += 1) {
      var text = (current.textContent || "").trim();
      if (text.indexOf(MARKER_START) !== -1 && text.indexOf("【转发的小红书笔记】") !== -1) {
        candidate = current;
        break;
      }
      current = current.parentElement;
    }
    if (!candidate) candidate = textNode.parentElement;
    if (!candidate) return null;
    var candidateText = (candidate.textContent || "").trim();
    for (var level = 0; level < 5; level += 1) {
      var parent = candidate.parentElement;
      if (!parent || parent === document.body) break;
      var parentText = (parent.textContent || "").trim();
      if (parentText !== candidateText) break;
      candidate = parent;
    }
    return candidate;
  }

  function scanCards(root) {
    if (!root || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node = null;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || "").indexOf(MARKER_START) !== -1) nodes.push(node);
    }
    nodes.forEach(function (textNode) {
      var raw = textNode.nodeValue || "";
      var match = raw.match(/\[XHS_CARD_V1\]([A-Za-z0-9_-]+)\[\/XHS_CARD_V1\]/);
      if (!match) {
        var parentRaw = textNode.parentElement ? textNode.parentElement.textContent || "" : "";
        match = parentRaw.match(/\[XHS_CARD_V1\]([A-Za-z0-9_-]+)\[\/XHS_CARD_V1\]/);
      }
      if (!match) return;
      var target = findReplaceTarget(textNode);
      if (!target || target.dataset.rxfXhsRendered === "1") return;
      try {
        var payload = JSON.parse(decodeBase64Url(match[1]));
        target.dataset.rxfXhsRendered = "1";
        target.replaceChildren(cardFromPayload(payload));
      } catch (_) {}
    });
  }

  function installObserver() {
    if (!document.body || state.observer) return;
    state.observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) scanCards(node);
          else if (node.nodeType === 3 && (node.nodeValue || "").indexOf(MARKER_START) !== -1) {
            scanCards(node.parentElement);
          }
        });
      });
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    scanCards(document.body);
  }

  function installListeners() {
    if (state.listenersInstalled) return;
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    state.listenersInstalled = true;
  }

  function boot() {
    if (state.destroyed) return;
    ensureGlobalStyles();
    installListeners();
    installObserver();
  }

  function destroy() {
    state.destroyed = true;
    clearOverlay();
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    if (state.listenersInstalled) {
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    }
    state.listenersInstalled = false;
    if (state.inputFallbackTimer) clearTimeout(state.inputFallbackTimer);
    state.inputFallbackTimer = null;
    if (state.style && state.style.parentNode) state.style.parentNode.removeChild(state.style);
  }

  function renderSettings(container, roche) {
    container.replaceChildren();
    var style = element("style");
    style.textContent = [
      ".rxf-settings-root{height:100%;overflow:auto;padding:16px;background:#f6f7f9;color:#222;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-sizing:border-box}",
      ".rxf-settings-top{display:flex;align-items:center;gap:12px;margin:0 0 4px}.rxf-settings-close{border:0;border-radius:10px;padding:8px 11px;background:#e8e9ec;color:#222;font-size:14px;font-weight:700;white-space:nowrap}.rxf-settings-top .rxf-settings-title{margin:0}",
      ".rxf-settings-root *{box-sizing:border-box}.rxf-settings-title{font-size:20px;font-weight:750;margin:2px 0 4px}.rxf-settings-sub{font-size:13px;color:#72767e;line-height:1.5;margin-bottom:18px}",
      ".rxf-settings-card{background:#fff;border:1px solid #e7e8eb;border-radius:15px;padding:14px;margin-bottom:12px}.rxf-settings-label{display:block;font-size:13px;font-weight:700;margin:0 0 6px}",
      ".rxf-settings-hint{font-size:12px;color:#83868d;line-height:1.45;margin:5px 0 0}.rxf-settings-input{width:100%;border:1px solid #d7d9de;border-radius:10px;padding:11px 12px;background:#fff;color:#222;font-size:14px;outline:none}",
      ".rxf-settings-input:focus{border-color:#ff2442;box-shadow:0 0 0 3px rgba(255,36,66,.1)}.rxf-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:13px}",
      ".rxf-settings-check{width:20px;height:20px;accent-color:#ff2442}.rxf-settings-actions{display:flex;gap:9px;margin-top:14px}.rxf-settings-button{flex:1;border:0;border-radius:10px;padding:11px;background:#e8e9ec;color:#222;font-size:14px;font-weight:700}",
      ".rxf-settings-button.primary{background:#ff2442;color:#fff}.rxf-settings-status{font-size:12px;line-height:1.45;margin-top:10px;color:#70747b;white-space:pre-wrap}.rxf-settings-status.ok{color:#16803c}.rxf-settings-status.bad{color:#b42318}",
      "@media(prefers-color-scheme:dark){.rxf-settings-root{background:#111214;color:#f3f3f4}.rxf-settings-card,.rxf-settings-input{background:#1d1e21;color:#f3f3f4;border-color:#34363b}.rxf-settings-sub,.rxf-settings-hint{color:#969aa2}.rxf-settings-button,.rxf-settings-close{background:#34363b;color:#f3f3f4}}"
    ].join("");
    container.appendChild(style);
    var root = element("div", "rxf-settings-root");
    container.appendChild(root);
    var top = element("div", "rxf-settings-top");
    var close = element("button", "rxf-settings-close", "‹ 返回");
    close.type = "button";
    close.onclick = function () {
      if (roche && roche.ui && typeof roche.ui.closeApp === "function") roche.ui.closeApp();
      else if (window.history && window.history.length > 1) window.history.back();
    };
    top.appendChild(close);
    top.appendChild(element("div", "rxf-settings-title", "小红书转发"));
    root.appendChild(top);
    root.appendChild(element("div", "rxf-settings-sub", "在聊天输入框粘贴小红书分享链接，插件会读取正文和配图文字，再生成可见的转发卡片。"));

    var config = Object.assign({}, state.config);
    var card = element("div", "rxf-settings-card");

    var baseLabel = element("label", "rxf-settings-label", "读取服务地址");
    var baseInput = element("input", "rxf-settings-input");
    baseInput.type = "url";
    baseInput.placeholder = "https://roche-xhs-reader.你的子域名.workers.dev";
    baseInput.value = config.baseUrl;
    baseInput.oninput = function () { config.baseUrl = baseInput.value; };
    card.appendChild(baseLabel);
    card.appendChild(baseInput);
    card.appendChild(element("div", "rxf-settings-hint", "填写后端首页地址，不要在末尾添加 /extract/xhs。"));

    var keyLabel = element("label", "rxf-settings-label", "访问密钥");
    keyLabel.style.marginTop = "14px";
    var keyInput = element("input", "rxf-settings-input");
    keyInput.type = "password";
    keyInput.placeholder = "与后端 GATEWAY_KEY 完全相同";
    keyInput.value = config.gatewayKey;
    keyInput.oninput = function () { config.gatewayKey = keyInput.value; };
    card.appendChild(keyLabel);
    card.appendChild(keyInput);

    var ocrRow = element("div", "rxf-settings-row");
    var ocrCopy = element("div");
    ocrCopy.appendChild(element("div", "rxf-settings-label", "识别配图文字"));
    ocrCopy.appendChild(element("div", "rxf-settings-hint", "关闭后只读取标题与笔记正文"));
    var ocrInput = element("input", "rxf-settings-check");
    ocrInput.type = "checkbox";
    ocrInput.checked = config.ocrEnabled;
    ocrInput.onchange = function () { config.ocrEnabled = ocrInput.checked; };
    ocrRow.appendChild(ocrCopy);
    ocrRow.appendChild(ocrInput);
    card.appendChild(ocrRow);

    var maxLabel = element("label", "rxf-settings-label", "最多识别配图数量");
    maxLabel.style.marginTop = "14px";
    var maxInput = element("input", "rxf-settings-input");
    maxInput.type = "number";
    maxInput.min = "1";
    maxInput.max = "12";
    maxInput.value = String(config.maxImages);
    maxInput.oninput = function () { config.maxImages = Number(maxInput.value) || 9; };
    card.appendChild(maxLabel);
    card.appendChild(maxInput);
    card.appendChild(element("div", "rxf-settings-hint", "推荐 9 张。图片越多，读取等待时间越长。"));

    var status = element("div", "rxf-settings-status", "");
    var actions = element("div", "rxf-settings-actions");
    var test = element("button", "rxf-settings-button", "测试连接");
    test.type = "button";
    test.onclick = async function () {
      status.className = "rxf-settings-status";
      status.textContent = "正在连接…";
      var clean = mergeConfig(config);
      if (!clean.baseUrl) {
        status.className = "rxf-settings-status bad";
        status.textContent = "请先填写读取服务地址。";
        return;
      }
      try {
        var response = await fetch(clean.baseUrl + "/health", {
          headers: { "X-Gateway-Key": clean.gatewayKey }
        });
        var data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.detail || "HTTP " + response.status);
        if (!data.gatewayKeyConfigured) throw new Error("后端还没有设置 GATEWAY_KEY");
        if (!data.gatewayKeyValid) throw new Error("访问密钥与后端 GATEWAY_KEY 不一致");
        status.className = "rxf-settings-status ok";
        status.textContent = "连接成功。浏览器：" + (data.browser ? "正常" : "未启动") + "；中文 OCR：" + (data.ocr ? "正常" : "不可用");
      } catch (error) {
        status.className = "rxf-settings-status bad";
        status.textContent = "连接失败：" + (error.message || error);
      }
    };
    var save = element("button", "rxf-settings-button primary", "保存");
    save.type = "button";
    save.onclick = async function () {
      config = await saveScopedConfig(roche, config);
      baseInput.value = config.baseUrl;
      keyInput.value = config.gatewayKey;
      maxInput.value = String(config.maxImages);
      toast("小红书转发设置已保存");
      status.className = "rxf-settings-status ok";
      status.textContent = "已保存。现在可以回到聊天输入框粘贴小红书分享链接。";
    };
    actions.appendChild(test);
    actions.appendChild(save);
    card.appendChild(actions);
    card.appendChild(status);
    root.appendChild(card);

    var note = element("div", "rxf-settings-card");
    note.appendChild(element("div", "rxf-settings-label", "使用方式"));
    note.appendChild(element("div", "rxf-settings-hint", "1. 在小红书点分享并复制链接。\n2. 回到 Roche，直接粘贴到聊天输入框。\n3. 等待卡片显示“读取完成”。\n4. 可以继续输入一句附言，再点击“发送转发”。"));
    root.appendChild(note);
  }

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "小红书转发",
    version: VERSION,
    apps: [
      {
        id: "roche-xhs-forwarder-settings",
        name: "小红书转发",
        icon: "link",
        iconImage: "",
        async mount(container, roche) {
          state.roche = roche;
          state.config = await loadScopedConfig(roche);
          renderSettings(container, roche);
          boot();
        },
        async unmount(container) {
          container.replaceChildren();
        }
      }
    ]
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.__rocheXhsForwarder = {
    version: VERSION,
    state: state,
    extractXhsUrl: extractXhsUrl,
    buildOutgoingMessage: buildOutgoingMessage,
    scanCards: scanCards,
    destroy: destroy
  };
})();
