import puppeteer from "@cloudflare/puppeteer";

const VERSION = "0.2.0";
const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CACHE_SECONDS = 6 * 60 * 60;
const OCR_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Gateway-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({
          ok: true,
          name: "Roche 小红书转发读取服务（Cloudflare）",
          version: VERSION,
          endpoints: ["/health", "/extract/xhs"]
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const suppliedKey = request.headers.get("X-Gateway-Key") || "";
        const configuredKey = String(env.GATEWAY_KEY || "");
        return jsonResponse({
          ok: true,
          version: VERSION,
          browser: Boolean(env.BROWSER),
          ocr: Boolean(env.AI),
          gatewayKeyConfigured: Boolean(configuredKey),
          gatewayKeyValid: Boolean(configuredKey && safeEqual(suppliedKey.trim(), configuredKey)),
          maxImages: MAX_IMAGES
        });
      }

      if (request.method === "POST" && url.pathname === "/extract/xhs") {
        requireKey(request, env);
        const payload = await readPayload(request);
        const originalUrl = validatePageUrl(payload.url);
        const useOcr = payload.ocr !== false;
        const maxImages = clampInteger(payload.maxImages, 1, MAX_IMAGES, MAX_IMAGES);

        const cacheRequest = await makeCacheRequest(request, originalUrl, useOcr, maxImages);
        const cache = caches.default;
        const cached = await cache.match(cacheRequest);
        if (cached) return withCors(cached);

        const result = await extractXhs(env, originalUrl, useOcr, maxImages);
        const response = jsonResponse(result, 200, {
          "Cache-Control": "public, max-age=" + CACHE_SECONDS
        });
        ctx.waitUntil(cache.put(cacheRequest, response.clone()));
        return response;
      }

      return jsonResponse({ detail: "接口不存在" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const detail = error instanceof HttpError
        ? error.message
        : "读取服务暂时出错，请稍后重试";
      if (!(error instanceof HttpError)) console.error(error);
      return jsonResponse({ detail }, status);
    }
  }
};

async function extractXhs(env, originalUrl, useOcr, maxImages) {
  const extracted = await extractPage(env, originalUrl);
  let title = cleanText(extracted.title, 180);
  if (["小红书", "小红书 - 你的生活兴趣社区", "RedNote"].includes(title)) title = "";

  let content = cleanText(extracted.content, 6500);
  const author = cleanText(extracted.author, 100);
  const images = [];
  for (const rawUrl of extracted.images || []) {
    const imageUrl = normalizeMediaUrl(rawUrl);
    if (imageUrl && !images.includes(imageUrl)) images.push(imageUrl);
    if (images.length >= maxImages) break;
  }
  const cover = normalizeMediaUrl(extracted.cover) || images[0] || "";

  if (!content) content = fallbackContent(extracted, title, author);
  if (!title && content) title = cleanText(content.split("\n")[0], 80);
  if (!title && !content && !images.length) {
    throw new HttpError(422, "没有读取到笔记内容，可能需要重新复制带 xsec_token 的分享链接");
  }

  let imageOcr = [];
  const warnings = [];
  if (useOcr && images.length) {
    if (!env.AI) {
      warnings.push("Cloudflare Workers AI 绑定不可用，已跳过配图文字");
    } else {
      const ocrResult = await runOcr(
        env,
        images,
        extracted.canonicalUrl || originalUrl,
        extracted.cookies || [],
        extracted.userAgent || "Mozilla/5.0"
      );
      imageOcr = ocrResult.items;
      warnings.push(...ocrResult.warnings);
    }
  }

  return {
    ok: true,
    source: "xiaohongshu",
    originalUrl,
    canonicalUrl: extracted.canonicalUrl || originalUrl,
    title: title || "小红书笔记",
    author,
    content,
    cover,
    images,
    imageOcr,
    warnings
  };
}

async function extractPage(env, originalUrl) {
  if (!env.BROWSER) throw new HttpError(503, "Cloudflare Browser Run 绑定不可用");

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      DNT: "1"
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await new Promise((resolve) => setTimeout(resolve, 2600));

    const finalUrl = validatePageUrl(page.url());
    const finalPath = new URL(finalUrl).pathname.toLowerCase();
    if (finalPath.includes("/404") || finalPath.includes("/login")) {
      throw new HttpError(422, "小红书要求登录或链接已经失效，请重新复制一次分享链接");
    }

    const extracted = await page.evaluate(extractFromPage);
    extracted.canonicalUrl = finalUrl;
    extracted.cookies = await page.cookies();
    return extracted;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = String(error && error.message || error);
    if (/timeout/i.test(message)) {
      throw new HttpError(504, "打开小红书链接超时，请稍后重试");
    }
    if (/limit|quota|browser/i.test(message)) {
      throw new HttpError(429, "Cloudflare 免费浏览器额度暂时不可用，请稍后再试");
    }
    throw new HttpError(422, "无法打开这条小红书分享链接");
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

function extractFromPage() {
  const tidy = (value) => String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const meta = (key) => {
    const el = document.querySelector('meta[property="' + key + '"]')
      || document.querySelector('meta[name="' + key + '"]');
    return el ? tidy(el.content) : "";
  };
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = el ? tidy(el.innerText || el.textContent) : "";
      if (value) return value;
    }
    return "";
  };
  const pathMatch = location.pathname.match(/(?:explore|item)\/([a-zA-Z0-9]+)/);
  const noteId = pathMatch ? pathMatch[1] : "";
  const seen = new WeakSet();
  const candidates = [];
  let visited = 0;

  const walk = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 12 || visited > 50000) return;
    if (seen.has(value)) return;
    seen.add(value);
    visited += 1;
    const id = String(value.noteId || value.note_id || value.id || "");
    let score = 0;
    if (noteId && id === noteId) score += 30;
    if (value.noteId || value.note_id) score += 9;
    if (value.desc || value.description || value.content) score += 5;
    if (value.title || value.displayTitle) score += 3;
    if (Array.isArray(value.imageList) || Array.isArray(value.image_list) || Array.isArray(value.images)) score += 6;
    if (value.user || value.userInfo || value.author) score += 2;
    if (score >= 8) candidates.push({ value, score });
    for (const key of Object.keys(value)) {
      if (["comments", "commentList", "feeds"].includes(key)) continue;
      try {
        walk(value[key], depth + 1);
      } catch (_) {}
    }
  };

  try {
    walk(window.__INITIAL_STATE__, 0);
  } catch (_) {}
  candidates.sort((a, b) => b.score - a.score);
  const note = candidates.length ? candidates[0].value : {};
  const pick = (...values) => {
    for (const value of values) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      const text = tidy(value);
      if (text && text !== "undefined" && text !== "null") return text;
    }
    return "";
  };
  const user = note.user || note.userInfo || note.author || {};
  const title = pick(
    note.title,
    note.displayTitle,
    firstText([
      "#detail-title",
      ".note-content .title",
      ".note-detail .title",
      "[class*='note-content'] [class*='title']"
    ]),
    meta("og:title"),
    document.title
  );
  const content = pick(
    note.desc,
    note.description,
    note.content,
    note.noteDesc,
    firstText([
      "#detail-desc",
      ".note-content .desc",
      ".note-detail .desc",
      "[class*='note-content'] [class*='desc']"
    ]),
    meta("og:description"),
    meta("description")
  );
  const author = pick(
    user.nickname,
    user.nickName,
    user.name,
    note.nickname,
    firstText([
      ".author-container .username",
      ".author-wrapper .username",
      "[class*='author'] [class*='name']",
      "[class*='user'] [class*='name']"
    ])
  );

  const imageUrls = [];
  const addImage = (value) => {
    let url = tidy(value);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const host = new URL(url).hostname.toLowerCase();
      const allowed = ["xhscdn.com", "rednote.com", "xiaohongshu.com"];
      if (!allowed.some((base) => host === base || host.endsWith("." + base))) return;
    } catch (_) {
      return;
    }
    if (!imageUrls.includes(url)) imageUrls.push(url);
  };
  const collectImages = (value, depth) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      addImage(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectImages(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (/^(url|urlDefault|urlPre|urlOriginal|masterUrl|originalUrl)$/i.test(key)) {
        collectImages(value[key], depth + 1);
      } else if (depth < 3) {
        collectImages(value[key], depth + 1);
      }
    }
  };
  collectImages(note.imageList || note.image_list || note.images || note.media || [], 0);
  if (!imageUrls.length) {
    document.querySelectorAll("img").forEach((img) => {
      const rect = img.getBoundingClientRect();
      const classText = String(img.className || "");
      if (/avatar|icon|logo|emoji/i.test(classText)) return;
      if (Math.max(rect.width, img.naturalWidth || 0) < 220) return;
      if (Math.max(rect.height, img.naturalHeight || 0) < 220) return;
      addImage(img.currentSrc || img.src);
    });
  }
  const metaImage = meta("og:image");
  if (metaImage && !imageUrls.includes(metaImage)) imageUrls.unshift(metaImage);

  return {
    title,
    content,
    author,
    images: imageUrls,
    cover: imageUrls[0] || metaImage || "",
    canonicalUrl: location.href,
    userAgent: navigator.userAgent,
    bodyText: tidy(document.body ? document.body.innerText : "").slice(0, 12000)
  };
}

async function runOcr(env, imageUrls, referer, cookies, userAgent) {
  const items = [];
  const warnings = [];
  const cookieHeader = cookies
    .filter((item) => item && item.name && item.value)
    .map((item) => item.name + "=" + item.value)
    .join("; ");

  for (let index = 0; index < imageUrls.length; index += 1) {
    try {
      const dataUri = await downloadImageAsDataUri(imageUrls[index], referer, cookieHeader, userAgent);
      const result = await env.AI.run(OCR_MODEL, {
        task: "query",
        image: dataUri,
        question: "请只抄录图片中清晰可见的文字，按阅读顺序输出；不要描述画面，不要解释。若没有可读文字，只输出 [NO_TEXT]。",
        reasoning: false,
        stream: false,
        max_tokens: 1400
      });
      let text = cleanText(result && result.answer, 1800);
      if (/^\[?NO_TEXT\]?$/i.test(text) || /^(图片中)?没有(可读|清晰)?文字[。.]?$/.test(text)) text = "";
      items.push({ index, text });
    } catch (error) {
      console.warn("OCR image " + (index + 1) + " failed", error);
      warnings.push("第 " + (index + 1) + " 张配图文字读取失败");
      items.push({ index, text: "" });
    }
  }
  return { items, warnings };
}

async function downloadImageAsDataUri(url, referer, cookieHeader, userAgent) {
  const imageUrl = normalizeMediaUrl(url);
  if (!imageUrl) throw new Error("invalid image url");
  const headers = {
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    Referer: referer,
    "User-Agent": userAgent
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetch(imageUrl, { headers, redirect: "follow" });
  if (!response.ok) throw new Error("image http " + response.status);
  if (!normalizeMediaUrl(response.url)) throw new Error("image redirected outside allowed hosts");
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim();
  if (!contentType.startsWith("image/")) throw new Error("not an image");
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error("image too large");
  const raw = await response.arrayBuffer();
  if (raw.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  return "data:" + contentType + ";base64," + arrayBufferToBase64(raw);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fallbackContent(extracted, title, author) {
  const body = cleanText(extracted.bodyText, 12000);
  if (!body) return "";
  const ignored = new Set([
    "创作中心", "业务合作", "发现", "RED", "直播", "发布", "通知", "关注", title, author
  ]);
  const useful = body.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !ignored.has(line))
    .filter((line) => !line.startsWith("沪ICP备"))
    .filter((line) => !line.startsWith("© 2014-"))
    .filter((line) => !line.includes("行吟信息科技"));
  return cleanText(useful.join("\n"), 6500);
}

function validatePageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch (_) {
    throw new HttpError(400, "请提供有效的小红书链接");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "只支持 http 或 https 链接");
  }
  if (url.username || url.password || !isAllowedPageHost(url.hostname)) {
    throw new HttpError(400, "目前只支持小红书分享链接");
  }
  return url.toString();
}

function isAllowedPageHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ["xhslink.com", "xiaohongshu.com", "rednote.com"]
    .some((base) => host === base || host === "www." + base);
}

function normalizeMediaUrl(raw) {
  let value = String(raw || "").trim();
  if (value.startsWith("//")) value = "https:" + value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = ["xhscdn.com", "rednote.com", "xiaohongshu.com"]
      .some((base) => host === base || host.endsWith("." + base));
    return allowed ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

function cleanText(value, maxLength = 10000) {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function readPayload(request) {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object") throw new Error("bad payload");
    return payload;
  } catch (_) {
    throw new HttpError(400, "请求内容必须是 JSON");
  }
}

function requireKey(request, env) {
  const configuredKey = String(env.GATEWAY_KEY || "");
  if (!configuredKey) throw new HttpError(503, "后端尚未设置 GATEWAY_KEY");
  const suppliedKey = (request.headers.get("X-Gateway-Key") || "").trim();
  if (!safeEqual(suppliedKey, configuredKey)) throw new HttpError(401, "访问密钥错误");
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  }
  return difference === 0;
}

async function makeCacheRequest(request, originalUrl, useOcr, maxImages) {
  const source = new TextEncoder().encode(JSON.stringify([originalUrl, useOcr, maxImages, VERSION]));
  const digest = await crypto.subtle.digest("SHA-256", source);
  const hash = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/__xhs_cache/" + hash;
  cacheUrl.search = "";
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...headers
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
