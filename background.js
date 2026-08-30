chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PROCESS_CLICK") {
    handleProcess(request, sender.tab.windowId)
      .then((res) => sendResponse({ success: true, data: res }))
      .catch((err) => {
        console.error("Background Error:", err);
        sendResponse({ success: false, error: err.message || "Олдсонгүй" });
      });
    return true;
  }
});

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run Tesseract OCR worker",
  });
}

async function handleProcess(data, windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });

  await ensureOffscreenDocument();

  const ocrResponse = await chrome.runtime.sendMessage({
    type: "CROP_AND_OCR",
    data: {
      dataUrl: dataUrl,
      clickX: data.clickX,
      clickY: data.clickY,
      devicePixelRatio: data.devicePixelRatio,
    },
  });

  if (!ocrResponse || !ocrResponse.success) {
    throw new Error(ocrResponse?.error || "Текст олдсонгүй");
  }

  const targetWord = ocrResponse.text;

  // Google Translate API
  const transUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=mn&dt=t&q=${encodeURIComponent(
    targetWord.toLowerCase()
  )}`;
  const transRes = await fetch(transUrl);
  const transData = await transRes.json();
  const translation = transData[0].map((x) => x[0]).join("");

  return { original: targetWord, translation };
}
