// 設計書に基づく最小骨格（XR自動切替、カメラ、HUD、MMD読込/MediaPipe雛形）
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
const api = window.api;

const els = {
  open: document.getElementById('btn-open'),
  selXR: document.getElementById('sel-xr'),
  selReso: document.getElementById('sel-reso'),
  selInfer: document.getElementById('sel-infer'),
  selQuality: document.getElementById('sel-quality'),
  selTexMax: document.getElementById('sel-texmax'),
  chkPhysics: document.getElementById('chk-physics'),
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
const xrHint = document.getElementById('xr-hint');
const dropHint = document.getElementById('drop-hint');

const defaultGesture = {
  T_grab: 0.035,
  T_release: 0.045,
  filter: 'ema',
  posAlpha: 0.5,
  rotAlpha: 0.7,
  minCutoff: 1.0,
  beta: 0.3,
  dCutoff: 1.0
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
  inferLastTs: performance.now(),
  gesture: { ...defaultGesture },
  quality: 'medium',
  physics: false,
  textureMax: 0
};
state.xrPlaced = false;

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
  // XRヒント表示
  xrHint.hidden = !(state.xrSession && !state.xrPlaced);
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
  state.lightHemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
  state.scene.add(state.lightHemi);
  state.lightDir = new THREE.DirectionalLight(0xffffff, 0.6);
  state.lightDir.position.set(2, 4, 2);
  state.lightDir.castShadow = true;
  state.lightDir.shadow.mapSize.set(1024, 1024);
  state.scene.add(state.lightDir);
  state.ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.25 })
  );
  state.ground.rotation.x = -Math.PI / 2;
  state.ground.receiveShadow = true;
  state.scene.add(state.ground);
  // モデルの親（XRアンカー/FB位置を集約）
  state.modelRoot = new THREE.Group();
  state.scene.add(state.modelRoot);
}

function applyQualityPreset() {
  const q = state.quality || 'medium';
  if (!state.renderer) return;
  if (q === 'low') {
    state.renderer.shadowMap.enabled = false;
    state.lightDir.intensity = 0.5;
    state.lightHemi.intensity = 0.8;
    state.ground.visible = false;
  } else if (q === 'high') {
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    state.lightDir.intensity = 1.0;
    state.lightHemi.intensity = 1.0;
    state.ground.visible = true;
  } else {
    state.renderer.shadowMap.enabled = true;
    state.lightDir.intensity = 0.7;
    state.lightHemi.intensity = 0.9;
    state.ground.visible = true;
  }
  if (state.model) { state.model.traverse(o => { if (o.isMesh) o.castShadow = (q !== 'low'); }); }
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

  // 物理ステップ（FB時）
  if (!state.xrSession && phys.enabled && phys.world) {
    phys.world.step(1/60);
    if (phys.body && !state._grabbing) {
      const b = phys.body.position; state.modelRoot.position.set(b.x, b.y, b.z);
    } else if (phys.body && state._grabbing) {
      const p = state.modelRoot.position; phys.body.position.set(p.x, p.y, p.z); phys.body.velocity.set(0,0,0);
    }
  }

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
  const btnReplace = document.getElementById('btn-replace');
  btnReplace?.addEventListener('click', () => {
    // XR再配置: アンカー解除し、設置やり直し
    state.xrPlaced = false;
    if (state.xrAnchor) { try { state.xrAnchor.delete && state.xrAnchor.delete(); } catch {} }
    state.xrAnchor = null;
    setStatus('XR再配置モード');
  });
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
  els.selQuality.addEventListener('change', async (e) => {
    state.quality = e.target.value;
    applyQualityPreset();
    await api.setStore({ settings: { ...(await api.getStore('settings')), quality: state.quality } });
  });
  els.selTexMax.addEventListener('change', async (e) => {
    state.textureMax = Number(e.target.value || 0);
    await api.setStore({ settings: { ...(await api.getStore('settings')), textureMax: state.textureMax } });
    setStatus(`テクスチャ最大辺=${state.textureMax || '無制限'}`);
    if (state.model) {
      showModal('テクスチャ縮小中');
      await downsampleModelTextures(state.model, state.textureMax);
      hideModal();
    }
  });
  els.chkPhysics.addEventListener('change', async (e) => {
    state.physics = !!e.target.checked;
    await ensurePhysics();
    await api.setStore({ settings: { ...(await api.getStore('settings')), physics: state.physics } });
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

  // ジェスチャー調整UI
  const btnGest = document.getElementById('btn-gest');
  const panel = document.getElementById('gest-panel');
  const btnClose = document.getElementById('btn-gest-close');
  const btnSave = document.getElementById('btn-gest-save');
  const selFilter = document.getElementById('in-filter');
  const inTg = document.getElementById('in-tgrab');
  const inTr = document.getElementById('in-trel');
  const inPa = document.getElementById('in-posa');
  const inRa = document.getElementById('in-rota');
  const inMin = document.getElementById('in-minc');
  const inBe = document.getElementById('in-beta');
  const inDc = document.getElementById('in-dc');
  const valTg = document.getElementById('val-tgrab');
  const valTr = document.getElementById('val-trel');
  const valPa = document.getElementById('val-posa');
  const valRa = document.getElementById('val-rota');
  const valMin = document.getElementById('val-minc');
  const valBe = document.getElementById('val-beta');
  const valDc = document.getElementById('val-dc');
  const btnCalib = document.getElementById('btn-calib');
  const calibStatus = document.getElementById('calib-status');

  function syncFilterVisibility() {
    const isOne = selFilter.value === 'oneeuro';
    document.querySelectorAll('.ema-only').forEach(e => e.style.display = isOne ? 'none' : 'grid');
    document.querySelectorAll('.oneeuro-only').forEach(e => e.style.display = isOne ? 'grid' : 'none');
  }
  function syncInputs() {
    const g = state.gesture;
    selFilter.value = g.filter;
    inTg.value = g.T_grab; valTg.textContent = Number(g.T_grab).toFixed(3);
    inTr.value = g.T_release; valTr.textContent = Number(g.T_release).toFixed(3);
    inPa.value = g.posAlpha; valPa.textContent = Number(g.posAlpha).toFixed(2);
    inRa.value = g.rotAlpha; valRa.textContent = Number(g.rotAlpha).toFixed(2);
    inMin.value = g.minCutoff; valMin.textContent = Number(g.minCutoff).toFixed(2);
    inBe.value = g.beta; valBe.textContent = Number(g.beta).toFixed(2);
    inDc.value = g.dCutoff; valDc.textContent = Number(g.dCutoff).toFixed(2);
    syncFilterVisibility();
  }
  btnGest?.addEventListener('click', () => { panel.hidden = false; syncInputs(); });
  btnClose?.addEventListener('click', () => { panel.hidden = true; });
  btnSave?.addEventListener('click', async () => {
    await api.setStore({ settings: { ...(await api.getStore('settings')), gesture: state.gesture } });
    panel.hidden = true; setStatus('ジェスチャー設定を保存');
  });
  selFilter.addEventListener('change', () => { state.gesture.filter = selFilter.value; syncFilterVisibility(); });
  inTg.addEventListener('input', () => { state.gesture.T_grab = Number(inTg.value); valTg.textContent = Number(inTg.value).toFixed(3); });
  inTr.addEventListener('input', () => { state.gesture.T_release = Number(inTr.value); valTr.textContent = Number(inTr.value).toFixed(3); });
  inPa.addEventListener('input', () => { state.gesture.posAlpha = Number(inPa.value); valPa.textContent = Number(inPa.value).toFixed(2); });
  inRa.addEventListener('input', () => { state.gesture.rotAlpha = Number(inRa.value); valRa.textContent = Number(inRa.value).toFixed(2); });
  inMin.addEventListener('input', () => { state.gesture.minCutoff = Number(inMin.value); valMin.textContent = Number(inMin.value).toFixed(2); });
  inBe.addEventListener('input', () => { state.gesture.beta = Number(inBe.value); valBe.textContent = Number(inBe.value).toFixed(2); });
  inDc.addEventListener('input', () => { state.gesture.dCutoff = Number(inDc.value); valDc.textContent = Number(inDc.value).toFixed(2); });

  // キャリブレーション
  let calibActive = false;
  let calibMin = Infinity, calibMax = 0;
  btnCalib.addEventListener('click', () => {
    calibActive = !calibActive;
    calibMin = Infinity; calibMax = 0;
    calibStatus.textContent = calibActive ? '計測中: ピンチ→離すを繰り返す' : '完了';
    btnCalib.textContent = calibActive ? '停止' : 'キャリブレーション開始';
    if (!calibActive) {
      if (isFinite(calibMin) && calibMax > calibMin) {
        const range = calibMax - calibMin;
        const grab = calibMin + range * 0.25; // 25% from the tightest pinch
        const rel = grab + Math.max(0.01, range * 0.2); // Hysteresis is 20% of range, or a minimum of 0.01
        state.gesture.T_grab = Math.max(0.005, Math.min(0.12, grab));
        state.gesture.T_release = Math.max(state.gesture.T_grab + 0.005, Math.min(0.15, rel));
        syncInputs();
      }
    }
  });

  // サンプル更新（推論ループから更新）
  state._calibUpdate = (dist) => {
    if (!calibActive) return;
    calibMin = Math.min(calibMin, dist);
    calibMax = Math.max(calibMax, dist);
    calibStatus.textContent = `min=${calibMin.toFixed(3)} max=${calibMax.toFixed(3)}`;
  };

  // ドラッグ&ドロップ
  const stage = document.getElementById('stage');
  function onDrag(e) { e.preventDefault(); e.stopPropagation(); dropHint.hidden = false; }
  function onDragLeave(e) { e.preventDefault(); e.stopPropagation(); dropHint.hidden = true; }
  function onDrop(e) {
    e.preventDefault(); e.stopPropagation(); dropHint.hidden = true;
    const files = Array.from(e.dataTransfer?.files || []);
    const pmx = files.find(f => (f.name || '').toLowerCase().endsWith('.pmx'));
    if (!pmx) { setStatus('PMXファイルをドロップして'); return; }
    // Electron環境のFileにはpathが付与される。無い場合は案内。
    const absPath = pmx.path || pmx.webkitRelativePath || '';
    if (!absPath) { setStatus('ドロップのパス取得不可。開くで選択'); return; }
    (async () => {
      try {
        await api.addRecent(absPath);
        await api.setBaseDir(absPath.substring(0, absPath.lastIndexOf('/')));
        await loadPMX(absPath);
        await refreshRecents();
      } catch (err) {
        console.error(err); setStatus('ドロップ読み込み失敗');
      }
    })();
  }
  ;['dragenter','dragover'].forEach(ev => stage.addEventListener(ev, onDrag));
  ;['dragleave','dragend'].forEach(ev => stage.addEventListener(ev, onDragLeave));
  stage.addEventListener('drop', onDrop);
  // ページ全体でデフォルトのファイルオープンを防止
  ['dragover','drop'].forEach(ev => document.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); }, false));
}

async function restoreSettings() {
  const s = (await api.getStore())?.settings || {};
  if (s.xrMode) state.xrMode = s.xrMode;
  if (s.resolution) state.resolution = s.resolution;
  if (s.inferFps) state.inferFps = s.inferFps;
  if (s.quality) state.quality = s.quality;
  if (typeof s.physics === 'boolean') state.physics = s.physics;
  if (typeof s.textureMax === 'number') state.textureMax = s.textureMax;
  if (s.gesture) state.gesture = { ...defaultGesture, ...s.gesture };
  els.selXR.value = state.xrMode;
  els.selReso.value = state.resolution;
  els.selInfer.value = String(state.inferFps);
  els.selQuality.value = state.quality;
  els.chkPhysics.checked = state.physics;
  els.selTexMax.value = String(state.textureMax || 0);
}

async function main() {
  bindEvents();
  await restoreSettings();
  await detectXR();
  await startCamera();
  await initThree();
  applyQualityPreset();
  await refreshRecents();
  await initHandTracking();
  await ensurePhysics();
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
    applyQualityPreset();
    if (state.physics) { await ensurePhysics(); updatePhysicsBodyFromModel(); }
    // テクスチャ縮小
    if (state.textureMax && state.textureMax > 0) {
      setProgress(0, 'テクスチャ縮小');
      await downsampleModelTextures(state.model, state.textureMax);
    }
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

async function downsampleModelTextures(root, maxEdge) {
  if (!maxEdge || maxEdge <= 0) return;
  const texProps = ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap','specularMap','alphaMap','bumpMap'];
  const tasks = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      for (const key of texProps) {
        const tex = m[key];
        if (tex && tex.image) tasks.push(maybeDownsampleTexture(tex, maxEdge));
      }
    }
  });
  await Promise.all(tasks);
}

function ensureImageLoaded(img) {
  return new Promise((resolve) => {
    if (!img) return resolve(null);
    if (img.complete || (img.width && img.height) || img instanceof HTMLCanvasElement || img instanceof ImageBitmap) return resolve(img);
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
  });
}

async function maybeDownsampleTexture(tex, maxEdge) {
  const img = await ensureImageLoaded(tex.image);
  try {
    const w = img.width || img.videoWidth || img.naturalWidth || 0;
    const h = img.height || img.videoHeight || img.naturalHeight || 0;
    if (!w || !h) return;
    const curMax = Math.max(w, h);
    if (curMax <= maxEdge) return;
    const scale = maxEdge / curMax;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, nw, nh);
    tex.image = canvas;
    tex.needsUpdate = true;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
  } catch {
    // ignore
  }
}

// --- MediaPipe Hand Landmarker 雛形 ---
let inferTimer = null;
let handLm = null;
let vision = null;
// 平滑化（EMA/OneEuro）・状態
const smooth = { posAlpha: 0.5, rotAlpha: 0.7 };
const filt = { pos: new THREE.Vector3(), rotY: 0, scale: 1 };
class LowPassFilter { constructor() { this.y = null; } filter(x, alpha) { if (this.y == null) this.y = x; this.y = alpha * x + (1 - alpha) * this.y; return this.y; } }
class OneEuroFilter { constructor(minCutoff, beta, dCutoff) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.xFilt = new LowPassFilter(); this.dxFilt = new LowPassFilter(); this.last = null; }
  alpha(dt, cutoff) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, dt) { if (dt <= 0) return x; const dx = this.last == null ? 0 : (x - this.last) / dt; const edx = this.dxFilt.filter(dx, this.alpha(dt, this.dCutoff)); const cutoff = this.minCutoff + this.beta * Math.abs(edx); const res = this.xFilt.filter(x, this.alpha(dt, cutoff)); this.last = res; return res; } }
let onePosX = null, onePosY = null, onePosZ = null, oneYaw = null;

// --- 物理（cannon-es） ---
const phys = { enabled: false, world: null, body: null, floor: null, last: 0, cannon: null };
async function ensurePhysics() {
  phys.enabled = !!state.physics;
  if (!phys.enabled) { if (phys.world) { /* keep for reuse */ } return; }
  if (!phys.cannon) {
    try {
      phys.cannon = await import('cannon-es');
    } catch (e) {
      setStatus('物理モジュール未導入');
      state.physics = false; els.chkPhysics.checked = false; return;
    }
  }
  if (!phys.world) {
    const C = phys.cannon;
    phys.world = new C.World({ gravity: new C.Vec3(0, -9.82, 0) });
    // 床
    phys.floor = new C.Body({ mass: 0, shape: new C.Plane() });
    phys.floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    phys.world.addBody(phys.floor);
  }
  // モデル剛体用意
  if (state.model && !phys.body) updatePhysicsBodyFromModel();
}

function updatePhysicsBodyFromModel() {
  if (!phys.enabled || !state.model) return;
  const C = phys.cannon; if (!C) return;
  // AABBから近似ボックス作成
  const box = new THREE.Box3().setFromObject(state.model);
  const size = new THREE.Vector3(); box.getSize(size);
  const half = new C.Vec3(Math.max(0.05, size.x/2), Math.max(0.05, size.y/2), Math.max(0.05, size.z/2));
  const shape = new C.Box(half);
  if (!phys.body) {
    phys.body = new C.Body({ mass: 1 });
    phys.world.addBody(phys.body);
  }
  phys.body.shapes = []; phys.body.addShape(shape);
  const p = state.modelRoot.position;
  phys.body.position.set(p.x, p.y || (half.y + 0.01), p.z);
}
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
    state.inferLastTs = t1;
  }, period);
}

function updateFromHands(result) {
  if (!state.modelRoot) return;
  const hands = result?.landmarks || [];
  const h0 = hands[0];
  const h1 = hands[1];
  const T_grab = state.gesture.T_grab, T_release = state.gesture.T_release;

  if (h0) {
    const d0 = pinchDistance(h0);
    state._grabbing = state._grabbing ? (d0 < T_release) : (d0 < T_grab);
    if (typeof state._calibUpdate === 'function') state._calibUpdate(d0);
  } else {
    state._grabbing = false;
  }
  if (h1) {
    const d1 = pinchDistance(h1);
    state._grabbing2 = state._grabbing2 ? (d1 < T_release) : (d1 < T_grab);
    if (typeof state._calibUpdate === 'function') state._calibUpdate(d1);
  } else {
    state._grabbing2 = false;
  }

  // 位置/回転（片手）
  if (state._grabbing && h0) {
    const c = handCenter(h0);
    const yaw = handYaw(h0);
    const pt = screenToWorld(c.x, c.y, 0);
    const dt = Math.max(1e-3, state.inferMs / 1000);
    if (pt) {
      if (state.gesture.filter === 'oneeuro') {
        onePosX ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
        onePosY ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
        onePosZ ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
        const x = onePosX.filter(pt.x, dt), y = onePosY.filter(pt.y, dt), z = onePosZ.filter(pt.z, dt);
        filt.pos.set(x, y, z);
      } else {
        filt.pos.lerp(pt, state.gesture.posAlpha);
      }
      state.modelRoot.position.copy(filt.pos);
    }
    if (isFinite(yaw)) {
      if (state.gesture.filter === 'oneeuro') {
        oneYaw ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
        const y = oneYaw.filter(yaw, dt);
        filt.rotY = y;
      } else {
        if (yawPrev == null) yawPrev = yaw;
        filt.rotY = lerpAngle(filt.rotY, yaw, state.gesture.rotAlpha);
      }
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
    filt.scale = filt.scale + (target - filt.scale) * (state.gesture.filter === 'oneeuro' ? 0.3 : state.gesture.posAlpha);
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
      state.xrPlaced = false; state.xrAnchor = null;
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
        // 掴みで設置確定（未設置時のみ）
        if (!state.xrPlaced && !state.xrAnchor && state._grabbing && results[0].createAnchor) {
          results[0].createAnchor().then(a => { state.xrAnchor = a; state.xrPlaced = true; }).catch(() => {});
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

      // 物理ステップ（XR時）
      if (phys.enabled && phys.world) {
        phys.world.step(1/60);
        if (phys.body && !state._grabbing) {
          const b = phys.body.position; state.modelRoot.position.set(b.x, b.y, b.z);
        } else if (phys.body && state._grabbing) {
          const p = state.modelRoot.position; phys.body.position.set(p.x, p.y, p.z); phys.body.velocity.set(0,0,0);
        }
      }

      state.renderer.render(state.scene, state.camera);
    });
  } catch (e) {
    console.warn('XR開始失敗', e);
    stopXR();
    setStatus('XR開始失敗: Fallbackへ切替');
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
