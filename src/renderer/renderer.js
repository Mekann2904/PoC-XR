// 設計書に基づく最小骨格（XR自動切替、カメラ、HUD、モデル読込の雛形）

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
  if (state.three) return; // once
  try {
    const THREE = await import('three');
    state.three = THREE;
    state.renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true, alpha: true });
    state.renderer.setPixelRatio(window.devicePixelRatio);
    resize();
    state.scene = new THREE.Scene();
    state.camera = new THREE.PerspectiveCamera(60, els.canvas.clientWidth / els.canvas.clientHeight, 0.01, 20);
    const light = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    state.scene.add(light);
  } catch (e) {
    setStatus('three未導入。npm install 実行要');
    console.warn('three import failed', e);
  }
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
  // 実装予定: PMX読み込み（MMDLoader）→ シーンに追加
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
  requestAnimationFrame(tick);
}

main();

