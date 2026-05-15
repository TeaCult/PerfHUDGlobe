const { app, BrowserWindow, screen } = require("electron");
const si = require("systeminformation");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function readFirstAmdGpuBusyPercent() {
  try {
    for (const d of fs.readdirSync("/sys/class/drm")) {
      if (!d.startsWith("card")) continue;
      const p = `/sys/class/drm/${d}/device/gpu_busy_percent`;
      if (fs.existsSync(p)) {
        const v = Number(String(fs.readFileSync(p)).trim());
        if (Number.isFinite(v)) return v;
      }
    }
  } catch {}
  return null;
}

function readNvidiaGpuUtilPercent() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      (err, stdout) => {
        if (err) return resolve(null);
        const v = Number(String(stdout).trim().split("\n")[0]);
        resolve(Number.isFinite(v) ? v : null);
      }
    );
  });
}

function defaultIface() {
  try {
    for (const ln of fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1)) {
      const c = ln.trim().split(/\s+/);
      if (c[1] === "00000000") return c[0]; // default route
    }
  } catch {}
  return null;
}

function readNetDev(ifaceWanted) {
  const lines = fs.readFileSync("/proc/net/dev", "utf8").trim().split("\n").slice(2);
  let rx = 0, tx = 0;

  for (const ln of lines) {
    const [lhs, rhs] = ln.split(":");
    if (!rhs) continue;
    const iface = lhs.trim();
    if (iface === "lo") continue;

    const f = rhs.trim().split(/\s+/);
    const rxb = Number(f[0]) || 0;
    const txb = Number(f[8]) || 0;

    if (ifaceWanted) {
      if (iface === ifaceWanted) return { iface, rx: rxb, tx: txb };
    } else {
      rx += rxb; tx += txb;
    }
  }
  return ifaceWanted ? null : { iface: "sum", rx, tx };
}

const sectorSizeCache = new Map();
function sectorSize(name) {
  if (sectorSizeCache.has(name)) return sectorSizeCache.get(name);
  let s = 512;
  try {
    const p = `/sys/block/${name}/queue/hw_sector_size`;
    if (fs.existsSync(p)) s = Number(String(fs.readFileSync(p)).trim()) || 512;
  } catch {}
  sectorSizeCache.set(name, s);
  return s;
}

function readDiskstatsBytes() {
  // sum "whole devices": minor==0, exclude loop/ram/sr/fd/zram
  const txt = fs.readFileSync("/proc/diskstats", "utf8");
  let rB = 0, wB = 0;

  for (const ln of txt.trim().split("\n")) {
    const p = ln.trim().split(/\s+/);
    if (p.length < 14) continue;

    const minor = Number(p[1]);
    const name = p[2];
    if (minor !== 0) continue;
    if (/^(loop|ram|sr|fd|zram)/.test(name)) continue;

    const sectorsRead = Number(p[5]) || 0;
    const sectorsWritten = Number(p[9]) || 0;
    const sz = sectorSize(name);

    rB += sectorsRead * sz;
    wB += sectorsWritten * sz;
  }
  return { rB, wB };
}

const { spawn } = require("child_process");

function startJournalStream(win) {
  // choose ONE:
  const args = ["-f", "-o", "json", "--no-hostname"];     // all logs
  // const args = ["-kf", "-o", "json", "--no-hostname"]; // kernel only

  const p = spawn("journalctl", args, { stdio: ["ignore", "pipe", "pipe"] });

  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        win.webContents.send("log", {
          ts: j.__REALTIME_TIMESTAMP ? Number(j.__REALTIME_TIMESTAMP) : Date.now()*1000,
          pri: j.PRIORITY != null ? Number(j.PRIORITY) : 6,
          msg: String(j.MESSAGE || ""),
          unit: j._SYSTEMD_UNIT || "",
          comm: j._COMM || ""
        });
      } catch {}
    }
  });

  p.stderr.on("data", (d) => {
    win.webContents.send("log", { pri: 3, msg: String(d), unit: "journalctl", comm: "stderr" });
  });

  p.on("close", () => {
    win.webContents.send("log", { pri: 3, msg: "journalctl stream stopped", unit: "", comm: "" });
  });

  return p;
}

app.whenReady().then(async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 600, H = 250;

  const win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - 16,
    y: workArea.y + 16,
    frame: false, transparent: true, resizable: true,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: __dirname + "/preload.js" },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile("index.html");
  startJournalStream(win);
  
  const iface = defaultIface();
  let lastNet = { t: Date.now(), rx: 0, tx: 0, ok: false };
  let lastDisk = { t: Date.now(), rB: 0, wB: 0, ok: false };

  setInterval(async () => {
    try {
      const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);

      const cpuPct = load.currentLoad || 0;
      const memPct = mem.total ? (mem.active / mem.total) * 100 : 0;

      // NET: /proc/net/dev delta
      const now = Date.now();
      const dtN = Math.max(0.2, (now - lastNet.t) / 1000);
      const nd = readNetDev(iface) || readNetDev(null);
      let rxBps = 0, txBps = 0;
      if (lastNet.ok) {
        rxBps = Math.max(0, (nd.rx - lastNet.rx) / dtN);
        txBps = Math.max(0, (nd.tx - lastNet.tx) / dtN);
      }
      lastNet = { t: now, rx: nd.rx, tx: nd.tx, ok: true };

      // DISK: /proc/diskstats delta
      const dtD = Math.max(0.2, (now - lastDisk.t) / 1000);
      const ds = readDiskstatsBytes();
      let diskReadBps = 0, diskWriteBps = 0;
      if (lastDisk.ok) {
        diskReadBps = Math.max(0, (ds.rB - lastDisk.rB) / dtD);
        diskWriteBps = Math.max(0, (ds.wB - lastDisk.wB) / dtD);
      }
      lastDisk = { t: now, rB: ds.rB, wB: ds.wB, ok: true };

      // GPU
      let gpuPct = readFirstAmdGpuBusyPercent();
      if (gpuPct == null) gpuPct = await readNvidiaGpuUtilPercent();
      if (gpuPct == null) gpuPct = 0;

      win.webContents.send("metrics", {
        cpuPct, gpuPct, memPct,
        rxBps, txBps,
        diskReadBps, diskWriteBps,
        netIface: nd.iface || iface || "sum",
      });
    } catch {}
  }, 300);
});
