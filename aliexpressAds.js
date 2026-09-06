// AliExpress Affiliate API — rotating product ads for EmailVanish
// Credentials + cache live OUTSIDE the statically-served app dir.
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.resolve(__dirname, "../../ae.env");
const CACHE_FILE = path.resolve(__dirname, "../../ae_ads_cache.json");
const REFRESH_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 20;
const KEYWORDS_PER_REFRESH = 2;

// Privacy/tech gear fits the temp-email audience
const KEYWORDS = [
  "rfid blocking wallet",
  "webcam cover slide",
  "usb data blocker",
  "faraday pouch phone",
  "privacy screen protector",
  "usb gadgets",
  "hidden camera detector",
  "usb flash drive"
];

let creds = null;
let cache = { updatedAt: 0, products: [] };
let refreshing = false;

function loadCreds() {
  if (creds) return creds;
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (e) {
    console.error("[ae-ads] cannot read " + ENV_FILE + ":", e.message);
  }
  creds = out;
  return creds;
}

function loadCacheFile() {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    cache = { updatedAt: 0, products: [] };
  }
}

function saveCacheFile() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    console.error("[ae-ads] failed to write cache:", e.message);
  }
}

function apiCall(method, extraParams) {
  return new Promise((resolve, reject) => {
    const { AE_APP_KEY, AE_APP_SECRET } = loadCreds();
    if (!AE_APP_KEY || !AE_APP_SECRET) return reject(new Error("AE credentials missing"));

    const params = {
      method,
      app_key: AE_APP_KEY,
      sign_method: "sha256",
      timestamp: String(Date.now()),
      ...extraParams
    };
    const base = Object.keys(params).sort().map(k => k + params[k]).join("");
    params.sign = crypto.createHmac("sha256", AE_APP_SECRET).update(base).digest("hex").toUpperCase();

    const url = "https://api-sg.aliexpress.com/sync?" + new URLSearchParams(params).toString();
    https.get(url, { timeout: 20000 }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("bad JSON from AliExpress API")); }
      });
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("AliExpress API timeout")); });
  });
}

async function fetchProductsForKeyword(keyword) {
  const resp = await apiCall("aliexpress.affiliate.product.query", {
    keywords: keyword,
    target_currency: "USD",
    target_language: "EN",
    tracking_id: loadCreds().AE_TRACKING_ID || "default",
    sort: "LAST_VOLUME_DESC",
    page_size: String(PAGE_SIZE)
  });
  const result = resp && resp.aliexpress_affiliate_product_query_response &&
    resp.aliexpress_affiliate_product_query_response.resp_result &&
    resp.aliexpress_affiliate_product_query_response.resp_result.result;
  const items = (result && result.products && result.products.product) || [];
  return items
    .filter(p => p.promotion_link && p.product_main_image_url && p.product_title)
    .map(p => ({
      title: p.product_title,
      image: p.product_main_image_url,
      link: p.promotion_link,
      price: p.target_sale_price,
      origPrice: p.target_original_price,
      discount: p.discount || ""
    }));
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const picked = [...KEYWORDS].sort(() => Math.random() - 0.5).slice(0, KEYWORDS_PER_REFRESH);
    const products = [];
    for (const kw of picked) {
      try {
        const items = await fetchProductsForKeyword(kw);
        products.push(...items);
        console.log(`[ae-ads] refreshed "${kw}": ${items.length} products`);
      } catch (e) {
        console.error(`[ae-ads] refresh failed for "${kw}":`, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (products.length > 0) {
      cache = { updatedAt: Date.now(), products };
      saveCacheFile();
    } else {
      cache.updatedAt = Date.now(); // avoid hammering the API when it errors
    }
  } finally {
    refreshing = false;
  }
}

function maybeRefresh() {
  if (Date.now() - cache.updatedAt > REFRESH_MS) {
    refreshAll().catch(e => console.error("[ae-ads] refresh error:", e.message));
  }
}

function getRandomAdProducts(n) {
  maybeRefresh();
  const pool = cache.products || [];
  if (pool.length === 0) return [];
  const picks = [];
  const used = new Set();
  while (picks.length < n && used.size < pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    if (!used.has(i)) {
      used.add(i);
      picks.push(pool[i]);
    }
  }
  return picks;
}

loadCacheFile();
maybeRefresh();

module.exports = { getRandomAdProducts };
