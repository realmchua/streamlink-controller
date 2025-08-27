// main.cjs
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn, exec } = require("node:child_process");

/* ---------- Ensure common bin dirs are visible when launched from Finder ---------- */
(function patchPathForGuiLaunch() {
  const extra = [];
  if (process.platform === "darwin") {
    extra.push("/opt/homebrew/bin", "/usr/local/bin");
  } else if (process.platform === "linux") {
    extra.push("/usr/local/bin", "/usr/bin");
  } else if (process.platform === "win32") {
    // Windows path fixes typically not needed; leave as-is.
  }
  const current = process.env.PATH || "";
  const merged = [...new Set([...extra, ...current.split(path.delimiter)])]
    .filter(Boolean)
    .join(path.delimiter);
  process.env.PATH = merged;
})();

/* ------------------ globals ------------------ */
let win = null;
const procs = new Map(); // id -> { mode, ytDlp, streamlink, ffmpeg, ... }
let currentOutDir = os.homedir();

/* ------------------ lightweight settings store ------------------ */
function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8")) || {}; }
  catch { return {}; }
}
function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  try {
    const p = getSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
    return { ok: true, settings: next };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* ------------------ helpers ------------------ */
function isYouTube(u = "") {
  return /(^|\.)youtube\.com/i.test(u) || /(^|\.)youtu\.be/i.test(u);
}
function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}
function log(id, m) { send("log", id ? `[${id}] ${m}` : m); }

function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore","pipe","pipe"], shell: false });
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
async function whichBin(name) {
  const cmd = process.platform === "win32" ? "where" : "which";
  const { code, out } = await runOnce(cmd, [name]);
  return code === 0 && out ? out.split(/\r?\n/)[0].trim() : null;
}

/** Look for binaries inside the packaged app too (Contents/Resources[/bin]) */
const BIN_DIRS_IN_RESOURCES = ["", "bin"];
function resolveBundled(name) {
  if (!process.resourcesPath) return null;
  for (const sub of BIN_DIRS_IN_RESOURCES) {
    const p = path.join(process.resourcesPath, sub, name);
    if (fs.existsSync(p)) return p;
    if (process.platform === "win32" && fs.existsSync(p + ".exe")) return p + ".exe";
  }
  return null;
}

/** Resolve a binary in this order: explicit path → bundled in .app → system PATH */
async function resolveBinary(preferredPath, fallbackName) {
  if (preferredPath && fs.existsSync(preferredPath)) return preferredPath;
  const bundled = resolveBundled(fallbackName);
  if (bundled) return bundled;
  return await whichBin(fallbackName);
}

/** Collect tools; streamlink path may be provided by user */
async function preflightBins(opts) {
  const ytDlpName  = process.platform === "win32" ? "yt-dlp.exe"  : "yt-dlp";
  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return {
    ytDlp:      await resolveBinary(null, ytDlpName),
    ffmpeg:     await resolveBinary(null, ffmpegName),
    streamlink: await resolveBinary(opts.streamlinkPath, "streamlink"),
  };
}

function killPids(job) {
  try { job.streamlink?.kill("SIGINT"); } catch {}
  try { job.ytDlp?.kill("SIGINT"); } catch {}
  try { job.ffmpeg?.stdin?.end(); job.ffmpeg?.kill("SIGINT"); } catch {}

  if (process.platform === "win32") {
    try { if (job.streamlink) exec(`taskkill /PID ${job.streamlink.pid} /T /F`); } catch {}
    try { if (job.ytDlp) exec(`taskkill /PID ${job.ytDlp.pid} /T /F`); } catch {}
    try { if (job.ffmpeg) exec(`taskkill /PID ${job.ffmpeg.pid} /T /F`); } catch {}
  } else {
    setTimeout(() => {
      try { job.streamlink?.kill("SIGKILL"); } catch {}
      try { job.ytDlp?.kill("SIGKILL"); } catch {}
      try { job.ffmpeg?.kill("SIGKILL"); } catch {}
    }, 1000);
  }
}

function classifyKind(u = "") {
  const s = u.toLowerCase();
  if (s.includes(".m3u8") || s.includes("mime=application%2Fx-mpegurl")) return "hls";
  if (s.includes(".mpd")   || s.includes("mime=application%2Fdash%2Bxml")) return "dash";
  if (s.endsWith(".mp4")   || s.includes("mime=video%2Fmp4")) return "direct";
  return "direct";
}
function yyyymmdd_HHMMSS(d = new Date()) {
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------ per-job dirs & state ------------------ */
function jobRootFor(outDir, id) { return path.join(outDir, ".jobs", id); }
function ensureJobDirs(outDir, id) {
  const root  = jobRootFor(outDir, id);
  const seg   = path.join(root, "segments");
  const tmp   = path.join(root, "tmp");
  const clips = path.join(root, "clips");
  const logs  = path.join(root, "logs");
  [root, seg, tmp, clips, logs].forEach(d => fs.mkdirSync(d, { recursive: true }));
  return { root, seg, tmp, clips, logs };
}
function writeJobState(job) {
  try {
    const state = {
      id: job.id, url: job.url, outDir: job.outDir,
      archive: job.archive, archiveTs: job.archiveTs,
      container: job.container, segmentsDir: job.segmentsDir,
      startedAt: job.startedAt, status: job.status || "recording"
    };
    fs.writeFileSync(path.join(job.jobRoot, "state.json"), JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

/* ------------------ finalize archive (.ts -> mkv/mp4) ------------------ */
async function finalizeArchive(job) {
  try {
    if (!job.archiveTs || !fs.existsSync(job.archiveTs)) return;
    const dst = job.archive || job.archiveTs;    // final .mkv/.mp4 the UI expects
    const tmp = dst + ".finalizing";
    const ffbin = await resolveBinary(null, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

    const args = (/\.(mp4)$/i.test(dst))
      ? ["-hide_banner","-loglevel","warning","-i",job.archiveTs,"-c","copy","-movflags","+faststart",tmp]
      : ["-hide_banner","-loglevel","warning","-i",job.archiveTs,"-c","copy",tmp];

    const r = await runOnce(ffbin, args);
    if (r.code === 0 && fs.existsSync(tmp)) {
      try { fs.renameSync(tmp, dst); } catch {}
      try { fs.unlinkSync(job.archiveTs); } catch {}
      log(job.id, `Finalized archive: ${dst}`);
    } else {
      log(job.id, `Finalize failed: ${r.err || "unknown"}`);
    }
  } catch (e) {
    log(job.id, `Finalize error: ${e.message}`);
  }
}

/* ------------------ window ------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, backgroundColor: "#111111", show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });

  const indexPath = path.join(__dirname, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error("index.html not found next to main.cjs");
  win.loadFile(indexPath);
  win.once("ready-to-show", () => { try { win.maximize(); } catch {} win.show(); });

  // Set a strict CSP on responses (mirrors <meta> tag in index.html).
  const { session } = win.webContents;
  session.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https: http:",
      "media-src 'self' https: http: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; ");
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
}

/* ------------------ lifecycle ------------------ */
app.whenReady().then(async () => {
  await recoverCrashedJobsOnStartup();
  createWindow();
});
app.on("window-all-closed", () => {
  try { procs.forEach(killPids); procs.clear(); } catch {}
  app.quit(); process.exit(0);
});
app.on("before-quit", () => {
  try { procs.forEach(killPids); procs.clear(); } catch {}
  setTimeout(() => process.exit(0), 0);
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ------------------ IPC: settings ------------------ */
ipcMain.handle("get-settings", async () => ({ ok: true, settings: readSettings() }));
ipcMain.handle("set-settings", async (_evt, patch) => writeSettings(patch || {}));

/* ------------------ IPC: basic ------------------ */
ipcMain.handle("ping", async (_evt, msg) => ({ ok: true, echo: msg || "pong", platform: process.platform, cwd: process.cwd() }));

ipcMain.handle("choose-folder", async () => {
  try {
    const s = readSettings();
    const defaultPath = s.lastOutDir || currentOutDir || os.homedir();
    const res = await dialog.showOpenDialog(win, {
      title: "Select output folder",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    currentOutDir = res.filePaths[0];
    writeSettings({ lastOutDir: currentOutDir }); // persist immediately
    return { ok: true, dir: currentOutDir };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle("open-folder", async (_evt, folderPath) => {
  const target = (folderPath && folderPath.trim()) || currentOutDir;
  if (!target) return { ok: false, message: "No path set." };
  const r = await shell.openPath(target); // works for dirs or files
  if (r) return { ok: false, message: r };
  return { ok: true };
});

ipcMain.handle("list-jobs", async () => {
  const list = Array.from(procs.entries()).map(([id, j]) => ({
    id,
    mode: j.mode,
    outfile: j.archive || path.join(j.outDir || "", `${id}.${j.container || "mp4"}`),
  }));
  return { ok: true, jobs: list };
});

/* ------------------ IPC: start/stop ------------------ */
ipcMain.handle("start-stream", async (_evt, payload = {}) => {
  const id = Date.now().toString();
  const streamlinkPath = payload.streamlinkPath;
  const url = payload.url;
  const quality = payload.quality;
  const outDir = payload.outDir;
  const extraArgs = payload.extraArgs;
  const container = payload.container;

  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, message: "Valid URL is required (http/https)." };

  const outDirectory = (outDir && outDir.trim()) || currentOutDir || os.homedir();
  currentOutDir = outDirectory;
  writeSettings({ lastUrl: url, lastOutDir: outDirectory });

  const chosen = (container === "mp4" || container === "mkv") ? container : "mp4";
  const bins = await preflightBins({ streamlinkPath });
  if (!bins.ffmpeg) return { ok: false, message: "ffmpeg not found in PATH. Install or bundle ffmpeg." };

  const dirs = ensureJobDirs(outDirectory, id);
  const archiveFinal = path.join(outDirectory, `${id}.${chosen}`); // final file the user sees
  const archiveTs    = archiveFinal.replace(/\.(mkv|mp4)$/i, ".ts"); // temp during capture

  if (isYouTube(url)) {
    if (!bins.ytDlp) return { ok: false, message: "yt-dlp not found. Install or bundle yt-dlp." };
    const r = await startYouTubePipe({ id, url, outfile: archiveFinal, archiveTs, quality, bins, extraArgs, chosen, segDir: dirs.seg });
    if (r.ok) {
      const j = procs.get(id) || {};
      Object.assign(j, {
        jobRoot: dirs.root, segmentsDir: dirs.seg, tmpDir: dirs.tmp, clipsDir: dirs.clips,
        archive: archiveFinal, archiveTs, id, url, outDir: outDirectory,
        container: chosen, startedAt: Date.now(), status: "recording"
      });
      procs.set(id, j);
      writeJobState(j);
      send("proc:state", { id, state: "started", mode: "yt-dlp", outfile: archiveFinal });
    }
    return r.ok ? { ...r, id, mode: "yt-dlp" } : r;
  } else {
    const sl = bins.streamlink;
    if (!sl) return { ok: false, message: "streamlink not found. Install or set full path." };
    const r = await startStreamlinkPipe({ id, streamlinkBin: sl, url, container: chosen, outfile: archiveFinal, archiveTs, quality, bins, extraArgs, segDir: dirs.seg });
    if (r.ok) {
      const j = procs.get(id) || {};
      Object.assign(j, {
        jobRoot: dirs.root, segmentsDir: dirs.seg, tmpDir: dirs.tmp, clipsDir: dirs.clips,
        archive: archiveFinal, archiveTs, id, url, outDir: outDirectory,
        container: chosen, startedAt: Date.now(), status: "recording"
      });
      procs.set(id, j);
      writeJobState(j);
      send("proc:state", { id, state: "started", mode: "streamlink", outfile: archiveFinal });
    }
    return r.ok ? { ...r, id, mode: "streamlink" } : r;
  }
});

ipcMain.handle("stop-stream", async (_evt, id) => {
  if (!id) {
    if (procs.size === 0) return { ok: false, message: "No running streams." };
    for (const jid of Array.from(procs.keys())) await endJob(jid);
    return { ok: true, all: true };
  }
  if (!procs.has(id)) return { ok: false, message: `No running stream with id ${id}` };
  await endJob(id);
  return { ok: true, id };
});

/* ------------------ IPC: resolve & VLC ------------------ */
ipcMain.handle("resolve-play-url", async (_evt, payload = {}) => {
  const url = payload.url;
  const quality = payload.quality;
  const streamlinkPath = payload.streamlinkPath;
  if (!url) return { ok: false, message: "URL is required." };
  const q = (quality && quality.trim()) || "best";
  try {
    const yt = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    const sl = await resolveBinary(streamlinkPath, "streamlink");

    async function tryYtProgressive() {
      const chk = await runOnce(yt, ["--version"]);
      if (chk.code !== 0) return null;
      const fmt = "18/best[acodec!=none]"; // progressive MP4 w/ audio if possible
      const r = await runOnce(yt, ["-g", "-f", fmt, url, "--no-cache-dir", "--cookies-from-browser", "chrome"]);
      if (r.code === 0) {
        const line = r.out.split(/\r?\n/).find(Boolean);
        if (line) return { playUrl: line, kind: "direct" };
      }
      return null;
    }

    async function tryStreamlink() {
      if (!sl) return null;
      const r = await runOnce(sl, ["--stream-url", url, q, "--retry-open", "2"]);
      if (r.code !== 0 || !r.out) return null;
      const play = r.out.split(/\s+/)[0];
      return { playUrl: play, kind: classifyKind(play) };
    }

    if (isYouTube(url)) {
      const a = await tryYtProgressive();
      if (a) return { ok: true, ...a };
    } else {
      const b = await tryStreamlink();
      if (b) return { ok: true, ...b };
    }
    return { ok: false, message: "Could not resolve a playable A/V URL." };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
});

/* ------------------ IPC: clip-on-demand ------------------ */
ipcMain.handle("clip-job", async (_evt, payload = {}) => {
  const { id, seconds = 120 } = payload;
  const job = procs.get(id);
  if (!job) return { ok: false, message: `No running job ${id}` };

  try {
    const segDir = job.segmentsDir;
    const files = fs.readdirSync(segDir)
      .filter(f => f.startsWith("part_") && f.endsWith(".mp4"))
      .map(f => ({ f, p: path.join(segDir, f), t: fs.statSync(path.join(segDir, f)).mtimeMs }))
      .sort((a,b) => a.t - b.t);

    if (files.length === 0) return { ok: false, message: "No segments yet." };

    // gather last N seconds worth of ~10s segments
    const need = Math.ceil(seconds / 10);
    const pick = files.slice(-need);
    if (pick.length === 0) return { ok: false, message: "Not enough segments." };

    // write concat list
    const tmpDir = job.tmpDir || path.join(job.jobRoot, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const listPath = path.join(tmpDir, `list_${Date.now()}.txt`);
    fs.writeFileSync(listPath, pick.map(x => `file '${x.p.replace(/'/g,"'\\''")}'`).join("\n"));

    // output clip into main output folder (not hidden)
    const clipName = `clip_${id}_${yyyymmdd_HHMMSS()}.mp4`; // mp4 for compatibility
    const clipOut = path.join(job.outDir, clipName);

    const ffbin = await resolveBinary(null, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const ff = await runOnce(ffbin, [
      "-hide_banner", "-loglevel", "warning",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", clipOut
    ]);
    if (ff.code !== 0) return { ok: false, message: "ffmpeg concat failed: " + ff.err };

    log(id, `Clip created: ${clipOut}`);
    return { ok: true, clipOut };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

/* ------------------ IPC: update via git (optional) ------------------ */
ipcMain.handle("check-update", async () => {
  try {
    const here = process.cwd();
    const head = await runOnce("git", ["rev-parse", "HEAD"], { cwd: here });
    const remote = await runOnce("git", ["ls-remote", "origin", "-h", "refs/heads/main"], { cwd: here });
    if (head.code !== 0 || remote.code !== 0) return { ok: false, message: "Not a git repo or no origin/main" };
    const local = head.out.trim();
    const remoteHash = (remote.out.split(/\s+/)[0] || "").trim();
    return { ok: true, local, remote: remoteHash, hasUpdate: local !== remoteHash };
  } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle("apply-update", async () => {
  try {
    const cwd = process.cwd();
    log(null, "[update] Fetching latest…");
    let r = await runOnce("git", ["fetch", "origin"], { cwd });
    if (r.code !== 0) return { ok: false, message: r.err || "git fetch failed" };
    log(null, "[update] Reset to origin/main…");
    r = await runOnce("git", ["reset", "--hard", "origin/main"], { cwd });
    if (r.code !== 0) return { ok: false, message: r.err || "git reset failed" };
    log(null, "[update] Installing deps…");
    r = await runOnce("npm", ["ci"], { cwd });
    if (r.code !== 0) return { ok: false, message: r.err || "npm ci failed" };
    try { await runOnce("node", ["scripts/copy-vendor.cjs"], { cwd }); } catch {}
    log(null, "[update] Relaunching app…");
    app.relaunch(); app.exit(0);
    return { ok: true, relaunching: true };
  } catch (e) { return { ok: false, message: e.message }; }
});

/* ------------------ pipelines: record -> tee(.ts + segments) ------------------ */
async function startYouTubePipe(opts) {
  const { id, url, outfile, archiveTs, bins, extraArgs, chosen, segDir } = opts;

  const formatSel = "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]";
  const yArgs = ["-f", formatSel, "-o", "-", "--no-cache-dir", "--cookies-from-browser", "chrome", url];
  if (extraArgs && extraArgs.trim()) yArgs.splice(2, 0, ...extraArgs.split(/\s+/));

  log(id, `[yt-dlp] ${bins.ytDlp} ${yArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  const ytDlp = spawn(bins.ytDlp, yArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false });

  // tee slaves: archive -> .ts, rolling segments -> mp4
  const slaves =
    `[f=mpegts:onfail=ignore]${archiveTs}|` +
    `[f=segment:onfail=ignore:segment_time=10:reset_timestamps=1:segment_format_options=movflags=+faststart]${path.join(segDir, "part_%06d.mp4")}`;

  const ffArgs = [
    "-hide_banner","-loglevel","warning",
    "-i","pipe:0",
    "-map","0:v","-map","0:a?","-dn","-sn","-c","copy",
    "-f","tee", slaves
  ];

  log(id, `[ffmpeg] ${bins.ffmpeg} ${ffArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  const ffmpeg = spawn(bins.ffmpeg, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });

  ytDlp.stdout.pipe(ffmpeg.stdin);
  ytDlp.stderr.on("data", d => log(id, "[yt-dlp] " + d.toString()));
  ffmpeg.stderr.on("data", d => log(id, "[ffmpeg] " + d.toString()));

  ytDlp.on("close", (code, sig) => { log(id, `yt-dlp exited (code=${code}, signal=${sig})`); });
  ffmpeg.on("close", async (code, sig) => { log(id, `ffmpeg exited (code=${code}, signal=${sig})`); await endJob(id); });

  procs.set(id, { mode: "yt-dlp", outDir: path.dirname(outfile), container: chosen, ytDlp, ffmpeg, archive: outfile, archiveTs });
  startSegmentJanitor(id, segDir, 10, 60);
  return { ok: true, id, outfile };
}

async function startStreamlinkPipe(opts) {
  const { id, streamlinkBin, url, container, outfile, archiveTs, quality, bins, extraArgs, segDir } = opts;

  log(id, `[streamlink] Starting via ${streamlinkBin} → ffmpeg ${bins.ffmpeg}`);

  const slArgs = ["--stdout","--hls-audio-select","best","--dash-audio-select","best", url, (quality && quality.trim()) || "best"];
  if (extraArgs && extraArgs.trim()) slArgs.push(...extraArgs.split(/\s+/));

  const streamlink = spawn(streamlinkBin, slArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false });

  const slaves =
    `[f=mpegts:onfail=ignore]${archiveTs}|` +
    `[f=segment:onfail=ignore:segment_time=10:reset_timestamps=1:segment_format_options=movflags=+faststart]${path.join(segDir, "part_%06d.mp4")}`;

  const ffArgs = [
    "-hide_banner","-loglevel","warning",
    "-probesize","200M","-analyzeduration","20M",
    "-i","pipe:0",
    "-map","0:v","-map","0:a?","-c","copy",
    "-f","tee", slaves
  ];

  log(id, `[ffmpeg] ${bins.ffmpeg} ${ffArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  const ffmpeg = spawn(bins.ffmpeg, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });

  streamlink.stderr.on("data", d => log(id, "[streamlink] " + d.toString()));
  ffmpeg.stderr.on("data", d => log(id, "[ffmpeg] " + d.toString()));

  streamlink.stdout.pipe(ffmpeg.stdin);

  streamlink.on("close", (code, sig) => { log(id, `streamlink exited (code=${code}, signal=${sig})`); });
  ffmpeg.on("close", async (code, sig) => { log(id, `ffmpeg exited (code=${code}, signal=${sig})`); await endJob(id); });

  procs.set(id, { mode: "streamlink", outDir: path.dirname(outfile), container, streamlink, ffmpeg, archive: outfile, archiveTs });
  startSegmentJanitor(id, segDir, 10, 60);
  return { ok: true, id, outfile };
}

/* ------------------ segments janitor (keep last window) ------------------ */
function startSegmentJanitor(id, segDir, segmentSeconds = 10, keepMinutes = 60) {
  const maxParts = Math.ceil((keepMinutes * 60) / segmentSeconds);
  const interval = setInterval(() => {
    const job = procs.get(id);
    if (!job) { clearInterval(interval); return; }
    try {
      const files = fs.readdirSync(segDir).filter(f => f.startsWith("part_") && f.endsWith(".mp4"))
        .map(f => ({ f, full: path.join(segDir, f), t: fs.statSync(path.join(segDir, f)).mtimeMs }))
        .sort((a,b) => a.t - b.t);
      if (files.length > maxParts) {
        const del = files.slice(0, files.length - maxParts);
        del.forEach(x => { try { fs.unlinkSync(x.full); } catch {} });
      }
    } catch {}
  }, 15000); // every 15s
}

/* ------------------ recovery on startup ------------------ */
async function recoverCrashedJobsOnStartup() {
  try {
    const s = readSettings();
    const base = s.lastOutDir || currentOutDir || os.homedir();
    const jobsDir = path.join(base, ".jobs");
    if (!fs.existsSync(jobsDir)) return;

    const recovered = [];
    for (const id of fs.readdirSync(jobsDir)) {
      const root = path.join(jobsDir, id);
      const stPath = path.join(root, "state.json");
      if (!fs.existsSync(stPath)) continue;
      let st;
      try { st = JSON.parse(fs.readFileSync(stPath, "utf8")); } catch { continue; }
      if (st.status !== "recording") continue; // only unfinished
      const archive = st.archive;
      const container = st.container || "mp4";

      // if a .ts still exists, try to finalize it to archive
      const tsGuess = st.archiveTs || (archive ? archive.replace(/\.(mkv|mp4)$/i, ".ts") : null);
      if (tsGuess && fs.existsSync(tsGuess) && archive) {
        const ffbin = await resolveBinary(null, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
        const tmp = archive + ".finalizing";
        const args = (/\.(mp4)$/i.test(archive))
          ? ["-hide_banner","-loglevel","warning","-i",tsGuess,"-c","copy","-movflags","+faststart",tmp]
          : ["-hide_banner","-loglevel","warning","-i",tsGuess,"-c","copy",tmp];
        const r = await runOnce(ffbin, args);
        if (r.code === 0 && fs.existsSync(tmp)) {
          try { fs.renameSync(tmp, archive); } catch {}
          try { fs.unlinkSync(tsGuess); } catch {}
        } else {
          try { fs.unlinkSync(tmp); } catch {}
        }
      }

      // purge tiny tail segments if any
      const segDir = st.segmentsDir;
      if (segDir && fs.existsSync(segDir)) {
        for (const f of fs.readdirSync(segDir)) {
          const p = path.join(segDir, f);
          try {
            const sz = fs.statSync(p).size;
            if (sz < 1024) fs.unlinkSync(p);
          } catch {}
        }
      }
      // mark stopped and keep record
      st.status = "recovered";
      fs.writeFileSync(stPath, JSON.stringify(st, null, 2), "utf8");
      recovered.push({ id: st.id, archive: st.archive, container: st.container, outDir: st.outDir });
    }
    if (recovered.length) send("proc:recovered", { items: recovered });
  } catch (e) {
    log(null, "[recovery] " + e.message);
  }
}

/* ------------------ end job (await finalize) ------------------ */
async function endJob(id) {
  const job = procs.get(id);
  if (!job) return;
  job.status = "stopped";
  writeJobState(job);
  killPids(job);
  await finalizeArchive(job);
  procs.delete(id);
  send("proc:state", { id, state: "stopped" });
}

/* ------------------ VLC opener ------------------ */
ipcMain.handle("open-in-vlc", async (_evt, playUrl) => {
  if (!playUrl) return { ok: false, message: "No URL" };
  try {
    if (process.platform === "darwin") {
      spawn("open", ["-a", "VLC", playUrl], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", "vlc", playUrl], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("vlc", [playUrl], { stdio: "ignore", detached: true }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});