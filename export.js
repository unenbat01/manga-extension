const HISTORY_KEY = "mtHistory";

let snapshot = []; // Цэвэрлэхээс өмнөх өгөгдөл — буцаахад хэрэгтэй
let cleared = false;

document.getElementById("print").addEventListener("click", () => window.print());

// Хэвлэх цонх хаагдсаны дараа жагсаалтыг цэвэрлэнэ.
// Цуцалсан ч ажилладаг тул "Буцаах" товч гаргаж хамгаална.
window.addEventListener("afterprint", clearAfterExport);

render();

function readHistory() {
  return chrome.storage.local
    .get(HISTORY_KEY)
    .then((o) => o[HISTORY_KEY] || [])
    .catch(() => []);
}

// Давхардлыг арилгаж, тоог нь нэгтгэнэ
function dedupe(raw) {
  const byWord = new Map();
  for (const item of raw) {
    const w = (item && item.w ? item.w : "").trim();
    const t = (item && item.t ? item.t : "").trim();
    if (!w || !t) continue;

    const key = w.toLowerCase();
    const n = Number(item.n) > 0 ? Number(item.n) : 1;
    const prev = byWord.get(key);
    if (prev) prev.n += n;
    else byWord.set(key, { w, t, n });
  }
  return Array.from(byWord.values());
}

async function render() {
  snapshot = await readHistory();
  const list = dedupe(snapshot);

  // Цаасан дээр хайхад амар байхаар цагаан толгойн дарааллаар
  list.sort((a, b) => a.w.toLowerCase().localeCompare(b.w.toLowerCase(), "en"));

  const totalUses = list.reduce((sum, x) => sum + x.n, 0);
  document.getElementById("count").textContent =
    list.length + " үг · нийт " + totalUses + " удаа";
  document.getElementById("date").textContent = new Date().toLocaleDateString(
    "mn-MN",
    { year: "numeric", month: "long", day: "numeric" }
  );

  const content = document.getElementById("content");
  content.textContent = "";

  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Одоогоор орчуулсан үг байхгүй байна.";
    content.appendChild(p);
    return;
  }

  content.appendChild(buildTable(list));

  // Хэвлэх цонхыг шууд нээнэ — хэрэглэгч "Save as PDF"-ийг сонгоно
  setTimeout(() => window.print(), 300);
}

function buildTable(list) {
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  const cols = [
    ["#", "num"],
    ["Англи", "word"],
    ["Монгол", ""],
    ["Удаа", "times"],
  ];
  for (const [label, cls] of cols) {
    const th = document.createElement("th");
    th.className = cls;
    th.textContent = label;
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  list.forEach((item, i) => {
    const tr = document.createElement("tr");
    const cells = [
      [String(i + 1), "num"],
      [item.w, "word"],
      [item.t, ""],
      [String(item.n), "times"],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  return table;
}

// ---------- Экспортын дараах цэвэрлэгээ ----------
async function clearAfterExport() {
  if (cleared || !snapshot.length) return;
  cleared = true;

  await chrome.storage.local.set({ [HISTORY_KEY]: [] }).catch(() => {});
  showBanner(dedupe(snapshot).length);
}

function showBanner(wordCount) {
  const bar = document.getElementById("banner");
  bar.textContent = wordCount + " үг PDF-д гарсан тул жагсаалт цэвэрлэгдлээ. ";

  const undo = document.createElement("button");
  undo.textContent = "Буцаах";
  undo.addEventListener("click", restore);
  bar.appendChild(undo);

  bar.style.display = "block";
}

// Цэвэрлэсний дараа өөр табд орчуулсан үг байвал түүнийг устгахгүйгээр нэгтгэнэ
async function restore() {
  const current = await readHistory();
  const seen = new Set(current.map((x) => (x.w || "").toLowerCase()));
  const merged = current.concat(
    snapshot.filter((x) => x && x.w && !seen.has(x.w.toLowerCase()))
  );

  await chrome.storage.local.set({ [HISTORY_KEY]: merged }).catch(() => {});
  cleared = false;

  const bar = document.getElementById("banner");
  bar.textContent = "Жагсаалт сэргээгдлээ.";
}
