const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // diagnostics
  ping: (msg) => ipcRenderer.invoke("ping", msg),

  // settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (patch) => ipcRenderer.invoke("set-settings", patch),

  // recording
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openFolder: (dir) => ipcRenderer.invoke("open-folder", dir),
  startStream: (payload) => ipcRenderer.invoke("start-stream", payload),
  stopStream: (id) => ipcRenderer.invoke("stop-stream", id),
  listJobs: () => ipcRenderer.invoke("list-jobs"),

  // clip
  clipJob: (id, seconds) => ipcRenderer.invoke("clip-job", { id, seconds }),

  // viewer
  resolvePlayUrl: (payload) => ipcRenderer.invoke("resolve-play-url", payload),
  openInVlc: (url) => ipcRenderer.invoke("open-in-vlc", url),

  // self-update
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  applyUpdate: () => ipcRenderer.invoke("apply-update"),

  // events
  onLog: (cb) => ipcRenderer.on("log", (_e, msg) => cb(msg)),
  onProcState: (cb) => ipcRenderer.on("proc:state", (_e, state) => cb(state)),
  onRecovered: (cb) => ipcRenderer.on("proc:recovered", (_e, payload) => cb(payload)),
});