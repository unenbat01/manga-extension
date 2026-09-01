const SRC_LANG = "en";
const DST_LANG = "mn";

const SHOT_TTL_MS = 800; // Скриншотыг хэр хугацаанд дахин ашиглах
const MEM_CACHE_MAX = 600;
const FETCH_TIMEOUT_MS = 8000;

// ---------- Кэш ----------
let shotCache = null; // { key, id, dataUrl, ts }
let shotSeq = 0;
let offscreenImageId = null; // Offscreen дээр аль зураг decode-логдсон байгаа
let offscreenReady = null; // createDocument-ийн race-ээс хамгаалах promise

const memCache = new Map(); // key -> { text, alts }

function memGet(key) {
  if (!memCache.has(key)) return null;
  const val = memCache.get(key);
  memCache.delete(key); // LRU: дахин хамгийн сүүлд болгоно
  memCache.set(key, val);
  return val;
}

function memPut(key, val) {
  memCache.set(key, val);
  if (memCache.size > MEM_CACHE_MAX) {
    memCache.delete(memCache.keys().next().value);
  }
}

// ---------- Мессежийн router ----------
const handlers = {
  WARMUP: warmup,
  PRECAPTURE: precapture,
  PROCESS_CLICK: processClick,
  PROCESS_REGION: processRegion,
  TRANSLATE_WORD: translateWord,
  TRANSLATE_TEXT: translatePlain,
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Offscreen руу явуулсан мессежийг (type-тай) энд үл хэрэгсэнэ
  if (!request || !request.action) return;
  const handler = handlers[request.action];
  if (!handler) return;

  handler(request, sender)
    .then((data) => sendResponse({ success: true, data }))
    .catch((err) => {
      console.error("[MT] " + request.action + ":", err);
      sendResponse({ success: false, error: err.message || "Олдсонгүй" });
    });
  return true;
});

// ---------- Offscreen ----------
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  if (!offscreenReady) {
    offscreenReady = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run Tesseract OCR worker",
      })
      .catch((err) => {
        // Зэрэг үүсгэх гэж оролдвол "single document" гэж хаядаг — үл хэрэгсэнэ
        if (!/single offscreen/i.test(err.message || "")) throw err;
      })
      .finally(() => {
        offscreenReady = null;
      });
  }
  await offscreenReady;
  offscreenImageId = null; // Шинэ document — decode-лосон зураг байхгүй
}

async function warmup() {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: "WARMUP" });
  return { ok: true };
}

// ---------- Скриншот ----------
async function captureVisible(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    // Rate limit / хуудас солигдох үед нэг удаа дахин оролдоно
    await new Promise((r) => setTimeout(r, 150));
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

async function getShot(windowId, stateKey) {
  const now = Date.now();
  if (
    shotCache &&
    shotCache.key === stateKey &&
    now - shotCache.ts < SHOT_TTL_MS
  ) {
    return shotCache;
  }
  const dataUrl = await captureVisible(windowId);
  shotCache = { key: stateKey, id: "s" + ++shotSeq, dataUrl, ts: now };
  return shotCache;
}

// mousedown үед дуудагдана — click болох хооронд скриншот бэлэн болчихно
async function precapture(request, sender) {
  if (!sender.tab) return { ok: false };
  ensureOffscreenDocument().catch(() => {});
  await getShot(sender.tab.windowId, request.stateKey || "");
  return { ok: true };
}

// Offscreen руу OCR даалгавар явуулна. Зураг аль хэдийн decode-логдсон бол
// зөвхөн id-г явуулж, хэдэн МБ base64 дамжуулахаас зайлсхийнэ.
async function runOcr(shot, payload) {
  await ensureOffscreenDocument();

  const send = (withImage) =>
    chrome.runtime.sendMessage({
      type: "CROP_AND_OCR",
      data: Object.assign({}, payload, {
        imageId: shot.id,
        dataUrl: withImage ? shot.dataUrl : null,
      }),
    });

  let res = await send(offscreenImageId !== shot.id);
  if (res && !res.success && res.code === "NEED_IMAGE") {
    res = await send(true);
  }

  if (!res || !res.success) {
    throw new Error((res && res.error) || "Текст олдсонгүй");
  }
  offscreenImageId = shot.id;
  return res;
}

// ---------- Гол урсгалууд ----------
async function processClick(request, sender) {
  if (!sender.tab) throw new Error("Таб олдсонгүй");

  const shot = await getShot(sender.tab.windowId, request.stateKey || "");
  const ocr = await runOcr(shot, {
    mode: "word",
    clickX: request.clickX,
    clickY: request.clickY,
    devicePixelRatio: request.devicePixelRatio,
  });

  const result = await buildWordResult(ocr.text, ocr.line);
  return Object.assign(result, { source: "ocr", confidence: ocr.confidence });
}

async function processRegion(request, sender) {
  if (!sender.tab) throw new Error("Таб олдсонгүй");

  const shot = await getShot(sender.tab.windowId, request.stateKey || "");
  const ocr = await runOcr(shot, {
    mode: "region",
    rect: request.rect,
    devicePixelRatio: request.devicePixelRatio,
  });

  const res = await translate(ocr.text);
  return {
    original: ocr.text,
    translation: res.text,
    alts: [],
    source: "region",
  };
}

// Хуудсан дээр DOM текст байвал OCR-гүйгээр шууд ирнэ
async function translateWord(request) {
  const result = await buildWordResult(request.word, request.context);
  return Object.assign(result, { source: "dom" });
}

async function translatePlain(request) {
  const res = await translate(request.text);
  return { original: request.text, translation: res.text, alts: res.alts };
}

// Үг болон түүний мөрийг зэрэг орчуулна (мөр нь контекст болно)
async function buildWordResult(word, contextLine) {
  const query = isAllCaps(word) ? word.toLowerCase() : word;

  const context =
    contextLine && contextLine.trim().split(/\s+/).length > 1
      ? contextLine.trim()
      : null;

  const [wordRes, ctxRes] = await Promise.all([
    translate(query),
    context ? translate(context).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    original: word,
    translation: wordRes.text,
    alts: wordRes.alts,
    context,
    contextTranslation: ctxRes ? ctxRes.text : null,
  };
}

function isAllCaps(w) {
  return /[A-Z]/.test(w) && w === w.toUpperCase();
}

// ---------- Орчуулга ----------
async function translate(rawText) {
  const text = (rawText || "").trim();
  if (!text) return { text: "", alts: [] };

  const key = "tc:" + SRC_LANG + ":" + DST_LANG + ":" + text.toLowerCase();

  const hit = memGet(key);
  if (hit) return hit;

  const stored = await chrome.storage.local
    .get(key)
    .then((o) => o[key])
    .catch(() => null);
  if (stored) {
    memPut(key, stored);
    return stored;
  }

  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=" + SRC_LANG + "&tl=" + DST_LANG + "&dj=1&dt=t&dt=bd&dt=at" +
    "&q=" + encodeURIComponent(text);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("Орчуулгын сервер: " + res.status);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const translation = (json.sentences || [])
    .map((s) => s.trans || "")
    .join("")
    .trim();

  if (!translation) throw new Error("Орчуулга хоосон байна");

  const result = { text: translation, alts: collectAlts(json, translation) };

  memPut(key, result);
  // Дараагийн удаа network-гүй шууд гаргахын тулд диск дээр хадгална
  chrome.storage.local.set({ [key]: result }).catch(() => {});

  return result;
}

const POS_MN = {
  noun: "нэр үг",
  verb: "үйл үг",
  adjective: "тэмдэг нэр",
  adverb: "дайвар үг",
  pronoun: "төлөөний үг",
  preposition: "угтвар үг",
  conjunction: "холбоос үг",
  interjection: "аялга үг",
  exclamation: "аялга үг",
  abbreviation: "хураангуй",
  prefix: "угтвар",
  suffix: "дагавар",
};

function collectAlts(json, main) {
  const norm = (s) => (s || "").toLowerCase().trim();
  const seen = new Set([norm(main)]);
  const out = [];

  // dt=bd — толь бичгийн хувилбарууд (үгийн төрлөөр)
  for (const entry of json.dict || []) {
    const pos = POS_MN[norm(entry.pos)] || entry.pos || "";
    for (const term of entry.terms || []) {
      if (!term || seen.has(norm(term))) continue;
      seen.add(norm(term));
      out.push(pos ? term + " · " + pos : term);
    }
  }

  // dt=at — өөр боломжит орчуулгууд (толь бичиг хоосон үед ажиллана)
  for (const group of json.alternativeTranslations || []) {
    for (const alt of group.alternative || []) {
      const w = alt.word_postproc;
      if (!w || seen.has(norm(w))) continue;
      seen.add(norm(w));
      out.push(w);
    }
  }

  return out.slice(0, 6);
}
