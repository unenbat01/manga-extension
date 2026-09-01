const WORKER_IDLE_MS = 5 * 60 * 1000; // Идэвхгүй байвал хэдий хугацааны дараа хаах
const PAD = 12; // Tesseract-д захын зай хэрэгтэй
const LOW_CONF = 60; // Үүнээс доогуур бол polarity эргүүлж дахин уншина
const MAX_REGION_PX = 3.5e6; // Хэсэг сонголтын дээд пиксел

// Мөрийн өндрийг хэмжих урьдчилсан талбай (CSS px).
// Хэт өргөн байвал бөмбөлгөөс гарч хар панель руу ордог тул нарийхан.
const PROBE_W_CSS = 340;
const PROBE_H_CSS = 260;

const TARGET_LINE_PX = 46; // OCR-д тохирох мөрийн өндөр
const FALLBACK_LINE_CSS = 17; // Хэмжиж чадаагүй үеийн таамаг

// Тайрах талбайг мөрийн өндрөөс тооцно (манга ~14px, manhwa ~40px)
const CROP_W_LINES = 16; // өргөн = мөрийн өндөр × энэ
const CROP_H_LINES = 3.4; // өндөр = мөрийн өндөр × энэ
const CROP_W_MIN_CSS = 240;
const CROP_W_MAX_CSS = 900;
const CROP_H_MIN_CSS = 90;
const CROP_H_MAX_CSS = 340;
const CROP_W_RETRY_MAX_CSS = 1400; // үг тайрагдсан үед хэр өргөн болгож болох

// ---------- Тогтмол Tesseract worker ----------
// Өмнө нь click тутам createWorker/terminate хийдэг байсан нь 1-3 секунд авдаг.
// Одоо нэг л удаа үүсгээд дараачийн бүх click-д дахин ашиглана.
let workerPromise = null;
let idleTimer = null;
let jobChain = Promise.resolve(); // Зэрэг ирсэн даалгаврыг дараалуулна

// Decode-лосон скриншотыг хадгалж, ижил зураг дахин ирэхэд base64
// дамжуулах/decode хийхээс зайлсхийнэ.
let imgCache = null; // { id, bitmap }

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: chrome.runtime.getURL("worker.min.js"),
        corePath: chrome.runtime.getURL("tesseract-core-simd.wasm.js"),
        workerBlobURL: false,
      });
      await worker.setParameters({
        tessedit_pageseg_mode: "6", // Single uniform block of text
        preserve_interword_spaces: "1",
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    idleTimer = null;
    try {
      const w = await p;
      await w.terminate();
    } catch (e) {
      /* хамаагүй */
    }
  }, WORKER_IDLE_MS);
}

// Бүх OCR даалгаврыг нэг дараалалд хийнэ — worker зэрэг хоёр job авахгүй
function enqueue(fn) {
  const run = jobChain.then(fn, fn);
  jobChain = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) return;

  if (request.type === "WARMUP") {
    getWorker()
      .then(() => {
        touchIdleTimer();
        sendResponse({ success: true });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === "CROP_AND_OCR") {
    enqueue(() => processCropAndOCR(request.data))
      .then((res) => sendResponse(Object.assign({ success: true }, res)))
      .catch((err) => {
        console.error("[MT] Offscreen OCR:", err);
        sendResponse({
          success: false,
          error: err.message,
          code: err.code || null,
        });
      });
    return true; // Мессежийн сувгийг нээлттэй хадгална
  }
});

// ---------- Зураг ----------
async function getBitmap({ imageId, dataUrl }) {
  if (imgCache && imgCache.id === imageId) return imgCache.bitmap;

  if (!dataUrl) {
    const err = new Error("Зураг кэшд байхгүй");
    err.code = "NEED_IMAGE"; // background дахин зурагтай явуулна
    throw err;
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  if (imgCache && imgCache.bitmap.close) imgCache.bitmap.close();
  imgCache = { id: imageId, bitmap };
  return bitmap;
}

// ---------- Гол урсгал ----------
async function processCropAndOCR(data) {
  const bitmap = await getBitmap(data);
  const worker = await getWorker();
  touchIdleTimer();

  if (data.mode === "region") {
    return await recognizeRegion(worker, bitmap, data);
  }
  return await recognizeWord(worker, bitmap, data);
}

async function recognizeWord(worker, bitmap, data) {
  const dpr = data.devicePixelRatio || 1;
  const cx = data.clickX * dpr;
  const cy = data.clickY * dpr;

  // 1) Текстийн мөрийн өндрийг OCR-гүйгээр хэмжинэ (~1мс).
  //    Үүнээс тайрах талбай, томруулалт хоёуланг нь гаргана.
  const metrics = estimateLine(bitmap, cx, cy, dpr);
  const lineH = metrics ? metrics.lineH : FALLBACK_LINE_CSS * dpr;

  const geom = {
    cx,
    cy,
    // Manhwa-гийн том үсэгт өргөн, манга-гийн жижиг үсэгт нарийн талбай
    wDev: clamp(CROP_W_LINES * lineH, CROP_W_MIN_CSS * dpr, CROP_W_MAX_CSS * dpr),
    hDev: clamp(CROP_H_LINES * lineH, CROP_H_MIN_CSS * dpr, CROP_H_MAX_CSS * dpr),
    // Аль хэдийн том үсгийг дэмий томруулахгүй — хурдан бас тод хэвээр
    scale: clamp(TARGET_LINE_PX / lineH, 1, 4),
    inkDark: metrics ? metrics.inkDark : null,
  };

  let rendered = renderCrop(bitmap, geom);
  let best = pickWord(await ocr(worker, rendered.canvas), rendered);

  // 2) Итгэл бага бол дэвсгэрийн polarity эсрэгээр эргүүлж дахин уншина
  //    (цайвар үсэг хар дэвсгэр дээр — SFX, шөнийн панел)
  if (!best || best.confidence < LOW_CONF) {
    const flipped = renderCrop(
      bitmap,
      Object.assign({}, geom, { inkDark: !rendered.inkDark })
    );
    const alt = pickWord(await ocr(worker, flipped.canvas), flipped);
    if (alt && (!best || alt.confidence > best.confidence)) {
      best = alt;
      rendered = flipped;
    }
  }

  if (!best) throw new Error("Текст олдсонгүй");

  // 3) Үг тайрах талбайн ирмэгт хүрсэн бол дутуу уншигдсан байх магадлалтай.
  //    Тухайн үгийн төв дээр төвлөрүүлж, 2 дахин өргөн талбайгаар дахин уншина.
  if (touchesSideEdge(best.bbox, rendered.canvas)) {
    const midX = (best.bbox.x0 + best.bbox.x1) / 2;
    const midY = (best.bbox.y0 + best.bbox.y1) / 2;
    const wider = renderCrop(bitmap, {
      cx: rendered.sx + (midX - PAD) / rendered.scale,
      cy: rendered.sy + (midY - PAD) / rendered.scale,
      wDev: Math.min(geom.wDev * 2, CROP_W_RETRY_MAX_CSS * dpr),
      hDev: geom.hDev,
      scale: geom.scale,
      inkDark: rendered.inkDark,
    });
    const full = pickWord(await ocr(worker, wider.canvas), wider);
    // Бүтэн үг нь тайрагдсанаасаа урт байх ёстой
    if (full && full.text.length >= best.text.length) best = full;
  }

  return {
    text: best.text,
    line: best.line,
    confidence: Math.round(best.confidence),
  };
}

async function recognizeRegion(worker, bitmap, data) {
  const r = data.rect;
  const dpr = data.devicePixelRatio || 1;

  const base = {
    cx: (r.left + r.width / 2) * dpr,
    cy: (r.top + r.height / 2) * dpr,
    wDev: r.width * dpr,
    hDev: r.height * dpr,
    maxPixels: MAX_REGION_PX,
  };

  const rendered = renderCrop(bitmap, Object.assign({}, base, { inkDark: null }));
  let text = cleanBlock((await ocr(worker, rendered.canvas)).data.text || "");

  if (!text) {
    const flipped = renderCrop(
      bitmap,
      Object.assign({}, base, { inkDark: !rendered.inkDark })
    );
    text = cleanBlock((await ocr(worker, flipped.canvas)).data.text || "");
  }

  if (!text) throw new Error("Текст олдсонгүй");
  return { text };
}

// hocr/tsv үүсгэхийг хаяснаар recognize мэдэгдэхүйц хурдан болно
function ocr(worker, canvas) {
  return worker.recognize(canvas, {}, { blocks: true, text: true });
}

function touchesSideEdge(bbox, canvas) {
  const m = 4;
  return bbox.x0 <= PAD + m || bbox.x1 >= canvas.width - PAD - m;
}

// ---------- Мөрийн өндөр хэмжих ----------
// OCR ажиллуулахгүйгээр, зөвхөн пикселийн мөрийн профайлаар текстийн
// мөрийн өндрийг олно. Ингэснээр манга/manhwa-г ялгаж тайрах хэмжээгээ тааруулна.
function estimateLine(bitmap, cx, cy, dpr) {
  const w = Math.min(Math.round(PROBE_W_CSS * dpr), bitmap.width);
  const h = Math.min(Math.round(PROBE_H_CSS * dpr), bitmap.height);
  if (w < 16 || h < 16) return null;

  const sx = clamp(Math.round(cx - w / 2), 0, bitmap.width - w);
  const sy = clamp(Math.round(cy - h / 2), 0, bitmap.height - h);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);

  const p = ctx.getImageData(0, 0, w, h).data;
  const total = w * h;
  const gray = new Uint8Array(total);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < total; i += 4, j++) {
    const g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
    gray[j] = g;
    hist[g]++;
  }

  const thr = otsu(hist, total);
  const px = clamp(Math.round(cx - sx), 0, w - 1);
  const py = clamp(Math.round(cy - sy), 0, h - 1);

  // Polarity-г дарсан цэгийн ойролцоох дэвсгэрээр тодорхойлно.
  // Глобал олонхоор шийдвэл цагаан бөмбөлөг + хар панель хамт орсон үед
  // буруу гардаг — manhwa дээр байнга тохиолддог.
  const inkDark = localBackground(gray, w, h, px, py) > thr;

  const isInk = (g) => (inkDark ? g <= thr : g > thr);

  // Бөмбөлгийн хэвтээ хүрээг олно. Хэмжих талбай бөмбөлгөөс гараад
  // хар зураг руу орвол бүх мөр "бэхтэй" болж мөрүүд салдаггүй.
  // Тиймээс бүтэн дүүрсэн багана = зураг гэж үзээд хилээ тогтооно.
  const colInk = new Uint32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) if (isInk(gray[y * w + x])) c++;
    colInk[x] = c;
  }
  const isWall = (x) => colInk[x] > h * 0.75;
  let xlo = px;
  let xhi = px;
  while (xlo > 0 && !isWall(xlo - 1)) xlo--;
  while (xhi < w - 1 && !isWall(xhi + 1)) xhi++;
  const bandW = xhi - xlo + 1;
  if (bandW < 24) return null;

  const rowInk = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const off = y * w;
    for (let x = xlo; x <= xhi; x++) if (isInk(gray[off + x])) c++;
    rowInk[y] = c;
  }

  // Зурагнаас ирэх тогтмол "суурь бэх"-ийг хасна (бөмбөлгийн ирмэг гэх мэт)
  const sorted = Array.from(rowInk).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length * 0.15)];

  const minInk = baseline + Math.max(2, bandW * 0.005);
  const maxInk = bandW * 0.85;
  const isTextRow = (y) => rowInk[y] >= minInk && rowInk[y] <= maxInk;

  // Бүх мөрийн зурвасыг олно
  const maxBand = Math.round(h * 0.4);
  const bands = [];
  let run = -1;
  for (let y = 0; y <= h; y++) {
    if (y < h && isTextRow(y)) {
      if (run < 0) run = y;
    } else if (run >= 0) {
      bands.push([run, y - 1]);
      run = -1;
    }
  }

  const plausible = bands.filter(
    (b) => b[1] - b[0] + 1 >= 6 && b[1] - b[0] + 1 <= maxBand
  );
  if (!plausible.length) return null;

  // Дарсан цэгийн мөр, эсвэл хамгийн ойрхон нь
  let hit = plausible.find((b) => py >= b[0] && py <= b[1]);
  if (!hit) {
    let bestD = Infinity;
    for (const b of plausible) {
      const d = py < b[0] ? b[0] - py : py - b[1];
      if (d < bestD) {
        bestD = d;
        hit = b;
      }
    }
    if (bestD > h * 0.25) return null;
  }

  // Хэрэв нэг зурвас руу хэд хэдэн мөр нийлсэн бол бусад мөрийн
  // медианаар орлуулна — нэг мөрийн алдаанд бүх зүйл унахгүй
  const heights = plausible.map((b) => b[1] - b[0] + 1).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  let lineH = hit[1] - hit[0] + 1;
  if (heights.length >= 3 && lineH > median * 1.8) lineH = median;

  if (lineH < 6 || lineH > maxBand) return null;

  return { lineH, inkDark };
}

// Дарсан цэгийн эргэн тойрны дэвсгэрийн медиан гэрэлтэлт
function localBackground(gray, w, h, px, py) {
  const rad = 12;
  const vals = [];
  for (let y = Math.max(0, py - rad); y <= Math.min(h - 1, py + rad); y++) {
    for (let x = Math.max(0, px - rad); x <= Math.min(w - 1, px + rad); x++) {
      vals.push(gray[y * w + x]);
    }
  }
  vals.sort((a, b) => a - b);
  // Дэвсгэр нь бэхнээс их талбай эзэлдэг тул 70-р хувиар авбал
  // үсэг дээр яг таарсан ч дэвсгэрийн өнгийг олно
  return vals[Math.floor(vals.length * 0.7)];
}

// ---------- Үг сонгох ----------
function pickWord(res, rendered) {
  const words = (res.data && res.data.words) || [];
  const { pointX, pointY } = rendered;

  const cands = [];
  for (const w of words) {
    const text = normalizeWord(w.text || "");
    if (!text) continue;
    if (typeof w.confidence === "number" && w.confidence < 25) continue;
    cands.push({
      text,
      confidence: typeof w.confidence === "number" ? w.confidence : 50,
      bbox: w.bbox,
      line: w.line && w.line.text ? cleanBlock(w.line.text) : null,
    });
  }
  if (!cands.length) return null;

  // 1) Дарсан цэг үгийн хүрээн дотор байвал шууд тэр үг
  const inside = cands.filter((c) => {
    const b = c.bbox;
    return (
      pointX >= b.x0 - 4 &&
      pointX <= b.x1 + 4 &&
      pointY >= b.y0 - 6 &&
      pointY <= b.y1 + 6
    );
  });
  if (inside.length) {
    return inside.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  }

  // 2) Дарсан мөр дээрх үгсээс хамгийн ойрыг
  const sameLine = cands.filter(
    (c) => pointY >= c.bbox.y0 - 4 && pointY <= c.bbox.y1 + 4
  );
  const pool = sameLine.length ? sameLine : cands;

  // 3) Босоо зайг 3 дахин их тооцно — буруу мөрийн үг авахаас сэргийлнэ
  let bestCand = null;
  let bestScore = Infinity;
  for (const c of pool) {
    const cxw = (c.bbox.x0 + c.bbox.x1) / 2;
    const cyw = (c.bbox.y0 + c.bbox.y1) / 2;
    const dx = Math.max(0, Math.abs(pointX - cxw) - (c.bbox.x1 - c.bbox.x0) / 2);
    const dy = Math.abs(pointY - cyw);
    const score = dx + dy * 3;
    if (score < bestScore) {
      bestScore = score;
      bestCand = c;
    }
  }
  return bestCand;
}

// OCR-ийн байнга гаргадаг андуурлыг залруулна
function normalizeWord(raw) {
  let w = raw
    .trim()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[|]/g, "I")
    .replace(/^[^A-Za-z0-9']+/, "")
    .replace(/[^A-Za-z0-9']+$/, "");

  if (!/[A-Za-z]/.test(w)) return "";

  const letters = (w.match(/[A-Za-z]/g) || []).length;
  const digits = (w.match(/[0-9]/g) || []).length;

  // Үсэгтэй хольсон цифр бараг үргэлж OCR-ийн андуурал (0->O, 1->I, 5->S, 8->B)
  if (digits > 0 && letters >= digits) {
    const caps = w === w.toUpperCase();
    w = w
      .replace(/0/g, caps ? "O" : "o")
      .replace(/1/g, caps ? "I" : "l")
      .replace(/5/g, caps ? "S" : "s")
      .replace(/8/g, caps ? "B" : "b");
  }

  if (w.length < 2 && !/^[AaIi]$/.test(w)) return "";
  return w;
}

function cleanBlock(text) {
  return text
    .replace(/-\n(?=[a-z])/g, "") // мөр таслах зураасыг залгана
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------- Зураг бэлтгэх ----------
// Тайрч, томруулж, Otsu-гийн адаптив threshold-оор хоёртын зураг болгоно.
function renderCrop(bitmap, opts) {
  const cropW = Math.max(8, Math.round(opts.wDev));
  const cropH = Math.max(8, Math.round(opts.hDev));

  const sx = clamp(
    Math.round(opts.cx - cropW / 2),
    0,
    Math.max(0, bitmap.width - cropW)
  );
  const sy = clamp(
    Math.round(opts.cy - cropH / 2),
    0,
    Math.max(0, bitmap.height - cropH)
  );

  const sw = Math.min(cropW, bitmap.width - sx);
  const sh = Math.min(cropH, bitmap.height - sy);

  let scale = opts.scale || 1;
  if (opts.maxPixels) {
    scale = Math.max(1, Math.min(scale, Math.sqrt(opts.maxPixels / (sw * sh))));
  }

  const outW = Math.round(sw * scale);
  const outH = Math.round(sh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = outW + PAD * 2;
  canvas.height = outH + PAD * 2;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, PAD, PAD, outW, outH);

  const inkDark = binarize(ctx, PAD, PAD, outW, outH, opts.inkDark);

  // Захын зайг дэвсгэр (цагаан) болгож үлдээнэ
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, PAD);
  ctx.fillRect(0, canvas.height - PAD, canvas.width, PAD);
  ctx.fillRect(0, 0, PAD, canvas.height);
  ctx.fillRect(canvas.width - PAD, 0, PAD, canvas.height);

  return {
    canvas,
    sx,
    sy,
    scale,
    inkDark,
    pointX: (opts.cx - sx) * scale + PAD,
    pointY: (opts.cy - sy) * scale + PAD,
  };
}

// inkDark: true = үсэг бараан, false = үсэг цайвар, null = өөрөө тааварла.
// Буцаах утга нь эцэст ашигласан polarity.
function binarize(ctx, x, y, w, h, inkDark) {
  const imgData = ctx.getImageData(x, y, w, h);
  const p = imgData.data;
  const total = w * h;

  const hist = new Uint32Array(256);
  const gray = new Uint8Array(total);

  for (let i = 0, j = 0; j < total; i += 4, j++) {
    const g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
    gray[j] = g;
    hist[g]++;
  }

  const thr = otsu(hist, total);

  let dark = 0;
  for (let g = 0; g <= thr; g++) dark += hist[g];

  // Тааварлах үед: бэх нь ихэвчлэн бага талбай эзэлдэг тул
  // "хар" тал олонх бол дэвсгэр нь хар байна гэсэн үг.
  const resolved = typeof inkDark === "boolean" ? inkDark : dark <= total / 2;
  const invert = !resolved; // Tesseract-д үсэг нь хар байх ёстой

  for (let i = 0, j = 0; j < total; i += 4, j++) {
    let v = gray[j] <= thr ? 0 : 255;
    if (invert) v = 255 - v;
    p[i] = p[i + 1] = p[i + 2] = v;
    p[i + 3] = 255;
  }

  ctx.putImageData(imgData, x, y);
  return resolved;
}

// Otsu — гистограмаас оновчтой threshold-ыг өөрөө тооцно
// (өмнөх 170 гэсэн тогтмол тооноос хамаагүй тогтвортой)
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 127;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const diff = sumB / wB - (sum - sumB) / wF;
    const variance = wB * wF * diff * diff;
    if (variance > best) {
      best = variance;
      thr = t;
    }
  }
  return thr;
}
