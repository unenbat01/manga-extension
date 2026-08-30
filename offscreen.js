chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CROP_AND_OCR") {
    processCropAndOCR(request.data)
      .then((res) => sendResponse({ success: true, ...res }))
      .catch((err) => {
        console.error("Offscreen OCR Error:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Мессежийн сувгийг нээлттэй хадгална
  }
});

async function processCropAndOCR({
  dataUrl,
  clickX,
  clickY,
  devicePixelRatio,
}) {
  const { croppedDataUrl, centerX, centerY } = await prepareCrop(
    dataUrl,
    clickX,
    clickY,
    devicePixelRatio
  );

  const worker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract-core-simd.wasm.js"),
    workerBlobURL: false,
  });

  await worker.setParameters({
    tessedit_pageseg_mode: "6", // Single block of text
  });

  const ret = await worker.recognize(croppedDataUrl);
  await worker.terminate();

  const words = ret.data.words || [];
  let matchedWord = "";
  let minDistance = Infinity;

  // Дарсан цэгт хамгийн ойр үгийг олох
  for (const w of words) {
    const clean = w.text.trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
    if (clean.length < 2) continue;

    const wordCenterX = (w.bbox.x0 + w.bbox.x1) / 2;
    const wordCenterY = (w.bbox.y0 + w.bbox.y1) / 2;

    const dist = Math.hypot(wordCenterX - centerX, wordCenterY - centerY);

    if (dist < minDistance) {
      minDistance = dist;
      matchedWord = clean;
    }
  }

  // Bounding box үүсээгүй тохиолдолд нийт танигдсан текстээс эхний боломжит үгийг авна
  if (!matchedWord && ret.data.text) {
    const fallbackWords = ret.data.text
      .replace(/[^a-zA-Z]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
    if (fallbackWords.length > 0) {
      matchedWord = fallbackWords[0];
    }
  }

  if (!matchedWord) {
    throw new Error("Текст олдсонгүй");
  }

  return { text: matchedWord };
}

function prepareCrop(dataUrl, clickX, clickY, devicePixelRatio) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dpr = devicePixelRatio || window.devicePixelRatio || 1;

      const cropW = 280 * dpr;
      const cropH = 140 * dpr;

      const realX = clickX * dpr;
      const realY = clickY * dpr;

      const sourceX = Math.max(0, realX - cropW / 2);
      const sourceY = Math.max(0, realY - cropH / 2);

      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sourceX, sourceY, cropW, cropH, 0, 0, cropW, cropH);

      // Контраст тодорч, текстийг цэвэрлэх
      const imgData = ctx.getImageData(0, 0, cropW, cropH);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const val = avg < 170 ? 0 : 255;
        data[i] = val;
        data[i + 1] = val;
        data[i + 2] = val;
      }
      ctx.putImageData(imgData, 0, 0);

      resolve({
        croppedDataUrl: canvas.toDataURL("image/png"),
        centerX: cropW / 2,
        centerY: cropH / 2,
      });
    };
    img.onerror = () => reject(new Error("Зураг уншихад алдаа гарлаа"));
    img.src = dataUrl;
  });
}
