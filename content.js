let autoHideTimer = null;

// Хуудас ачаалагдахад зүүн дээд UI-г үүсгэнэ
injectTopBoxUI();

document.addEventListener("click", async (e) => {
  // Дээд UI эсвэл Tooltip дээр дарахад OCR ажиллахгүй
  if (
    e.target.closest("#manga-translator-tooltip") ||
    e.target.closest("#manga-translator-topbox")
  )
    return;

  const clickX = e.clientX;
  const clickY = e.clientY;

  showLoadingTooltip(clickX, clickY);

  chrome.runtime.sendMessage(
    {
      action: "PROCESS_CLICK",
      clickX: clickX,
      clickY: clickY,
      devicePixelRatio: window.devicePixelRatio,
    },
    (response) => {
      if (response && response.success) {
        showResultTooltip(
          response.data.original,
          response.data.translation,
          clickX,
          clickY
        );
      } else {
        showErrorTooltip(response?.error || "Олдсонгүй", clickX, clickY);
      }
    }
  );
});

// Зүүн дээд буланд байрлах UI
function injectTopBoxUI() {
  if (document.getElementById("manga-translator-topbox")) return;

  const box = document.createElement("div");
  box.id = "manga-translator-topbox";
  box.innerHTML = `
    <textarea id="mt-text-input" placeholder="Англи текст эсвэл өгүүлбэр бичих..."></textarea>
    <div class="mt-topbox-row">
      <button id="mt-translate-btn">Орчуулах</button>
    </div>
    <div id="mt-text-result" style="display: none;"></div>
  `;
  document.body.appendChild(box);

  const btn = box.querySelector("#mt-translate-btn");
  const input = box.querySelector("#mt-text-input");
  const resultDiv = box.querySelector("#mt-text-result");

  btn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;

    btn.innerText = "Уншиж байна...";
    btn.disabled = true;

    chrome.runtime.sendMessage(
      { action: "TRANSLATE_TEXT", text: text },
      (res) => {
        btn.innerText = "Орчуулах";
        btn.disabled = false;
        if (res && res.success) {
          resultDiv.innerText = res.translation;
          resultDiv.style.display = "block";
        } else {
          resultDiv.innerText = "Орчуулахад алдаа гарлаа";
          resultDiv.style.display = "block";
        }
      }
    );
  });

  // Ctrl+Enter эсвэл Cmd+Enter дарахад шууд орчуулна
  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      btn.click();
    }
  });
}

function resetTimer() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

function showLoadingTooltip(x, y) {
  resetTimer();
  let el = getOrCreateTooltip();
  el.style.left = `${x + 12}px`;
  el.style.top = `${y + 12}px`;
  el.innerHTML = `<div class="mt-loading">Уншиж байна...</div>`;
  el.style.display = "block";
}

function showResultTooltip(original, translation, x, y) {
  resetTimer();
  let el = getOrCreateTooltip();
  el.style.left = `${x + 12}px`;
  el.style.top = `${y + 12}px`;

  el.innerHTML = `
    <div class="mt-word">${original}</div>
    <div class="mt-divider"></div>
    <div class="mt-trans">${translation}</div>
  `;
  el.style.display = "block";

  autoHideTimer = setTimeout(() => {
    el.style.display = "none";
  }, 1500);
}

function showErrorTooltip(msg, x, y) {
  resetTimer();
  let el = getOrCreateTooltip();
  el.style.left = `${x + 12}px`;
  el.style.top = `${y + 12}px`;
  el.innerHTML = `<div class="mt-error">${msg}</div>`;
  el.style.display = "block";

  autoHideTimer = setTimeout(() => {
    el.style.display = "none";
  }, 1500);
}

function getOrCreateTooltip() {
  let el = document.getElementById("manga-translator-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "manga-translator-tooltip";
    document.body.appendChild(el);
  }
  return el;
}
