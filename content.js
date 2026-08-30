let autoHideTimer = null;

document.addEventListener("click", async (e) => {
  if (e.target.closest("#manga-translator-tooltip")) return;

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

  // 3 секундын дараа автоматаар нуух
  autoHideTimer = setTimeout(() => {
    el.style.display = "none";
  }, 2000);
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
  }, 3000);
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
