import { File } from "node:buffer";
if (!globalThis.File) {
  globalThis.File = File;
}

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const app = express();
const port = Number(process.env.PORT || 3000);

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const DEFAULT_MIN_INTERVAL_SECONDS = 1;
const DEFAULT_MAX_INTERVAL_SECONDS = 3;
const DEFAULT_MONITOR_DURATION_HOURS = 24;
const MAX_MONITOR_DURATION_MS = 24 * 60 * 60 * 1000;

const jobs = new Map();
let initialized = false;
let browser;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const OS_PLATFORMS = [
  {
    os: "Mac OS X",
    model: "Mac",
    os_version: "10.15.7",
    browser: "Chrome",
    browser_version: "136.0.0.0",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  },
  {
    os: "Windows",
    model: "PC",
    os_version: "10",
    browser: "Chrome",
    browser_version: "135.0.0.0",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
  },
  {
    os: "Mac OS X",
    model: "Mac",
    os_version: "10.15.7",
    browser: "Safari",
    browser_version: "17.4",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
  },
  {
    os: "iOS",
    model: "iPhone",
    os_version: "17.4",
    browser: "Safari",
    browser_version: "17.4",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/605.1.15"
  },
  {
    os: "Android",
    model: "Android Phone",
    os_version: "14",
    browser: "Chrome Mobile",
    browser_version: "135.0.0.0",
    ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36"
  }
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
  { width: 412, height: 915 }
];

class FetchError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

function randHex(len) {
  let str = "";
  while (str.length < len) {
    str += Math.random().toString(16).substring(2);
  }
  return str.substring(0, len);
}

async function ensureDb() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    const seed = {
      newsItems: [],
      history: [],
      settings: { proxyUrl: "" }
    };
    await fs.writeFile(dbPath, JSON.stringify(seed, null, 2), "utf8");
  }
}

let dbCache = null;

async function readDb() {
  await ensureDb();
  if (dbCache) {
    return dbCache;
  }
  const raw = await fs.readFile(dbPath, "utf8");
  const db = JSON.parse(raw);
  let changed = false;

  if (!db.settings) {
    db.settings = { proxyUrl: "" };
    changed = true;
  }

  db.newsItems = (db.newsItems || []).map((item) => {
    let nextItem = item;

    if (
      nextItem.frequencySeconds === undefined &&
      nextItem.frequencyMinutes !== undefined
    ) {
      changed = true;
      nextItem = {
        ...nextItem,
        frequencySeconds: Number(nextItem.frequencyMinutes) * 60
      };
    }

    if (nextItem.frequencySeconds === undefined) {
      changed = true;
      nextItem = {
        ...nextItem,
        frequencySeconds: DEFAULT_MIN_INTERVAL_SECONDS
      };
    }

    if (
      nextItem.frequencyMinSeconds === undefined ||
      nextItem.frequencyMaxSeconds === undefined
    ) {
      changed = true;
      nextItem = {
        ...nextItem,
        frequencyMinSeconds: Number(nextItem.frequencySeconds),
        frequencyMaxSeconds: Number(nextItem.frequencySeconds)
      };
    }

    if (nextItem.monitorDurationHours === undefined) {
      changed = true;
      nextItem = {
        ...nextItem,
        monitorDurationHours: DEFAULT_MONITOR_DURATION_HOURS
      };
    }

    const normalizedMin = Math.max(
      Number(nextItem.frequencyMinSeconds ?? DEFAULT_MIN_INTERVAL_SECONDS),
      DEFAULT_MIN_INTERVAL_SECONDS
    );
    const normalizedMax = Math.max(
      Number(nextItem.frequencyMaxSeconds ?? normalizedMin),
      normalizedMin
    );
    if (
      normalizedMin !== Number(nextItem.frequencyMinSeconds) ||
      normalizedMax !== Number(nextItem.frequencyMaxSeconds)
    ) {
      changed = true;
      nextItem = {
        ...nextItem,
        frequencySeconds: normalizedMin,
        frequencyMinSeconds: normalizedMin,
        frequencyMaxSeconds: normalizedMax
      };
    }

    if (
      nextItem.monitorEnabled &&
      nextItem.monitorStartedAt &&
      Date.now() - new Date(nextItem.monitorStartedAt).getTime() >= getMonitorDurationMs(nextItem)
    ) {
      changed = true;
      nextItem = {
        ...nextItem,
        monitorEnabled: false,
        monitorStoppedAt: nextItem.monitorStoppedAt || nowIso(),
        monitorStopReason: "超过 24 小时，已自动停止"
      };
    }

    return nextItem;
  });

  dbCache = db;

  if (changed) {
    await writeDb(db);
  }

  return db;
}

async function writeDb(db) {
  dbCache = db;
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

async function getProxyPortForNewsItem(itemId) {
  const db = await readDb();
  const settings = db.settings || {};
  if (!settings.proxyUrl && !settings.subscriptionUrl) {
    return null;
  }

  let nodes = [];
  try {
    const nodesRaw = await fs.readFile(path.join(dataDir, "nodes.json"), "utf8");
    nodes = JSON.parse(nodesRaw);
  } catch (err) {
    // ignore
  }

  if (nodes.length === 0) {
    return settings.proxyUrl || null;
  }

  const itemIndex = db.newsItems.findIndex((entry) => entry.id === itemId);
  if (itemIndex === -1) {
    return settings.proxyUrl || null;
  }

  const nodeIndex = itemIndex % nodes.length;
  const targetPort = 10001 + nodeIndex;
  return `http://127.0.0.1:${targetPort}`;
}

async function getProxyNodeNameForNewsItem(itemId) {
  const db = await readDb();
  const settings = db.settings || {};
  if (!settings.proxyUrl && !settings.subscriptionUrl) {
    return "直连";
  }

  let nodes = [];
  try {
    const nodesRaw = await fs.readFile(path.join(dataDir, "nodes.json"), "utf8");
    nodes = JSON.parse(nodesRaw);
  } catch (err) {
    // ignore
  }

  if (nodes.length === 0) {
    return settings.proxyUrl ? "全局代理" : "直连";
  }

  const itemIndex = db.newsItems.findIndex((entry) => entry.id === itemId);
  if (itemIndex === -1) {
    return settings.proxyUrl ? "全局代理" : "直连";
  }

  const nodeIndex = itemIndex % nodes.length;
  const targetPort = 10001 + nodeIndex;
  const node = nodes[nodeIndex];
  return `端口 ${targetPort} (${node.name})`;
}

function getItemIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("id");
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "").trim();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBrowserExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/snap/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next installed Chromium browser.
    }
  }

  throw new Error("未找到可用的 Chrome 或 Edge 浏览器。");
}

async function getBrowser() {
  if (browser?.isConnected()) {
    return browser;
  }

  const db = await readDb();
  const proxyUrl = db.settings?.proxyUrl;
  const launchOptions = {
    executablePath: await getBrowserExecutablePath(),
    headless: process.env.BROWSER_HEADLESS !== "false"
  };

  if (proxyUrl) {
    launchOptions.proxy = { server: proxyUrl };
  }

  browser = await chromium.launch(launchOptions);
  return browser;
}

function extractNextData(html) {
  if (html.includes("aliyun_waf_aa") || html.includes("initAliyunCaptcha")) {
    throw new FetchError(
      "请求过于频繁，潮新闻触发了访问校验。请把监控频率调高一些后再试。",
      "WAF_BLOCKED"
    );
  }

  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    throw new FetchError("未找到潮新闻页面数据脚本，页面结构可能已变化。", "PARSE_FAILED");
  }
  return JSON.parse(match[1]);
}

async function fetchArticleStats(itemId, url) {
  let httpError;

  try {
    return {
      ...(await fetchArticleStatsByHttp(itemId, url)),
      fetchMethod: "http",
      fetchFallbackReason: ""
    };
  } catch (error) {
    httpError = error;
  }

  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const activeBrowser = await getBrowser();
    const page = await activeBrowser.newPage({
      userAgent: BROWSER_USER_AGENT
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      await page.waitForSelector("#__NEXT_DATA__", {
        state: "attached",
        timeout: 10000
      });

      const html = await page.content();
      const nextData = extractNextData(html);
      return {
        ...parseArticleStats(nextData, url),
        fetchMethod: "browser",
        fetchFallbackReason: httpError?.message || ""
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      await page.close().catch(() => {});
    }
  }

  throw lastError;
}

async function fetchArticleStatsByHttp(itemId, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const proxyUrl = await getProxyPortForNewsItem(itemId);

  try {
    const fetchOptions = {
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        "user-agent": BROWSER_USER_AGENT
      }
    };

    if (proxyUrl) {
      process.env.HTTP_PROXY = proxyUrl;
      process.env.HTTPS_PROXY = proxyUrl;
    } else {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new FetchError(`潮新闻返回 ${response.status}，读取失败。`, "HTTP_FAILED");
    }

    const html = await response.text();
    const nextData = extractNextData(html);
    return parseArticleStats(nextData, url);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new FetchError("轻量请求超时，已尝试使用浏览器兜底。", "HTTP_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseArticleStats(nextData, url) {
  const article = nextData?.props?.pageProps?.article;

  if (!article) {
    throw new FetchError("未解析到稿件信息。", "PARSE_FAILED");
  }

  return {
    articleId: article.id ?? getItemIdFromUrl(url),
    title: article.doc_title || article.list_title || "",
    url: article.url || url,
    readCount: Number(article.read_total ?? article.read_count ?? 0),
    readCountText: article.read_count_general || String(article.read_total ?? article.read_count ?? 0),
    shareCount: Number(article.share_count ?? 0),
    likeCount: Number(article.like_count ?? 0),
    propagationReadCount: Number(article.propagation_read_count ?? 0),
    channelName: article.channel_name || "",
    author: article.author || "",
    source: article.source || "",
    fetchedAt: nowIso()
  };
}

function sanitizeFrequencyRange(minValue, maxValue) {
  const min = Number(minValue);
  const max = Number(maxValue ?? minValue);

  if (!Number.isFinite(min) || min < DEFAULT_MIN_INTERVAL_SECONDS) {
    throw new Error(`最小访问间隔必须大于等于 ${DEFAULT_MIN_INTERVAL_SECONDS} 秒。`);
  }

  if (!Number.isFinite(max) || max < min) {
    throw new Error("最大访问间隔必须大于等于最小访问间隔。");
  }

  return {
    min: Math.min(min, 24 * 60 * 60),
    max: Math.min(max, 24 * 60 * 60)
  };
}

function sanitizeDurationHours(value) {
  const hours = Number(value ?? DEFAULT_MONITOR_DURATION_HOURS);

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("监控总时长必须大于 0 小时。");
  }

  return Math.min(hours, DEFAULT_MONITOR_DURATION_HOURS);
}

function getRandomIntervalMs(item) {
  const min = Number(item.frequencyMinSeconds ?? item.frequencySeconds ?? DEFAULT_MIN_INTERVAL_SECONDS);
  const max = Number(item.frequencyMaxSeconds ?? item.frequencySeconds ?? min);
  const nextSeconds = min + Math.random() * (max - min);
  return Math.max(nextSeconds * 1000, DEFAULT_MIN_INTERVAL_SECONDS * 1000);
}

async function stopMonitorInDb(itemId, reason) {
  const db = await readDb();
  const target = db.newsItems.find((entry) => entry.id === itemId);
  if (target) {
    target.monitorEnabled = false;
    target.monitorStoppedAt = nowIso();
    target.monitorStopReason = reason;
    target.updatedAt = nowIso();
    await writeDb(db);
  }
  clearMonitor(itemId);
}

function getRemainingMonitorMs(item) {
  const startedAt = item.monitorStartedAt ? new Date(item.monitorStartedAt).getTime() : Date.now();
  if (!Number.isFinite(startedAt)) {
    return getMonitorDurationMs(item);
  }
  return getMonitorDurationMs(item) - (Date.now() - startedAt);
}

function getMonitorDurationMs(item) {
  const hours = sanitizeDurationHours(item.monitorDurationHours);
  return Math.min(hours * 60 * 60 * 1000, MAX_MONITOR_DURATION_MS);
}

async function visitArticlePage(itemId, url, title = "") {
  const platform = OS_PLATFORMS[Math.floor(Math.random() * OS_PLATFORMS.length)];
  const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

  const distinctId = `${randHex(4)}-${randHex(6)}-${randHex(8)}-${randHex(6)}-${randHex(4)}`;
  const sessionId = `${randHex(4)}-${randHex(6)}-${randHex(6)}-${randHex(8)}-${randHex(4)}`;

  const payload = {
    appId: "347",
    distinct_id: distinctId,
    session_id: sessionId,
    lib: {
      lib: "js",
      lib_method: "code",
      lib_version: "1.0.0"
    },
    properties: {
      $url: url,
      $url_path: "/news.html",
      $title: title || "",
      $referrer: "",
      $screen_height: vp.height,
      $screen_width: vp.width,
      $is_new_user: "1",
      $os: platform.os,
      $model: platform.model,
      $os_version: platform.os_version,
      $browser: platform.browser,
      $browser_version: platform.browser_version,
      user_agent: platform.ua
    },
    time: Date.now(),
    type: "track",
    eventId: "$PageView"
  };

  const jsonStr = JSON.stringify(payload);
  const base64 = Buffer.from(jsonStr).toString("base64");
  const trackingUrl = `https://bggt.tmuyun.com/iop-ps/sdk/data.gif?data=${encodeURIComponent(base64)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const proxyUrl = await getProxyPortForNewsItem(itemId);

  try {
    console.log(`[visit] → ${url} | OS=${platform.os} UA=${platform.browser}`);
    
    const fetchOptions = {
      signal: controller.signal,
      method: "GET",
      headers: {
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        "user-agent": platform.ua
      }
    };

    if (proxyUrl) {
      process.env.HTTP_PROXY = proxyUrl;
      process.env.HTTPS_PROXY = proxyUrl;
    } else {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
    }

    const response = await fetch(trackingUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`Tracking server returned ${response.status}`);
    }

    console.log(`[visit] ✓ done ${url}`);
    return {
      visitedAt: nowIso(),
      pageTitle: title || "潮新闻",
      finalUrl: url
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordFetch(itemId) {
  const db = await readDb();
  const item = db.newsItems.find((entry) => entry.id === itemId);

  if (!item) {
    throw new Error("未找到该新闻记录。");
  }

  const stats = await fetchArticleStats(itemId, item.url);
  const previous = db.history
    .filter((entry) => entry.newsItemId === itemId)
    .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))[0];

  const delta = previous ? stats.readCount - previous.readCount : 0;

  const isFallbackTitle = !item.title || /^潮新闻 \d+(-\d{2})?$/.test(item.title) || item.title.startsWith("未命名新闻");
  if (isFallbackTitle && stats.title) {
    item.title = stats.title + (item.titleSuffix || "");
  }
  item.articleId = stats.articleId;
  item.lastReadCount = stats.readCount;
  item.lastReadCountText = stats.readCountText;
  item.lastFetchedAt = stats.fetchedAt;
  item.lastDelta = delta;
  item.lastStatus = "success";
  item.lastError = "";
  item.lastFetchMethod = stats.fetchMethod || "";
  item.lastFetchFallbackReason = stats.fetchFallbackReason || "";

  // Perform lightweight direct simulation visit to increment count
  try {
    const visitRes = await visitArticlePage(itemId, item.url, item.title);
    item.lastVisitedAt = visitRes.visitedAt;
    item.lastVisitStatus = "success";
    item.lastVisitError = "";
  } catch (visitError) {
    console.error(`[visit] Error visiting ${item.url}:`, visitError);
    item.lastVisitStatus = "error";
    item.lastVisitError = visitError.message || "访问失败";
  }

  db.history.push({
    id: crypto.randomUUID(),
    newsItemId: itemId,
    fetchedAt: stats.fetchedAt,
    readCount: stats.readCount,
    readCountText: stats.readCountText,
    shareCount: stats.shareCount,
    likeCount: stats.likeCount,
    propagationReadCount: stats.propagationReadCount,
    delta
  });

  // Limit history entries per news item to prevent database bloat
  const itemHistory = db.history.filter((h) => h.newsItemId === itemId);
  if (itemHistory.length > 100) {
    const toRemove = itemHistory.sort((a, b) => new Date(a.fetchedAt) - new Date(b.fetchedAt)).slice(0, itemHistory.length - 100);
    const removeIds = new Set(toRemove.map((h) => h.id));
    db.history = db.history.filter((h) => !removeIds.has(h.id));
  }

  await writeDb(db);
  return { item, stats, delta };
}

async function recordFetchFailure(itemId, error) {
  const db = await readDb();
  const item = db.newsItems.find((entry) => entry.id === itemId);
  if (!item) {
    return null;
  }

  item.lastStatus = "error";
  item.lastError = error.message || "读取失败";
  item.updatedAt = nowIso();

  if (error.code === "WAF_BLOCKED") {
    item.monitorEnabled = false;
    item.monitorStoppedAt = nowIso();
    item.monitorStopReason = "触发访问校验，已自动停止";
    clearMonitor(itemId);
  }

  await writeDb(db);
  return item;
}

function scheduleMonitor(item) {
  clearMonitor(item.id);

  if (!item.monitorEnabled) {
    return;
  }

  let stopped = false;
  let fetchTimeoutId = null;
  let maxDurationTimeoutId = null;

  const stopBecauseExpired = () => {
    stopped = true;
    if (fetchTimeoutId) clearTimeout(fetchTimeoutId);
    stopMonitorInDb(item.id, "超过 24 小时，已自动停止").catch(() => {});
  };

  const remainingMs = getRemainingMonitorMs(item);
  if (remainingMs <= 0) {
    stopBecauseExpired();
    return;
  }
  maxDurationTimeoutId = setTimeout(stopBecauseExpired, remainingMs);

  const runFetch = async () => {
    if (stopped) return;

    try {
      await recordFetch(item.id);
    } catch (error) {
      await recordFetchFailure(item.id, error);
      if (error.code === "WAF_BLOCKED") {
        stopped = true;
        clearMonitor(item.id);
        return;
      }
    } finally {
      if (!stopped) {
        const nextDelay = Math.min(getRandomIntervalMs(item), Math.max(getRemainingMonitorMs(item), 0));
        if (nextDelay <= 0) {
          stopBecauseExpired();
          return;
        }
        fetchTimeoutId = setTimeout(runFetch, nextDelay);
      }
    }
  };

  fetchTimeoutId = setTimeout(runFetch, Math.min(getRandomIntervalMs(item), remainingMs));

  jobs.set(item.id, {
    stop() {
      stopped = true;
      if (fetchTimeoutId) clearTimeout(fetchTimeoutId);
      if (maxDurationTimeoutId) clearTimeout(maxDurationTimeoutId);
    }
  });
}

function clearMonitor(itemId) {
  const existing = jobs.get(itemId);
  if (existing) {
    existing.stop();
    jobs.delete(itemId);
  }
}

async function bootstrapSchedulers() {
  const db = await readDb();
  db.newsItems.forEach((item) => {
    if (item.monitorEnabled) {
      scheduleMonitor(item);
    }
  });
}

app.get("/api/news", async (_req, res) => {
  const db = await readDb();
  const newsItems = [];
  for (const item of db.newsItems) {
    const proxyNode = await getProxyNodeNameForNewsItem(item.id);
    newsItems.push({
      ...item,
      proxyNode,
      history: db.history
        .filter((entry) => entry.newsItemId === item.id)
        .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt))
        .slice(0, 20)
    });
  }
  newsItems.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ newsItems });
});

app.post("/api/news", async (req, res) => {
  try {
    const url = String(req.body.url || "").trim();
    const title = String(req.body.title || "").trim();
    const range = sanitizeFrequencyRange(
      req.body.frequencyMinSeconds ?? req.body.frequencySeconds ?? DEFAULT_MIN_INTERVAL_SECONDS,
      req.body.frequencyMaxSeconds ?? req.body.frequencySeconds ?? DEFAULT_MAX_INTERVAL_SECONDS
    );

    if (!url.startsWith("http")) {
      return res.status(400).json({ error: "请填写有效的新闻链接。" });
    }

    const normalizedUrl = normalizeUrl(url);
    const db = await readDb();
    const duplicates = db.newsItems.filter((entry) => normalizeUrl(entry.url) === normalizedUrl);
    const N = duplicates.length;
    const titleSuffix = N > 0 ? "-" + String(N - 1).padStart(2, "0") : "";

    const id = crypto.randomUUID();
    const articleId = getItemIdFromUrl(url);

    const item = {
      id,
      articleId,
      title: title ? (title + titleSuffix) : "",
      titleSuffix,
      url,
      frequencySeconds: range.min,
      frequencyMinSeconds: range.min,
      frequencyMaxSeconds: range.max,
      monitorDurationHours: DEFAULT_MONITOR_DURATION_HOURS,
      monitorEnabled: false,
      monitorStartedAt: "",
      monitorStoppedAt: "",
      monitorStopReason: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastFetchedAt: "",
      lastVisitedAt: "",
      lastReadCount: null,
      lastReadCountText: "",
      lastDelta: 0,
      lastStatus: "pending",
      lastError: "",
      lastVisitStatus: "pending",
      lastVisitError: ""
    };

    db.newsItems.push(item);
    await writeDb(db);

    let finalItem = item;
    try {
      const result = await recordFetch(id);
      finalItem = result.item;
    } catch (fetchError) {
      console.error(`Initial fetch failed for news ${id}:`, fetchError);
      finalItem = (await recordFetchFailure(id, fetchError)) || item;
      if (!item.title || item.title === item.titleSuffix) {
        item.title = (articleId ? `潮新闻 ${articleId}` : "未命名新闻") + (item.titleSuffix || "");
        const db2 = await readDb();
        const target = db2.newsItems.find(entry => entry.id === id);
        if (target) {
          target.title = item.title;
          await writeDb(db2);
          finalItem = target;
        }
      }
    }

    res.status(201).json({ item: finalItem });
  } catch (error) {
    res.status(500).json({ error: error.message || "创建失败" });
  }
});

app.post("/api/news/:id/fetch", async (req, res) => {
  try {
    const result = await recordFetch(req.params.id);
    res.json(result);
  } catch (error) {
    const item = await recordFetchFailure(req.params.id, error);
    res.status(500).json({ error: error.message || "读取失败" });
  }
});

app.post("/api/news/:id/monitor", async (req, res) => {
  try {
    const db = await readDb();
    const item = db.newsItems.find((entry) => entry.id === req.params.id);

    if (!item) {
      return res.status(404).json({ error: "未找到该新闻记录。" });
    }

    const range = sanitizeFrequencyRange(
      req.body.frequencyMinSeconds ?? req.body.frequencySeconds ?? item.frequencyMinSeconds ?? item.frequencySeconds,
      req.body.frequencyMaxSeconds ?? req.body.frequencySeconds ?? item.frequencyMaxSeconds ?? item.frequencySeconds
    );
    item.frequencySeconds = range.min;
    item.frequencyMinSeconds = range.min;
    item.frequencyMaxSeconds = range.max;
    item.monitorDurationHours = sanitizeDurationHours(req.body.monitorDurationHours ?? item.monitorDurationHours);
    const oldEnabled = item.monitorEnabled;
    const nextMonitorEnabled = req.body.monitorEnabled !== undefined ? Boolean(req.body.monitorEnabled) : oldEnabled;
    item.monitorEnabled = nextMonitorEnabled;
    if (nextMonitorEnabled !== oldEnabled) {
      if (nextMonitorEnabled) {
        item.monitorStartedAt = nowIso();
        item.monitorStoppedAt = "";
        item.monitorStopReason = "";
      } else {
        item.monitorStoppedAt = nowIso();
        item.monitorStopReason = "手动停止";
      }
    }
    item.updatedAt = nowIso();

    await writeDb(db);
    if (item.monitorEnabled) {
      scheduleMonitor(item);
    } else {
      clearMonitor(item.id);
    }

    res.json({ item });
  } catch (error) {
    res.status(500).json({ error: error.message || "更新监控状态失败" });
  }
});

app.delete("/api/news/:id", async (req, res) => {
  const db = await readDb();
  const exists = db.newsItems.some((entry) => entry.id === req.params.id);

  if (!exists) {
    return res.status(404).json({ error: "未找到该新闻记录。" });
  }

  db.newsItems = db.newsItems.filter((entry) => entry.id !== req.params.id);
  db.history = db.history.filter((entry) => entry.newsItemId !== req.params.id);
  await writeDb(db);
  clearMonitor(req.params.id);

  res.json({ ok: true });
});

app.get("/api/news/:id/history", async (req, res) => {
  const db = await readDb();
  const history = db.history
    .filter((entry) => entry.newsItemId === req.params.id)
    .sort((a, b) => new Date(a.fetchedAt) - new Date(b.fetchedAt));

  res.json({ history });
});

app.get("/api/settings", async (_req, res) => {
  try {
    const db = await readDb();
    const settings = db.settings || { proxyUrl: "", subscriptionUrl: "" };
    let hasNodes = false;
    try {
      const nodesRaw = await fs.readFile(path.join(dataDir, "nodes.json"), "utf8");
      const nodes = JSON.parse(nodesRaw);
      hasNodes = Array.isArray(nodes) && nodes.length > 0;
    } catch {
      // Ignore
    }
    res.json({
      proxyUrl: settings.proxyUrl || "",
      subscriptionUrl: settings.subscriptionUrl || "",
      hasNodes
    });
  } catch (error) {
    res.status(500).json({ error: "获取设置失败" });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const db = await readDb();
    db.settings = {
      proxyUrl: String(req.body.proxyUrl || "").trim(),
      subscriptionUrl: String(req.body.subscriptionUrl || "").trim()
    };
    await writeDb(db);
    res.json(db.settings);
  } catch (error) {
    res.status(500).json({ error: "保存设置失败" });
  }
});

app.post("/api/settings/import-subscription", async (req, res) => {
  try {
    const { subscriptionUrl } = req.body;
    if (!subscriptionUrl) {
      return res.status(400).json({ error: "订阅链接不能为空" });
    }

    console.log("Importing Clash subscription from:", subscriptionUrl);
    const fetchRes = await fetch(subscriptionUrl);
    if (!fetchRes.ok) {
      return res.status(500).json({ error: `订阅下载失败，服务器返回 ${fetchRes.status}` });
    }

    const base64Text = await fetchRes.text();
    const decoded = Buffer.from(base64Text, "base64").toString("utf8");
    const lines = decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const proxies = [];
    for (const line of lines) {
      if (line.startsWith("trojan://")) {
        try {
          const hashIdx = line.indexOf("#");
          let name = "Node-" + (proxies.length + 1);
          let mainPart = line;
          if (hashIdx !== -1) {
            name = decodeURIComponent(line.substring(hashIdx + 1)).trim();
            mainPart = line.substring(0, hashIdx);
          }

          const urlObj = new URL(mainPart);
          const password = urlObj.username || urlObj.password || urlObj.pathname.substring(1);
          const server = urlObj.hostname;
          const port = Number(urlObj.port);
          const sni = urlObj.searchParams.get("peer") || urlObj.searchParams.get("sni") || "";
          const skipCertVerify = urlObj.searchParams.get("allowInsecure") === "1" || urlObj.searchParams.get("skip-cert-verify") === "true";

          proxies.push({
            name,
            type: "trojan",
            server,
            port,
            password,
            sni,
            "skip-cert-verify": skipCertVerify,
            udp: true
          });
        } catch (err) {
          // ignore
        }
      } else if (line.startsWith("ss://")) {
        try {
          const hashIdx = line.indexOf("#");
          let name = "SS-" + (proxies.length + 1);
          let mainPart = line;
          if (hashIdx !== -1) {
            name = decodeURIComponent(line.substring(hashIdx + 1)).trim();
            mainPart = line.substring(0, hashIdx);
          }
          const url = new URL(mainPart);
          const server = url.hostname;
          const port = Number(url.port);
          
          let method = "";
          let password = "";
          
          if (url.username) {
            const decodedUserInfo = Buffer.from(url.username, "base64").toString("utf8");
            const [m, p] = decodedUserInfo.split(":");
            method = m;
            password = p;
          } else {
            const userInfo = url.href.split("@")[0].replace("ss://", "");
            const [m, p] = userInfo.split(":");
            method = m;
            password = p;
          }

          proxies.push({
            name,
            type: "ss",
            server,
            port,
            cipher: method,
            password,
            udp: true
          });
        } catch (err) {
          // ignore
        }
      }
    }

    if (proxies.length === 0) {
      return res.status(400).json({ error: "未能在订阅中解析出有效的 Trojan 或 SS 节点" });
    }

    // Save nodes
    await fs.writeFile(path.join(dataDir, "nodes.json"), JSON.stringify(proxies, null, 2), "utf8");

    // Also update settings db
    const db = await readDb();
    db.settings = db.settings || {};
    db.settings.subscriptionUrl = subscriptionUrl;
    await writeDb(db);

    res.json({ totalNodes: proxies.length });
  } catch (error) {
    console.error("Import subscription error:", error);
    res.status(500).json({ error: error.message || "同步订阅失败" });
  }
});

app.get("/api/settings/clash-config", async (req, res) => {
  try {
    let proxies = [];
    try {
      const nodesRaw = await fs.readFile(path.join(dataDir, "nodes.json"), "utf8");
      proxies = JSON.parse(nodesRaw);
    } catch {
      return res.status(404).send("Error: Please sync nodes first!");
    }

    if (proxies.length === 0) {
      return res.status(404).send("Error: No nodes parsed yet!");
    }

    // Build YAML
    let yaml = `port: 7890\nsocks-port: 7891\nmixed-port: 7892\nallow-lan: false\nmode: rule\nlog-level: info\nexternal-controller: '127.0.0.1:9090'\n\ndns:\n  enable: true\n  ipv6: false\n  default-nameserver: [223.5.5.5, 119.29.29.29]\n  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n  nameserver: [https://dns.alicdn.com/dns-query, https://doh.pub/dns-query]\n\nproxies:\n`;

    for (const proxy of proxies) {
      yaml += `  - name: "${proxy.name}"\n    type: ${proxy.type}\n    server: ${proxy.server}\n    port: ${proxy.port}\n`;
      if (proxy.type === "trojan") {
        yaml += `    password: "${proxy.password}"\n`;
        if (proxy.sni) {
          yaml += `    sni: ${proxy.sni}\n`;
        }
        yaml += `    skip-cert-verify: ${!!proxy["skip-cert-verify"]}\n    udp: true\n`;
      } else if (proxy.type === "ss") {
        yaml += `    cipher: "${proxy.cipher}"\n    password: "${proxy.password}"\n    udp: true\n`;
      }
    }

    yaml += `\nproxy-groups:\n  - name: "AUTO_NEWS_PROXIES"\n    type: select\n    proxies:\n`;
    for (const proxy of proxies) {
      yaml += `      - "${proxy.name}"\n`;
    }

    yaml += `\nlisteners:\n`;
    for (let i = 0; i < proxies.length; i++) {
      const port = 10001 + i;
      yaml += `  - name: news-port-${port}\n    type: mixed\n    port: ${port}\n    proxy: "${proxies[i].name}"\n`;
    }

    yaml += `\nrules:\n  - MATCH, AUTO_NEWS_PROXIES\n`;

    res.setHeader("Content-Disposition", 'attachment; filename="news-monitor-clash.yaml"');
    res.setHeader("Content-Type", "application/x-yaml");
    res.send(yaml);
  } catch (error) {
    console.error("Clash config generation error:", error);
    res.status(500).send("Error generating clash config: " + error.message);
  }
});

export async function initApp() {
  if (initialized) {
    return;
  }
  await ensureDb();
  await bootstrapSchedulers();
  initialized = true;
}

if (process.env.START_SERVER !== "false") {
  await initApp();
  app.listen(port, () => {
    console.log(`Tide News monitor running at http://localhost:${port}`);
  });
}
