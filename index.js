import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("c");
const $cpu = document.getElementById("cpu");
const $gpu = document.getElementById("gpu");
const $mem = document.getElementById("mem");
const $net = document.getElementById("net");
const $disk = document.getElementById("disk");

const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
r.setClearColor(0x000000, 0);

const s = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
let zoom = 6;
cam.position.z = zoom;
cam.fov = 28;  
cam.position.x = 1.25;
const group = new THREE.Group();
s.add(group);



// ---- tweak ----
const RADIUS = 1, DETAIL = 2, GAP = 0.12, OPACITY = 0.5, EDGE =0x57A0D2; // CAROLINE
const BASE_AMP = 0.10, BASE_SPEED = 5.0;
const NET_NORM_BPS = 5_000_000;    // 5MB/s => 1
const DISK_NORM_BPS = 20_000_000;  // 20MB/s => 1
// -------------

const view = document.getElementById("view");

function fit(){
  const w = view.clientWidth, h = view.clientHeight;
  r.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}
addEventListener("resize", fit);
fit();

function weld(geo, eps = 1e-5) {
  const a = geo.attributes.position.array;
  const src = geo.index ? geo.index.array : Array.from({ length: a.length / 3 }, (_, i) => i);
  const map = new Map(), newPos = [], newIdx = [];
  const key = (x, y, z) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
  for (const vi of src) {
    const x = a[3 * vi], y = a[3 * vi + 1], z = a[3 * vi + 2];
    const k = key(x, y, z);
    let ni = map.get(k);
    if (ni === undefined) { ni = newPos.length / 3; map.set(k, ni); newPos.push(x, y, z); }
    newIdx.push(ni);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(newPos, 3));
  g.setIndex(newIdx);
  return g;
}

let base = weld(new THREE.IcosahedronGeometry(RADIUS, DETAIL));
const pos = base.attributes.position;
const idx = base.index.array;
const fCount = idx.length / 3;

const fC = Array(fCount);
for (let f = 0; f < fCount; f++) {
  const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
  const A = new THREE.Vector3().fromBufferAttribute(pos, a);
  const B = new THREE.Vector3().fromBufferAttribute(pos, b);
  const C = new THREE.Vector3().fromBufferAttribute(pos, c);
  fC[f] = A.add(B).add(C).multiplyScalar(1 / 3).normalize().multiplyScalar(RADIUS);
}

const vFaces = Array.from({ length: pos.count }, () => []);
for (let f = 0; f < fCount; f++) {
  vFaces[idx[3 * f]].push(f);
  vFaces[idx[3 * f + 1]].push(f);
  vFaces[idx[3 * f + 2]].push(f);
}

const faceMat = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: OPACITY,
  side: THREE.DoubleSide, depthWrite: false
});
const edgeMat = new THREE.LineBasicMaterial({
  color: EDGE, transparent: true, opacity: 1,
  blending: THREE.AdditiveBlending
});

const DEV = ["cpu", "gpu", "net", "mem", "disk"];
const tiles = [];
const n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3();
const center = new THREE.Vector3();
const tmp = new THREE.Vector3();

for (let vi = 0; vi < pos.count; vi++) {
  const faces = vFaces[vi];
  if (faces.length < 5) continue;

  const v = new THREE.Vector3().fromBufferAttribute(pos, vi).normalize();
  n.copy(v);
  t.set(0, 1, 0); if (Math.abs(t.dot(n)) > 0.9) t.set(1, 0, 0);
  t.cross(n).normalize();
  b.copy(n).cross(t).normalize();

  const ring = faces.map(fi => {
    const p = fC[fi];
    return { p, a: Math.atan2(p.dot(b), p.dot(t)) };
  }).sort((u, v) => u.a - v.a).map(o => o.p);

  center.set(0, 0, 0);
  for (const p of ring) center.add(p);
  center.multiplyScalar(1 / ring.length).normalize().multiplyScalar(RADIUS);

  const shrunk = ring.map(p => {
    tmp.copy(p).sub(center);
    return new THREE.Vector3().copy(center).add(tmp.multiplyScalar(1 - GAP)).normalize().multiplyScalar(RADIUS);
  });

  const verts = [];
  for (let i = 0; i < shrunk.length; i++) {
    const p1 = shrunk[i], p2 = shrunk[(i + 1) % shrunk.length];
    verts.push(center.x, center.y, center.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));

  const mesh = new THREE.Mesh(g, faceMat);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(shrunk.concat([shrunk[0]])),
    edgeMat
  );

  group.add(mesh); group.add(line);

  tiles.push({
    mesh, line,
    n: center.clone().normalize(),
    pos: new THREE.Vector3(),
    theta: 0,
    phase: vi * 0.37,
    id: DEV[tiles.length % DEV.length],
  });
}

// ---- live values ----
const raw = { cpuPct: 0, gpuPct: 0, memPct: 0, rxBps: 0, txBps: 0, drBps: 0, dwBps: 0 };
const target = { cpu: 0, gpu: 0, net: 0, mem: 0, disk: 0 };
const smooth = { cpu: 0, gpu: 0, net: 0, mem: 0, disk: 0 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmtPct = (x) => `${x.toFixed(0)}%`;
function fmtRate(bps){
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024*1024) return `${(bps/1024).toFixed(1)} KB/s`;
  return `${(bps/1_000_000).toFixed(2)} MB/s`;
}

window.api?.onMetrics?.((m) => {
  raw.cpuPct = m.cpuPct || 0;
  raw.gpuPct = m.gpuPct || 0;
  raw.memPct = m.memPct || 0;
  raw.rxBps = m.rxBps || 0;
  raw.txBps = m.txBps || 0;
  raw.drBps = m.diskReadBps || 0;
  raw.dwBps = m.diskWriteBps || 0;

  target.cpu = clamp01(raw.cpuPct / 100);
  target.gpu = clamp01(raw.gpuPct / 100);
  target.mem = clamp01(raw.memPct / 100);
  target.net = clamp01(Math.max(raw.rxBps, raw.txBps) / NET_NORM_BPS);
  target.disk = clamp01(Math.max(raw.drBps, raw.dwBps) / DISK_NORM_BPS);
});

// mouse rotate + zoom
let dragging = false, lx = 0, ly = 0, yaw = 0, pitch = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true; lx = e.clientX; ly = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", () => dragging = false);
canvas.addEventListener("pointercancel", () => dragging = false);
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lx, dy = e.clientY - ly;
  lx = e.clientX; ly = e.clientY;
  yaw += dx * 0.005;
  pitch += dy * 0.005;
  pitch = Math.max(-1.3, Math.min(1.3, pitch));
});
// animate
let last = performance.now() * 0.001;
let hudAcc = 0;

(function anim() {
  const now = performance.now() * 0.001;
  let dt = now - last; last = now;
  if (dt > 0.05) dt = 0.05;

  const k = 1 - Math.exp(-dt * 5);
  for (const id of DEV) smooth[id] += (target[id] - smooth[id]) * k;

  group.rotation.y = yaw;
  group.rotation.x = pitch;

  for (const tile of tiles) {
    const v = smooth[tile.id] || 0;
    const amp = BASE_AMP * (0.15 + v * 1.2);
    const spd = BASE_SPEED * (0.25 + v * 2.5);

    tile.theta += dt * spd;
    const off = amp * Math.sin(tile.theta + tile.phase);

    tile.pos.copy(tile.n).multiplyScalar(off);
    tile.mesh.position.copy(tile.pos);
    tile.line.position.copy(tile.pos);
  }

  hudAcc += dt;
  if (hudAcc > 0.1) {
    hudAcc = 0;
    $cpu.textContent = fmtPct(raw.cpuPct);
    $gpu.textContent = fmtPct(raw.gpuPct);
    $mem.textContent = fmtPct(raw.memPct);
    $net.textContent  = `↓ ${fmtRate(raw.rxBps)}  ↑ ${fmtRate(raw.txBps)}`;
    $disk.textContent = `R ${fmtRate(raw.drBps)}  W ${fmtRate(raw.dwBps)}`;
  }

  r.render(s, cam);
  requestAnimationFrame(anim);
})();

const logBox = document.getElementById("loglines");
const MAX_LINES = 120;

function priClass(p){
  if (p <= 3) return "logE";   // err/crit/alert/emerg
  if (p === 4) return "logW";  // warning
  return "logI";              // notice/info/debug
}

function shortLine(e){
  const who = (e.unit || e.comm) ? `[${e.unit || e.comm}] ` : "";
  return who + (e.msg || "");
}

window.api?.onLog?.((e) => {
  const div = document.createElement("div");
  div.className = priClass(e.pri ?? 6);
  div.textContent = shortLine(e);

  logBox.appendChild(div);
  while (logBox.childNodes.length > MAX_LINES) logBox.removeChild(logBox.firstChild);
});