const SRC_LANG = "en";
const DST_LANG = "mn";

const SHOT_TTL_MS = 800; // Скриншотыг хэр хугацаанд дахин ашиглах
const MEM_CACHE_MAX = 600;
const FETCH_TIMEOUT_MS = 8000;
const DICT_TIMEOUT_MS = 3500; // Толь бичиг удаан бол tooltip-ыг хүлээлгэхгүй
const MAX_SENSES = 3; // Хэдэн утга (үгийн төрлөөр) харуулах
const DEF_MAX_CHARS = 120;

// ---------- Кэш ----------
let shotCache = null; // { key, id, dataUrl, ts }
let shotSeq = 0;
let offscreenImageId = null; // Offscreen дээр аль зураг decode-логдсон байгаа
let offscreenReady = null; // createDocument-ийн race-ээс хамгаалах promise

const memCache = new Map(); // key -> value

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
  OPEN_EXPORT: openExport,
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

  // Ганц үг сонгосон бол мөн адил үгийн дэлгэрэнгүй үр дүнг гаргана
  if (countWords(ocr.text) === 1) {
    const result = await buildWordResult(ocr.text, ocr.line);
    return Object.assign(result, { source: "region" });
  }

  const res = await translate(cleanSentence(ocr.text));
  return {
    original: ocr.text,
    translation: res.text,
    alts: [],
    senses: [],
    source: "region",
  };
}

// Хуудсан дээр DOM текст байвал OCR-гүйгээр шууд ирнэ
async function translateWord(request) {
  const result = await buildWordResult(request.word, request.context);
  return Object.assign(result, { source: "dom" });
}

// Орчуулсан үгсийн хэвлэх/PDF хуудсыг шинэ табд нээнэ
async function openExport() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("export.html") });
  return { ok: true };
}

async function translatePlain(request) {
  const text = cleanSentence(request.text);

  // Талбарт ганц үг бичсэн бол утга/үгийн төрлөөр нь задалж өгнө
  if (countWords(text) === 1) {
    const result = await buildWordResult(text, null);
    return Object.assign(result, { source: "input" });
  }

  const res = await translate(text);
  return { original: text, translation: res.text, alts: res.alts, senses: [] };
}

// ---------- Үгийн үр дүн ----------
// Ганц үгийг контекстгүй шидвэл Google санамсаргүй нэг утгыг сонгодог тул:
//   1) OCR/манга-гийн бичиглэлийг цэвэрлэнэ (NOOOO!, WHAAAT, "Running,")
//   2) Орчуулга буцаж ирээгүй бол үндсэн хэлбэрээр нь дахин оролдоно
//   3) Толь бичгээс үгийн төрлүүдийг нь аваад тус бүрээр нь орчуулна
//      ("to run" → үйл үг, "the run" → нэр үг), тайлбарыг нь бас орчуулна
//   4) Контекстээс үгийн төрлийг таасан бол тэр утгыг үндсэн орчуулга болгоно
async function buildWordResult(rawWord, contextLine) {
  const word = cleanWord(rawWord) || String(rawWord || "").trim();
  if (!word) throw new Error("Үг олдсонгүй");

  const context =
    contextLine && countWords(contextLine) > 1
      ? cleanSentence(contextLine)
      : null;

  const [main, dict, ctxRes] = await Promise.all([
    translateWordSmart(word),
    withTimeout(lookupDict(word), DICT_TIMEOUT_MS, null),
    context ? translate(context).catch(() => null) : Promise.resolve(null),
  ]);

  const senses = dict
    ? await withTimeout(buildSenses(dict), DICT_TIMEOUT_MS, [])
    : [];

  const head = senses.length ? senses[0].head : null;

  return {
    original: word,
    translation: pickPrimary(main, senses, word, context),
    alts: main.alts,
    lemma: head && head.toLowerCase() !== word.toLowerCase() ? head : null,
    senses,
    context,
    contextTranslation: ctxRes ? ctxRes.text : null,
  };
}

// Контекстээс үгийн төрлийг таасан бол тэр төрлийн орчуулгыг үндсэн болгоно
function pickPrimary(main, senses, word, context) {
  if (!senses.length) return main.text;

  const guess = guessPos(word, context);
  if (guess) {
    const hit = senses.find((s) => s.posEn === guess && s.word);
    if (hit) return hit.word;
  }
  return main.text;
}

// Маш энгийн дүрэм — эргэлзээтэй бол юу ч заахгүй (null)
function guessPos(word, context) {
  const w = word.toLowerCase();

  if (context) {
    const words = context.toLowerCase().match(/[a-z']+/g) || [];
    const i = words.indexOf(w);
    if (i > 0) {
      const prev = words[i - 1];
      if (/^(to|will|shall|can|could|should|would|must|may|might|let|not|never)$/.test(prev))
        return "verb";
      if (/^(i|you|he|she|we|they|it)$/.test(prev)) return "verb";
      if (/^(a|an|the|this|that|these|those|my|your|his|her|its|our|their|some|any|no|every)$/.test(prev))
        return "noun";
      if (/^(is|are|was|were|be|been|being|so|very|too|more|most|really|quite)$/.test(prev))
        return "adjective";
    }
  }

  if (/(ing|ed)$/.test(w)) return "verb";
  if (/(tion|sion|ness|ment|ity|ship|hood)$/.test(w)) return "noun";
  if (/(ous|ful|less|able|ible|ive)$/.test(w)) return "adjective";
  return null;
}

// Үгийн боломжит бичиглэлүүд — эхнийх нь амжилттай орчуулагдвал тэндээ зогсоно
async function translateWordSmart(word) {
  let first = null;

  for (const form of wordForms(word)) {
    const res = await translate(form).catch(() => null);
    if (!res || !res.text) continue;
    const cand = { query: form, text: res.text, alts: res.alts };
    if (!first) first = cand;
    if (looksTranslated(form, res.text)) return cand;
  }

  if (!first) throw new Error("Орчуулга олдсонгүй");
  return first;
}

function wordForms(word) {
  const out = [];
  const push = (w) => {
    if (w && w.length > 1 && !out.includes(w)) out.push(w);
  };

  push(word);
  push(word.toLowerCase()); // ЗӨВХӨН ТОМООР бичсэн манга текст
  push(deElongate(word.toLowerCase())); // NOOOO → NO
  for (const g of lemmaGuesses(word.toLowerCase())) push(g);

  return out.slice(0, 4);
}

// ---------- Толь бичгээс үгийн утгууд ----------
async function buildSenses(dict) {
  const raw = dict.senses || [];
  if (!raw.length) return [];

  const frames = raw.map((s) => frameFor(s.posEn, s.head));
  const defs = raw.map((s) => shorten(s.text, DEF_MAX_CHARS));

  const out = await translateLines(frames.concat(defs));
  const n = raw.length;

  const seen = new Set();
  const senses = [];

  for (let i = 0; i < n; i++) {
    const w = (out[i] || "").trim();
    const def = (out[n + i] || "").trim();
    if (!w && !def) continue;

    const good = looksTranslated(frames[i], w) ? w : "";
    if (good && seen.has(good.toLowerCase())) continue;
    if (good) seen.add(good.toLowerCase());

    senses.push({
      pos: POS_MN[raw[i].posEn] || raw[i].posEn || "",
      posEn: raw[i].posEn,
      head: raw[i].head,
      word: good,
      def,
      defEn: defs[i],
    });
  }
  return senses;
}

// Хуучирсан/ховор утгууд ("(obsolete) A course; a way") — уншигчид хэрэггүй
const STALE_DEF =
  /^\([^)]*\b(obsolete|archaic|rare|dated|dialectal|nonstandard|proscribed|poetic|heraldry)\b/i;

// Datamuse-ийн "n\tтайлбар" мөрүүдээс үгийн төрөл бүрийн эхний утгыг авна
function parseDefs(entry) {
  const used = new Set();
  const out = [];

  for (const d of entry.defs || []) {
    const tab = d.indexOf("\t");
    const posEn = POS_FULL[tab > 0 ? d.slice(0, tab) : ""] || "";
    const text = (tab > 0 ? d.slice(tab + 1) : d).trim();
    if (!text || used.has(posEn) || STALE_DEF.test(text)) continue;
    used.add(posEn);
    out.push({ posEn, text, head: entry.word });
  }
  return out;
}

// Google-ээс тухайн үгийн төрлийн утгыг гаргуулах "хүрээ".
// Монгол хэлэнд артикль байхгүй тул "the"/"to" нь орчуулгад үлдэхгүй.
function frameFor(posEn, word) {
  if (posEn === "verb") return "to " + word;
  if (posEn === "noun") return "the " + word;
  return word;
}

const POS_FULL = {
  n: "noun",
  v: "verb",
  adj: "adjective",
  adv: "adverb",
  u: "",
};

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

// ---------- Datamuse (англи толь бичиг) ----------
// Буцаах утга: { senses: [{ posEn, text, head }] }
// "running" гэх мэт хувирсан хэлбэрт толь нь зөвхөн нэр/тэмдэг нэрийг өгдөг тул
// үндсэн хэлбэрийнх нь ("run") дутуу үгийн төрлүүдийг нэмж нийлүүлнэ.
async function lookupDict(word) {
  const w = word.toLowerCase();
  if (!/^[a-z][a-z'-]{1,24}$/.test(w)) return null;

  const key = "dm:" + w;
  const hit = memGet(key);
  if (hit) return hit.dict;

  const stored = await chrome.storage.local
    .get(key)
    .then((o) => o[key])
    .catch(() => null);
  if (stored && stored.dict !== undefined) {
    memPut(key, stored);
    return stored.dict;
  }

  const dict = await buildDict(w);
  const val = { dict: dict || null };
  memPut(key, val);
  chrome.storage.local.set({ [key]: val }).catch(() => {});
  return val.dict;
}

async function buildDict(w) {
  const surface = await datamuseEntry(w);
  const senses = surface ? parseDefs(surface) : [];

  // Хувирсан хэлбэр (running, went) эсвэл огт олдоогүй үед үндсээр нь хайна
  const inflected = !!IRREGULAR[w] || /(ing|ed|ies|es|s)$/.test(w);
  const needLemma =
    !surface || (inflected && !senses.some((s) => s.posEn === "verb"));

  let lemma = null;
  if (needLemma) {
    const tries = lemmaGuesses(w).slice(0, 3);
    const de = deElongate(w); // NOOOO → NO
    if (de && !tries.includes(de)) tries.push(de);

    for (const g of tries) {
      lemma = await datamuseEntry(g);
      if (lemma) break;
    }
  }

  if (lemma) {
    const used = new Set(senses.map((s) => s.posEn));
    for (const s of parseDefs(lemma)) {
      if (used.has(s.posEn)) continue;
      used.add(s.posEn);
      senses.push(s);
    }
  }

  if (!senses.length) return null;

  // Хувирсан хэлбэр (running, went) бол үйл үгийн утга нь хамгийн хэрэгтэй —
  // MAX_SENSES-д тасрахгүйн тулд түрүүлж тавина. Бусад тохиолдолд
  // толь бичгийн өөрийнх нь дараалал (түгээмэл утга эхэндээ) хэвээр үлдэнэ.
  if (inflected) {
    const vi = senses.findIndex((s) => s.posEn === "verb");
    if (vi > 0) senses.unshift(senses.splice(vi, 1)[0]);
  }

  return { senses: senses.slice(0, MAX_SENSES) };
}

async function datamuseEntry(w) {
  const url =
    "https://api.datamuse.com/words?md=dp&max=1&sp=" + encodeURIComponent(w);
  const arr = await fetchJson(url).catch(() => null);
  const first = Array.isArray(arr) ? arr[0] : null;
  if (!first || (first.word || "").toLowerCase() !== w) return null;
  if (!first.defs || !first.defs.length) return null;
  return {
    word: first.word,
    tags: first.tags || [],
    defs: first.defs.slice(0, 12),
  };
}

// ---------- Текст цэвэрлэх ----------
function cleanWord(raw) {
  return String(raw || "")
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSentence(raw) {
  return String(raw || "")
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text) {
  const m = String(text || "").match(/[\p{L}\p{N}']+/gu);
  return m ? m.length : 0;
}

// NOOOO → NO, WHAAAT → WHAT (манга-гийн сунгасан бичиглэл)
function deElongate(w) {
  const out = w.replace(/(\p{L})\1{2,}/gu, "$1");
  return out !== w ? out : null;
}

// Түгээмэл дүрмийн бус үйл үгс — манга-гийн яриа өнгөрсөн цагаар их байдаг
const IRREGULAR = {
  was: "be", were: "be", been: "be",
  had: "have", did: "do", done: "do",
  went: "go", gone: "go",
  said: "say", saw: "see", seen: "see",
  got: "get", gotten: "get",
  made: "make", knew: "know", known: "know",
  took: "take", taken: "take",
  came: "come", thought: "think",
  gave: "give", given: "give",
  found: "find", told: "tell",
  became: "become", left: "leave",
  felt: "feel", brought: "bring",
  began: "begin", begun: "begin",
  kept: "keep", held: "hold",
  wrote: "write", written: "write",
  stood: "stand", heard: "hear",
  meant: "mean", met: "meet",
  ran: "run", paid: "pay", sat: "sit",
  spoke: "speak", spoken: "speak",
  led: "lead", grew: "grow", grown: "grow",
  lost: "lose", fell: "fall", fallen: "fall",
  sent: "send", built: "build",
  understood: "understand",
  drew: "draw", drawn: "draw",
  broke: "break", broken: "break",
  spent: "spend",
  drove: "drive", driven: "drive",
  bought: "buy", wore: "wear", worn: "wear",
  chose: "choose", chosen: "choose",
  ate: "eat", eaten: "eat",
  slept: "sleep", drank: "drink", drunk: "drink",
  flew: "fly", flown: "fly",
  threw: "throw", thrown: "throw",
  hid: "hide", hidden: "hide",
  fought: "fight", caught: "catch",
  taught: "teach", bit: "bite",
  woke: "wake", woken: "wake",
  stole: "steal", stolen: "steal",
  shot: "shoot", forgot: "forget", forgotten: "forget",
  sold: "sell", won: "win", shook: "shake",
  bled: "bleed", bent: "bend", dealt: "deal",
  swam: "swim", sang: "sing", sung: "sing",
  rang: "ring", rung: "ring", sank: "sink", sunk: "sink",
  struck: "strike", stuck: "stick",
  tore: "tear", torn: "tear",
  crept: "creep", dug: "dig",
  fed: "feed", fled: "flee",
  froze: "freeze", frozen: "freeze",
  hung: "hang", lent: "lend",
  lit: "light", rode: "ride", ridden: "ride",
  sought: "seek", shone: "shine",
  slid: "slide", sprang: "spring",
  stung: "sting", swept: "sweep", swung: "swing",
  wept: "weep",
};

// Үндсэн хэлбэрийн таамаг — магадлал өндөртэйг нь эхэнд нь тавина
function lemmaGuesses(s) {
  const out = [];
  const push = (x) => {
    if (x && x.length > 1 && x !== s && !out.includes(x)) out.push(x);
  };

  push(IRREGULAR[s]);

  // Давхар гийгүүлэгч: running → run, stopped → stop
  if (/([bdgklmnprt])\1(ed|ing)$/.test(s)) {
    push(s.replace(/([bdgklmnprt])\1(ed|ing)$/, "$1"));
  }
  if (/ies$/.test(s)) push(s.slice(0, -3) + "y");
  if (/(ches|shes|sses|xes|zes)$/.test(s)) push(s.slice(0, -2));
  if (/s$/.test(s) && !/(ss|us|is)$/.test(s)) push(s.slice(0, -1));
  // Дуугүй "e"-г эхэлж сэргээнэ (hoped → hope, hoping → hope). Байхгүй үг
  // гарвал (walke) толь бичиг олохгүй тул дараагийн таамаг руу шилжинэ.
  if (/ied$/.test(s)) push(s.slice(0, -3) + "y");
  if (/ed$/.test(s)) {
    push(s.slice(0, -1));
    push(s.slice(0, -2));
  }
  if (/ing$/.test(s)) {
    push(s.slice(0, -3) + "e");
    push(s.slice(0, -3));
  }
  if (/est$/.test(s)) push(s.slice(0, -3));
  if (/ly$/.test(s)) push(s.slice(0, -2));

  return out;
}

function shorten(text, max) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

// Орчуулга үнэхээр болсон эсэх (эх үгээ давтсан / кирилл болоогүй бол үгүй)
function looksTranslated(src, out) {
  const o = (out || "").trim();
  if (!o) return false;
  if (o.toLowerCase() === String(src || "").toLowerCase()) return false;
  if (DST_LANG === "mn" && !/[Ѐ-ӿ]/.test(o)) return false;
  return true;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// ---------- Орчуулга ----------
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("Сервер: " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function translate(rawText, sl, tl) {
  const src = sl || SRC_LANG;
  const dst = tl || DST_LANG;
  const text = (rawText || "").trim();
  if (!text) return { text: "", alts: [] };

  const key = "tc:" + src + ":" + dst + ":" + text.toLowerCase();

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
    "&sl=" + src + "&tl=" + dst + "&dj=1&dt=t&dt=bd&dt=at" +
    "&q=" + encodeURIComponent(text);

  const json = await fetchJson(url);

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

// Хэд хэдэн богино текстийг нэг хүсэлтээр орчуулна (мөрөөр тусгаарлаж).
// Мөрийн тоо таарахгүй бол тус тусад нь дахин явуулна.
async function translateLines(lines, sl, tl) {
  const clean = lines.map((l) => cleanSentence(l));
  const one = (t) =>
    t
      ? translate(t, sl, tl)
          .then((r) => r.text)
          .catch(() => "")
      : Promise.resolve("");

  if (clean.length <= 1) return Promise.all(clean.map(one));

  try {
    const res = await translate(clean.join("\n"), sl, tl);
    const parts = res.text.split("\n").map((s) => s.trim());
    if (parts.length === clean.length) return parts;
  } catch (err) {
    // доор тус тусад нь дахин оролдоно
  }
  return Promise.all(clean.map(one));
}

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
