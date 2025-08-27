const $ = (id) => document.getElementById(id);
const logEl = $("log");
const appendLog = (m) => { if (!logEl) return; logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; };

let _playerKind = null;
let currentJobId = null;
const jobs = new Map();

function setJobId(id) {
  currentJobId = id || null;
  const lbl = $("jobIdLabel");
  if (lbl) lbl.textContent = currentJobId ? `Job: ${currentJobId}` : "";
}

/* ---------- Jobs table ---------- */
function renderJobs() {
  const tbody = $("jobsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (jobs.size === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = "No active jobs.";
    td.style.color = "#6b7280";
    td.style.fontSize = "13px";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const [id, j] of jobs) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.className = "mono col-id";
    tdId.textContent = id;

    const tdOut = document.createElement("td");
    tdOut.className = "mono col-out";
    const outLink = document.createElement("a");
    outLink.href = "#";
    outLink.className = "out-clip";
    outLink.title = j.outfile || "";
    outLink.textContent = j.outfile || "";
    outLink.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!j.outfile) return;
      const res = await window.api.openFolder(j.outfile);
      if (!res?.ok) appendLog(res?.message || "Open failed.");
    });
    tdOut.appendChild(outLink);

    const tdAct = document.createElement("td");
    tdAct.className = "col-act";

    const mkBtn = (label, secs) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", async () => {
        appendLog(`Clipping last ${Math.round(secs/60)} min for ${id}…`);
        const r = await window.api.clipJob(id, secs); // <- FIXED call shape
        if (!r?.ok) appendLog(r?.message || "Clip failed");
        else appendLog(`Clip created: ${r.clipOut}`);
      });
      return b;
    };
    tdAct.appendChild(mkBtn("Clip 2m", 120));
    tdAct.appendChild(mkBtn("Clip 5m", 300));
    tdAct.appendChild(mkBtn("Clip 10m", 600));

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop";
    stopBtn.style.marginLeft = "8px";
    stopBtn.addEventListener("click", async () => {
      const res = await window.api.stopStream(id);
      appendLog(res?.ok ? `Stopping job ${id}…` : (res?.message || `Failed to stop ${id}`));
    });
    tdAct.appendChild(stopBtn);

    tr.appendChild(tdId);
    tr.appendChild(tdOut);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

/* ---------- Player ---------- */
function attachPlayer(url, kind) {
  const video = $("player");
  if (!video) return;
  _playerKind = kind || "direct";

  try {
    video.src = url;
    video.muted = false;
    video.volume = 1.0;
    video.play().catch(e => appendLog("Video play error: " + e.message));
  } catch (e) {
    appendLog("Attach failed: " + e.message);
  }
}
function stopPlayer() {
  const video = $("player");
  if (!video) return;
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.load();
  _playerKind = null;
}

/* ---------- boot ---------- */
if (!window.api) {
  document.body.innerHTML = "<h2>Preload failed (window.api not found)</h2><p>Check preload path in main.cjs.</p>";
} else {
  window.api.onLog((m) => appendLog(m));
  window.api.onProcState((state) => {
    if (!state?.id) return;
    if (state.state === "started") {
      jobs.set(state.id, { id: state.id, mode: state.mode, outfile: state.outfile });
      setJobId(state.id);
      renderJobs();
    } else if (state.state === "stopped") {
      jobs.delete(state.id);
      if (currentJobId === state.id) setJobId(null);
      renderJobs();
    }
  });
  window.api.onRecovered((payload) => {
    if (!payload?.items?.length) return;
    appendLog(`Recovered ${payload.items.length} file(s):`);
    payload.items.forEach(x => appendLog(`• ${x.id}: ${x.archive}`));
  });

  (async () => {
    try {
      const r = await window.api.getSettings();
      if (r?.ok && r.settings) {
        if (r.settings.lastUrl) $("url").value = r.settings.lastUrl;
        if (r.settings.lastOutDir) $("outDir").value = r.settings.lastOutDir;
      }
    } catch {}
    try {
      const r2 = await window.api.listJobs();
      if (r2?.ok && Array.isArray(r2.jobs)) {
        r2.jobs.forEach(j => jobs.set(j.id, j));
        renderJobs();
      }
    } catch {}
  })();

  // buttons
  $("start")?.addEventListener("click", async () => {
    const payload = {
      streamlinkPath: $("streamlinkPath")?.value,
      url: $("url").value.trim(),
      quality: $("quality")?.value?.trim() || "best",
      outDir: $("outDir").value.trim(),
      filename: $("filename")?.value?.trim(),
      container: $("container")?.value || "mp4",
      extraArgs: ""
    };
    const res = await window.api.startStream(payload);
    if (!res?.ok) { appendLog(res?.message || "Failed to start."); return; }
    try { await window.api.setSettings({ lastUrl: payload.url, lastOutDir: payload.outDir }); } catch {}

    if (res.id) {
      jobs.set(res.id, { id: res.id, mode: res.mode, outfile: res.outfile });
      setJobId(res.id);
      renderJobs();
    }
    appendLog(`Started${res.id ? " job " + res.id : ""}. Writing to: ${res.outfile}`);
  });

  $("stop")?.addEventListener("click", async () => {
    const res = await window.api.stopStream();
    appendLog(res?.ok ? "Stopping all…" : (res?.message || "No stream running."));
  });

  $("pick")?.addEventListener("click", async () => {
    appendLog("Opening folder chooser…");
    const r = await window.api.chooseFolder();
    if (!r) { appendLog("No response from main process."); return; }
    if (r.canceled) { appendLog("Folder selection cancelled."); return; }
    if (!r.ok) { appendLog("Browse failed: " + (r.message || "unknown error")); return; }
    $("outDir").value = r.dir;
    try { await window.api.setSettings({ lastOutDir: r.dir }); } catch {}
    appendLog("Selected folder: " + r.dir);
  });

  $("open")?.addEventListener("click", async () => {
    const res = await window.api.openFolder($("outDir").value.trim());
    appendLog(res?.ok ? "Open folder invoked." : (res?.message || "Open failed."));
  });

  $("clearLog")?.addEventListener("click", () => { if (logEl) logEl.textContent = ""; }); // <- Clear log now works

  $("diag")?.addEventListener("click", async () => {
    const r = await window.api.ping("diag");
    appendLog("Diag: " + JSON.stringify(r));
  });

  $("playLive")?.addEventListener("click", async () => {
    const payload = {
      url: $("url").value.trim(),
      quality: $("quality")?.value?.trim() || "best",
      streamlinkPath: $("streamlinkPath")?.value
    };
    if (!payload.url) { appendLog("URL is required to play."); return; }
    appendLog("Resolving playback URL…");
    const r = await window.api.resolvePlayUrl(payload);
    if (!r?.ok) { appendLog("Resolve failed: " + (r?.message || "unknown error")); return; }
    appendLog(`Playback URL (${r.kind}): ` + r.playUrl);
    attachPlayer(r.playUrl, r.kind);
  });

  $("stopLive")?.addEventListener("click", () => {
    stopPlayer();
    appendLog("Stopped live preview.");
  });

  // persist edits
  const urlInput = $("url");
  const outDirInput = $("outDir");
  const persistUrl = () => { const v = urlInput.value.trim(); if (v) window.api.setSettings({ lastUrl: v }).catch(()=>{}); };
  const persistOut = () => { const v = outDirInput.value.trim(); if (v) window.api.setSettings({ lastOutDir: v }).catch(()=>{}); };
  urlInput?.addEventListener("blur", persistUrl);
  urlInput?.addEventListener("change", persistUrl);
  urlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") persistUrl(); });
  outDirInput?.addEventListener("blur", persistOut);
  outDirInput?.addEventListener("change", persistOut);
  outDirInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") persistOut(); });

  // updates
  $("checkUpdate")?.addEventListener("click", async () => {
    const r = await window.api.checkUpdate();
    if (!r?.ok) { appendLog("Update check failed: " + (r?.message || "")); return; }
    if (r.hasUpdate) appendLog(`Update available: ${r.local} → ${r.remote}`);
    else appendLog(`Up to date: ${r.local}`);
  });
  $("applyUpdate")?.addEventListener("click", async () => {
    appendLog("Applying update…");
    const r = await window.api.applyUpdate();
    if (!r?.ok) appendLog("Update failed: " + (r?.message || ""));
  });
}
