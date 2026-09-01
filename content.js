const HIDE_DELAY_MS = 3000; // Хариу гарснаас хойш өөрөө алга болох хугацаа
const SCROLL_HIDE_PX = 60; // Ийм зайд гүйлгэхэд popover алга болно
const SETTINGS_KEY = "mtSettings";

const state = {
  enabled: true,
  altOnly: false, // Зөвхөн Alt+click дарахад ажиллах
  collapsed: false,
  reqId: 0, // Хоцорсон хариуг үл хэрэгсэхэд
  hideTimer: null,
  warmedUp: false,
};

let dragStart = null;
let dragBox = null;
let scrollAnchor = null; // { win, els } — popover гарах үеийн гүйлгэлтийн байрлал

init();

async function init() {
  const stored = await chrome.storage.local
    .get(SETTINGS_KEY)
    .then((o) => o[SETTINGS_KEY])
    .catch(() => null);
  if (stored) Object.assign(state, stored);

  injectTopBoxUI();

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
}

function saveSettings() {
  chrome.storage.local
    .set({
      [SETTINGS_KEY]: {
        enabled: state.enabled,
        altOnly: state.altOnly,
        collapsed: state.collapsed,
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
      el.closest("#manga-translator-topbox"))
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
  if (isOurUI(e.target)) return;

  if (state.enabled && e.shiftKey && e.button === 0) {
    dragStart = { x: e.clientX, y: e.clientY };
    e.preventDefault();
    return;
  }

  warmUpOnce();

  // click болтол background скриншотоо аваад бэлэн болгоно
  if (shouldHandle(e) && !wordFromDom(e.clientX, e.clientY)) {
    chrome.runtime
      .sendMessage({ action: "PRECAPTURE", stateKey: stateKey() })
      .catch(() => {});
  }
}

function onMouseMove(e) {
  warmUpOnce();
  if (!dragStart) return;
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
  if (!dragStart) return;
  const r = rectOf(dragStart, { x: e.clientX, y: e.clientY });
  dragStart = null;
  if (dragBox) {
    dragBox.remove();
    dragBox = null;
  }
  if (r.width < 12 || r.height < 8) return;

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
      <span class="mt-title">Орчуулагч</span>
      <span class="mt-head-btns">
        <button id="mt-power" title="Товшиж орчуулахыг сэлгэх">⏻</button>
        <button id="mt-collapse" title="Хумих">–</button>
      </span>
    </div>
    <div id="mt-body">
      <textarea id="mt-text-input" placeholder="Англи текст эсвэл өгүүлбэр бичих..."></textarea>
      <div class="mt-topbox-row">
        <label class="mt-check">
          <input type="checkbox" id="mt-alt-only" /> Alt+click
        </label>
        <button id="mt-translate-btn">Орчуулах</button>
      </div>
      <div id="mt-text-result" style="display: none;"></div>
      <div class="mt-hint">Shift+чирэх = бүтэн бөмбөлөг</div>
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

  altOnly.checked = state.altOnly;
  altOnly.addEventListener("change", () => {
    state.altOnly = altOnly.checked;
    saveSettings();
  });

  const applyCollapsed = () => {
    body.style.display = state.collapsed ? "none" : "block";
    collapse.innerText = state.collapsed ? "+" : "–";
  };
  applyCollapsed();
  collapse.addEventListener("click", () => {
    state.collapsed = !state.collapsed;
    applyCollapsed();
    saveSettings();
  });

  const translate = () => {
    const text = input.value.trim();
    if (!text) return;

    btn.innerText = "Уншиж байна...";
    btn.disabled = true;

    chrome.runtime.sendMessage({ action: "TRANSLATE_TEXT", text }, (res) => {
      btn.innerText = "Орчуулах";
      btn.disabled = false;
      resultDiv.style.display = "block";
      resultDiv.textContent =
        res && res.success
          ? res.data.translation
          : "Орчуулахад алдаа гарлаа" +
            (res && res.error ? ": " + res.error : "");
    });
  };

  btn.addEventListener("click", translate);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      translate();
    }
  });
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
