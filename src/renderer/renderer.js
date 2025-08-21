// 設計書に基づく最小骨格（XR自動切替、カメラ、HUD、MMD読込/MediaPipe雛形）
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
const api = window.api;

const els = {
  open: document.getElementById('btn-open'),
  selXR: document.getElementById('sel-xr'),
  selReso: document.getElementById('sel-reso'),
  selInfer: document.getElementById('sel-infer'),
  selRecent: document.getElementById('sel-recent'),
  status: document.getElementById('status'),
  video: document.getElementById('bg'),
  canvas: document.getElementById('gl'),
  hud: document.getElementById('hud')
};

const state = {
  xrMode: 'auto', // auto | xr | fb
  resolution: '1080p',
  inferFps: 30,
  hasXR: false,
  three: null,
  renderer: null,
  scene: null,
  camera: null,
  lastFrameTs: performance.now(),
  fps: 0,
  inferMs: 0,
  inferCounter: 0,
  inferLastTs: performance.now()
};

function setStatus(msg) { els.status.textContent = msg; }

function hudRender() {
  els.hud.innerText = `fps: ${state.fps.toFixed(0)}\n` +
    `infer: ${state.inferFps}fps (${state.inferMs.toFixed(1)}ms)\n` +
    `mode: ${state.xrMode}${state.hasXR ? ' (XR可)' : ' (XR不可)'}\n`;
}

async function detectXR() {
  try {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      state.hasXR = await navigator.xr.isSessionSupported('immersive-ar');
    } else {
      state.hasXR = false;
    }
  } catch {
    state.hasXR = false;
  }
}

function getUserMediaConstraints() {
  switch (state.resolution) {
    case '720p': return { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    case '480p': return { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
    case '1080p':
    default: return { video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(getUserMediaConstraints());
    els.video.srcObject = stream;
    setStatus('カメラ開始');
  } catch (e) {
    // 降格リトライ
    if (state.resolution === '1080p') {
      state.resolution = '720p'; await startCamera(); return;
    } else if (state.resolution === '720p') {
      state.resolution = '480p'; await startCamera(); return;
    }
    setStatus('カメラ開始失敗');
    console.error(e);
  }
}

async function initThree() {
  if (state.renderer) return;
  state.renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true, alpha: true });
  state.renderer.setPixelRatio(window.devicePixelRatio);
  resize();
  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(60, els.canvas.clientWidth / els.canvas.clientHeight, 0.01, 20);
  const light = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
  state.scene.add(light);
}

function resize() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  if (state.renderer) state.renderer.setSize(w, h, false);
  if (state.camera) {
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
  }
}

function tick(ts) {
  const dt = ts - state.lastFrameTs;
  state.lastFrameTs = ts;
  state.fps = 1000 / Math.max(1, dt);

  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
  }

  hudRender();
  requestAnimationFrame(tick);
}

async function handleOpen() {
  const fp = await api.openModel();
  if (!fp) return;
  setStatus('モデル選択: ' + fp.split('/').pop());
  await refreshRecents();
  await api.setBaseDir(fp.substring(0, fp.lastIndexOf('/')));
  await loadPMX(fp);
}

async function refreshRecents() {
  const list = await api.listRecents();
  els.selRecent.innerHTML = '<option value="">最近</option>' +
    list.map(p => `<option value="${encodeURIComponent(p)}">${p}</option>`).join('');
}

function bindEvents() {
  els.open.addEventListener('click', handleOpen);
  els.selXR.addEventListener('change', async (e) => {
    state.xrMode = e.target.value;
    await api.setStore({ settings: { ...(await api.getStore('settings')), xrMode: state.xrMode } });
  });
  els.selReso.addEventListener('change', async (e) => {
    state.resolution = e.target.value;
    await startCamera();
    await api.setStore({ settings: { ...(await api.getStore('settings')), resolution: state.resolution } });
  });
  els.selInfer.addEventListener('change', async (e) => {
    state.inferFps = Number(e.target.value);
    await api.setStore({ settings: { ...(await api.getStore('settings')), inferFps: state.inferFps } });
  });
  els.selRecent.addEventListener('change', async (e) => {
    const v = decodeURIComponent(e.target.value || '');
    if (!v) return;
    setStatus('最近から選択: ' + v.split('/').pop());
    await api.addRecent(v);
    await api.setBaseDir(v.substring(0, v.lastIndexOf('/')));
    await loadPMX(v);
  });
  window.addEventListener('resize', resize);
}

async function restoreSettings() {
  const s = (await api.getStore())?.settings || {};
  if (s.xrMode) state.xrMode = s.xrMode;
  if (s.resolution) state.resolution = s.resolution;
  if (s.inferFps) state.inferFps = s.inferFps;
  els.selXR.value = state.xrMode;
  els.selReso.value = state.resolution;
  els.selInfer.value = String(state.inferFps);
}

async function main() {
  bindEvents();
  await restoreSettings();
  await detectXR();
  await startCamera();
  await initThree();
  await refreshRecents();
  await initHandTracking();
  requestAnimationFrame(tick);
}

main();

// --- MMD Loader 雛形 ---
const blobCache = new Map();
async function toBlobURL(absPath, mime = 'application/octet-stream') {
  if (blobCache.has(absPath)) return blobCache.get(absPath);
  const buf = await api.fsRead(absPath);
  if (!buf) throw new Error('読み込み失敗: ' + absPath);
  const u8 = new Uint8Array(buf);
  const url = URL.createObjectURL(new Blob([u8], { type: mime }));
  blobCache.set(absPath, url);
  return url;
}

function resolveRelative(baseAbs, rel) {
  // 簡易解決（Electron側でベース外は拒否）
  const parts = baseAbs.split('/');
  parts.pop();
  const baseDir = parts.join('/');
  const stack = baseDir.split('/');
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop(); else stack.push(seg);
  }
  return stack.join('/');
}

async function loadPMX(pmxAbsPath) {
  try {
    // URL変換: 依存テクスチャ等をblob:に差し替え
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      try {
        const abs = url.startsWith('blob:') || url.startsWith('data:')
          ? url
          : resolveRelative(pmxAbsPath, url);
        if (abs.startsWith('blob:') || abs.startsWith('data:')) return abs;
        // 画像系MIMEは簡易推定
        const ext = abs.split('.').pop()?.toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
        // 事前に非同期変換したいが、URLModifierは同期。既知パスはキャッシュ利用前提。
        // 未キャッシュの場合は一旦プレースホルダを返し、事後差し替え（簡易: 必要時生成）。
        const cached = blobCache.get(abs);
        if (cached) return cached;
        // 同期で返す必要があるため、暫定的にdata:空を返す（テクスチャは遅延ロードで再試行されることが多い）
        // 後続で明示読み込みを試みる
        toBlobURL(abs, mime).catch(() => {});
        return 'data:application/octet-stream;base64,';
      } catch {
        return url;
      }
    });

    const loader = new MMDLoader(manager);
    const pmxURL = await toBlobURL(pmxAbsPath, 'model/pmx');

    // 既存モデルをクリア
    for (let i = state.scene.children.length - 1; i >= 0; i--) {
      const o = state.scene.children[i];
      if (o.userData?.tag === 'pmx') state.scene.remove(o);
    }

    setStatus('PMX読み込み中');
    const mesh = await new Promise((resolve, reject) => {
      loader.load(pmxURL, resolve, (e) => setStatus(`読込 ${Math.round((e.loaded||0)/(e.total||1)*100)}%`), reject);
    });
    mesh.userData.tag = 'pmx';
    autoPlace(mesh);
    state.scene.add(mesh);
    setStatus('PMX読み込み完了');
  } catch (e) {
    console.error(e);
    setStatus('PMX読み込み失敗');
  }
}

function autoPlace(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const targetScreenRatio = 0.35;
  const cam = state.camera;
  const dist = 1.5; // 仮固定
  cam.position.set(0, 1.3, dist);
  cam.lookAt(0, 1.2, 0);
  const scale = size.y > 0 ? (targetScreenRatio * 2.0) / size.y : 1.0;
  obj.scale.setScalar(scale);
  obj.position.set(0, 0, 0);
}

// --- MediaPipe Hand Landmarker 雛形 ---
let inferTimer = null;
async function initHandTracking() {
  // 依存未導入のため雛形のみ。導入時に初期化。
  if (inferTimer) clearInterval(inferTimer);
  inferTimer = setInterval(() => {
    const t0 = performance.now();
    // TODO: Hand Landmarker推論をここで実施
    // state.video からフレームを入力し、ランドマークに応じて操作を更新
    const t1 = performance.now();
    state.inferMs = t1 - t0;
  }, Math.max(1, Math.round(1000 / Math.max(1, state.inferFps))));
}
