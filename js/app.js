/* Счётчик хода для «Подземелья». Герои читаются с фото, в коде их нет. */
const PHASES = [
  ["recovery", "Восст."],
  ["villainy", "Злодеяния"],
  ["location", "Локации"],
  ["deeds", "Подвиги"],
  ["discard", "Сброс"],
];
const SETTINGS_KEY = "dungeoneer-settings";
const GAME_KEY = "dungeoneer-game";
const CARDS_KEY = "dungeoneer-cards";

const state = {
  screen: "home",
  back: "home",
  heroes: [],
  settings: null,
  game: null,
  history: [],
  draft: null,
  scan: { busy: false, error: "" },
  setup: null,
  modal: null,
  sheetId: null,
  menu: false,
  toast: "",
  confirm: null,
  die: null,
  reward: null,
  counter: null,
  crop: null,
  originalSrc: "",
};

const app = document.getElementById("app");
let dbPromise = null;
let workerPromise = null;
let toastTimer = 0;

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function uid() { return crypto.randomUUID(); }
function flash(text) {
  state.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ""; render(); }, 3200);
  render();
}
function go(screen) { state.screen = screen; render(true); }
function render(reset) {
  const y = reset ? 0 : (document.scrollingElement ? document.scrollingElement.scrollTop : 0);
  app.innerHTML = view() + toastHtml() + confirmHtml();
  if (document.scrollingElement) document.scrollingElement.scrollTop = y;
  bindCropper();
}

function loadSettings() {
  const d = { questsToWin: 3, maxLevel: 4, healthOnLevel: false, sets: 1, surfacePerSet: 17, dungeonPerSet: 0 };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {}; } catch (e) { saved = {}; }
  Object.assign(d, saved);
  if (saved.surfacePerSet == null && saved.startLocations != null) d.surfacePerSet = saved.startLocations;
  d.questsToWin = clamp(Number(d.questsToWin) || 3, 1, 12);
  d.maxLevel = clamp(Number(d.maxLevel) || 4, 4, 20);
  d.healthOnLevel = !!d.healthOnLevel;
  d.sets = clamp(Number(d.sets) || 1, 1, 2);
  d.surfacePerSet = clamp(Number(d.surfacePerSet) || 0, 0, 80);
  d.dungeonPerSet = clamp(Number(d.dungeonPerSet) || 0, 0, 80);
  return d;
}
function deckTotals(s) {
  return { surface: s.surfacePerSet * s.sets, dungeon: s.dungeonPerSet * s.sets };
}
function startingDecks(s) {
  const totals = deckTotals(s);
  return { surface: Math.max(0, totals.surface - 5), dungeon: totals.dungeon };
}
function planeLabel(id) { return id === "dungeon" ? "Подземелье" : "Поверхность"; }
function ensureDecks(g) {
  if (!g.decks) {
    const left = Number(g.locationsLeft);
    g.decks = { surface: Number.isFinite(left) ? Math.max(0, left) : deckTotals(state.settings).surface, dungeon: 0 };
  }
  g.decks.surface = Math.max(0, Number(g.decks.surface) || 0);
  g.decks.dungeon = Math.max(0, Number(g.decks.dungeon) || 0);
  g.plane = g.plane === "dungeon" ? "dungeon" : "surface";
  g.locationsLeft = g.decks.surface + g.decks.dungeon;
}
function drawLocation(g) {
  ensureDecks(g);
  if (g.decks[g.plane] <= 0) return false;
  g.decks[g.plane] -= 1;
  g.locationsLeft = g.decks.surface + g.decks.dungeon;
  return true;
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
function loadCardBook() {
  try {
    const list = JSON.parse(localStorage.getItem(CARDS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function savedCards(kind) {
  return loadCardBook().filter((c) => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function savedTypes() {
  return [...new Set(savedCards("treasure").map((c) => String(c.typeName || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"));
}
function refreshSuggest(input) {
  const box = input.parentElement && input.parentElement.querySelector(".suggest");
  if (!box || !state.modal) return;
  const q = String(input.value || "").trim().toLowerCase();
  let html = "";
  if (input.dataset.bind === "modal.name") {
    html = savedCards(state.modal.kind)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((c) => {
        const extra = cardBits(c).join(", ");
        return `<button type="button" data-act="pick-card" data-id="${esc(c.id)}"><b>${esc(c.name)}</b>${extra ? `<small>${esc(extra)}</small>` : ""}</button>`;
      }).join("");
  } else if (input.dataset.bind === "modal.typeName") {
    html = savedTypes()
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 8)
      .map((t) => `<button type="button" data-act="pick-type" data-type="${esc(t)}">${esc(t)}</button>`)
      .join("");
  }
  box.innerHTML = html;
  box.hidden = !html;
}
function rememberCard(card) {
  if (!card || (card.kind !== "boon" && card.kind !== "treasure")) return "";
  const name = String(card.name || "").trim();
  if (!name || name === "Эффект") return "";
  const book = loadCardBook();
  const key = card.kind + "\n" + name.toLowerCase();
  const prev = book.find((c) => c.kind + "\n" + String(c.name).toLowerCase() === key);
  const entry = {
    id: prev ? prev.id : uid(),
    name, kind: card.kind, typeName: String(card.typeName || "").trim(),
    until: card.until === "turn" ? "turn" : "permanent",
    melee: num(card.melee), magic: num(card.magic), speed: num(card.speed),
    heal: num(card.heal), healthMax: num(card.healthMax),
    boonLimit: num(card.boonLimit), treasureLimit: num(card.treasureLimit),
    cost: Math.max(0, num(card.cost)),
    special: card.special && String(card.special.text || "").trim()
      ? { stat: card.special.stat === "melee" ? "melee" : "magic", text: String(card.special.text).trim() }
      : null,
  };
  if (prev) Object.assign(prev, entry);
  else book.push(entry);
  localStorage.setItem(CARDS_KEY, JSON.stringify(book));
  return prev ? "updated" : "new";
}
function absorbCards(g) {
  if (!g || !Array.isArray(g.players)) return;
  g.players.forEach((p) => (p.cards || []).forEach(rememberCard));
}
function applySavedCard(entry) {
  const m = state.modal;
  if (!m || !entry) return;
  m.name = entry.name;
  m.kind = entry.kind;
  m.typeName = entry.typeName || "";
  m.cost = num(entry.cost);
  m.until = entry.until === "turn" ? "turn" : "permanent";
  m.melee = num(entry.melee);
  m.magic = num(entry.magic);
  m.speed = num(entry.speed);
  m.heal = num(entry.heal);
  m.healthMax = num(entry.healthMax);
  m.boonLimit = num(entry.boonLimit);
  m.treasureLimit = num(entry.treasureLimit);
  m.specialOn = !!(entry.special && entry.special.text);
  m.specialStat = entry.special && entry.special.stat === "melee" ? "melee" : "magic";
  m.specialText = entry.special ? entry.special.text : "";
}
function cardBits(card) {
  const bits = [];
  const put = (label, value) => { if (value) bits.push(label + " " + (value > 0 ? "+" : "") + value); };
  put("ближний", num(card.melee));
  put("магия", num(card.magic));
  put("скорость", num(card.speed));
  put("лечение", num(card.heal));
  put("макс. здоровье", num(card.healthMax));
  return bits;
}
function loadGame() {
  try {
    const g = JSON.parse(localStorage.getItem(GAME_KEY) || "null");
    if (!g || !Array.isArray(g.players)) return null;
    g.stay = g.stay || { glory: 0, peril: 0 };
    g.pay = g.pay || {};
    ensureDecks(g);
    g.fights = Array.isArray(g.fights) ? g.fights : [];
    absorbCards(g);
    return g;
  } catch (e) { return null; }
}
function saveGame() {
  if (state.game) localStorage.setItem(GAME_KEY, JSON.stringify(state.game));
  else localStorage.removeItem(GAME_KEY);
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("dungeoneer", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("heroes", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}
async function listHeroes() {
  const base = await db();
  return new Promise((resolve, reject) => {
    const req = base.transaction("heroes", "readonly").objectStore("heroes").getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.name.localeCompare(b.name, "ru")));
    req.onerror = () => reject(req.error);
  });
}
async function saveHero(hero) {
  const base = await db();
  await new Promise((resolve, reject) => {
    const tx = base.transaction("heroes", "readwrite");
    tx.objectStore("heroes").put(hero);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function deleteHero(id) {
  const base = await db();
  await new Promise((resolve, reject) => {
    const tx = base.transaction("heroes", "readwrite");
    tx.objectStore("heroes").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function emptyDraft() {
  return {
    id: null, name: "", race: "", setName: "", ability: "",
    health: null, boonLimit: null, treasureLimit: null,
    stats: [0, 1, 2, 3].map(() => ({ melee: null, magic: null, speed: null })),
    photo: "", ocrText: "",
  };
}
function draftFromHero(h) {
  return {
    id: h.id, name: h.name, race: h.race || "", setName: h.setName || "", ability: h.ability || "",
    health: h.health, boonLimit: h.boonLimit, treasureLimit: h.treasureLimit,
    stats: h.stats.map((r) => ({ ...r })), photo: h.photo || "", ocrText: h.ocrText || "",
  };
}
function findNum(text, label) {
  const a = new RegExp(label + "\\S{0,16}\\D{0,16}(\\d{1,2})", "i").exec(text);
  const b = new RegExp("(\\d{1,2})\\D{0,12}" + label, "i").exec(text);
  const m = a || b;
  return m ? Number(m[1]) : null;
}
function lineDigits(line) {
  const compact = String(line || "").replace(/\s+/g, "");
  if (/^\d{4}$/.test(compact)) return compact.split("").map(Number);
  const groups = String(line || "").match(/\d+/g) || [];
  if (groups.length === 4 && groups.every((g) => g.length <= 2)) return groups.map(Number);
  if (groups.length === 1 && groups[0].length === 4) return groups[0].split("").map(Number);
  return null;
}
function isLevelHeader(row) {
  return !!row && row.join() === "1,2,3,4";
}
function parseHeroText(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const draft = emptyDraft();
  draft.ocrText = text.trim();
  const flat = lines.join("\n");
  draft.health = findNum(flat, "здоров") ?? findNum(flat, "жизн") ?? findNum(flat, "life");
  draft.boonLimit = findNum(flat, "преимущ") ?? findNum(flat, "boon");
  draft.treasureLimit = findNum(flat, "сокровищ") ?? findNum(flat, "treasure");
  const quads = [];
  const plain = [];
  for (const line of lines) {
    const four = lineDigits(line);
    if (!four) continue;
    const low = line.toLowerCase();
    let kind = null;
    if (/ближ|melee|меч/.test(low)) kind = "melee";
    else if (/маги|magic/.test(low)) kind = "magic";
    else if (/скор|speed|move|сапог/.test(low)) kind = "speed";
    else if (/уров|level/.test(low) || isLevelHeader(four)) kind = "level";
    quads.push({ kind, four });
    if (kind !== "level") plain.push(four);
  }
  const byKind = {};
  quads.forEach((q) => { if (q.kind && q.kind !== "level") byKind[q.kind] = q.four; });
  let rows = null;
  if (byKind.melee && byKind.magic && byKind.speed) rows = [byKind.melee, byKind.magic, byKind.speed];
  else if (plain.length >= 3) rows = plain.slice(0, 3);
  if (rows && rows.length >= 3) {
    for (let i = 0; i < 4; i++) draft.stats[i] = { melee: rows[0][i], magic: rows[1][i], speed: rows[2][i] };
  }
  const skip = /здоров|жизн|преимущ|сокровищ|ближ|маги|скор|уров|life|boon|treasure|melee|magic|speed|особ|умен/i;
  const words = lines.filter((l) => /[A-Za-zА-Яа-яЁё]/.test(l) && !skip.test(l) && (l.match(/\d/g) || []).length < 3);
  draft.name = words[0] || "";
  draft.race = words[1] && words[1].length <= 48 ? words[1] : "";
  draft.ability = words.slice(draft.race ? 2 : 1).join(" ").slice(0, 600);
  return draft;
}
function firstLine(text) {
  return String(text || "").split("\n").map((l) => l.trim()).find((l) => /[A-Za-zА-Яа-яЁё]{2,}/.test(l)) || "";
}
function smallNumber(text) {
  const m = String(text || "").match(/\d{1,2}/);
  if (!m) return null;
  const n = Number(m[0]);
  return n <= 30 ? n : null;
}
function applyRegions(draft, regions) {
  const name = firstLine(regions.name);
  const race = firstLine(regions.race);
  if (name && name.length <= 40) draft.name = name;
  if (race && race.length <= 48 && race !== draft.name) draft.race = race;
  const ability = String(regions.ability || "").replace(/\s+/g, " ").trim();
  if (ability.length > 12) draft.ability = ability.slice(0, 600);
  const health = smallNumber(regions.health);
  if (health != null && health >= 1) draft.health = health;
  const boon = smallNumber(regions.boon);
  const treasure = smallNumber(regions.treasure);
  if (boon != null) draft.boonLimit = boon;
  if (treasure != null) draft.treasureLimit = treasure;
  const grid = regions.grid;
  if (grid && grid.filter((row) => row && row.filter((n) => n != null).length === 4).length >= 2) {
    const rows = grid.map((row) => row || [null, null, null, null]);
    for (let i = 0; i < 4; i++) {
      draft.stats[i] = {
        melee: rows[0][i] != null ? rows[0][i] : draft.stats[i].melee,
        magic: rows[1][i] != null ? rows[1][i] : draft.stats[i].magic,
        speed: rows[2][i] != null ? rows[2][i] : draft.stats[i].speed,
      };
    }
  }
  return draft;
}
function draftErrors(d) {
  const bad = [];
  if (!String(d.name || "").trim()) bad.push("имя");
  if (d.health == null || Number.isNaN(Number(d.health)) || Number(d.health) < 1) bad.push("здоровье");
  if (d.boonLimit == null || Number.isNaN(Number(d.boonLimit))) bad.push("предел преимуществ");
  if (d.treasureLimit == null || Number.isNaN(Number(d.treasureLimit))) bad.push("предел сокровищ");
  d.stats.forEach((row, i) => {
    if (["melee", "magic", "speed"].some((k) => row[k] == null || Number.isNaN(Number(row[k])))) bad.push("цифры " + (i + 1) + "-го уровня");
  });
  return bad;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}
function drawImage(img, max, contrast) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (contrast) {
    const image = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      y = (y - 128) * 1.25 + 128;
      d[i] = d[i + 1] = d[i + 2] = y < 0 ? 0 : y > 255 ? 255 : y;
    }
    g.putImageData(image, 0, 0);
  }
  return canvas;
}
function ocrStatus(m) {
  const el = document.getElementById("ocr-status");
  const bar = document.getElementById("ocr-bar");
  const map = {
    "loading tesseract core": "Загружаю распознавание",
    "initializing tesseract": "Готовлю чтение",
    "loading language traineddata": "Загружаю русский язык",
    "initializing api": "Почти готово",
    "recognizing text": "Читаю карточку",
  };
  const label = map[m.status] || "Распознаю";
  const pct = m.progress ? Math.round(m.progress * 100) : 0;
  if (el) el.textContent = pct ? label + " " + pct + "%" : label + "…";
  if (bar) bar.style.width = (m.status === "recognizing text" ? pct : 15) + "%";
}
async function getWorker() {
  if (!window.Tesseract) throw new Error("no-engine");
  if (!workerPromise) {
    const root = new URL("vendor/", location.href);
    workerPromise = Tesseract.createWorker("rus", 1, {
      workerPath: new URL("worker.min.js", root).href,
      corePath: new URL("tesseract-core-simd-lstm.wasm.js", root).href,
      langPath: new URL("lang", root).href,
      workerBlobURL: false,
      logger: ocrStatus,
    }).then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      return worker;
    }).catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}
const TEXT_CHARS = "0123456789АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .,:-–—«»()";
function loadSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}
function defaultCrop(w, h) {
  const aspect = w / h;
  if (aspect > 0.9) {
    const cw = Math.min(0.96, (0.72 * h) / w);
    return { x: (1 - cw) / 2, y: 0.02, w: cw, h: 0.96 };
  }
  return { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
}
function sliceCanvas(source, fx, fy, fw, fh, scale) {
  const sw = source.width;
  const sh = source.height;
  const sx = Math.max(0, Math.round(sw * fx));
  const sy = Math.max(0, Math.round(sh * fy));
  const w = Math.max(1, Math.min(sw - sx, Math.round(sw * fw)));
  const h = Math.max(1, Math.min(sh - sy, Math.round(sh * fh)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.drawImage(source, sx, sy, w, h, 0, 0, canvas.width, canvas.height);
  const image = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    y = (y - 140) * 1.7 + 140;
    const v = y < 0 ? 0 : y > 255 ? 255 : y;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(image, 0, 0);
  return canvas;
}
function setOcr(label) {
  const el = document.getElementById("ocr-status");
  const bar = document.getElementById("ocr-bar");
  if (el) el.textContent = label;
  if (bar) bar.style.width = "50%";
}
async function readCanvas(worker, canvas, psm, digits) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: digits ? "0123456789" : TEXT_CHARS,
  });
  const result = await worker.recognize(canvas);
  return (result.data && result.data.text) || "";
}
async function recognizeCard(source) {
  const worker = await getWorker();
  const full = drawImage(source, 1800, true);
  setOcr("Читаю карточку целиком…");
  const wholeA = await readCanvas(worker, full, 6, false);
  setOcr("Второй проход по всей карточке…");
  const wholeB = await readCanvas(worker, full, 4, false);
  const draft = parseHeroText(wholeA + "\n" + wholeB);
  const names = { name: "имя", race: "расу", ability: "умение", health: "здоровье", boon: "предел преимуществ", treasure: "предел сокровищ" };
  const spots = [
    ["name", 0.40, 0.01, 0.36, 0.14, 7, false],
    ["race", 0.62, 0.02, 0.36, 0.16, 7, false],
    ["ability", 0.38, 0.42, 0.60, 0.28, 6, false],
    ["health", 0.34, 0.50, 0.24, 0.22, 8, true],
    ["boon", 0.34, 0.72, 0.16, 0.18, 10, true],
    ["treasure", 0.48, 0.72, 0.18, 0.20, 10, true],
  ];
  const regions = {};
  for (const [key, x, y, w, h, psm, digits] of spots) {
    setOcr("Читаю " + names[key] + "…");
    regions[key] = await readCanvas(worker, sliceCanvas(full, x, y, w, h, 2), psm, digits);
  }
  const grid = [];
  const statNames = ["ближний бой", "магию", "скорость"];
  for (let row = 0; row < 3; row++) {
    setOcr("Читаю " + statNames[row] + "…");
    const line = await readCanvas(worker, sliceCanvas(full, 0.46, 0.16 + row * 0.09, 0.52, 0.09, 3), 7, true);
    let four = lineDigits(line);
    if (!four || isLevelHeader(four)) {
      four = [];
      for (let col = 0; col < 4; col++) {
        const cell = await readCanvas(worker, sliceCanvas(full, 0.46 + col * 0.13, 0.16 + row * 0.09, 0.13, 0.09, 4), 10, true);
        four.push(smallNumber(cell));
      }
    }
    grid.push(four);
  }
  regions.grid = grid;
  draft.ocrText = [wholeA, wholeB, regions.name, regions.race, regions.ability].filter(Boolean).join("\n").trim();
  applyRegions(draft, regions);
  await worker.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: TEXT_CHARS });
  return draft;
}
async function startCrop(file) {
  let img;
  try { img = await loadImage(file); } catch (e) { flash("Этот снимок не открылся. Нужен JPEG или PNG."); return; }
  const prepared = drawImage(img, 1600, false);
  state.originalSrc = prepared.toDataURL("image/jpeg", 0.86);
  state.cropSize = { w: prepared.width, h: prepared.height };
  state.crop = Object.assign({ src: state.originalSrc }, defaultCrop(prepared.width, prepared.height));
  render();
}
function cropCanvas(img, crop) {
  const canvas = document.createElement("canvas");
  const sx = Math.round(img.width * crop.x);
  const sy = Math.round(img.height * crop.y);
  const sw = Math.max(1, Math.round(img.width * crop.w));
  const sh = Math.max(1, Math.round(img.height * crop.h));
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}
async function readPrepared(canvas) {
  state.draft.photo = drawImage(canvas, 420, false).toDataURL("image/jpeg", 0.72);
  state.crop = null;
  state.scan.busy = true;
  state.scan.error = "";
  render();
  try {
    const parsed = await recognizeCard(canvas);
    parsed.photo = state.draft.photo;
    parsed.id = state.draft.id;
    parsed.setName = state.draft.setName;
    state.draft = parsed;
  } catch (e) {
    state.scan.error = location.protocol === "file:"
      ? "Откройте счётчик файлом «Открыть счётчик». Сейчас заполните карточку вручную."
      : "Не удалось прочитать фото. Заполните цифры с карточки.";
  }
  state.scan.busy = false;
  render();
}
function screenCrop() {
  const c = state.crop;
  return `<main class="wrap stack"><h1>Обрезать карточку</h1><p class="note">Сдвиньте рамку так, чтобы внутри была сама карточка: имя сверху, три ряда цифр справа, здоровье и пределы внизу.</p><div class="crop-stage" id="cropper"><img alt="" src="${c.src}"><div class="crop-rect" id="crop-rect" style="left:${c.x * 100}%;top:${c.y * 100}%;width:${c.w * 100}%;height:${c.h * 100}%"><span data-handle="nw"></span><span data-handle="ne"></span><span data-handle="sw"></span><span data-handle="se"></span></div></div><button type="button" class="btn gold block" data-act="crop-read">Прочитать эту область</button><button type="button" class="btn block" data-act="crop-full">Читать всё фото</button><button type="button" class="btn ghost block" data-act="crop-cancel">Отмена</button></main>`;
}
function bindCropper() {
  const stage = document.getElementById("cropper");
  const rect = document.getElementById("crop-rect");
  if (!stage || !rect || stage.dataset.bound) return;
  stage.dataset.bound = "1";
  let drag = null;
  const point = (e) => {
    const box = stage.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  };
  const paint = () => {
    const c = state.crop;
    rect.style.left = (c.x * 100) + "%";
    rect.style.top = (c.y * 100) + "%";
    rect.style.width = (c.w * 100) + "%";
    rect.style.height = (c.h * 100) + "%";
  };
  stage.addEventListener("pointerdown", (e) => {
    const handle = e.target.dataset.handle || "";
    if (!handle && e.target !== rect) return;
    const p = point(e);
    drag = { mode: handle || "move", px: p.x, py: p.y, x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h };
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || !state.crop) return;
    const p = point(e);
    const dx = p.x - drag.px;
    const dy = p.y - drag.py;
    let x = drag.x, y = drag.y, w = drag.w, h = drag.h;
    if (drag.mode === "move") { x += dx; y += dy; }
    if (drag.mode === "se") { w += dx; h += dy; }
    if (drag.mode === "nw") { x += dx; y += dy; w -= dx; h -= dy; }
    if (drag.mode === "ne") { y += dy; w += dx; h -= dy; }
    if (drag.mode === "sw") { x += dx; w -= dx; h += dy; }
    w = Math.max(0.2, w);
    h = Math.max(0.2, h);
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > 1) x = 1 - w;
    if (y + h > 1) y = 1 - h;
    state.crop.x = x;
    state.crop.y = y;
    state.crop.w = w;
    state.crop.h = h;
    paint();
  });
  stage.addEventListener("pointerup", () => { drag = null; });
}

function current() { return state.game.players[state.game.active]; }
function byId(id) { return state.game.players.find((p) => p.id === id); }
function printed(p) {
  const row = p.cardStats[Math.min(p.level, 4) - 1];
  const extra = Math.max(0, p.level - 4);
  return { melee: row.melee + extra, magic: row.magic + extra, speed: row.speed + extra, extra, row };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function itemMods(p) {
  return (p.cards || []).reduce((m, c) => ({
    melee: m.melee + num(c.melee), magic: m.magic + num(c.magic), speed: m.speed + num(c.speed),
  }), { melee: 0, magic: 0, speed: 0 });
}
function statsOf(p) {
  const base = printed(p);
  const mod = itemMods(p);
  const escort = p.escort && p.escort.on ? p.escort : null;
  return {
    melee: base.melee + mod.melee + (p.rewardMelee || 0) + (escort ? num(escort.melee) : 0),
    magic: base.magic + mod.magic + (escort ? num(escort.magic) : 0),
    speed: base.speed + mod.speed + (p.rewardSpeed || 0) + (escort ? num(escort.speed) : 0),
    extra: base.extra, base, mod, escort,
  };
}
function limitsOf(p, extra) {
  let boon = p.baseBoon, treasure = p.baseTreasure;
  p.cards.forEach((c) => { boon += c.boonLimit || 0; treasure += c.treasureLimit || 0; });
  if (extra) { boon += extra.boonLimit || 0; treasure += extra.treasureLimit || 0; }
  return { boon, treasure };
}
function countKind(p, kind) {
  return p.cards.filter((c) => c.kind === kind && c.until === "permanent").length;
}
function changeLevel(p, delta) {
  const cap = state.settings.maxLevel;
  const next = clamp(p.level + delta, 1, cap);
  const diff = next - p.level;
  if (!diff) return null;
  const was = p.level;
  p.level = next;
  if (state.settings.healthOnLevel && diff > 0) {
    p.healthMax += diff;
    p.health += diff;
  } else if (state.settings.healthOnLevel && diff < 0) {
    p.healthMax = Math.max(1, p.healthMax + diff);
    if (p.health > p.healthMax) p.health = p.healthMax;
  }
  const extraNow = Math.max(0, next - 4);
  const extraWas = Math.max(0, was - 4);
  const bits = [];
  if (extraNow !== extraWas) {
    bits.push(extraNow ? "сверх 4-го уровня +" + extraNow + " ко всем характеристикам" : "характеристики снова как на 4-м уровне карточки");
  }
  if (state.settings.healthOnLevel) bits.push(diff > 0 ? "здоровье +" + diff : "максимум здоровья " + diff);
  return bits.join(", ");
}
function shiftAp(p, delta) {
  if (!delta) return;
  p.ap = Math.max(0, num(p.ap) + delta);
}
function removeCard(p, id) {
  const card = p.cards.find((c) => c.id === id);
  if (!card) return;
  p.cards = p.cards.filter((c) => c.id !== id);
  shiftAp(p, -num(card.speed));
  if (card.healthMax) {
    p.healthMax = Math.max(1, p.healthMax - card.healthMax);
    if (p.health > p.healthMax) p.health = p.healthMax;
  }
}
function applyRecovery() {
  const g = state.game;
  const p = current();
  const gain = g.recover || { glory: 1, peril: 1 };
  p.glory += Math.max(0, num(gain.glory));
  p.peril += Math.max(0, num(gain.peril));
  dropTurnCards(p);
  p.ap = Math.max(0, statsOf(p).speed);
  if (p.escort && p.escort.on) p.escort.apShift = num(p.escort.speed);
  p.savedAp = 0;
  p.moved = false;
  p.stayTaken = false;
  p.abilityUsed = false;
  nextPhase();
}
function nextPhase() {
  if (state.game.phase === "villainy") {
    state.game.fights = [];
    state.game.counterRolls = {};
    state.game.counterSeen = false;
    state.counter = null;
  }
  const ids = PHASES.map((x) => x[0]);
  const i = ids.indexOf(state.game.phase);
  if (i >= 0 && i < ids.length - 1) state.game.phase = ids[i + 1];
  state.game.prompt = null;
}
function endTurn() {
  const g = state.game;
  const p = current();
  if (g.saveAp && p.ap > 0) p.savedAp = 1;
  p.ap = 0;
  p.moved = false;
  p.stayTaken = false;
  g.prompt = null;
  g.saveAp = false;
  const n = g.players.length;
  let i = g.active;
  for (let s = 1; s <= n; s++) {
    const j = (g.active + s) % n;
    if (!g.players[j].eliminated) { i = j; break; }
  }
  if (i <= g.active) g.round += 1;
  g.active = i;
  g.phase = "recovery";
  dropTurnCards(g.players[i]);
  g.recover = { glory: 1, peril: 1 };
  g.fights = [];
  g.counterSeen = false;
  g.challenge = null;
  g.dash = null;
  state.counter = null;
}
function evaluate() {
  const g = state.game;
  if (!g) return;
  g.players.forEach((p) => {
    if (p.health <= 0) { p.health = 0; p.eliminated = true; }
    else p.eliminated = false;
  });
  const living = g.players.filter((p) => !p.eliminated);
  const questWinner = g.players.find((p) => !p.eliminated && p.quests >= state.settings.questsToWin);
  if (questWinner) g.victory = { id: questWinner.id, reason: "quests" };
  else if (g.players.some((p) => p.eliminated) && living.length === 1) g.victory = { id: living[0].id, reason: "last" };
  else {
    g.victory = null;
    if (g.players[g.active].eliminated && living.length) {
      const n = g.players.length;
      for (let s = 1; s <= n; s++) {
        const j = (g.active + s) % n;
        if (!g.players[j].eliminated) {
          if (j <= g.active) g.round += 1;
          g.active = j;
          g.phase = "recovery";
          g.recover = { glory: 1, peril: 1 };
          g.prompt = null;
          break;
        }
      }
    }
  }
}
function settle() { evaluate(); saveGame(); render(); }
function commit(fn) {
  state.history.push(JSON.parse(JSON.stringify(state.game)));
  if (state.history.length > 40) state.history.shift();
  fn();
  settle();
}
function addQuest(delta) {
  const p = current();
  if (delta < 0) {
    if (p.quests <= 0) return;
    p.quests -= 1;
    let info = "";
    if ((p.questsWithoutLevel || 0) > 0) p.questsWithoutLevel -= 1;
    else info = changeLevel(p, -1) || "";
    flash(info ? "Задание снято. " + info : "Задание снято");
    return;
  }
  p.quests += 1;
  state.reward = { health: 0, peril: 0, glory: 0, melee: 0, speed: 0, noLevel: false };
  flash("Задание засчитано");
}

function face(photo, name, cls) {
  if (photo && String(photo).startsWith("data:image/")) return `<img class="${cls}" alt="" src="${photo}">`;
  return `<span class="${cls}">${esc((name || "?").trim().slice(0, 1).toUpperCase())}</span>`;
}
function stepper(value, act, extra) {
  return `<div class="stepper"><button type="button" data-act="${act}" data-delta="-1" ${extra || ""}>−</button><b>${value}</b><button type="button" data-act="${act}" data-delta="1" ${extra || ""}>+</button></div>`;
}
function toastHtml() { return state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ""; }
function confirmHtml() {
  if (!state.confirm) return "";
  return `<div class="confirm"><div class="stack"><p>${esc(state.confirm.text)}</p><div class="row"><button type="button" class="btn gold" data-act="confirm-yes">${esc(state.confirm.yes || "Да")}</button><button type="button" class="btn ghost" data-act="confirm-no">Отмена</button></div></div></div>`;
}
function rulesLine() {
  const s = state.settings;
  const decks = startingDecks(s);
  return `Победа: ${s.questsToWin} заданий · уровень до ${s.maxLevel} · здоровье за уровень ${s.healthOnLevel ? "включено" : "выключено"} · поверхность в колоде ${decks.surface} · подземелье ${decks.dungeon}`;
}
function levelPreview() {
  const cap = state.settings.maxLevel;
  if (cap <= 4) return `<p class="note">Потолок 4 — как четыре столбца на карточке. Поднимите его, если герой растёт дальше: каждый следующий уровень даёт +1 к ближнему бою, магии и скорости поверх 4-го столбца.</p>`;
  const items = [];
  for (let lvl = 4; lvl <= cap && items.length < 8; lvl++) {
    const extra = lvl - 4;
    items.push(`<li>${lvl} ур. ${extra ? "+" + extra : "с карточки"}</li>`);
  }
  if (cap > 11) items.push(`<li>${cap} ур. +${cap - 4}</li>`);
  return `<p class="note">С 5-го уровня к цифре 4-го столбца прибавляется 1 за каждый шаг, ко всем трём характеристикам.</p><ul class="preview">${items.join("")}</ul>`;
}
function statHint(p, key) {
  const st = statsOf(p);
  const bits = [];
  if (st.extra) bits.push("4-й +" + st.extra);
  if (st.mod[key]) bits.push("вещи " + (st.mod[key] > 0 ? "+" : "") + st.mod[key]);
  if (key === "melee" && p.rewardMelee) bits.push("задания +" + p.rewardMelee);
  if (key === "speed" && p.rewardSpeed) bits.push("задания +" + p.rewardSpeed);
  if (st.escort && num(st.escort[key])) bits.push("сопровождение " + (num(st.escort[key]) > 0 ? "+" : "") + num(st.escort[key]));
  return bits.join(" · ");
}

function view() {
  if (!state.settings) return "";
  if (state.screen === "settings") return screenSettings();
  if (state.screen === "library") return screenLibrary();
  if (state.screen === "hero") return state.crop ? screenCrop() : screenHero();
  if (state.screen === "setup") return screenSetup();
  if (state.screen === "play" && state.game) return screenPlay();
  return screenHome();
}
function screenHome() {
  const fileNote = location.protocol === "file:" ? `<p class="note">Чтобы читать фото карточек, запускайте файл «Открыть счётчик».</p>` : "";
  const needHeroes = state.heroes.length < 2 ? `<p class="note">Сначала добавьте двух разных героев. Настройки можно менять сразу, партия откроется после героев.</p>` : "";
  return `<main class="wrap stack"><p class="kicker">Настольный счётчик</p><h1 class="home-title">Подземелье</h1><p class="note">Ход по фазам, слава, риск, здоровье и уровень. Герои добавляются фотографией карточки — из любого набора. Партия хранится в этом телефоне, компьютер для игры не нужен.</p>${fileNote}<div class="card stack"><p class="summary">${esc(rulesLine())}</p>${needHeroes}<button type="button" class="btn gold block" data-act="go-setup" ${state.heroes.length >= 2 ? "" : "disabled"}>Новая партия</button><button type="button" class="btn block" data-act="continue" ${state.game ? "" : "disabled"}>Продолжить</button><button type="button" class="btn block" data-act="go-library">Герои</button><button type="button" class="btn ghost block" data-act="open-settings">Настройки игры</button><button type="button" class="btn ghost block" data-act="refresh-app">Обновить приложение</button><p class="note">Если вышла новая версия, нажмите «Обновить приложение». Герои и партия останутся.</p></div></main>`;
}
function screenSettings() {
  const s = state.settings;
  return `<main class="wrap stack"><button type="button" class="btn ghost" data-act="back">Назад</button><h1>Настройки игры</h1><p class="note">Правила действуют сразу, в том числе в текущей партии.</p>
  <section class="card setting"><h2>Заданий для победы</h2>${stepper(s.questsToWin, "setting", 'data-key="questsToWin"')}<p class="note">Сколько заданий нужно завершить одному герою. В правилах набора это 3.</p></section>
  <section class="card setting"><h2>Максимальный уровень</h2>${stepper(s.maxLevel, "setting", 'data-key="maxLevel"')}${levelPreview()}</section>
  <section class="card setting"><div class="spread"><div><h2>Здоровье за уровень</h2><p class="note">При повышении максимум и текущее здоровье +1. При понижении максимум уменьшается, лишнее текущее срезается. Уже полученные уровни задним числом не пересчитываются.</p></div><button type="button" class="switch ${s.healthOnLevel ? "on" : ""}" data-act="setting" data-key="healthOnLevel" aria-pressed="${s.healthOnLevel}" aria-label="Увеличивать здоровье при повышении уровня"><span></span></button></div></section>
  <section class="card setting"><h2>Наборов в партии</h2>${stepper(s.sets, "setting", 'data-key="sets"')}<p class="note">Одна игра — колоды как ниже. Вторая игра с тем же числом карт удваивает и поверхность, и подземелье.</p><h2>Поверхность в одном наборе</h2>${stepper(s.surfacePerSet, "setting", 'data-key="surfacePerSet"')}<h2>Подземелье в одном наборе</h2>${stepper(s.dungeonPerSet, "setting", 'data-key="dungeonPerSet"')}<p class="note">В новых партиях в колоде будет: поверхность ${startingDecks(s).surface}, подземелье ${startingDecks(s).dungeon}. Пять карт поверхности уже открыты на столе, поэтому они сразу вычтены один раз, даже если наборов два. Подземный набор впишите во вторую строку и оставьте наборов 1, если он не дублирует пустыню. Уже идущую партию эти цифры не переписывают.</p></section>
  </main>`;
}
function screenLibrary() {
  const tiles = state.heroes.map((h) => `<article class="hero-tile"><button type="button" class="hero-tile" data-act="edit-hero" data-id="${h.id}">${face(h.photo, h.name, "face")}<span><b>${esc(h.name)}</b><small class="muted">${esc(h.race || "без расы")}${h.setName ? " · " + esc(h.setName) : ""}</small></span></button><button type="button" class="tiny danger" data-act="delete-hero" data-id="${h.id}">Удалить</button></article>`).join("");
  return `<main class="wrap stack"><button type="button" class="btn ghost" data-act="back">Назад</button><h1>Герои</h1><p class="note">Сфотографируйте карточку. Имя и цифры можно поправить перед сохранением. Список остаётся в этом браузере.</p><div class="row"><button type="button" class="btn gold" data-act="new-hero" data-mode="camera">Сфотографировать</button><button type="button" class="btn" data-act="new-hero" data-mode="file">Выбрать снимок</button><button type="button" class="btn ghost" data-act="blank-hero">Вручную</button></div><div class="heroes">${tiles || `<p class="note">Пока пусто. Добавьте героев из ваших наборов.</p>`}</div></main>`;
}
function numInput(path, value) {
  const missing = value == null || value === "";
  return `<input data-bind="draft.${path}" data-num="1" inputmode="numeric" value="${value ?? ""}" class="${missing ? "missing" : ""}">`;
}
function screenHero() {
  const d = state.draft;
  const head = ["", "1", "2", "3", "4"].map((x) => `<b>${x}</b>`).join("");
  const row = (label, key) => `<span>${label}</span>` + d.stats.map((s, i) => numInput(`stats.${i}.${key}`, s[key])).join("");
  const photo = d.photo ? `<img class="photo-frame" alt="Карточка героя" src="${d.photo}">` : `<div class="photo-frame" style="height:140px"></div>`;
  const busy = state.scan.busy ? `<p id="ocr-status">Читаю карточку…</p><div class="bar"><i id="ocr-bar"></i></div>` : "";
  return `<main class="wrap stack"><button type="button" class="btn ghost" data-act="back">Назад</button><h1>${d.id ? "Герой" : "Новый герой"}</h1><p class="note">Сначала обрежьте фото по карточке. Имя сверху, справа цифры уровней, внизу здоровье и пределы.</p>${state.scan.error ? `<p class="note">${esc(state.scan.error)}</p>` : ""}${photo}${busy}<div class="row"><button type="button" class="btn" data-act="pick" data-mode="camera">Переснять</button><button type="button" class="btn ghost" data-act="pick" data-mode="file">Другой файл</button>${state.originalSrc ? `<button type="button" class="btn ghost" data-act="crop-again">Обрезать</button>` : ""}</div>
  <label class="field">Имя<input data-bind="draft.name" value="${esc(d.name)}"></label>
  <label class="field">Раса и класс<input data-bind="draft.race" value="${esc(d.race)}"></label>
  <label class="field">Набор<input data-bind="draft.setName" value="${esc(d.setName)}" placeholder="Пустыня, Ледяная ведьма…"></label>
  <div class="card statgrid">${head}${row("Ближний", "melee")}${row("Магия", "magic")}${row("Скорость", "speed")}</div>
  <div class="row"><label class="field">Здоровье${numInput("health", d.health)}</label><label class="field">Преимущества${numInput("boonLimit", d.boonLimit)}</label><label class="field">Сокровища${numInput("treasureLimit", d.treasureLimit)}</label></div>
  <label class="field">Умение<textarea data-bind="draft.ability">${esc(d.ability)}</textarea></label>
  <details class="card"><summary>Что прочитала камера</summary><p class="note">${esc(d.ocrText || "Пока ничего.")}</p></details>
  <button type="button" class="btn gold block" data-act="save-hero">Сохранить героя</button></main>`;
}
function screenSetup() {
  const setup = state.setup;
  const seats = setup.seats.map((seat, i) => {
    const heroes = state.heroes.map((h) => {
      const taken = setup.seats.some((s, j) => j !== i && s.heroId === h.id);
      const on = seat.heroId === h.id;
      return `<button type="button" class="hero-tile ${on ? "on" : ""} ${taken && !on ? "taken" : ""}" data-act="pick-hero" data-seat="${i}" data-id="${h.id}">${face(h.photo, h.name, "face")}<span><b>${esc(h.name)}</b><small class="muted">${esc(h.race || "")}</small></span></button>`;
    }).join("");
    return `<section class="card stack"><div class="spread"><h2>Место ${i + 1}${setup.first === i ? " · ходит первым" : ""}</h2><div class="row"><button type="button" class="tiny" data-act="seat-move" data-seat="${i}" data-delta="-1">Выше</button><button type="button" class="tiny" data-act="seat-move" data-seat="${i}" data-delta="1">Ниже</button></div></div><label class="field">Имя игрока<input data-bind="seat.${i}.playerName" value="${esc(seat.playerName)}"></label><div class="heroes">${heroes}</div><button type="button" class="btn ghost" data-act="first" data-seat="${i}">Ходит первым</button></section>`;
  }).join("");
  const dice = setup.die ? `<p class="note">Кубики: ${setup.die.map((n, i) => esc(setup.seats[i].playerName) + " " + n).join(", ")}. При равенстве первым остаётся тот, кто раньше по кругу.</p>` : "";
  return `<main class="wrap stack"><button type="button" class="btn ghost" data-act="go-home">На главную</button><h1>Новая партия</h1><p class="note">Добавляйте игроков по часовой стрелке. Ход переходит к следующему.</p><div class="card setting"><h2>Игроков</h2>${stepper(setup.count, "players")}</div><div class="card stack"><p>${esc(rulesLine())}</p><button type="button" class="btn ghost" data-act="open-settings">Изменить правила</button></div>${seats}<div class="row"><button type="button" class="btn" data-act="roll-first">Кубик за первого</button><button type="button" class="btn gold" data-act="add-during-setup">Добавить героя</button></div>${dice}<button type="button" class="btn gold block" data-act="start-game">Начать у входа</button><p class="note">На входе каждый получает 1 славу и 1 риск. Здоровье берётся с карточки.</p></main>`;
}

function counter(cls, label, value, sub, id, key) {
  return `<div class="counter ${cls}"><button type="button" data-act="bump" data-id="${id}" data-key="${key}" data-delta="-1">−</button><div><b>${value}</b><small>${sub}</small><span>${label}</span></div><button type="button" data-act="bump" data-id="${id}" data-key="${key}" data-delta="1">+</button></div>`;
}
function screenPlay() {
  const g = state.game;
  const p = current();
  const st = statsOf(p);
  const s = state.settings;
  const rail = PHASES.map(([id, name], i) => {
    const cur = PHASES.findIndex((x) => x[0] === g.phase);
    const cls = i === cur ? "now" : i < cur ? "past" : "";
    return `<span class="${cls}">${i + 1}. ${name}</span>`;
  }).join("");
  const marks = s.questsToWin <= 10
    ? `<span class="pips">${Array.from({ length: s.questsToWin }, (_, i) => `<i class="${i < p.quests ? "got" : ""}"></i>`).join("")}</span>`
    : `<b>${p.quests} / ${s.questsToWin}</b>`;
  const hero = `<section class="card stack"><div class="spread">${face(p.photo, p.heroName, "face-lg")}<div class="stack"><p class="kicker">Раунд ${g.round}${state.die ? " · кубик " + state.die : ""}</p><h2>${esc(p.heroName)}</h2><p class="muted">${esc(p.playerName)}${p.race ? " · " + esc(p.race) : ""}</p>${p.eliminated ? `<b>Выбыл</b>` : ""}</div></div>
    <div class="stats"><div class="stat" data-stat="melee"><b>${st.melee}</b><small>Ближний</small><em>${esc(statHint(p, "melee"))}</em></div><div class="stat" data-stat="magic"><b>${st.magic}</b><small>Магия</small><em>${esc(statHint(p, "magic"))}</em></div><div class="stat" data-stat="speed"><b>${st.speed}</b><small>Скорость</small><em>${esc(statHint(p, "speed"))}</em></div></div>
    ${escortPanel(p)}
    ${heroEffects(p)}
    <div class="spread"><div><p>Уровень <b data-level="${p.level}">${p.level}</b> / ${s.maxLevel}</p><p class="note">${s.maxLevel > 4 ? "Выше 4-го: +1 ко всем за каждый уровень. " : ""}${s.healthOnLevel ? "За уровень +1 к здоровью." : ""}</p></div><div class="row"><button type="button" class="tiny" data-act="level" data-delta="-1">−</button><button type="button" class="tiny" data-act="level" data-delta="1" ${p.level >= s.maxLevel ? "disabled" : ""}>+</button></div></div>
    <div class="spread"><div class="row">${marks}<span>задания ${p.quests}</span></div><button type="button" class="tiny" data-act="quest" data-delta="-1" ${p.quests ? "" : "disabled"}>Снять</button></div>
    <div class="counters">${counter("life", "Здоровье", p.health, "из " + p.healthMax, p.id, "health")}${counter("glory", "Слава", p.glory, "свои карты", p.id, "glory")}${counter("peril", "Риск", p.peril, "тратят соперники", p.id, "peril")}${counter("ap", "Действия", p.ap, p.savedAp ? "ещё 1 вне хода" : "в этот ход", p.id, "ap")}</div>
    <div class="row"><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="healthMax" data-delta="-1">Макс. здоровье −</button><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="healthMax" data-delta="1">Макс. здоровье +</button></div>
    ${p.ability ? `<details><summary>Умение</summary><p class="note">${esc(p.ability)}</p><button type="button" class="tiny" data-act="ability">${p.abilityUsed ? "Уже использовано" : "Отметить использование"}</button></details>` : ""}
    ${cardsHtml(p)}</section>`;
  const phase = `<section class="card stack" data-phase="${g.phase}"><h2>${esc(PHASES.find((x) => x[0] === g.phase)[1])}</h2>${phaseBody()}${phaseButtons()}</section>`;
  const strip = `<div class="wide stack"><h3>Все герои</h3><div class="heroes">${g.players.map((hero, i) => `<button type="button" class="chip ${i === g.active ? "on" : ""} ${hero.eliminated ? "dead" : ""}" data-act="sheet" data-id="${hero.id}">${face(hero.photo, hero.heroName, "face")}<span><b>${esc(hero.playerName)}</b><small>❤ ${hero.health}/${hero.healthMax} · слава ${hero.glory} · риск ${hero.peril}${hero.savedAp ? " · 1 вне хода" : ""}${hero.escort && hero.escort.on ? " · жетон" : ""}</small></span></button>`).join("")}</div></div>`;
  return `<main class="wrap stack"><div class="spread"><button type="button" class="tiny" data-act="undo" ${state.history.length ? "" : "disabled"}>Отменить</button><button type="button" class="tiny" data-act="roll">Кубик${state.die ? " " + state.die : ""}</button><button type="button" class="tiny" data-act="menu">Меню</button></div><div class="rail">${rail}</div><div class="play-grid">${hero}${phase}${strip}</div>${overlays()}</main>`;
}
function specialText(c) {
  if (!c.special || !String(c.special.text || "").trim()) return "";
  return (c.special.stat === "melee" ? "Ближний бой" : "Магия") + ": " + c.special.text.trim();
}
function heroEffects(p) {
  const list = (p.cards || []).filter((c) => specialText(c));
  if (!list.length) return "";
  return `<ul class="fx">${list.map((c) => `<li><b>${esc(c.special.stat === "melee" ? "Ближний" : "Магия")}</b> · ${esc(c.name)}: ${esc(c.special.text)}</li>`).join("")}</ul>`;
}
function cardsHtml(p) {
  const lim = limitsOf(p);
  const list = p.cards.map((c) => {
    const extra = specialText(c);
    return `<div><span><b>${esc(c.name)}</b><small class="muted"> ${esc(kindName(c.kind))}${c.until === "turn" ? ", до восстановления" : ""}</small>${extra ? `<small class="muted">${esc(extra)}</small>` : ""}</span><button type="button" class="tiny" data-act="drop-card" data-pid="${p.id}" data-cid="${c.id}">Снять</button></div>`;
  }).join("");
  return `<details><summary>Карты: преимущества ${countKind(p, "boon")}/${lim.boon}, сокровища ${countKind(p, "treasure")}/${lim.treasure}</summary><div class="cards">${list || `<p class="note">Пока нет.</p>`}</div></details>`;
}
function kindName(k) { return { boon: "преимущество", treasure: "сокровище", instant: "мгновенная", curse: "эффект" }[k] || k; }
function planeToggle() {
  const g = state.game;
  ensureDecks(g);
  const side = (id) => `<button type="button" class="${g.plane === id ? "on" : ""}" data-act="plane" data-plane="${id}"><span>${planeLabel(id)}</span><b>${g.decks[id]}</b></button>`;
  return `<div class="plane" role="group" aria-label="Откуда открывать локацию">${side("surface")}${side("dungeon")}</div>`;
}
function phaseBody() {
  const g = state.game;
  ensureDecks(g);
  const p = current();
  const st = statsOf(p);
  if (g.phase === "recovery") {
    const gain = g.recover || { glory: 1, peril: 1 };
    return `<p class="note">Старые очки действия сгорают, в том числе сохранённое на чужой ход. Новые станут равны скорости: <b>${st.speed}</b>.</p><div class="spread"><span>Слава локации</span>${stepper(gain.glory, "recover", 'data-key="glory"')}</div><div class="spread"><span>Риск локации</span>${stepper(gain.peril, "recover", 'data-key="peril"')}</div><p class="note">Это очки клетки, на которой стоит герой, а не его текущий запас. Каждый заход фазы начинается с 1 и 1. Они прибавятся, когда нажмёте «Восстановить».</p>`;
  }
  if (g.phase === "villainy") return villainyBody();
  if (g.phase === "location") {
    const left = g.decks[g.plane];
    return `<p class="note">Откройте одну локацию из той колоды, где сейчас стоит герой. Слава и риск с карты придут, когда он в неё войдёт.</p>${planeToggle()}${left ? `<p class="note">Спишется 1 карта: ${planeLabel(g.plane).toLowerCase()}.</p>` : `<p class="note">Эта колода пуста. Переключите ползунок или пропустите фазу.</p>`}<p>Поправить «${planeLabel(g.plane)}»</p>${stepper(left, "deck")}`;
  }
  if (g.phase === "deeds") return deedsBody();
  return discardBody();
}
function livingFoes() {
  const me = current();
  return state.game.players.filter((p) => p.id !== me.id && !p.eliminated);
}
function effectsFor(p, stat) {
  if (!p) return [];
  return (p.cards || []).filter((c) => c.special && c.special.stat === stat && String(c.special.text || "").trim());
}
function effectsBlock(title, cards) {
  if (!cards.length) return `<p class="fx">${esc(title)}: нет</p>`;
  return `<div class="fx"><b>${esc(title)}</b><ul>${cards.map((c) => `<li><b>${esc(c.name)}</b> — ${esc(c.special.text)}</li>`).join("")}</ul></div>`;
}
function compareLine(mine, theirs, mineName, foeName) {
  mineName = mineName || "Ваш результат";
  foeName = foeName || "соперника";
  if (mine > theirs) return mineName + " выше на " + (mine - theirs);
  if (mine < theirs) return "Выше у " + foeName + " на " + (theirs - mine);
  return "Поровну";
}
function statKey(stat) {
  return stat === "magic" || stat === "speed" ? stat : "melee";
}
function statTitle(stat) {
  return stat === "magic" ? "магии" : stat === "speed" ? "скорости" : "ближнему бою";
}
function statBrief(p) {
  if (!p) return "";
  const st = statsOf(p);
  return `<p class="brief"><span>ближний <b>${st.melee}</b></span><span>магия <b>${st.magic}</b></span><span>скорость <b>${st.speed}</b></span><span>слава <b>${p.glory}</b></span></p>`;
}
function dropTurnCards(p) {
  if (!p) return;
  const gone = (p.cards || []).filter((c) => c.until === "turn" || c.kind === "instant");
  gone.forEach((c) => removeCard(p, c.id));
  if (gone.length) flash("Сброшено до восстановления: " + gone.map((c) => c.name).join(", "));
}
function statButtons(act, extra, current) {
  return [["melee", "Ближний бой"], ["magic", "Магия"], ["speed", "Скорость"]].map(([id, name]) => `<button type="button" class="tiny ${current === id ? "gold" : ""}" data-act="${act}" data-stat="${id}" ${extra}>${name}</button>`).join("");
}
function blankFight() {
  const foes = fightPool();
  const foe = foes[0] || livingFoes()[0];
  const me = current();
  return {
    foeId: foe ? foe.id : "",
    stat: "melee",
    mine: me ? statsOf(me).melee : 0,
    theirs: foe ? statsOf(foe).melee : 0,
    wound: false,
    glory: 1,
    gloryTaken: false,
    gloryTakenAmount: 0,
  };
}
function setFightCount(n) {
  const g = state.game;
  g.fights = Array.isArray(g.fights) ? g.fights : [];
  n = clamp(n, 0, 8);
  while (g.fights.length < n) g.fights.push(blankFight());
  g.fights.length = n;
  g.counterSeen = false;
  state.counter = null;
  saveGame();
  render();
}
function counterFoes() {
  return livingFoes().filter((p) => p.savedAp > 0);
}
function turnCardsHtml(p) {
  const temps = (p.cards || []).filter((c) => c.until === "turn");
  if (!temps.length) return "";
  const rows = temps.map((c) => {
    const bits = [];
    if (c.melee) bits.push("ближний " + (c.melee > 0 ? "+" : "") + c.melee);
    if (c.magic) bits.push("магия " + (c.magic > 0 ? "+" : "") + c.magic);
    if (c.speed) bits.push("скорость " + (c.speed > 0 ? "+" : "") + c.speed);
    if (c.cost) bits.push("слава " + c.cost);
    const spec = specialText(c);
    if (spec) bits.push(spec);
    return `<div><span><b>${esc(c.name)}</b><small class="muted">${esc(bits.join(" · ") || "мгновенно")}</small></span><button type="button" class="tiny" data-act="drop-card" data-pid="${p.id}" data-cid="${c.id}">Снять</button></div>`;
  }).join("");
  return `<div class="stack"><p class="note">Мгновенные карты. Снимите, если эффект уже отыгран. Иначе они сами сбросятся в фазе восстановления этого героя.</p><div class="cards">${rows}</div></div>`;
}
function fightPool() {
  const foes = livingFoes();
  if (foes.length <= 1) return foes;
  const chosen = foes.find((p) => p.id === state.game.targetId);
  return chosen ? [chosen] : [];
}
function fightHtml() {
  const g = state.game;
  const foes = fightPool();
  if (!foes.length) return "";
  const me = current();
  g.fights = Array.isArray(g.fights) ? g.fights : [];
  const rows = g.fights.map((f, i) => {
    const foe = byId(f.foeId) || foes[0];
    const stat = statKey(f.stat);
    const statName = statTitle(stat);
    const picks = foes.length > 1
      ? `<div class="row">${foes.map((p) => `<button type="button" class="tiny ${p.id === foe.id ? "gold" : ""}" data-act="fight-foe" data-i="${i}" data-id="${p.id}">${esc(p.heroName)}</button>`).join("")}</div>`
      : `<p><b>${esc(foe.heroName)}</b></p>`;
    const speedGlory = stat === "speed"
      ? `<div class="spread"><span>Слава за успех</span><div class="stepper"><button type="button" data-act="fight-mod" data-i="${i}" data-key="glory" data-delta="-1">−</button><b>${f.glory || 0}</b><button type="button" data-act="fight-mod" data-i="${i}" data-key="glory" data-delta="1">+</button></div></div><button type="button" class="btn ${f.gloryTaken ? "" : "gold"}" data-act="fight-success" data-i="${i}">${f.gloryTaken ? "Слава уже взята — отменить" : "Успех — слава +" + (f.glory || 0)}</button>`
      : "";
    return `<article class="fight"><h3>Бой ${i + 1}</h3>${picks}<p class="muted">Статы того, кого атакуют</p>${statBrief(foe)}<div class="row">${statButtons("fight-stat", `data-i="${i}"`, stat)}</div><div class="spread"><span>У меня</span><div class="stepper"><button type="button" data-act="fight-mod" data-i="${i}" data-key="mine" data-delta="-1">−</button><b>${f.mine}</b><button type="button" data-act="fight-mod" data-i="${i}" data-key="mine" data-delta="1">+</button></div></div><div class="spread"><span>У соперника</span><div class="stepper"><button type="button" data-act="fight-mod" data-i="${i}" data-key="theirs" data-delta="-1">−</button><b>${f.theirs}</b><button type="button" data-act="fight-mod" data-i="${i}" data-key="theirs" data-delta="1">+</button></div></div><p class="compare">${compareLine(Number(f.mine) || 0, Number(f.theirs) || 0)}</p>${speedGlory}<div class="row"><button type="button" class="btn ${f.wound ? "gold" : ""}" data-act="fight-wound" data-i="${i}">${f.wound ? "Рана уже есть — снять риск" : "Рана — +1 риск"}</button><button type="button" class="btn ${f.miss ? "gold" : ""}" data-act="fight-miss" data-i="${i}">${f.miss ? "Неудача отмечена" : "Неудача"}</button></div>${effectsBlock("Ваши эффекты по " + statName, effectsFor(me, stat))}${effectsBlock("Эффекты соперника по " + statName, effectsFor(foe, stat))}</article>`;
  }).join("");
  const played = g.fights.length ? `<button type="button" class="btn gold block" data-act="cards-played">Карты злодеяний отыграны</button><p class="note">После этого, если у соперника сохранено действие, откроется контратака.</p>` : "";
  return `<div class="stack"><h3>Карты злодеяний</h3>${stepper(g.fights.length, "fight-count")}<p class="note">Сколько карт разыгрываете. По каждой — своё сравнение: выберите характеристику и поправьте числа после кубиков.</p>${rows}${played}</div>`;
}
function foeArticle(p) {
  const g = state.game;
  const pay = g.pay[p.id] || 1;
  const st = statsOf(p);
  return `<article class="foe">${face(p.photo, p.heroName, "face")}<div class="stack" style="flex:1"><b>${esc(p.heroName)}</b><span class="muted">${esc(p.playerName)} · риск <b data-foe-peril="${p.id}">${p.peril}</b> · здоровье ${p.health}${p.savedAp ? " · действие на контратаку" : ""}</span><p class="brief"><span>ближний <b>${st.melee}</b></span><span>магия <b>${st.magic}</b></span><span>скорость <b>${st.speed}</b></span><span>слава <b>${p.glory}</b></span>${p.savedAp ? `<span>контратака</span>` : ""}</p>${turnCardsHtml(p)}<div class="stepper"><button type="button" data-act="pay" data-id="${p.id}" data-delta="-1">−</button><b>${pay}</b><button type="button" data-act="pay" data-id="${p.id}" data-delta="1">+</button></div><button type="button" class="btn gold" data-act="spend" data-id="${p.id}">Списать его риск</button><div class="row"><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="health" data-delta="-1">Рана</button><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="health" data-delta="1">Лечение</button><button type="button" class="tiny" data-act="grant-peril" data-id="${p.id}">+1 риск</button><button type="button" class="tiny" data-act="open-card" data-id="${p.id}" data-kind="curse">Эффект</button><button type="button" class="tiny" data-act="open-card" data-id="${p.id}" data-kind="instant">Его ответ</button></div></div></article>`;
}
function villainyBody() {
  const g = state.game;
  const me = current();
  const foes = livingFoes();
  const many = foes.length > 1;
  const chosen = many ? foes.find((p) => p.id === g.targetId) : foes[0];
  const picker = many ? `<div class="row">${foes.map((p) => `<button type="button" class="tiny ${chosen && p.id === chosen.id ? "gold" : ""}" data-act="pick-target" data-id="${p.id}">${esc(p.heroName)}</button>`).join("")}</div>` : "";
  if (many && !chosen) return `<p class="note">Игроков больше двух. Выберите, кого атакуете и чей риск списываете.</p>${picker}`;
  const any = chosen ? chosen.peril > 0 : false;
  const blocks = chosen ? foeArticle(chosen) : "";
  return `<p class="note">${many ? "Атака и списание риска — только у выбранного соперника. " : ""}Спишите риск одного соперника на проклятие или столкновение. Одну карту нельзя оплатить двоими. Свой риск тратить нельзя.</p>${picker}${any ? "" : `<p class="note">У выбранного соперника нет риска — фазу можно пропустить.</p>`}<div class="stack">${blocks}</div>${fightHtml()}<div class="row"><button type="button" class="tiny" data-act="grant-glory">+1 слава за рану монстру</button><button type="button" class="tiny" data-act="grant-peril" data-id="${me.id}">+1 риск себе</button></div>`;
}
function deedsBody() {
  const g = state.game;
  const p = current();
  const need = state.settings.questsToWin;
  const win = p.quests + 1 >= need;
  let prompt = "";
  if (g.prompt && g.prompt.type === "move") {
    prompt = `<div class="card stack"><p>Новая локация?</p><p class="note">Слава и риск с карты локации. Если здесь уже были в этот ход — ничего не берите.</p><div class="row"><span>Слава</span>${stepper(g.prompt.glory, "prompt", 'data-key="glory"')}</div><div class="row"><span>Риск</span>${stepper(g.prompt.peril, "prompt", 'data-key="peril"')}</div><div class="row"><button type="button" class="btn gold" data-act="move-new">Забрать</button><button type="button" class="btn" data-act="move-old">Уже был</button><button type="button" class="btn ghost" data-act="move-cancel">Отмена хода</button></div></div>`;
  }
  const escort = p.escort && p.escort.on
    ? `<p class="note">Жетон сопровождения уже на герое. Играйте следующие ходы как обычно и сбросьте его на нужной локации.</p>`
    : `<button type="button" class="btn block" data-act="escort-start">Начать сопровождение</button>`;
  return `${p.fallen ? `<p class="note">Герой лежит и не может двигаться. Очко действия уходит на подъём.</p><button type="button" class="btn gold" data-act="stand">Встать</button>` : ""}
  <div class="row"><button type="button" class="btn" data-act="move">Перемещение −1</button><button type="button" class="btn" data-act="explore">Исследовать −1</button><button type="button" class="btn" data-act="challenge-start">Вызов −1</button><button type="button" class="btn" data-act="fall">${p.fallen ? "Уже лежит" : "Упал"}</button></div>
  ${prompt}
  ${challengeHtml(p)}
  ${p.level > 3 && !g.dash ? `<button type="button" class="btn block" data-act="dash-start">Быстрое перемещение</button>` : ""}
  ${dashHtml(p)}
  <button type="button" class="btn gold block" data-act="open-card" data-id="${p.id}" data-kind="boon">Карта славы</button>
  ${escort}
  <button type="button" class="btn block" data-act="quest" data-delta="1">${win ? "Задание выполнено — победа" : "Задание выполнено"}</button>
  <p class="note">Движение, исследование, карты славы и задания можно мешать. После задания фаза подвигов продолжается. Первая попытка задания за ход не тратит действие.</p>
  ${planeToggle()}
  <p class="note">Исследование берёт карту оттуда, где герой: ${planeLabel(g.plane).toLowerCase()}, осталось ${g.decks[g.plane]}.</p>`;
}
function placesWord(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "локацию";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "локации";
  return "локаций";
}
function challengeHtml(p) {
  const c = state.game.challenge;
  if (!c) return "";
  const foes = livingFoes();
  if (!c.foeId) {
    const picks = foes.map((f) => `<button type="button" class="tiny" data-act="challenge-foe" data-id="${f.id}">${esc(f.heroName)}</button>`).join("");
    return `<div class="card stack"><p>Вызов</p><p class="note">Выберите героя, который стоит с вами в одной локации. Действие уже потрачено, отмена его вернёт.</p><div class="row">${picks}</div><button type="button" class="btn ghost" data-act="challenge-cancel">Отмена вызова</button></div>`;
  }
  const foe = byId(c.foeId);
  if (!foe) return "";
  const stat = statKey(c.stat);
  const statName = statTitle(stat);
  return `<article class="fight"><h3>Вызов: ${esc(foe.heroName)}</h3><p class="muted">Вы</p>${statBrief(p)}<p class="muted">${esc(foe.heroName)}</p>${statBrief(foe)}<div class="row">${statButtons("challenge-stat", "", stat)}</div><div class="spread"><span>У меня</span><div class="stepper"><button type="button" data-act="challenge-mod" data-key="mine" data-delta="-1">−</button><b>${c.mine}</b><button type="button" data-act="challenge-mod" data-key="mine" data-delta="1">+</button></div></div><div class="spread"><span>У соперника</span><div class="stepper"><button type="button" data-act="challenge-mod" data-key="theirs" data-delta="-1">−</button><b>${c.theirs}</b><button type="button" data-act="challenge-mod" data-key="theirs" data-delta="1">+</button></div></div><p class="compare">${compareLine(Number(c.mine) || 0, Number(c.theirs) || 0)}</p>${effectsBlock("Ваши эффекты по " + statName, effectsFor(p, stat))}${effectsBlock("Эффекты соперника по " + statName, effectsFor(foe, stat))}<div class="row"><button type="button" class="btn ${c.wound ? "gold" : ""}" data-act="challenge-hit">${c.wound ? "Рана уже есть — снять" : "Удача — +1 рана"}</button><button type="button" class="btn ${c.miss ? "gold" : ""}" data-act="challenge-miss">${c.miss ? "Неудача отмечена" : "Неудача"}</button></div><button type="button" class="btn block" data-act="challenge-close">Бой окончен</button><button type="button" class="btn ghost" data-act="challenge-cancel">Отмена вызова</button></article>`;
}
function dashHtml(p) {
  const d = state.game.dash;
  if (!d) return "";
  const max = Math.max(0, p.ap);
  return `<div class="card stack"><p>Быстрое перемещение</p><p class="note">Каждая локация стоит 1 действие. Сейчас хватает на ${max} ${placesWord(max)}. Слава и риск — общая сумма со всех этих локаций.</p><div class="spread"><span>Локации</span>${stepper(d.locations, "dash", 'data-key="locations"')}</div><div class="spread"><span>Слава</span>${stepper(d.glory, "dash", 'data-key="glory"')}</div><div class="spread"><span>Риск</span>${stepper(d.peril, "dash", 'data-key="peril"')}</div><button type="button" class="btn gold block" data-act="dash-go">Перейти</button><button type="button" class="btn ghost" data-act="dash-cancel">Отмена</button></div>`;
}
function signed(n) { n = num(n); return (n > 0 ? "+" : "") + n; }
function escortPanel(p) {
  const e = p.escort && p.escort.on ? p.escort : null;
  if (!e) return "";
  const summary = `ближний ${signed(e.melee)} · скорость ${signed(e.speed)} · магия ${signed(e.magic)}`;
  const form = e.editing
    ? `<p class="note">Введите поправки этой миссии. Потом закрепите жетон и играйте дальше: он останется на герое несколько ходов, пока не дойдёте до точки сброса.</p><div class="spread"><span>Ближний бой</span>${stepper(num(e.melee), "escort", 'data-key="melee"')}</div><div class="spread"><span>Скорость, действия</span>${stepper(num(e.speed), "escort", 'data-key="speed"')}</div><div class="spread"><span>Магия</span>${stepper(num(e.magic), "escort", 'data-key="magic"')}</div><button type="button" class="btn block" data-act="escort-pin">Закрепить жетон</button>`
    : `<p class="note">Жетон закреплён. ${summary}. Статы держатся, пока не сбросите жетон на нужной локации.</p><button type="button" class="tiny" data-act="escort-edit">Поправить статы</button>`;
  return `<div class="stack"><p><b>Жетон сопровождения</b></p>${form}<button type="button" class="btn gold block" data-act="escort-end">Сбросить жетон</button></div>`;
}
function discardBody() {
  const g = state.game;
  const p = current();
  let stay = "";
  if (!p.moved && !p.stayTaken) {
    stay = `<div class="stack"><p>Вы не двигались. Возьмите славу и риск клетки, на которой стоите.</p><div class="row"><span>Слава</span>${stepper(g.stay.glory, "stay", 'data-key="glory"')}</div><div class="row"><span>Риск</span>${stepper(g.stay.peril, "stay", 'data-key="peril"')}</div><button type="button" class="btn" data-act="take-stay">Взять с клетки</button></div>`;
  }
  return `${stay}<label class="row"><input type="checkbox" data-flag="saveAp" ${g.saveAp ? "checked" : ""} ${p.ap > 0 ? "" : "disabled"}> Сохранить 1 очко действия на чужой ход</label><div class="spread"><span>Карт в руке</span><div class="row"><button type="button" class="tiny" data-act="hand" data-delta="-1">−</button><b>${p.hand}</b><button type="button" class="tiny" data-act="hand" data-delta="1">+</button></div></div><p class="note">Если рука не пуста, сбросьте одну карту с руки, сокровище или столкновение из логова. Потом доберите до пяти. Лишнее сокровище снимается в списке карт героя.</p>`;
}
function phaseButtons() {
  const g = state.game;
  ensureDecks(g);
  if (g.phase === "recovery") return `<button type="button" class="btn gold block" data-act="finish">Восстановить</button><button type="button" class="btn ghost block" data-act="skip">Пропустить</button>`;
  if (g.phase === "location") return `<button type="button" class="btn gold block" data-act="finish" ${g.decks[g.plane] ? "" : "disabled"}>Открыл локацию</button><button type="button" class="btn ghost block" data-act="skip">Пропустить</button>`;
  if (g.phase === "discard") return `<button type="button" class="btn gold block" data-act="finish">Завершить ход</button><button type="button" class="btn ghost block" data-act="skip">Пропустить</button>`;
  return `<button type="button" class="btn gold block" data-act="finish">Готово</button><button type="button" class="btn ghost block" data-act="skip">Пропустить</button>`;
}
function overlays() {
  return menuHtml() + sheetHtml() + cardHtml() + victoryHtml() + rewardHtml() + counterHtml();
}
function counterRoll(foe) {
  const g = state.game;
  g.counterRolls = g.counterRolls || {};
  if (!g.counterRolls[foe.id]) g.counterRolls[foe.id] = { stat: "melee", mine: statsOf(foe).melee, monster: 0 };
  return g.counterRolls[foe.id];
}
function counterHtml() {
  if (!state.counter || !state.game) return "";
  const foes = counterFoes();
  if (!foes.length) return "";
  const me = current();
  const rows = foes.map((p) => {
    const roll = counterRoll(p);
    const stat = statKey(roll.stat);
    return `<article class="fight"><h3>${esc(p.heroName)}</h3><p class="note">${esc(p.playerName)} контратакует. Выберите стату и поправьте числа после кубиков. Успех сам добавляет ему славу +1 за рану. Провал — без награды, действие всё равно потрачено.</p><p class="muted">Его статы</p>${statBrief(p)}<p class="muted">Ваши статы</p>${statBrief(me)}<div class="row">${statButtons("counter-stat", `data-id="${p.id}"`, stat)}</div><div class="spread"><span>Его результат</span><div class="stepper"><button type="button" data-act="counter-mod" data-id="${p.id}" data-key="mine" data-delta="-1">−</button><b>${roll.mine}</b><button type="button" data-act="counter-mod" data-id="${p.id}" data-key="mine" data-delta="1">+</button></div></div><div class="spread"><span>Монстр</span><div class="stepper"><button type="button" data-act="counter-mod" data-id="${p.id}" data-key="monster" data-delta="-1">−</button><b>${roll.monster}</b><button type="button" data-act="counter-mod" data-id="${p.id}" data-key="monster" data-delta="1">+</button></div></div><p class="compare">${compareLine(Number(roll.mine) || 0, Number(roll.monster) || 0, "Контратака", "монстра")}</p>${effectsBlock("Его эффекты по " + statTitle(stat), effectsFor(p, stat))}<div class="row"><button type="button" class="btn gold" data-act="counter" data-id="${p.id}" data-result="hit">Успех — слава +1</button><button type="button" class="btn" data-act="counter" data-id="${p.id}" data-result="miss">Провал — пропуск</button></div></article>`;
  }).join("");
  return `<div class="modal reward"><div class="stack"><h2>Контратака</h2>${rows}</div></div>`;
}
function rewardHtml() {
  if (!state.reward || !state.game) return "";
  const r = state.reward;
  const step = (key, label) => `<div class="spread"><span>${label}</span><div class="stepper"><button type="button" data-act="reward" data-key="${key}" data-delta="-1">−</button><b>${r[key] || 0}</b><button type="button" data-act="reward" data-key="${key}" data-delta="1">+</button></div></div>`;
  return `<div class="modal reward"><div class="stack"><h2>Награда задания</h2><p class="note">Что герой получил за задание. Ноль — ничего не прибавлять. Ближний бой и скорость остаются на герое, скорость сразу добавляет действия. Уровень прибавится, когда закроете форму, если ползунок выключен.</p>${step("health", "Здоровье")}${step("peril", "Риск")}${step("glory", "Слава")}${step("melee", "Ближний бой")}${step("speed", "Скорость")}<div class="spread"><span>Без прибавления уровня</span><button type="button" class="switch ${r.noLevel ? "on" : ""}" data-act="reward-level" aria-pressed="${r.noLevel ? "true" : "false"}" aria-label="Без прибавления уровня"><span></span></button></div><button type="button" class="btn gold block" data-act="apply-reward">Применить</button><button type="button" class="btn ghost block" data-act="skip-reward">Без награды</button></div></div>`;
}
function menuHtml() {
  if (!state.menu) return "";
  return `<div class="sheet"><div class="stack"><h2>Меню</h2><button type="button" class="btn block" data-act="open-settings">Настройки партии</button><button type="button" class="btn block" data-act="go-library">Герои</button><button type="button" class="btn block" data-act="go-home">На главную</button><button type="button" class="btn danger block" data-act="reset-game">Сбросить партию</button><button type="button" class="btn ghost block" data-act="close">Закрыть</button></div></div>`;
}
function sheetHtml() {
  const p = state.sheetId ? byId(state.sheetId) : null;
  if (!p) return "";
  return `<div class="sheet"><div class="stack"><div class="spread"><h2>${esc(p.heroName)}</h2><button type="button" class="tiny" data-act="close">Закрыть</button></div><p class="note">Поправка, если нажали не туда. Оплата карт риска — в фазе злодеяний, и только чужим риском.</p>${counter("life", "Здоровье", p.health, "из " + p.healthMax, p.id, "health")}${counter("glory", "Слава", p.glory, "", p.id, "glory")}${counter("peril", "Риск", p.peril, "", p.id, "peril")}<div class="spread"><span>Вне хода</span><div class="row"><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="savedAp" data-delta="-1">−</button><b>${p.savedAp}</b><button type="button" class="tiny" data-act="bump" data-id="${p.id}" data-key="savedAp" data-delta="1">+</button></div></div></div></div>`;
}
function cardHtml() {
  const m = state.modal;
  if (!m) return "";
  const step = (key, label) => `<div class="spread"><span>${label}</span><div class="stepper"><button type="button" data-act="mod" data-key="${key}" data-delta="-1">−</button><b>${m[key]}</b><button type="button" data-act="mod" data-key="${key}" data-delta="1">+</button></div></div>`;
  const special = (m.kind === "boon" || m.kind === "treasure")
    ? `<div class="spread"><span>Особый эффект</span><button type="button" class="switch ${m.specialOn ? "on" : ""}" data-act="special-toggle" aria-pressed="${m.specialOn ? "true" : "false"}" aria-label="Особый эффект"><span></span></button></div>${m.specialOn ? `<div class="row"><button type="button" class="tiny ${m.specialStat === "melee" ? "gold" : ""}" data-act="special-stat" data-stat="melee">Ближний бой</button><button type="button" class="tiny ${m.specialStat === "magic" ? "gold" : ""}" data-act="special-stat" data-stat="magic">Магия</button></div><label class="field">Что делает<textarea data-bind="modal.specialText" placeholder="два кубика, взять высший">${esc(m.specialText || "")}</textarea></label>` : ""}`
    : "";
  const kinds = [["boon", "Преимущество"], ["treasure", "Сокровище"], ["instant", "Мгновенная"], ["curse", "Эффект"]].map(([id, name]) => `<button type="button" class="tiny ${m.kind === id ? "gold" : ""}" data-act="kind" data-kind="${id}">${name}</button>`).join("");
  const who = state.game.players.map((p) => `<option value="${p.id}" ${p.id === m.targetId ? "selected" : ""}>${esc(p.heroName)}</option>`).join("");
  const book = (m.kind === "boon" || m.kind === "treasure") ? savedCards(m.kind) : [];
  const nameBox = book.length ? `<div class="suggest" hidden></div>` : "";
  const typeBox = m.kind === "treasure" && savedTypes().length ? `<div class="suggest" hidden></div>` : "";
  return `<div class="modal"><div class="stack"><div class="spread"><h2>Карта или эффект</h2><button type="button" class="tiny" data-act="close-card">Закрыть</button></div><div class="row">${kinds}</div><label class="field">Название<input data-bind="modal.name" value="${esc(m.name)}" autocomplete="off" placeholder="Начните вводить">${nameBox}</label>${m.kind === "treasure" ? `<label class="field">Тип сокровища<input data-bind="modal.typeName" value="${esc(m.typeName)}" placeholder="шлем, плащ…" autocomplete="off">${typeBox}</label>` : ""}${m.kind === "curse" ? `<label class="field">На кого<select data-bind="modal.targetId">${who}</select></label>` : ""}${m.kind !== "curse" ? step("cost", "Цена в славе") : ""}<div class="row"><button type="button" class="tiny ${m.until === "permanent" ? "gold" : ""}" data-act="until" data-until="permanent">Постоянная</button><button type="button" class="tiny ${m.until === "turn" ? "gold" : ""}" data-act="until" data-until="turn">До восстановления</button></div>${step("melee", "Ближний")}${step("magic", "Магия")}${step("speed", "Скорость")}${step("heal", "Лечение сейчас")}${step("healthMax", "Максимум здоровья")}${step("boonLimit", "Предел преимуществ")}${step("treasureLimit", "Предел сокровищ")}${special}<button type="button" class="btn gold block" data-act="play-card">Сыграть</button></div></div>`;
}
function victoryHtml() {
  const g = state.game;
  if (!g || !g.victory) return "";
  const w = byId(g.victory.id);
  const why = g.victory.reason === "quests" ? `Выполнено заданий: ${w.quests}.` : "Остальные герои выбыли.";
  return `<div class="victory"><div class="stack"><p class="kicker">Победа</p><h2>${esc(w.heroName)}</h2><p>${esc(w.playerName)}. ${why}</p><button type="button" class="btn" data-act="undo">Отменить последний шаг</button><button type="button" class="btn gold" data-act="go-setup">Новая партия</button><button type="button" class="btn ghost" data-act="go-home">На главную</button></div></div>`;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[/^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]];
  const last = parts[parts.length - 1];
  cur[/^\d+$/.test(last) ? Number(last) : last] = value;
}
function bump(p, key, delta) {
  if (key === "health") p.health = clamp(p.health + delta, 0, p.healthMax);
  else if (key === "healthMax") {
    p.healthMax = Math.max(1, p.healthMax + delta);
    if (p.health > p.healthMax) p.health = p.healthMax;
  } else if (key === "savedAp") p.savedAp = clamp((p.savedAp || 0) + delta, 0, 1);
  else p[key] = Math.max(0, (p[key] || 0) + delta);
}
function cardOwner() {
  const m = state.modal;
  if (m.kind === "curse" || (m.targetId && m.targetId !== current().id)) return byId(m.targetId);
  return current();
}
function cardProblem() {
  const m = state.modal;
  const target = cardOwner();
  if (!target) return "Нет героя";
  const card = modalCard();
  if (m.kind !== "curse" && target.glory < Math.max(0, m.cost || 0)) return "Не хватает славы";
  if ((card.kind === "boon" || card.kind === "treasure") && card.until === "permanent") {
    const lim = limitsOf(target, card);
    const count = countKind(target, card.kind) + 1;
    if (count > (card.kind === "boon" ? lim.boon : lim.treasure)) return card.kind === "boon" ? "Предел преимуществ" : "Предел сокровищ";
  }
  return "";
}
function modalCard() {
  const m = state.modal;
  return {
    id: uid(), name: (m.name || "Эффект").trim(), kind: m.kind, typeName: (m.typeName || "").trim(),
    until: m.kind === "instant" ? "turn" : m.until,
    melee: m.melee || 0, magic: m.magic || 0, speed: m.speed || 0,
    heal: m.heal || 0, healthMax: m.healthMax || 0, boonLimit: m.boonLimit || 0, treasureLimit: m.treasureLimit || 0,
    cost: Math.max(0, m.cost || 0),
    special: (m.kind === "boon" || m.kind === "treasure") && m.specialOn && String(m.specialText || "").trim()
      ? { stat: m.specialStat === "melee" ? "melee" : "magic", text: String(m.specialText).trim() }
      : null,
  };
}
function playModal() {
  const m = state.modal;
  const target = cardOwner();
  const card = modalCard();
  if (m.kind !== "curse") target.glory -= card.cost;
  target.healthMax = Math.max(1, target.healthMax + card.healthMax);
  target.health += card.healthMax;
  if (card.heal) target.health += card.heal;
  if (target.health > target.healthMax) target.health = target.healthMax;
  if (target.health < 0) target.health = 0;
  target.cards.push(card);
  shiftAp(target, num(card.speed));
  const remembered = rememberCard(card);
  const bits = cardBits(card);
  if (num(card.speed)) bits.push("действия " + (num(card.speed) > 0 ? "+" : "") + num(card.speed));
  if (remembered === "new") bits.push("название сохранено");
  state.modal = null;
  if (bits.length) flash(bits.join(", "));
}
function makePlayer(seat, hero) {
  return {
    id: uid(), heroId: hero.id, playerName: seat.playerName.trim() || hero.name, heroName: hero.name,
    race: hero.race || "", ability: hero.ability || "", photo: hero.photo || "",
    cardStats: hero.stats.map((r) => ({ melee: Number(r.melee), magic: Number(r.magic), speed: Number(r.speed) })),
    baseHealth: Number(hero.health), baseBoon: Number(hero.boonLimit), baseTreasure: Number(hero.treasureLimit),
    level: 1, health: Number(hero.health), healthMax: Number(hero.health), glory: 1, peril: 1,
    ap: 0, savedAp: 0, quests: 0, moved: false, stayTaken: false, fallen: false, eliminated: false,
    abilityUsed: false, hand: 5, cards: [], rewardMelee: 0, rewardSpeed: 0,
  };
}
function openForm(hero, back) {
  state.formBack = back;
  state.draft = hero ? draftFromHero(hero) : emptyDraft();
  state.scan = { busy: false, error: "" };
  go("hero");
}
function changeSetting(key, delta) {
  const s = state.settings;
  if (key === "healthOnLevel") s.healthOnLevel = !s.healthOnLevel;
  if (key === "questsToWin") s.questsToWin = clamp(s.questsToWin + delta, 1, 12);
  if (key === "sets") s.sets = clamp(s.sets + delta, 1, 2);
  if (key === "surfacePerSet") s.surfacePerSet = clamp(s.surfacePerSet + delta, 0, 80);
  if (key === "dungeonPerSet") s.dungeonPerSet = clamp(s.dungeonPerSet + delta, 0, 80);
  if (key === "maxLevel") {
    s.maxLevel = clamp(s.maxLevel + delta, 4, 20);
    if (state.game) {
      const names = [];
      state.game.players.forEach((p) => { if (p.level > s.maxLevel) { p.level = s.maxLevel; names.push(p.heroName); } });
      if (names.length) flash("Потолок снижен. Опущены: " + names.join(", ") + ". Здоровье не менял.");
    }
  }
  saveSettings();
  if (state.game) settle();
  else render();
}

const actions = {
  back() { go(state.screen === "hero" ? (state.formBack || "library") : (state.back || "home")); },
  "go-home"() { state.menu = false; go("home"); },
  continue() { if (state.game) go("play"); },
  "open-settings"() { state.back = state.screen === "play" || state.screen === "setup" ? state.screen : "home"; state.menu = false; go("settings"); },
  "go-library"() { state.back = state.screen === "play" || state.screen === "setup" ? state.screen : "home"; state.menu = false; go("library"); },
  "go-setup"() { state.menu = false; startSetup(); },
  setting(btn) { changeSetting(btn.dataset.key, Number(btn.dataset.delta || 0)); },
  "new-hero"(btn) { openForm(null, state.screen === "setup" ? "setup" : "library"); setTimeout(() => pick(btn.dataset.mode), 0); },
  "blank-hero"() { openForm(null, "library"); },
  "edit-hero"(btn) { const h = state.heroes.find((x) => x.id === btn.dataset.id); if (h) openForm(h, "library"); },
  "delete-hero"(btn) {
    const h = state.heroes.find((x) => x.id === btn.dataset.id);
    state.confirm = { text: "Удалить «" + (h ? h.name : "героя") + "» из списка?", yes: "Удалить", run: async () => { await deleteHero(btn.dataset.id); state.heroes = await listHeroes(); } };
    render();
  },
  pick(btn) { pick(btn.dataset.mode); },
  async "save-hero"() {
    const bad = draftErrors(state.draft);
    if (bad.length) { flash("Заполните: " + bad.join(", ")); return; }
    const d = state.draft;
    await saveHero({
      id: d.id || uid(), name: d.name.trim(), race: d.race.trim(), setName: d.setName.trim(), ability: d.ability.trim(),
      health: Number(d.health), boonLimit: Number(d.boonLimit), treasureLimit: Number(d.treasureLimit),
      stats: d.stats.map((r) => ({ melee: Number(r.melee), magic: Number(r.magic), speed: Number(r.speed) })),
      photo: d.photo || "", ocrText: d.ocrText || "", updatedAt: Date.now(),
    });
    state.heroes = await listHeroes();
    flash("Герой сохранён");
    go(state.formBack || "library");
  },
  players(btn) {
    const n = clamp(state.setup.count + Number(btn.dataset.delta), 2, 6);
    const seats = state.setup.seats;
    while (seats.length < n) seats.push({ playerName: "Игрок " + (seats.length + 1), heroId: "" });
    seats.length = n;
    if (state.setup.first >= n) state.setup.first = 0;
    state.setup.count = n;
    render();
  },
  "pick-hero"(btn) {
    const i = Number(btn.dataset.seat);
    const id = btn.dataset.id;
    if (state.setup.seats.some((s, j) => j !== i && s.heroId === id)) { flash("Этот герой уже сидит за столом"); return; }
    state.setup.seats[i].heroId = state.setup.seats[i].heroId === id ? "" : id;
    render();
  },
  "seat-move"(btn) {
    const i = Number(btn.dataset.seat);
    const j = i + Number(btn.dataset.delta);
    const seats = state.setup.seats;
    if (j < 0 || j >= seats.length) return;
    const tmp = seats[i]; seats[i] = seats[j]; seats[j] = tmp;
    if (state.setup.first === i) state.setup.first = j;
    else if (state.setup.first === j) state.setup.first = i;
    render();
  },
  first(btn) { state.setup.first = Number(btn.dataset.seat); render(); },
  "roll-first"() {
    const rolls = state.setup.seats.map(() => 1 + Math.floor(Math.random() * 6));
    let best = 0;
    rolls.forEach((n, i) => { if (n > rolls[best]) best = i; });
    state.setup.die = rolls;
    state.setup.first = best;
    render();
  },
  "add-during-setup"() { openForm(null, "setup"); },
  "start-game"() {
    const setup = state.setup;
    if (setup.seats.some((s) => !s.heroId)) { flash("Выберите героя каждому"); return; }
    if (new Set(setup.seats.map((s) => s.heroId)).size !== setup.seats.length) { flash("Один герой не может сидеть дважды"); return; }
    state.game = {
      players: setup.seats.map((seat) => makePlayer(seat, state.heroes.find((h) => h.id === seat.heroId))),
      active: setup.first, phase: "recovery", round: 1, decks: startingDecks(state.settings), plane: "surface", locationsLeft: startingDecks(state.settings).surface + startingDecks(state.settings).dungeon,
      prompt: null, stay: { glory: 0, peril: 0 }, recover: { glory: 1, peril: 1 }, saveAp: false, pay: {}, fights: [], victory: null,
    };
    state.history = [];
    saveGame();
    go("play");
  },
  undo() {
    const prev = state.history.pop();
    if (!prev) return;
    state.game = prev;
    state.menu = false;
    state.reward = null;
    state.counter = null;
    saveGame();
    render();
  },
  roll() { state.die = 1 + Math.floor(Math.random() * 6); render(); },
  menu() { state.menu = true; render(); },
  close() { state.menu = false; state.sheetId = null; render(); },
  "close-card"() { state.modal = null; render(); },
  sheet(btn) { state.sheetId = btn.dataset.id; render(); },
  finish() {
    const phase = state.game.phase;
    ensureDecks(state.game);
    if (phase === "location" && state.game.decks[state.game.plane] <= 0) { flash("Эта колода пуста — переключите ползунок или пропустите"); return; }
    if (phase === "deeds" && state.game.challenge && !state.game.challenge.done) { flash("Сначала закончите вызов или отмените его"); return; }
    if (phase === "deeds") state.game.dash = null;
    if (phase === "villainy" && (state.game.fights || []).length > 0 && !state.game.counterSeen && counterFoes().length) {
      state.counter = true;
      render();
      return;
    }
    commit(() => {
      if (phase === "recovery") applyRecovery();
      else if (phase === "location") { drawLocation(state.game); nextPhase(); }
      else if (phase === "discard") endTurn();
      else nextPhase();
    });
  },
  skip() {
    if (state.game.phase === "deeds" && state.game.challenge && !state.game.challenge.done) { flash("Сначала закончите вызов или отмените его"); return; }
    commit(() => { if (state.game.phase === "deeds") state.game.dash = null; if (state.game.phase === "recovery") dropTurnCards(current()); if (state.game.phase === "discard") endTurn(); else nextPhase(); });
  },
  plane(btn) {
    ensureDecks(state.game);
    state.game.plane = btn.dataset.plane === "dungeon" ? "dungeon" : "surface";
    saveGame();
    render();
  },
  deck(btn) { commit(() => { ensureDecks(state.game); const id = state.game.plane; state.game.decks[id] = Math.max(0, state.game.decks[id] + Number(btn.dataset.delta)); state.game.locationsLeft = state.game.decks.surface + state.game.decks.dungeon; }); },
  pay(btn) {
    const id = btn.dataset.id;
    state.game.pay[id] = Math.max(1, (state.game.pay[id] || 1) + Number(btn.dataset.delta));
    render();
  },
  spend(btn) {
    const id = btn.dataset.id;
    const amount = state.game.pay[id] || 1;
    if (id === current().id) { flash("Свой риск тратить нельзя"); return; }
    const foe = byId(id);
    if (!foe || foe.peril < amount) { flash("У этого героя не хватает риска"); return; }
    commit(() => { foe.peril -= amount; });
  },
  bump(btn) { commit(() => bump(byId(btn.dataset.id), btn.dataset.key, Number(btn.dataset.delta))); },
  recover(btn) {
    const g = state.game;
    g.recover = g.recover || { glory: 1, peril: 1 };
    const key = btn.dataset.key === "peril" ? "peril" : "glory";
    g.recover[key] = Math.max(0, num(g.recover[key]) + Number(btn.dataset.delta));
    saveGame();
    render();
  },
  "pick-target"(btn) {
    state.game.targetId = btn.dataset.id;
    const foe = byId(btn.dataset.id);
    (state.game.fights || []).forEach((f) => {
      f.foeId = btn.dataset.id;
      if (foe) f.theirs = statsOf(foe)[statKey(f.stat)];
    });
    saveGame();
    render();
  },
  "grant-peril"(btn) { commit(() => { byId(btn.dataset.id).peril += 1; }); },
  "grant-glory"() { commit(() => { current().glory += 1; }); },
  "cards-played"() {
    if (!counterFoes().length) {
      state.game.counterSeen = true;
      state.counter = null;
      saveGame();
      flash("Сохранённых действий для контратаки нет");
      return;
    }
    state.counter = true;
    render();
  },
  counter(btn) {
    const foe = byId(btn.dataset.id);
    if (!foe) return;
    const hit = btn.dataset.result === "hit";
    commit(() => {
      foe.savedAp = 0;
      if (hit) foe.glory += 1;
      if (!counterFoes().length) {
        state.counter = null;
        state.game.counterSeen = true;
      }
    });
    flash(hit ? foe.heroName + ": рана монстру, слава +1" : foe.heroName + ": пропуск, без награды");
  },
  level(btn) {
    const delta = Number(btn.dataset.delta);
    commit(() => {
      const info = changeLevel(current(), delta);
      if (info === null && delta > 0) flash("Это максимальный уровень");
      else if (info) flash(info);
      else flash("Уровень " + current().level);
    });
  },
  quest(btn) { commit(() => addQuest(Number(btn.dataset.delta))); },
  "escort-start"() {
    const p = current();
    if (p.escort && p.escort.on) return;
    commit(() => { p.escort = { on: true, editing: true, melee: 0, magic: 0, speed: 0, apShift: 0 }; });
  },
  "escort-pin"() {
    const p = current();
    if (!p.escort || !p.escort.on) return;
    p.escort.editing = false;
    saveGame();
    render();
  },
  "escort-edit"() {
    const p = current();
    if (!p.escort || !p.escort.on) return;
    p.escort.editing = true;
    saveGame();
    render();
  },
  escort(btn) {
    const p = current();
    const key = btn.dataset.key;
    if (!p.escort || !p.escort.on || (key !== "melee" && key !== "magic" && key !== "speed")) return;
    const delta = Number(btn.dataset.delta);
    commit(() => {
      const before = p.ap;
      p.escort[key] = num(p.escort[key]) + delta;
      if (key === "speed") {
        shiftAp(p, delta);
        p.escort.apShift = num(p.escort.apShift) + (p.ap - before);
      }
    });
  },
  "escort-end"() {
    const p = current();
    if (!p.escort || !p.escort.on) return;
    commit(() => {
      shiftAp(p, -num(p.escort.apShift));
      p.escort = { on: false, melee: 0, magic: 0, speed: 0, apShift: 0 };
      addQuest(1);
    });
  },
  reward(btn) {
    const r = state.reward;
    if (!r) return;
    r[btn.dataset.key] = clamp((r[btn.dataset.key] || 0) + Number(btn.dataset.delta), 0, 20);
    render();
  },
  "reward-level"() {
    if (!state.reward) return;
    state.reward.noLevel = !state.reward.noLevel;
    render();
  },
  "skip-reward"() {
    const r = state.reward;
    const p = current();
    state.reward = null;
    if (!p) { render(); return; }
    if (r && r.noLevel) commit(() => { p.questsWithoutLevel = (p.questsWithoutLevel || 0) + 1; });
    else commit(() => { const info = changeLevel(p, 1); flash(info === null ? "Уровень уже максимальный" : "Уровень " + p.level); });
  },
  "apply-reward"() {
    const r = state.reward || { health: 0, peril: 0, glory: 0, melee: 0, speed: 0, noLevel: false };
    const p = current();
    state.reward = null;
    if (!p) { render(); return; }
    const stats = r.health || r.peril || r.glory || r.melee || r.speed;
    const room = p.healthMax - p.health;
    commit(() => {
      if (r.noLevel) p.questsWithoutLevel = (p.questsWithoutLevel || 0) + 1;
      else changeLevel(p, 1);
      if (stats) {
        p.health = clamp(p.health + (r.health || 0), 0, p.healthMax);
        p.peril = Math.max(0, p.peril + (r.peril || 0));
        p.glory = Math.max(0, p.glory + (r.glory || 0));
        p.rewardMelee = Math.max(0, (p.rewardMelee || 0) + (r.melee || 0));
        p.rewardSpeed = Math.max(0, (p.rewardSpeed || 0) + (r.speed || 0));
        if (r.speed) shiftAp(p, r.speed);
      }
    });
    if ((r.health || 0) > room) flash("Здоровье упёрлось в максимум. Поднимите максимум, если награда больше.");
  },
  "fight-count"(btn) { setFightCount((state.game.fights || []).length + Number(btn.dataset.delta)); },
  "fight-stat"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    if (!f) return;
    f.stat = statKey(btn.dataset.stat);
    const me = current();
    const foe = byId(f.foeId);
    if (me) f.mine = statsOf(me)[f.stat];
    if (foe) f.theirs = statsOf(foe)[f.stat];
    if (f.glory == null) f.glory = 1;
    saveGame();
    render();
  },
  "fight-foe"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    if (!f) return;
    f.foeId = btn.dataset.id;
    const foe = byId(f.foeId);
    if (foe) f.theirs = statsOf(foe)[statKey(f.stat)];
    saveGame();
    render();
  },
  "fight-mod"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    if (!f) return;
    const key = btn.dataset.key === "theirs" ? "theirs" : btn.dataset.key === "glory" ? "glory" : "mine";
    f[key] = Math.max(0, (Number(f[key]) || 0) + Number(btn.dataset.delta));
    saveGame();
    render();
  },
  "fight-wound"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    const foe = f && byId(f.foeId);
    if (!f || !foe) return;
    commit(() => {
      if (f.wound) { foe.peril = Math.max(0, foe.peril - 1); f.wound = false; }
      else { foe.peril += 1; f.wound = true; }
    });
    flash(f.wound ? foe.heroName + ": риск +1 за рану" : "Риск за рану снят");
  },
  "fight-miss"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    if (!f) return;
    f.miss = !f.miss;
    saveGame();
    render();
  },
  "fight-success"(btn) {
    const f = (state.game.fights || [])[Number(btn.dataset.i)];
    const me = current();
    if (!f || !me || statKey(f.stat) !== "speed") return;
    commit(() => {
      if (f.gloryTaken) {
        me.glory = Math.max(0, me.glory - (f.gloryTakenAmount || 0));
        f.gloryTaken = false;
        f.gloryTakenAmount = 0;
      } else {
        const amount = Math.max(0, Number(f.glory) || 0);
        me.glory += amount;
        f.gloryTaken = true;
        f.gloryTakenAmount = amount;
      }
    });
    flash(f.gloryTaken ? "Слава +" + f.gloryTakenAmount : "Слава за успех снята");
  },
  "counter-stat"(btn) {
    const foe = byId(btn.dataset.id);
    if (!foe) return;
    const roll = counterRoll(foe);
    roll.stat = statKey(btn.dataset.stat);
    roll.mine = statsOf(foe)[roll.stat];
    saveGame();
    render();
  },
  "counter-mod"(btn) {
    const foe = byId(btn.dataset.id);
    if (!foe) return;
    const roll = counterRoll(foe);
    const key = btn.dataset.key === "monster" ? "monster" : "mine";
    roll[key] = Math.max(0, (Number(roll[key]) || 0) + Number(btn.dataset.delta));
    saveGame();
    render();
  },
  ability() { commit(() => { current().abilityUsed = !current().abilityUsed; }); },
  "challenge-start"() {
    const p = current();
    if (p.fallen) { flash("Сначала встаньте"); return; }
    if (p.ap < 1) { flash("Нет очков действия"); return; }
    if (!livingFoes().length) { flash("Некого вызывать"); return; }
    if (state.game.challenge) { flash("Вызов уже идёт"); return; }
    commit(() => {
      p.ap -= 1;
      state.game.challenge = { foeId: "", stat: "melee", mine: statsOf(p).melee, theirs: 0, wound: false, miss: false, done: false };
    });
  },
  "challenge-foe"(btn) {
    const c = state.game.challenge;
    const foe = byId(btn.dataset.id);
    if (!c || !foe) return;
    c.foeId = foe.id;
    c.stat = "melee";
    c.mine = statsOf(current()).melee;
    c.theirs = statsOf(foe).melee;
    c.wound = false;
    c.miss = false;
    c.done = false;
    saveGame();
    render();
  },
  "challenge-stat"(btn) {
    const c = state.game.challenge;
    const foe = c && byId(c.foeId);
    if (!c || !foe) return;
    c.stat = statKey(btn.dataset.stat);
    c.mine = statsOf(current())[c.stat];
    c.theirs = statsOf(foe)[c.stat];
    saveGame();
    render();
  },
  "challenge-mod"(btn) {
    const c = state.game.challenge;
    if (!c) return;
    const key = btn.dataset.key === "theirs" ? "theirs" : "mine";
    c[key] = Math.max(0, (Number(c[key]) || 0) + Number(btn.dataset.delta));
    saveGame();
    render();
  },
  "challenge-hit"() {
    const c = state.game.challenge;
    const foe = c && byId(c.foeId);
    if (!c || !foe) return;
    commit(() => {
      if (c.wound) { foe.peril = Math.max(0, foe.peril - 1); c.wound = false; }
      else { foe.peril += 1; c.wound = true; c.miss = false; c.done = true; }
    });
    flash(c.wound ? foe.heroName + ": риск +1 за рану" : "Рана снята");
  },
  "challenge-miss"() {
    const c = state.game.challenge;
    if (!c) return;
    c.miss = !c.miss;
    if (c.miss) c.done = true;
    saveGame();
    render();
  },
  "challenge-close"() {
    const c = state.game.challenge;
    if (!c || !c.foeId) { flash("Сначала выберите соперника или отмените вызов"); return; }
    state.game.challenge = null;
    saveGame();
    render();
  },
  "challenge-cancel"() {
    const p = current();
    const c = state.game.challenge;
    if (!c) return;
    commit(() => {
      if (c.wound) {
        const foe = byId(c.foeId);
        if (foe) foe.peril = Math.max(0, foe.peril - 1);
      }
      p.ap += 1;
      state.game.challenge = null;
    });
  },
  "dash-start"() {
    const p = current();
    if (p.level <= 3) return;
    if (p.fallen) { flash("Сначала встаньте"); return; }
    if (p.ap < 1) { flash("Нет очков действия"); return; }
    state.game.dash = { locations: 1, glory: 0, peril: 0 };
    saveGame();
    render();
  },
  dash(btn) {
    const p = current();
    const d = state.game.dash;
    if (!d) return;
    const key = btn.dataset.key;
    const delta = Number(btn.dataset.delta);
    if (key === "locations") {
      const next = d.locations + delta;
      if (next > p.ap) { flash("Действий хватает на " + p.ap + " " + placesWord(p.ap)); return; }
      d.locations = Math.max(1, next);
    } else d[key] = Math.max(0, (Number(d[key]) || 0) + delta);
    saveGame();
    render();
  },
  "dash-go"() {
    const p = current();
    const d = state.game.dash;
    if (!d) return;
    if (p.fallen) { flash("Сначала встаньте"); return; }
    if (d.locations > p.ap) { flash("Действий хватает на " + p.ap + " " + placesWord(p.ap)); return; }
    commit(() => {
      p.ap -= d.locations;
      p.glory += d.glory;
      p.peril += d.peril;
      p.moved = true;
      state.game.dash = null;
    });
  },
  "dash-cancel"() { state.game.dash = null; saveGame(); render(); },
  move() {
    const p = current();
    if (p.fallen) { flash("Сначала встаньте"); return; }
    if (p.ap < 1) { flash("Нет очков действия"); return; }
    commit(() => { p.ap -= 1; state.game.prompt = { type: "move", glory: 0, peril: 0, wasMoved: p.moved }; });
  },
  "move-new"() { commit(() => { const p = current(); const pr = state.game.prompt; p.glory += pr.glory; p.peril += pr.peril; p.moved = true; state.game.prompt = null; }); },
  "move-old"() { commit(() => { current().moved = true; state.game.prompt = null; }); },
  "move-cancel"() { commit(() => { const p = current(); p.ap += 1; p.moved = state.game.prompt.wasMoved; state.game.prompt = null; }); },
  prompt(btn) { const pr = state.game.prompt; pr[btn.dataset.key] = Math.max(0, pr[btn.dataset.key] + Number(btn.dataset.delta)); render(); },
  explore() {
    const p = current();
    if (p.fallen) { flash("Лёжа можно только встать"); return; }
    if (p.ap < 1) { flash("Нет очков действия"); return; }
    ensureDecks(state.game);
    if (state.game.decks[state.game.plane] < 1) { flash("Колода «" + planeLabel(state.game.plane) + "» пуста"); return; }
    commit(() => { p.ap -= 1; drawLocation(state.game); });
  },
  fall() { if (!current().fallen) commit(() => { current().fallen = true; }); },
  stand() {
    const p = current();
    if (!p.fallen) return;
    if (p.ap < 1 && p.savedAp < 1) { flash("Нет очка действия, чтобы встать"); return; }
    commit(() => { if (p.ap > 0) p.ap -= 1; else p.savedAp -= 1; p.fallen = false; });
  },
  stay(btn) { state.game.stay[btn.dataset.key] = Math.max(0, state.game.stay[btn.dataset.key] + Number(btn.dataset.delta)); render(); },
  "take-stay"() { commit(() => { const p = current(); p.glory += state.game.stay.glory; p.peril += state.game.stay.peril; p.stayTaken = true; }); },
  hand(btn) { commit(() => { current().hand = Math.max(0, current().hand + Number(btn.dataset.delta)); }); },
  "open-card"(btn) {
    const kind = btn.dataset.kind || "boon";
    state.modal = {
      name: "", kind, typeName: "", cost: kind === "curse" ? 0 : 1,
      until: kind === "instant" || kind === "curse" ? "turn" : "permanent",
      melee: 0, magic: 0, speed: 0, heal: 0, healthMax: 0, boonLimit: 0, treasureLimit: 0,
      specialOn: false, specialStat: "magic", specialText: "",
      targetId: btn.dataset.id || current().id,
    };
    render();
  },
  kind(btn) {
    state.modal.kind = btn.dataset.kind;
    if (btn.dataset.kind === "instant") state.modal.until = "turn";
    if (btn.dataset.kind === "boon" || btn.dataset.kind === "treasure") state.modal.until = "permanent";
    render();
  },
  until(btn) { if (state.modal.kind !== "instant") { state.modal.until = btn.dataset.until; render(); } },
  mod(btn) { state.modal[btn.dataset.key] = (state.modal[btn.dataset.key] || 0) + Number(btn.dataset.delta); render(); },
  "special-toggle"() { state.modal.specialOn = !state.modal.specialOn; render(); },
  "special-stat"(btn) { state.modal.specialStat = btn.dataset.stat === "melee" ? "melee" : "magic"; render(); },
  "pick-card"(btn) {
    const found = loadCardBook().find((c) => c.id === btn.dataset.id);
    if (!found) return;
    applySavedCard(found);
    render();
  },
  "pick-type"(btn) {
    if (!state.modal) return;
    state.modal.typeName = btn.dataset.type || "";
    render();
  },
  "play-card"() {
    const problem = cardProblem();
    if (problem) { flash(problem); return; }
    commit(() => playModal());
  },
  "drop-card"(btn) { commit(() => removeCard(byId(btn.dataset.pid), btn.dataset.cid)); },
  "reset-game"() {
    state.confirm = { text: "Сбросить текущую партию? Герои в списке останутся.", yes: "Сбросить", run: () => { state.game = null; state.history = []; saveGame(); state.menu = false; go("home"); } };
    render();
  },
  "confirm-yes"() { const run = state.confirm && state.confirm.run; state.confirm = null; if (run) Promise.resolve(run()).then(() => render()); },
  "confirm-no"() { state.confirm = null; render(); },
  async "crop-read"() {
    const img = await loadSrc(state.originalSrc);
    await readPrepared(cropCanvas(img, state.crop));
  },
  async "crop-full"() {
    const img = await loadSrc(state.originalSrc);
    await readPrepared(drawImage(img, 1600, false));
  },
  "crop-cancel"() { state.crop = null; render(); },
  "crop-again"() {
    if (!state.originalSrc || !state.cropSize) return;
    state.crop = Object.assign({ src: state.originalSrc }, defaultCrop(state.cropSize.w, state.cropSize.h));
    render();
  },
  async "refresh-app"() {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
    } catch (e) { /* всё равно перезагружаем */ }
    location.reload();
  },
};

function pick(mode) {
  const input = document.getElementById(mode === "camera" ? "camera-input" : "photo-input");
  input.click();
}
function startSetup() {
  if (state.heroes.length < 2) { flash("Сначала добавьте хотя бы двух героев"); go("library"); return; }
  state.setup = { count: 2, first: 0, die: null, seats: [{ playerName: "Игрок 1", heroId: "" }, { playerName: "Игрок 2", heroId: "" }] };
  go("setup");
}
function onInput(e) {
  const el = e.target;
  if (el.dataset.flag === "saveAp" && state.game) { state.game.saveAp = el.checked; return; }
  if (el.dataset.fillCard != null && state.modal) {
    const found = loadCardBook().find((c) => c.id === el.value);
    if (found) applySavedCard(found);
    render();
    return;
  }
  if (!el.dataset.bind) return;
  let value = el.value;
  if (el.dataset.num) {
    value = value === "" ? null : Number(value);
    el.classList.toggle("missing", value == null || Number.isNaN(value));
  }
  const path = el.dataset.bind;
  if (path.startsWith("draft.")) setPath(state.draft, path.slice(6), value);
  else if (path.startsWith("modal.")) {
    setPath(state.modal, path.slice(6), value);
    if (path === "modal.name" || path === "modal.typeName") refreshSuggest(el);
    if (e.type === "change" && path === "modal.name" && (state.modal.kind === "boon" || state.modal.kind === "treasure")) {
      const found = savedCards(state.modal.kind).find((c) => c.name.toLowerCase() === String(value).trim().toLowerCase());
      if (found) { applySavedCard(found); render(); }
    }
  }
  else if (path.startsWith("seat.")) {
    const parts = path.split(".");
    state.setup.seats[Number(parts[1])][parts[2]] = value;
  }
}
function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const fn = actions[btn.dataset.act];
  if (fn) Promise.resolve(fn(btn)).catch((err) => { console.error(err); flash("Что-то пошло не так. Попробуйте ещё раз."); });
}
async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (file && state.draft) await startCrop(file);
}

function bind() {
  window.addEventListener("click", onClick, true);
  app.addEventListener("input", onInput);
  app.addEventListener("change", onInput);
  app.addEventListener("focusin", (e) => {
    if (e.target.dataset && (e.target.dataset.bind === "modal.name" || e.target.dataset.bind === "modal.typeName")) refreshSuggest(e.target);
  });
  app.addEventListener("focusout", (e) => {
    const box = e.target.parentElement && e.target.parentElement.querySelector(".suggest");
    if (box) setTimeout(() => { box.hidden = true; }, 250);
  });
  app.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".suggest button")) e.preventDefault();
  });
  document.getElementById("photo-input").addEventListener("change", onFile);
  document.getElementById("camera-input").addEventListener("change", onFile);
}
async function boot() {
  state.settings = loadSettings();
  state.game = loadGame();
  try { state.heroes = await listHeroes(); } catch (e) { state.heroes = []; }
  bind();
  render(true);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();
