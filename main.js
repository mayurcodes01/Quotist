const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const GITHUB_URL = "https://github.com/mayurcodes01";

let backend = null;
let backendBuffer = "";
let sequence = 0;
let mainWindow = null;
const pending = new Map();

function backendCommand() {
  const dbPath = path.join(app.getPath("userData"), "quotist.db");
  if (app.isPackaged) {
    const name = process.platform === "win32" ? "quotist_backend.exe" : "quotist_backend";
    return { command: path.join(process.resourcesPath, "backend", name), args: [dbPath] };
  }
  const python = process.platform === "win32" ? "python" : "python3";
  return { command: python, args: [path.join(__dirname, "backend", "backend.py"), dbPath] };
}

function failPending(message) {
  pending.forEach((entry) => entry.resolve({ ok: false, error: message }));
  pending.clear();
}

function startBackend() {
  const { command, args } = backendCommand();
  backend = spawn(command, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })
  });
  backend.stdout.setEncoding("utf8");
  backend.stdout.on("data", (chunk) => {
    backendBuffer += chunk;
    let index = backendBuffer.indexOf("\n");
    while (index >= 0) {
      const line = backendBuffer.slice(0, index).trim();
      backendBuffer = backendBuffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            entry.resolve(message);
          }
        } catch (error) {
          continue;
        }
      }
      index = backendBuffer.indexOf("\n");
    }
  });
  backend.stderr.on("data", () => {});
  backend.on("error", (error) => {
    backend = null;
    failPending("Backend could not start: " + error.message);
  });
  backend.on("exit", () => {
    backend = null;
    failPending("Backend stopped unexpectedly");
  });
}

function callBackend(action, payload) {
  return new Promise((resolve) => {
    if (!backend) {
      resolve({ ok: false, error: "Backend is not running" });
      return;
    }
    sequence += 1;
    pending.set(sequence, { resolve });
    backend.stdin.write(JSON.stringify({ id: sequence, action, payload: payload || {} }) + "\n");
  });
}

function cleanItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, 5000).map((item) => ({
    text: String((item && item.text) || ""),
    author: String((item && item.author) || ""),
    category: String((item && item.category) || ""),
    created_at: item && item.created_at ? String(item.created_at) : ""
  }));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildText(items) {
  const header = "Quotist\nExported " + new Date().toLocaleString() + "\n\n";
  const body = items
    .map((item) => '"' + item.text + '"\n' + item.author + " (" + item.category + ")")
    .join("\n\n");
  return header + body + "\n";
}

function buildPdfHtml(items) {
  const blocks = items
    .map((item) => {
      const stamp = item.created_at ? " | " + escapeHtml(new Date(item.created_at).toLocaleString()) : "";
      return (
        '<div class="entry"><p class="text">&ldquo;' +
        escapeHtml(item.text) +
        '&rdquo;</p><p class="author">' +
        escapeHtml(item.author) +
        '</p><p class="meta">' +
        escapeHtml(item.category) +
        stamp +
        "</p></div>"
      );
    })
    .join("");
  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    "@page{size:A4;margin:22mm 20mm}" +
    "body{font-family:'Palatino Linotype',Palatino,Georgia,serif;color:#1b1f2a;margin:0}" +
    "header{border-bottom:2px solid #1b1f2a;padding-bottom:10px;margin-bottom:28px}" +
    "header h1{font-size:30px;margin:0;letter-spacing:.5px}" +
    "header p{margin:4px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#5b6272}" +
    ".entry{page-break-inside:avoid;margin-bottom:26px;padding-left:16px;border-left:3px solid #6d5dfc}" +
    ".text{font-size:19px;line-height:1.5;margin:0 0 8px}" +
    ".author{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:600;margin:0}" +
    ".meta{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#7a8091;margin:2px 0 0}" +
    "</style></head><body><header><h1>Quotist</h1><p>Exported " +
    escapeHtml(new Date().toLocaleString()) +
    "</p></header>" +
    blocks +
    "</body></html>"
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "Quotist",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("api", (event, action, payload) => callBackend(String(action), payload));

ipcMain.handle("export-text", async (event, rawItems, name) => {
  const items = cleanItems(rawItems);
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: String(name || "quotist") + ".txt",
    filters: [{ name: "Text file", extensions: ["txt"] }]
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  try {
    fs.writeFileSync(result.filePath, buildText(items), "utf8");
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle("export-pdf", async (event, rawItems, name) => {
  const items = cleanItems(rawItems);
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    defaultPath: String(name || "quotist") + ".pdf",
    filters: [{ name: "PDF document", extensions: ["pdf"] }]
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await printer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(buildPdfHtml(items)));
    const data = await printer.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
    fs.writeFileSync(result.filePath, data);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  } finally {
    printer.destroy();
  }
});

ipcMain.handle("open-external", async (event, url) => {
  if (url === GITHUB_URL) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.on("win-min", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on("win-max", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on("win-close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    startBackend();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    if (backend) {
      backend.kill();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
