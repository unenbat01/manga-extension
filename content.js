const HIDE_DELAY_MS = 3000; // Хариу гарснаас хойш өөрөө алга болох хугацаа
const SCROLL_HIDE_PX = 60; // Ийм зайд гүйлгэхэд popover алга болно
const SETTINGS_KEY = "mtSettings";
const HISTORY_KEY = "mtHistory";
const DRAG_THRESHOLD = 8; // Ийм зайд хөдөлбөл чирэлт гэж үзнэ
const HISTORY_MAX_WORDS = 4; // Түүхэд хэдэн үгтэй хүртэл хэллэг оруулах
const HISTORY_MAX = 500; // Хадгалах үгийн дээд тоо (PDF-д бүгд орно)

const state = {
  enabled: true,
  altOnly: false, // Зөвхөн Alt+click дарахад ажиллах
  dragSelect: false, // Shift-гүйгээр зүгээр чирэхэд хэсэг сонгох
  collapsed: false,
  histCollapsed: false,
  panels: {}, // { topbox|history: { left, top, width, height } }
  reqId: 0, // Хоцорсон хариуг үл хэрэгсэхэд
  hideTimer: null,
  warmedUp: false,
};

let dragStart = null;
let dragBox = null;
let pendingDrag = null; // Дарсан ч хараахан хөдлөөгүй байгаа цэг
let suppressClick = false; // Чирсний дараах click-ийг үл тоох
let scrollAnchor = null; // { win, els } — popover гарах үеийн гүйлгэлтийн байрлал
let history = []; // [{ w, t }] — сүүлд орчуулсан үгс

init();

async function init() {
  const stored = await chrome.storage.local
    .get(SETTINGS_KEY)
    .then((o) => o[SETTINGS_KEY])
    .catch(() => null);
  if (stored) Object.assign(state, stored);

  history = await chrome.storage.local
    .get(HISTORY_KEY)
    .then((o) => o[HISTORY_KEY] || [])
    .catch(() => []);

  injectTopBoxUI();
  injectHistoryUI();

  // Өөр таб дээр орчуулсан үг энд ч шинэчлэгдэнэ
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[HISTORY_KEY]) return;
    history = changes[HISTORY_KEY].newValue || [];
    renderHistory();
  });

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClick);
  // capture: true — хуудасны дотоод гүйлгэдэг блокуудыг ч барина
  document.addEventListener("scroll", onAnyScroll, {
    passive: true,
    capture: true,
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTooltip();
  });
  window.addEventListener("resize", clampPanels);
  document.addEventListener("pointerdown", onPanelPointerDown, true);
  // Зураг дээр чирэхэд хөтчийн drag-and-drop эхлэхээс сэргийлнэ
  document.addEventListener(
    "dragstart",
    (e) => {
      if (dragStart || pendingDrag) e.preventDefault();
    },
    true
  );
}

function saveSettings() {
  chrome.storage.local
    .set({
      [SETTINGS_KEY]: {
        enabled: state.enabled,
        altOnly: state.altOnly,
        dragSelect: state.dragSelect,
        collapsed: state.collapsed,
        histCollapsed: state.histCollapsed,
        panels: state.panels,
      },
    })
    .catch(() => {});
}

// Скриншотын кэшийн түлхүүр — скролл/хэмжээ өөрчлөгдвөл шинээр авна
function stateKey() {
  return [
    location.href,
    Math.round(window.scrollX),
    Math.round(window.scrollY),
    window.innerWidth,
    window.innerHeight,
  ].join("|");
}

function isOurUI(el) {
  return !!(
    el &&
    el.closest &&
    (el.closest("#manga-translator-tooltip") ||
      el.closest("#manga-translator-topbox") ||
      el.closest("#manga-translator-history"))
  );
}

// Линк, товч, талбар дарахад OCR ажиллуулахгүй — хуудас хэвийн ажиллана
function isInteractive(el) {
  return !!(
    el &&
    el.closest &&
    el.closest(
      "a, button, input, select, textarea, label, summary, [contenteditable], [role='button'], [role='link']"
    )
  );
}

function shouldHandle(e) {
  if (!state.enabled) return false;
  if (isOurUI(e.target)) return false;
  if (e.detail === 0) return false; // клавиатураар өдөөгдсөн
  if (e.shiftKey) return false; // Shift = хэсэг сонголт, товшилт биш
  if (state.altOnly && !e.altKey) return false;
  if (!e.altKey && isInteractive(e.target)) return false;
  return true;
}

// ---------- Хэсэг сонголт (Shift + чирэх) ----------
function onMouseDown(e) {
  if (isOurUI(e.target) || e.button !== 0) return;

  warmUpOnce();

  // Shift+чирэх — үргэлж ажиллана, шууд эхэлнэ
  if (state.enabled && e.shiftKey) {
    dragStart = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }

  // "Чирж сонгох" горим: одоохондоо зөвхөн цэгийг тэмдэглэнэ.
  // Хулгана DRAG_THRESHOLD-оос хол хөдөлж байж хайрцаг гарна —
  // ингэснээр энгийн товшилт хэвээрээ нэг үг орчуулна.
  if (state.dragSelect && state.enabled && !isInteractive(e.target)) {
    pendingDrag = { x: e.clientX, y: e.clientY };
  }

  // click болтол background скриншотоо аваад бэлэн болгоно
  if (shouldHandle(e) && !wordFromDom(e.clientX, e.clientY)) {
    chrome.runtime
      .sendMessage({ action: "PRECAPTURE", stateKey: stateKey() })
      .catch(() => {});
  }
}

function onMouseMove(e) {
  warmUpOnce();

  // Хангалттай хол хөдөлсөн бол товшилтоос чирэлт рүү шилжинэ
  if (pendingDrag && !dragStart) {
    const dx = e.clientX - pendingDrag.x;
    const dy = e.clientY - pendingDrag.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragStart = pendingDrag;
    pendingDrag = null;
  }

  if (!dragStart) return;
  e.preventDefault(); // хуудасны текст сонгогдохгүй
  document.body.classList.add("mt-dragging");

  if (!dragBox) {
    dragBox = document.createElement("div");
    dragBox.id = "manga-translator-dragbox";
    document.body.appendChild(dragBox);
  }
  const r = rectOf(dragStart, { x: e.clientX, y: e.clientY });
  dragBox.style.left = r.left + "px";
  dragBox.style.top = r.top + "px";
  dragBox.style.width = r.width + "px";
  dragBox.style.height = r.height + "px";
}

function onMouseUp(e) {
  pendingDrag = null;
  document.body.classList.remove("mt-dragging");

  if (!dragStart) return;
  const r = rectOf(dragStart, { x: e.clientX, y: e.clientY });
  dragStart = null;
  if (dragBox) {
    dragBox.remove();
    dragBox = null;
  }
  // Хэт жижиг бол товшилт гэж үзээд ердийн замаар явуулна
  if (r.width < 12 || r.height < 8) return;

  suppressClick = true;

  const reqId = ++state.reqId;
  showLoadingTooltip(r.left, r.top + r.height);

  chrome.runtime.sendMessage(
    {
      action: "PROCESS_REGION",
      rect: r,
      devicePixelRatio: window.devicePixelRatio,
      stateKey: stateKey(),
    },
    (response) => onResponse(reqId, response, r.left, r.top + r.height)
  );
}

function rectOf(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

// ---------- Товших ----------
function onClick(e) {
  if (suppressClick) {
    suppressClick = false; // Чирсний дараах click — үг орчуулахгүй
    return;
  }
  if (!shouldHandle(e)) return;

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) return;

  const x = e.clientX;
  const y = e.clientY;
  const reqId = ++state.reqId;

  showLoadingTooltip(x, y);

  // Хуудсан дээр жинхэнэ текст байвал OCR хэрэггүй — шууд орчуулна
  const dom = wordFromDom(x, y);
  const message = dom
    ? { action: "TRANSLATE_WORD", word: dom.word, context: dom.context }
    : {
        action: "PROCESS_CLICK",
        clickX: x,
        clickY: y,
        devicePixelRatio: window.devicePixelRatio,
        stateKey: stateKey(),
      };

  chrome.runtime.sendMessage(message, (response) =>
    onResponse(reqId, response, x, y)
  );
}

function onResponse(reqId, response, x, y) {
  if (reqId !== state.reqId) return; // хоцорсон хариу
  if (chrome.runtime.lastError) {
    showErrorTooltip("Extension-ыг дахин ачаална уу", x, y);
    return;
  }
  if (response && response.success) {
    showResultTooltip(response.data, x, y);
  } else {
    showErrorTooltip((response && response.error) || "Олдсонгүй", x, y);
  }
}

// Tesseract worker-ыг эхний хөдөлгөөнд урьдчилан ачаална (эхний click хурдан болно)
function warmUpOnce() {
  if (state.warmedUp || !state.enabled) return;
  state.warmedUp = true;
  const fire = () =>
    chrome.runtime.sendMessage({ action: "WARMUP" }).catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(fire, { timeout: 2000 });
  else setTimeout(fire, 500);
}

// ---------- DOM-оос үг унших ----------
function wordFromDom(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  if (!range) return null;

  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent || "";
  const isWordChar = (c) => !!c && /[A-Za-z'’-]/.test(c);

  let i = range.startOffset;
  if (!isWordChar(text[i]) && !isWordChar(text[i - 1])) return null;

  let s = i;
  let e = i;
  while (s > 0 && isWordChar(text[s - 1])) s--;
  while (e < text.length && isWordChar(text[e])) e++;

  const word = text.slice(s, e).replace(/^['’-]+|['’-]+$/g, "");
  if (!/^[A-Za-z][A-Za-z'’-]*$/.test(word)) return null;

  // caretRangeFromPoint хамгийн ойрын үсэг руу "татдаг" тул
  // дарсан цэг үнэхээр үгийн хүрээнд байгааг шалгана
  const probe = document.createRange();
  probe.setStart(node, s);
  probe.setEnd(node, e);
  const inside = Array.from(probe.getClientRects()).some(
    (r) =>
      x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2
  );
  if (!inside) return null;

  return { word, context: sentenceAround(text, s, e) };
}

function sentenceAround(text, s, e) {
  let start = 0;
  for (let i = s - 1; i >= 0; i--) {
    if (/[.!?…]/.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = e; i < text.length; i++) {
    if (/[.!?…]/.test(text[i])) {
      end = i + 1;
      break;
    }
  }
  const sentence = text.slice(start, end).replace(/\s+/g, " ").trim();
  return sentence.length > 300 ? null : sentence;
}

// ---------- Зүүн дээд UI ----------
function injectTopBoxUI() {
  if (document.getElementById("manga-translator-topbox")) return;

  const box = document.createElement("div");
  box.id = "manga-translator-topbox";
  box.innerHTML = `
    <div class="mt-head">
      <span class="mt-title"><span class="mt-grip">⠿</span> Орчуулагч</span>
      <span class="mt-head-btns">
        <button class="mt-corner" title="Булан солих (↖ ↗ ↘ ↙)">↖</button>
        <button id="mt-power" title="Товшиж орчуулахыг сэлгэх">⏻</button>
        <button id="mt-collapse" title="Хумих">–</button>
      </span>
    </div>
    <div id="mt-body">
      <textarea id="mt-text-input" placeholder="Англи текст эсвэл өгүүлбэр бичих..."></textarea>
      <div class="mt-opts">
        <label class="mt-check">
          <input type="checkbox" id="mt-alt-only" /> Alt+click
        </label>
        <label class="mt-check">
          <input type="checkbox" id="mt-drag-select" /> Чирж сонгох
        </label>
      </div>
      <div class="mt-topbox-row">
        <button id="mt-translate-btn">Орчуулах</button>
      </div>
      <div id="mt-text-result" style="display: none;"></div>
      <div class="mt-hint" id="mt-hint"></div>
    </div>
  `;
  document.body.appendChild(box);

  const btn = box.querySelector("#mt-translate-btn");
  const input = box.querySelector("#mt-text-input");
  const resultDiv = box.querySelector("#mt-text-result");
  const altOnly = box.querySelector("#mt-alt-only");
  const collapse = box.querySelector("#mt-collapse");
  const power = box.querySelector("#mt-power");
  const body = box.querySelector("#mt-body");

  const applyEnabled = () => {
    power.classList.toggle("mt-off", !state.enabled);
    power.title = state.enabled
      ? "Товшиж орчуулах: ON"
      : "Товшиж орчуулах: OFF";
  };
  applyEnabled();
  power.addEventListener("click", () => {
    state.enabled = !state.enabled;
    applyEnabled();
    if (!state.enabled) hideTooltip();
    saveSettings();
  });

  makePanelInteractive(box, "topbox");

  altOnly.checked = state.altOnly;
  altOnly.addEventListener("change", () => {
    state.altOnly = altOnly.checked;
    saveSettings();
  });

  const dragSel = box.querySelector("#mt-drag-select");
  const hint = box.querySelector("#mt-hint");
  const applyHint = () => {
    hint.textContent = state.dragSelect
      ? "Чирэх = хэсэг сонгох · товших = нэг үг"
      : "Shift+чирэх = хэсэг сонгох";
  };
  dragSel.checked = state.dragSelect;
  applyHint();
  dragSel.addEventListener("change", () => {
    state.dragSelect = dragSel.checked;
    applyHint();
    saveSettings();
  });

  const applyCollapsed = () => {
    body.style.display = state.collapsed ? "none" : "flex";
    collapse.innerText = state.collapsed ? "+" : "–";
    // Хумсан үед тогтоосон өндөр хоосон хайрцаг үлдээхээс сэргийлнэ
    const saved = state.panels.topbox;
    box.style.height =
      state.collapsed || !saved || !saved.height ? "" : saved.height + "px";
  };
  applyCollapsed();
  collapse.addEventListener("click", () => {
    state.collapsed = !state.collapsed;
    applyCollapsed();
    saveSettings();
  });

  let lastTranslated = null; // Одоо үр дүн нь харагдаж буй текст

  const translate = () => {
    const text = input.value.trim();
    if (!text) return;

    btn.innerText = "Уншиж байна...";
    btn.disabled = true;

    chrome.runtime.sendMessage({ action: "TRANSLATE_TEXT", text }, (res) => {
      btn.innerText = "Орчуулах";
      btn.disabled = false;
      resultDiv.style.display = "block";
      if (res && res.success) {
        resultDiv.textContent = res.data.translation;
        lastTranslated = text;
        addHistory(text, res.data.translation);
      } else {
        resultDiv.textContent =
          "Орчуулахад алдаа гарлаа" + (res && res.error ? ": " + res.error : "");
        lastTranslated = null;
      }
    });
  };

  // Талбар дээр дарахад өмнө орчуулсан үгийг цэвэрлэнэ.
  // Хараахан орчуулаагүй бичиж байсан текстийг арилгахгүй.
  input.addEventListener("focus", () => {
    if (lastTranslated !== null && input.value.trim() === lastTranslated) {
      input.value = "";
      resultDiv.style.display = "none";
      resultDiv.textContent = "";
      lastTranslated = null;
    }
  });

  btn.addEventListener("click", translate);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      translate();
    }
  });
}

// ---------- Самбарыг чирж зөөх, хэмжээг нь хадгалах ----------
function panelState(key) {
  if (!state.panels[key]) state.panels[key] = {};
  return state.panels[key];
}

function applyPanelLayout(box, key) {
  const p = state.panels[key];
  if (!p) return;
  if (p.left != null) {
    box.style.left = p.left + "px";
    box.style.right = "auto";
  }
  if (p.top != null) box.style.top = p.top + "px";
  if (p.width) box.style.width = p.width + "px";
  if (p.height) box.style.height = p.height + "px";
  box.classList.toggle("mt-sized", !!p.height);
}

function savePanelPos(box, key) {
  const r = box.getBoundingClientRect();
  const p = panelState(key);
  p.left = Math.round(r.left);
  p.top = Math.round(r.top);
  saveSettings();
}

// Зөвхөн хэрэглэгч өөрөө чирж томруулсан үед л (inline хэмжээ) хадгална.
// Эс тэгвээс агуулгаас хамаарсан өндөр түгжигдэж, жагсаалт өсөхөө болино.
function savePanelSize(box, key) {
  const p = panelState(key);
  let changed = false;
  if (box.style.width) {
    p.width = parseInt(box.style.width, 10);
    changed = true;
  }
  if (box.style.height) {
    p.height = parseInt(box.style.height, 10);
    box.classList.add("mt-sized");
    changed = true;
  }
  if (changed) saveSettings();
}

// Аль толгой аль самбарынх болохыг бүртгэнэ
const dragPanels = new Map(); // head -> { box, key }

const CORNERS = [
  { icon: "↖", left: true, top: true },
  { icon: "↗", left: false, top: true },
  { icon: "↘", left: false, top: false },
  { icon: "↙", left: true, top: false },
];
const CORNER_MARGIN = 16;

function snapToCorner(box, key, idx) {
  const c = CORNERS[idx];
  const left = c.left
    ? CORNER_MARGIN
    : window.innerWidth - box.offsetWidth - CORNER_MARGIN;
  const top = c.top
    ? CORNER_MARGIN
    : window.innerHeight - box.offsetHeight - CORNER_MARGIN;

  box.style.right = "auto";
  setViewportPos(box, Math.max(0, left), Math.max(0, top));
  panelState(key).corner = idx;
  savePanelPos(box, key);
}

// <body> дээр transform байвал fixed элементийн эх цэг шилждэг.
// Тиймээс style.left-ийг харагдах байрлалтай нь тааруулж залруулна.
function setViewportPos(box, viewLeft, viewTop) {
  box.style.left = Math.round(viewLeft) + "px";
  box.style.top = Math.round(viewTop) + "px";
  const r = box.getBoundingClientRect();
  const dx = r.left - viewLeft;
  const dy = r.top - viewTop;
  if (dx || dy) {
    box.style.left = Math.round(viewLeft - dx) + "px";
    box.style.top = Math.round(viewTop - dy) + "px";
  }
}

function makePanelInteractive(box, key) {
  applyPanelLayout(box, key);

  const head = box.querySelector(".mt-head");
  dragPanels.set(head, { box, key });

  const corner = box.querySelector(".mt-corner");
  if (corner) {
    const p = state.panels[key] || {};
    let idx = typeof p.corner === "number" ? p.corner : 0;
    corner.innerText = CORNERS[idx].icon;
    corner.addEventListener("click", () => {
      idx = (idx + 1) % CORNERS.length;
      corner.innerText = CORNERS[idx].icon;
      snapToCorner(box, key, idx);
    });
  }

  // Булангаас татаж хэмжээ өөрчлөхийг ажиглана
  if (window.ResizeObserver) {
    let t = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => savePanelSize(box, key), 400);
    });
    ro.observe(box);
  }

  // Толгой дээр давхар дарвал анхны байрлал/хэмжээ рүү буцаана
  head.addEventListener("dblclick", () => {
    delete state.panels[key];
    box.style.left = "";
    box.style.top = "";
    box.style.right = "";
    box.style.width = "";
    box.style.height = "";
    box.classList.remove("mt-sized");
    saveSettings();
  });
}

// Чирэлтийг document дээр capture фазаар барина. Зарим manhwa reader
// pointerdown-ыг өөртөө барьж stopPropagation хийдэг тул элемент дээрх
// listener хүртэл хүрэхгүй байх магадлалтай.
function onPanelPointerDown(e) {
  if (e.button !== 0 || !e.target || !e.target.closest) return;

  const head = e.target.closest(".mt-head");
  if (!head || !dragPanels.has(head)) return;
  if (e.target.closest("button")) return;

  const { box, key } = dragPanels.get(head);

  e.preventDefault();
  e.stopPropagation();

  const r = box.getBoundingClientRect();
  const offX = e.clientX - r.left;
  const offY = e.clientY - r.top;
  box.style.right = "auto";

  const move = (ev) => {
    const left = Math.min(
      Math.max(0, ev.clientX - offX),
      Math.max(0, window.innerWidth - box.offsetWidth)
    );
    const top = Math.min(
      Math.max(0, ev.clientY - offY),
      Math.max(0, window.innerHeight - box.offsetHeight)
    );
    setViewportPos(box, left, top);
  };

  const up = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    document.body.classList.remove("mt-dragging");
    savePanelPos(box, key);
  };

  document.body.classList.add("mt-dragging");
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

function clampPanels() {
  for (const id of ["manga-translator-topbox", "manga-translator-history"]) {
    const box = document.getElementById(id);
    if (!box || !box.style.left) continue;
    const left = parseInt(box.style.left, 10) || 0;
    const top = parseInt(box.style.top, 10) || 0;
    setViewportPos(
      box,
      Math.min(Math.max(0, left), Math.max(0, window.innerWidth - box.offsetWidth)),
      Math.min(Math.max(0, top), Math.max(0, window.innerHeight - box.offsetHeight))
    );
  }
}

// ---------- Баруун дээд булан: сүүлд орчуулсан үгс ----------
function injectHistoryUI() {
  if (document.getElementById("manga-translator-history")) return;

  const box = document.createElement("div");
  box.id = "manga-translator-history";
  box.innerHTML = `
    <div class="mt-head">
      <span class="mt-title"><span class="mt-grip">⠿</span> Орчуулсан үгс <span id="mt-hist-count"></span></span>
      <span class="mt-head-btns">
        <button class="mt-corner" title="Булан солих (↖ ↗ ↘ ↙)">↗</button>
        <button id="mt-hist-pdf" title="Бүх үгийг PDF болгож татах">⤓</button>
        <button id="mt-hist-clear" title="Цэвэрлэх">✕</button>
        <button id="mt-hist-collapse" title="Хумих">–</button>
      </span>
    </div>
    <div id="mt-hist-list"></div>
  `;
  document.body.appendChild(box);

  const collapse = box.querySelector("#mt-hist-collapse");
  const list = box.querySelector("#mt-hist-list");

  makePanelInteractive(box, "history");

  const applyCollapsed = () => {
    list.style.display = state.histCollapsed ? "none" : "block";
    collapse.innerText = state.histCollapsed ? "+" : "–";
    const saved = state.panels.history;
    box.style.height =
      state.histCollapsed || !saved || !saved.height ? "" : saved.height + "px";
  };
  applyCollapsed();
  collapse.addEventListener("click", () => {
    state.histCollapsed = !state.histCollapsed;
    applyCollapsed();
    saveSettings();
  });

  box.querySelector("#mt-hist-pdf").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "OPEN_EXPORT" }).catch(() => {});
  });

  box.querySelector("#mt-hist-clear").addEventListener("click", () => {
    history = [];
    renderHistory();
    chrome.storage.local.set({ [HISTORY_KEY]: history }).catch(() => {});
  });

  renderHistory();
}

// Зөвхөн ганц үгийг бүртгэнэ — өгүүлбэр, бөмбөлгийн орчуулга жагсаалтад орохгүй
function addHistory(word, translation) {
  const w = (word || "").trim();
  const t = (translation || "").trim();
  if (!w || !t) return;
  // Ганц үг эсвэл богино хэллэг л жагсаалтад орно (бүтэн өгүүлбэр орохгүй)
  if (w.split(/\s+/).length > HISTORY_MAX_WORDS) return;

  // Давхардвал устгахгүй — хэдэн удаа хайснаа тоолж, дээш нь гаргана
  const key = w.toLowerCase();
  const idx = history.findIndex((h) => h.w.toLowerCase() === key);
  let n = 1;
  if (idx >= 0) {
    n = (history[idx].n || 1) + 1;
    history.splice(idx, 1);
  }
  history.unshift({ w, t, n });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;

  renderHistory();
  chrome.storage.local.set({ [HISTORY_KEY]: history }).catch(() => {});
}

function renderHistory() {
  const counter = document.getElementById("mt-hist-count");
  if (counter) counter.textContent = history.length ? "(" + history.length + ")" : "";

  const list = document.getElementById("mt-hist-list");
  if (!list) return;
  list.innerHTML = "";

  if (!history.length) {
    list.appendChild(div("mt-hist-empty", "Үг дарж орчуулаарай"));
    return;
  }

  for (const h of history) {
    const item = div("mt-hist-item", "");
    const word = div("mt-hist-w", h.w);
    if (h.n > 1) word.appendChild(div("mt-hist-n", "×" + h.n));
    item.appendChild(word);
    item.appendChild(div("mt-hist-t", h.t));
    list.appendChild(item);
  }
}

// ---------- Tooltip ----------
function resetTimer() {
  if (state.hideTimer) {
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
  }
}

function getOrCreateTooltip() {
  let el = document.getElementById("manga-translator-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "manga-translator-tooltip";
    document.body.appendChild(el);
    el.addEventListener("mouseenter", resetTimer);
    el.addEventListener("mouseleave", () => scheduleHide(1200));
  }
  return el;
}

function placeTooltip(el, x, y) {
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, x + 12), window.innerWidth - r.width - 8);
  const top =
    y + 12 + r.height > window.innerHeight - 8
      ? Math.max(8, y - r.height - 12)
      : y + 12;
  el.style.left = left + "px";
  el.style.top = top + "px";
}

// Popover гарах үеийн гүйлгэлтийн байрлалыг тэмдэглэнэ
function armScrollHide() {
  scrollAnchor = { win: window.scrollY, els: new Map() };
}

function onAnyScroll(e) {
  if (!scrollAnchor) return;

  let moved = Math.abs(window.scrollY - scrollAnchor.win);

  // Дотоод гүйлгэдэг элемент бол window.scrollY өөрчлөгддөггүй
  const t = e.target;
  if (t && t.nodeType === 1) {
    if (!scrollAnchor.els.has(t)) scrollAnchor.els.set(t, t.scrollTop);
    moved = Math.max(moved, Math.abs(t.scrollTop - scrollAnchor.els.get(t)));
  }

  if (moved > SCROLL_HIDE_PX) hideTooltip();
}

function scheduleHide(ms) {
  resetTimer();
  state.hideTimer = setTimeout(hideTooltip, ms);
}

function hideTooltip() {
  resetTimer();
  scrollAnchor = null;
  const el = document.getElementById("manga-translator-tooltip");
  if (el) el.style.display = "none";
}

function showLoadingTooltip(x, y) {
  resetTimer();
  const el = getOrCreateTooltip();
  el.innerHTML = '<div class="mt-loading">Уншиж байна...</div>';
  placeTooltip(el, x, y);
  armScrollHide();
}

function showResultTooltip(data, x, y) {
  resetTimer();
  const el = getOrCreateTooltip();
  el.innerHTML = "";

  el.appendChild(div("mt-word", data.original));
  el.appendChild(div("mt-divider", ""));
  el.appendChild(div("mt-trans", data.translation));

  if (data.alts && data.alts.length) {
    el.appendChild(div("mt-alts", data.alts.join(", ")));
  }

  if (data.contextTranslation && data.context) {
    const ctx = div("mt-context", "");
    ctx.appendChild(div("mt-context-en", data.context));
    ctx.appendChild(div("mt-context-mn", data.contextTranslation));
    el.appendChild(ctx);
  }

  placeTooltip(el, x, y);
  armScrollHide();
  scheduleHide(HIDE_DELAY_MS);
  addHistory(data.original, data.translation);
}

function showErrorTooltip(msg, x, y) {
  resetTimer();
  const el = getOrCreateTooltip();
  el.innerHTML = "";
  el.appendChild(div("mt-error", msg));
  placeTooltip(el, x, y);
  armScrollHide();
  scheduleHide(2500);
}

// textContent — OCR/орчуулгын текстээр HTML тарихаас сэргийлнэ
function div(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text) d.textContent = text;
  return d;
}
