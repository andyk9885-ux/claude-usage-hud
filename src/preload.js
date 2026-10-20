"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hud", {
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (fn) => ipcRenderer.on("state", (_e, s) => fn(s)),
  onClosing: (fn) => ipcRenderer.on("closing", () => fn()),
  toggle: () => ipcRenderer.send("toggle"),
  collapse: () => ipcRenderer.send("collapse"),
  collapseDone: () => ipcRenderer.send("collapse-done"),
  capture: (on) => ipcRenderer.send("capture", on),
  refresh: () => ipcRenderer.send("refresh"),
  setRange: (r) => ipcRenderer.send("set-range", r),
  setLogin: (on) => ipcRenderer.send("set-login", on),
  setTheme: (t) => ipcRenderer.send("set-theme", t),
  setColor: (c) => ipcRenderer.send("set-color", c),
  setLang: (l) => ipcRenderer.send("set-lang", l),
  holdOpen: (on) => ipcRenderer.send("hold-open", on),
  quit: () => ipcRenderer.send("quit"),
  dragStart: (y) => ipcRenderer.send("drag-start", y),
  dragMove: (y) => ipcRenderer.send("drag-move", y),
  dragEnd: () => ipcRenderer.send("drag-end"),
});
