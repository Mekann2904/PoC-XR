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
const modal = {
  root: document.getElementById('modal'),
  msg: document.getElementById('modal-msg'),
  bar: document.getElementById('bar-inner'),
  errors: document.getElementById('modal-errors')
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
function showModal(msg) { modal.root.hidden = false; modal.msg.textContent = msg; modal.errors.textContent = ''; modal.bar.style.width = '0%'; }
function hideModal() { modal.root.hidden = true; }
function setProgress(p, msg) { modal.bar.style.width = `${Math.max(0, Math.min(100, p))}%`; if (msg) modal.msg.textContent = msg; }
function pushError(e) { modal.errors.textContent += (modal.errors.textContent ? '\n' : '') + e; }

function hudRender() {
  els.hud.innerText = `fps: ${state.fps.toFixed(0)}\n` +
    `infer: ${state.inferFps}fps (${state.inferMs.toFixed(1)}ms)\n` +
    `mode: ${state.xrMode}${state.hasXR ? ' (XR可)' : ' (XR不可)'}\n` +
    (state._grabbing ? 'grab: ON' : 'grab: OFF');
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
  // モデルの親（XRアンカー/FB位置を集約）
  state.modelRoot = new THREE.Group();
  state.scene.add(state.modelRoot);
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

  if (!state.xrSession && state.renderer && state.scene && state.camera) {
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
    await ensureModeLoop();
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
  await ensureModeLoop();
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
  rel = rel.replace(/\\/g, '/');
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
    // 事前検証: 拡張子/サイズ上限
    if (!pmxAbsPath.toLowerCase().endsWith('.pmx')) {
      pushError('非対応拡張子'); return;
    }
    const pmxBuf = await api.fsRead(pmxAbsPath);
    if (!pmxBuf) { pushError('PMXファイル読込失敗'); return; }
    const sizeMB = (pmxBuf.byteLength || pmxBuf.length || 0) / (1024*1024);
    if (sizeMB > 200) { pushError('サイズ上限超過: ' + sizeMB.toFixed(1) + 'MB'); return; }

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
        // 事前非同期変換は不可のため、キャッシュ未命中ならプレースホルダを返し、裏で変換
        const cached = blobCache.get(abs);
        if (cached) return cached;
        toBlobURL(abs, mime).catch(() => pushError('依存読み込み失敗: ' + abs));
        return (mime.startsWith('image/')) ? placeholderDataURL() : 'data:application/octet-stream;base64,';
      } catch {
        return url;
      }
    });

    const loader = new MMDLoader(manager);
    showModal('PMX読み込み開始');
    const pmxURL = URL.createObjectURL(new Blob([new Uint8Array(pmxBuf)], { type: 'model/pmx' }));

    // 既存モデルをクリア
    const parent = state.modelRoot || state.scene;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const o = parent.children[i];
      if (o.userData?.tag === 'pmx') parent.remove(o);
    }

    setStatus('PMX読み込み中');
    const mesh = await new Promise((resolve, reject) => {
      loader.load(pmxURL, resolve, (e) => {
        const p = Math.round((e.loaded||0)/(e.total||1)*100);
        setStatus(`読込 ${p}%`);
        setProgress(p, `アセット読み込み ${p}%`);
      }, (err) => {
        pushError('PMX読込エラー'); reject(err);
      });
    });
    mesh.userData.tag = 'pmx';
    autoPlace(mesh);
    state.modelRoot.add(mesh);
    state.model = mesh;
    setStatus('PMX読み込み完了');
    hideModal();
  } catch (e) {
    console.error(e);
    setStatus('PMX読み込み失敗');
    showModal('読み込み失敗');
    pushError(String(e?.message || e));
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

function placeholderDataURL() {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const g = c.getContext('2d');
  g.fillStyle = '#777'; g.fillRect(0,0,2,2);
  g.fillStyle = '#999'; g.fillRect(0,0,1,1); g.fillRect(1,1,1,1);
  return c.toDataURL('image/png');
}

// --- MediaPipe Hand Landmarker 雛形 ---
let inferTimer = null;
let handLm = null;
let vision = null;
// 平滑化（EMA）・状態
const smooth = { posAlpha: 0.5, rotAlpha: 0.7 };
const filt = { pos: new THREE.Vector3(), rotY: 0, scale: 1 };
let pinchBaseline = null;
let yawPrev = null;
state._grabbing = false;
state._grabbing2 = false;
async function initHandTracking() {
  if (inferTimer) { clearInterval(inferTimer); inferTimer = null; }
  try {
    // 動的import（未導入時は失敗→雛形で継続）
    const mod = await import(/* @vite-ignore */ '@mediapipe/tasks-vision').catch(() => null);
    if (!mod) throw new Error('tasks-vision未導入');
    vision = mod;

    // モデルをローカルassetsから読み込み（配置前提）
    const modelAbs = resolveRelative(window.location.pathname, 'assets/hand_landmarker.task');
    const modelBuf = await api.fsRead(modelAbs);
    if (!modelBuf) throw new Error('モデル未配置: assets/hand_landmarker.task');

    const fileset = await vision.FilesetResolver.forVisionTasks({
      wasmLoaderPath: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js',
      wasmBinaryPath: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'
    });
    handLm = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetBuffer: new Uint8Array(modelBuf)
      },
      runningMode: 'VIDEO',
      numHands: 2
    });
  } catch (e) {
    console.warn('HandLandmarker初期化スキップ:', e?.message || e);
    handLm = null;
  }

  // 推論ループ（導入済みなら実推論、未導入ならメトリクスのみ更新）
  const period = Math.max(1, Math.round(1000 / Math.max(1, state.inferFps)));
  inferTimer = setInterval(() => {
    const t0 = performance.now();
    if (handLm && els.video.readyState >= 2) {
      try {
        const res = handLm.detectForVideo(els.video, performance.now());
        updateFromHands(res);
      } catch (e) {
        // 推論失敗は継続
      }
    }
    const t1 = performance.now();
    state.inferMs = t1 - t0;
  }, period);
}

function updateFromHands(result) {
  if (!state.modelRoot) return;
  const hands = result?.landmarks || [];
  const h0 = hands[0];
  const h1 = hands[1];
  const T_grab = 0.035, T_release = 0.045;

  if (h0) {
    const d0 = pinchDistance(h0);
    state._grabbing = state._grabbing ? (d0 < T_release) : (d0 < T_grab);
  } else {
    state._grabbing = false;
  }
  if (h1) {
    const d1 = pinchDistance(h1);
    state._grabbing2 = state._grabbing2 ? (d1 < T_release) : (d1 < T_grab);
  } else {
    state._grabbing2 = false;
  }

  // 位置/回転（片手）
  if (state._grabbing && h0) {
    const c = handCenter(h0);
    const yaw = handYaw(h0);
    const pt = screenToWorld(c.x, c.y, 0);
    if (pt) {
      filt.pos.lerp(pt, smooth.posAlpha);
      state.modelRoot.position.copy(filt.pos);
    }
    if (isFinite(yaw)) {
      if (yawPrev == null) yawPrev = yaw;
      filt.rotY = lerpAngle(filt.rotY, yaw, smooth.rotAlpha);
      state.modelRoot.rotation.y = filt.rotY;
    }
  } else {
    yawPrev = null;
  }

  // スケール（両手）
  if (state._grabbing && state._grabbing2 && h0 && h1 && state.model) {
    const c0 = handCenter(h0), c1 = handCenter(h1);
    const dist = Math.hypot(c0.x - c1.x, c0.y - c1.y);
    if (pinchBaseline == null) pinchBaseline = dist;
    const target = Math.max(0.2, Math.min(5.0, 1.0 * (dist / Math.max(1e-5, pinchBaseline))));
    filt.scale = filt.scale + (target - filt.scale) * smooth.posAlpha;
    state.model.scale.setScalar(filt.scale);
  } else {
    pinchBaseline = null;
  }
}

const _raycaster = new THREE.Raycaster();
function screenToWorld(nx, ny, zPlane = 0) {
  // nx, ny: 0..1（左上原点）→ NDCへ
  const x = nx * 2 - 1;
  const y = ny * -2 + 1;
  _raycaster.setFromCamera({ x, y }, state.camera);
  const planeNormal = new THREE.Vector3(0, 0, 1);
  const plane = new THREE.Plane(planeNormal, -zPlane);
  const pt = new THREE.Vector3();
  const hit = _raycaster.ray.intersectPlane(plane, pt);
  return hit ? pt : null;
}
// --- XR層（A: WebXR Hit Test） ---
state.xrSession = null;
state.xrRefSpace = null;
state.viewerSpace = null;
state.hitTestSource = null;
state.xrAnchor = null;
state.reticle = null;

async function ensureModeLoop() {
  if (state.xrMode === 'xr' || (state.xrMode === 'auto' && state.hasXR)) {
    await startXR();
  } else {
    stopXR();
    requestAnimationFrame(tick);
  }
}

function stopXR() {
  if (state.xrSession) {
    try { state.xrSession.end(); } catch {}
  }
  state.xrSession = null;
  if (state.renderer) state.renderer.xr.enabled = false;
}

async function startXR() {
  if (!navigator.xr) { requestAnimationFrame(tick); return; }
  try {
    const session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'] });
    state.xrSession = session;
    state.renderer.xr.enabled = true;
    state.renderer.xr.setReferenceSpaceType('local');
    state.viewerSpace = await session.requestReferenceSpace('viewer');
    state.xrRefSpace = await session.requestReferenceSpace('local');
    state.hitTestSource = await session.requestHitTestSource({ space: state.viewerSpace });
    createReticle();

    session.addEventListener('end', () => {
      state.xrSession = null; state.hitTestSource = null; if (state.reticle) { state.scene.remove(state.reticle); state.reticle = null; }
      if (state.renderer) state.renderer.xr.enabled = false;
      requestAnimationFrame(tick);
    });

    state.renderer.setAnimationLoop((t, frame) => {
      if (!frame) return;
      const results = state.hitTestSource ? frame.getHitTestResults(state.hitTestSource) : [];
      if (results.length > 0) {
        const pose = results[0].getPose(state.xrRefSpace);
        if (pose && state.reticle) {
          state.reticle.visible = true;
          state.reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
          const o = pose.transform.orientation; state.reticle.quaternion.set(o.x, o.y, o.z, o.w);
        }
        if (!state.xrAnchor && state._grabbing && results[0].createAnchor) {
          results[0].createAnchor().then(a => { state.xrAnchor = a; }).catch(() => {});
        }
      } else if (state.reticle) {
        state.reticle.visible = false;
      }

      if (state.xrAnchor) {
        const pose = frame.getPose(state.xrAnchor.anchorSpace || state.xrAnchor, state.xrRefSpace);
        if (pose) {
          state.modelRoot.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
          const o = pose.transform.orientation; state.modelRoot.quaternion.set(o.x, o.y, o.z, o.w);
        }
      }

      state.renderer.render(state.scene, state.camera);
    });
  } catch (e) {
    console.warn('XR開始失敗', e);
    stopXR();
    requestAnimationFrame(tick);
  }
}

function createReticle() {
  if (state.reticle) return;
  const geom = new THREE.RingGeometry(0.05, 0.06, 32);
  const mat = new THREE.MeshBasicMaterial({ color: 0x33ff66, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2; mesh.visible = false; state.reticle = mesh; state.scene.add(mesh);
}

function pinchDistance(h) { const a = h[4], b = h[8]; return Math.hypot(a.x - b.x, a.y - b.y); }
function handCenter(h) { const cx = (h[0].x + h[5].x + h[17].x) / 3; const cy = (h[0].y + h[5].y + h[17].y) / 3; return { x: cx, y: cy }; }
function handYaw(h) { const a = h[0], b = h[9]; const vx = b.x - a.x, vy = b.y - a.y; return Math.atan2(-vx, -vy); }
function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; return a + d * t; }
