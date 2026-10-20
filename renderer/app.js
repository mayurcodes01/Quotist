const bridge = window.quotist;
const GITHUB_URL = "https://github.com/mayurcodes01";

const THEMES = [
  { id: "aurora", name: "Aurora", colors: ["#2dd4bf", "#8b5cf6"] },
  { id: "ocean", name: "Ocean", colors: ["#3b82f6", "#06b6d4"] },
  { id: "sunset", name: "Sunset", colors: ["#fb923c", "#ec4899"] },
  { id: "forest", name: "Forest", colors: ["#22c55e", "#84cc16"] },
  { id: "rose", name: "Rose", colors: ["#f472b6", "#fb7185"] },
  { id: "graphite", name: "Graphite", colors: ["#94a3b8", "#cbd5e1"] }
];

const state = {
  category: "All",
  current: null,
  count: 0,
  history: [],
  settings: {}
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function request(action, payload) {
  const response = await bridge.call(action, payload || {});
  if (!response.ok) {
    throw new Error(response.error || "Request failed");
  }
  return response.data;
}

let toastTimer = null;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
}

function quoteLine(item) {
  return "\u201C" + item.text + "\u201D\n" + item.author;
}

function moveIndicator() {
  const active = $(".tab.active");
  const indicator = $("#indicator");
  indicator.style.height = active.offsetHeight + "px";
  indicator.style.transform = "translateY(" + active.offsetTop + "px)";
}

function switchTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-" + name));
  moveIndicator();
  if (name === "history") {
    loadHistory();
  }
  if (name === "settings") {
    refreshStats();
  }
}

async function refreshStats() {
  try {
    const stats = await request("library_stats");
    $("#statTotal").textContent = stats.total.toLocaleString();
    $("#statBuiltin").textContent = stats.builtin.toLocaleString();
    $("#statOnline").textContent = stats.online.toLocaleString();
  } catch (error) {
    toast(error.message);
  }
}

function wrapLines(text, max) {
  const lines = [];
  let current = "";
  text.split(/\s+/).forEach((word) => {
    if (current && (current + " " + word).length > max) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function renderEditor(lines, author) {
  const code = $("#quoteLines");
  const gutter = $("#gutter");
  code.innerHTML = "";
  gutter.innerHTML = "";
  const rows = lines.map((text, index) => {
    const line = document.createElement("span");
    line.className = "line quote";
    line.style.animationDelay = index * 70 + "ms";
    if (index === 0) {
      const open = document.createElement("span");
      open.className = "q";
      open.textContent = "\u201C";
      line.appendChild(open);
    }
    line.appendChild(document.createTextNode(text));
    if (index === lines.length - 1) {
      const close = document.createElement("span");
      close.className = "q";
      close.textContent = "\u201D";
      line.appendChild(close);
    }
    return line;
  });
  if (author) {
    const credit = document.createElement("span");
    credit.className = "line author";
    credit.style.animationDelay = lines.length * 70 + "ms";
    credit.textContent = author;
    rows.push(credit);
  }
  rows.forEach((row, index) => {
    code.appendChild(row);
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    gutter.appendChild(number);
  });
  $("#quoteMeta").textContent = "ln " + rows.length + ", utf-8";
}

function showQuote(quote) {
  state.current = quote;
  state.count += 1;
  const long = quote.text.length > 170;
  const lines = wrapLines(quote.text, long ? 46 : 34);
  const card = $("#quoteCard");
  card.style.setProperty("--q-size", lines.length <= 3 ? "30px" : lines.length <= 5 ? "25px" : lines.length <= 7 ? "21px" : "18px");
  renderEditor(lines, quote.author);
  $("#fileName").textContent = "quote_" + String(state.count).padStart(3, "0") + ".txt";
  const chip = $("#quoteCat");
  chip.textContent = String(quote.category || "").toLowerCase();
  chip.classList.toggle("hidden", !quote.category);
  ["#btnCopy", "#btnTxt", "#btnPdf", "#btnSave"].forEach((id) => {
    $(id).disabled = false;
  });
  $("#btnSave").disabled = quote.id !== null;
  if (quote.offline_fallback) {
    toast("Could not reach the online source. Showing a quote from your library.");
  }
}

function showPlaceholder() {
  const card = $("#quoteCard");
  card.style.setProperty("--q-size", "24px");
  const code = $("#quoteLines");
  const gutter = $("#gutter");
  code.innerHTML = "";
  gutter.innerHTML = "";
  ["// no quote yet", "// press generate or hit enter"].forEach((text, index) => {
    const line = document.createElement("span");
    line.className = "line comment";
    line.style.fontSize = "1em";
    line.style.lineHeight = "1.5";
    line.textContent = text;
    code.appendChild(line);
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    gutter.appendChild(number);
  });
}

async function generate() {
  const button = $("#btnGenerate");
  button.disabled = true;
  const online = state.settings.online_enabled === "1";
  if (online) {
    button.textContent = "Generating...";
  }
  try {
    const quote = await request("generate", {
      category: state.category,
      keyword: $("#keyword").value,
      last: state.current ? state.current.text : ""
    });
    showQuote(quote);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = "Generate <kbd>\u21B5</kbd>";
  }
}

async function syncLibrary() {
  const button = $("#btnSync");
  button.disabled = true;
  button.textContent = "Syncing...";
  try {
    const result = await request("library_sync");
    await refreshStats();
    if (result.partial) {
      toast("Connection dropped. Added " + result.added + " quotes so far.");
    } else if (result.added > 0) {
      toast("Added " + result.added.toLocaleString() + " new quotes to your library");
    } else {
      toast("Your library is already up to date");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Sync library";
  }
}

async function saveCurrent() {
  if (!state.current || state.current.id !== null) {
    return;
  }
  try {
    const saved = await request("history_add", state.current);
    state.current.id = saved.id;
    $("#btnSave").disabled = true;
    toast("Saved to history");
  } catch (error) {
    toast(error.message);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch (error) {
    toast("Copy failed");
  }
}

async function runExport(kind, items, name) {
  if (!items.length) {
    toast("There is nothing to export");
    return;
  }
  const result = kind === "pdf" ? await bridge.exportPdf(items, name) : await bridge.exportText(items, name);
  if (result.ok) {
    toast(kind === "pdf" ? "PDF exported" : "Text file exported");
  } else if (!result.canceled) {
    toast(result.error || "Export failed");
  }
}

async function loadHistory() {
  try {
    state.history = await request("history_list", { search: $("#historySearch").value });
    renderHistory();
  } catch (error) {
    toast(error.message);
  }
}

function formatDate(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function renderHistory() {
  const list = $("#historyList");
  list.innerHTML = "";
  const total = state.history.length;
  $("#historyCount").textContent = total + (total === 1 ? " item" : " items");
  $("#historyEmpty").classList.toggle("hidden", total > 0);
  list.classList.toggle("hidden", total === 0);
  state.history.forEach((item) => {
    const row = document.createElement("article");
    row.className = "item";

    const body = document.createElement("div");
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = "\u201C" + item.text + "\u201D";
    const meta = document.createElement("p");
    meta.className = "item-meta";
    const author = document.createElement("strong");
    author.textContent = item.author;
    meta.appendChild(author);
    meta.appendChild(document.createTextNode("  #" + String(item.category).toLowerCase() + "  " + formatDate(item.created_at)));
    body.appendChild(text);
    body.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn ghost";
    copy.textContent = "copy";
    copy.addEventListener("click", () => copyText(quoteLine(item)));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost danger";
    remove.textContent = "del";
    remove.addEventListener("click", async () => {
      try {
        await request("history_delete", { id: item.id });
        await loadHistory();
      } catch (error) {
        toast(error.message);
      }
    });
    actions.appendChild(copy);
    actions.appendChild(remove);

    row.appendChild(body);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

let clearTimer = null;

function handleClear() {
  const button = $("#btnHistClear");
  if (!button.classList.contains("confirm")) {
    button.classList.add("confirm");
    button.textContent = "sure?";
    clearTimer = setTimeout(() => {
      button.classList.remove("confirm");
      button.textContent = "clear";
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  button.classList.remove("confirm");
  button.textContent = "clear";
  request("history_clear")
    .then(loadHistory)
    .then(() => toast("History cleared"))
    .catch((error) => toast(error.message));
}

function applySettings() {
  const root = document.documentElement;
  const settings = state.settings;
  root.dataset.theme = settings.theme;
  root.dataset.mode = settings.mode;
  $("#autoSave").checked = settings.auto_save === "1";
  $("#onlineEnabled").checked = settings.online_enabled === "1";
  $("#btnSave").classList.toggle("hidden", settings.auto_save === "1");
  $("#sourceNote").textContent =
    settings.online_enabled === "1"
      ? "online + library"
      : "local library";
  $$(".swatch").forEach((swatch) => swatch.classList.toggle("active", swatch.dataset.theme === settings.theme));
  $$("#modeSeg button").forEach((button) => button.classList.toggle("active", button.dataset.mode === settings.mode));
  requestAnimationFrame(moveIndicator);
}

async function saveSetting(key, value) {
  state.settings[key] = String(value);
  applySettings();
  try {
    await request("settings_set", { key, value });
  } catch (error) {
    toast(error.message);
  }
}

function buildSettingsControls() {
  const swatches = $("#swatches");
  THEMES.forEach((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.dataset.theme = theme.id;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = "linear-gradient(135deg, " + theme.colors[0] + ", " + theme.colors[1] + ")";
    const label = document.createElement("span");
    label.textContent = theme.name;
    button.appendChild(dot);
    button.appendChild(label);
    button.addEventListener("click", () => saveSetting("theme", theme.id));
    swatches.appendChild(button);
  });

  $$("#modeSeg button").forEach((button) => {
    button.addEventListener("click", () => saveSetting("mode", button.dataset.mode));
  });

  $("#autoSave").addEventListener("change", (event) => saveSetting("auto_save", event.target.checked ? "1" : "0"));
  $("#onlineEnabled").addEventListener("change", (event) => saveSetting("online_enabled", event.target.checked ? "1" : "0"));
}

function bindEvents() {
  showPlaceholder();
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  $("#btnGenerate").addEventListener("click", generate);
  $("#btnSave").addEventListener("click", saveCurrent);
  $("#btnSync").addEventListener("click", syncLibrary);
  $("#btnCopy").addEventListener("click", () => state.current && copyText(quoteLine(state.current)));
  $("#btnTxt").addEventListener("click", () => state.current && runExport("text", [state.current], "Quotist Quote"));
  $("#btnPdf").addEventListener("click", () => state.current && runExport("pdf", [state.current], "Quotist Quote"));
  $("#keyword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") generate();
  });

  let searchTimer = null;
  $("#historySearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadHistory, 160);
  });
  $("#btnHistTxt").addEventListener("click", () => runExport("text", state.history, "Quotist History"));
  $("#btnHistPdf").addEventListener("click", () => runExport("pdf", state.history, "Quotist History"));
  $("#btnHistClear").addEventListener("click", handleClear);

  $("#btnGithub").addEventListener("click", () => bridge.openExternal(GITHUB_URL));
  $("#btnMin").addEventListener("click", () => bridge.minimize());
  $("#btnClose").addEventListener("click", () => bridge.close());
  window.addEventListener("resize", moveIndicator);
}

async function init() {
  bindEvents();
  try {
    state.settings = await request("settings_get");
    buildSettingsControls();
    applySettings();
    await refreshStats();
  } catch (error) {
    toast(error.message);
  }
  moveIndicator();
}

init();
