// 設計書に基づく最小骨格（XR自動切替、カメラ、HUD、MMD読込/MediaPipe雛形)
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
const assetHint = document.getElementById('asset-hint');

const defaultGesture = {
  T_grab: 0.035,
  T_release: 0.045,
  filter: 'ema',
  posAlpha: 0.5,
  rotAlpha: 0.7,
  // 非掴み時の回転→スケール変換ゲイン
  scaleGain: 0.5,
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
  // Fallback用 擬似Z（z=0基準の前後位置）
  fbZ: 0,
  fbZMin: -1.0,
  fbZMax: 1.0,
  lastFrameTs: performance.now(),
  fps: 0,
  inferMs: 0,
  inferCounter: 0,
  inferLastTs: performance.now(),
  gesture: { ...defaultGesture },
  quality: 'medium',
  physics: false,
  textureMax: 0,
  logLevel: 'info',
  lastHands: 0
};
state.xrPlaced = false;

function setStatus(msg) { els.status.textContent = msg; }
function showModal(msg) { modal.root.hidden = false; modal.msg.textContent = msg; modal.errors.textContent = ''; modal.bar.style.width = '0%'; }
function hideModal() { modal.root.hidden = true; }
function setProgress(p, msg) { modal.bar.style.width = `${Math.max(0, Math.min(100, p))}%`; if (msg) modal.msg.textContent = msg; }
function pushError(e) { modal.errors.textContent += (modal.errors.textContent ? '\n' : '') + e; }

function hudRender() {
  const gestureMode = gestureState?.currentMode || 'none';
  const modeDisplay = {
    'none': '待機中',
    'move': '移動中',
    'rotate': '回転中', 
    'scale': 'スケール中',
    'camera': 'カメラ操作',
    'reset': 'リセット待機',
    'point': 'ポイント',
    'special': '特殊操作'
  };
  
  els.hud.innerText = `fps: ${state.fps.toFixed(0)}
` +
    `infer: ${state.inferFps}fps (${state.inferMs.toFixed(1)}ms)
` +
    `mode: ${state.xrMode}${state.hasXR ? ' (XR可)' : ' (XR不可)'}
` +
    `hands: ${state.lastHands || 0}
` +
    `gesture: ${modeDisplay[gestureMode] || gestureMode}
` +
    (state._grabbing ? 'grab: ON' : 'grab: OFF');
  // XRヒント表示
  xrHint.hidden = !(state.xrSession && !state.xrPlaced);
  if (assetHint) assetHint.hidden = !state._needHandModel;
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
  
  // レンダラーの初期化
  state.renderer = new THREE.WebGLRenderer({ 
    canvas: els.canvas, 
    antialias: true, 
    alpha: true,
    premultipliedAlpha: false 
  });
  state.renderer.setPixelRatio(window.devicePixelRatio);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.0;
  
  resize();
  
  // シーンとカメラの初期化
  state.scene = new THREE.Scene();
  state.scene.background = null; // 透明背景を維持
  
  state.camera = new THREE.PerspectiveCamera(
    50, // より自然な視野角
    els.canvas.clientWidth / els.canvas.clientHeight, 
    0.1, 
    100
  );
  
  // 初期カメラ位置（モデル読み込み前の適当な位置）
  state.camera.position.set(0, 1.6, 5);
  state.camera.lookAt(0, 1, 0);
  
  // 照明の設定
  state.lightHemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.8);
  state.scene.add(state.lightHemi);
  
  state.lightDir = new THREE.DirectionalLight(0xffffff, 0.8);
  state.lightDir.position.set(2, 4, 3);
  state.lightDir.castShadow = true;
  state.lightDir.shadow.mapSize.set(2048, 2048);
  state.lightDir.shadow.camera.near = 0.5;
  state.lightDir.shadow.camera.far = 50;
  state.lightDir.shadow.camera.left = -10;
  state.lightDir.shadow.camera.right = 10;
  state.lightDir.shadow.camera.top = 10;
  state.lightDir.shadow.camera.bottom = -10;
  state.scene.add(state.lightDir);
  
  // 地面の追加
  state.ground = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.3 })
  );
  state.ground.rotation.x = -Math.PI / 2;
  state.ground.receiveShadow = true;
  state.scene.add(state.ground);
  
  // モデルの親グループ（XRアンカー/FB位置を集約）
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

  // レンダリング（非XR時）
  if (!state.xrSession && state.renderer && state.scene && state.camera) {
    // キャンバスのサイズが変更されている場合の対応
    const canvas = state.renderer.domElement;
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      state.renderer.setSize(displayWidth, displayHeight, false);
      state.camera.aspect = displayWidth / displayHeight;
      state.camera.updateProjectionMatrix();
    }
    
    state.renderer.render(state.scene, state.camera);
  }

  hudRender();
  requestAnimationFrame(tick);
}

async function handleOpen() {
  const fp = await api.openModel();
  if (!fp) return;
  console.log('Selected file path:', fp);
  setStatus('モデル選択: ' + fp.split('/').pop());
  await refreshRecents();
  const baseDir = fp.substring(0, fp.lastIndexOf('/'));
  console.log('Setting base directory:', baseDir);
  const baseDirResult = await api.setBaseDir(baseDir);
  console.log('Base directory set result:', baseDirResult);
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
  const inSc = document.getElementById('in-scale');
  const inMin = document.getElementById('in-minc');
  const inBe = document.getElementById('in-beta');
  const inDc = document.getElementById('in-dc');
  const valTg = document.getElementById('val-tgrab');
  const valTr = document.getElementById('val-trel');
  const valPa = document.getElementById('val-posa');
  const valRa = document.getElementById('val-rota');
  const valSc = document.getElementById('val-scale');
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
    inSc.value = g.scaleGain; valSc.textContent = Number(g.scaleGain).toFixed(2);
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
  inSc.addEventListener('input', () => { state.gesture.scaleGain = Number(inSc.value); valSc.textContent = Number(inSc.value).toFixed(2); });
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
  if (s.logLevel) state.logLevel = s.logLevel;
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
  bindVerifyPanel();
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

// 受入基準パネル
let verifyTimer = null;
function bindVerifyPanel() {
  const btn = document.getElementById('btn-verify');
  const panel = document.getElementById('verify-panel');
  const close = document.getElementById('btn-ver-close');
  const elMode = document.getElementById('ver-mode');
  const elFps = document.getElementById('ver-fps');
  const elInfer = document.getElementById('ver-infer');
  const elHands = document.getElementById('ver-hands');
  const elLat = document.getElementById('ver-lat');
  const elPass = document.getElementById('ver-pass');
  const selLog = document.getElementById('ver-log');

  function update() {
    const xr = !!state.xrSession;
    const fps = state.fps;
    const infer = state.inferMs;
    const lat = infer + (1000 / Math.max(1, fps));
    const pass = xr ? (lat <= 120) : (fps >= 24);
    elMode.textContent = xr ? 'XR(A)' : 'FB(B)';
    elFps.textContent = fps.toFixed(1);
    elInfer.textContent = infer.toFixed(1);
    elHands.textContent = String(state.lastHands);
    elLat.textContent = lat.toFixed(1);
    elPass.textContent = pass ? 'OK' : 'NG';
    elPass.style.color = pass ? '#4caf50' : '#ff5252';
  }

  btn?.addEventListener('click', async () => {
    selLog.value = state.logLevel;
    panel.hidden = false;
    if (verifyTimer) clearInterval(verifyTimer);
    verifyTimer = setInterval(update, 250);
  });
  close?.addEventListener('click', () => {
    panel.hidden = true;
    if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
  });
  selLog.addEventListener('change', async () => {
    state.logLevel = selLog.value;
    await api.setStore({ settings: { ...(await api.getStore('settings')), logLevel: state.logLevel } });
  });
}

main();

// --- MMD Loader 雛形 ---
const blobCache = new Map();
async function toBlobURL(absPath, mime = 'application/octet-stream') {
  if (blobCache.has(absPath)) return blobCache.get(absPath);
  
  try {
    console.log('Reading file for blob URL:', absPath);
    const buf = await api.fsRead(absPath);
    if (!buf) {
      console.warn('File not found or empty:', absPath);
      throw new Error('読み込み失敗: ' + absPath);
    }
    
    const bufSize = buf.byteLength || buf.length || 0;
    console.log('File size:', bufSize, 'bytes');
    
    if (bufSize === 0) {
      console.warn('Empty file:', absPath);
      throw new Error('空ファイル: ' + absPath);
    }
    
    const u8 = new Uint8Array(buf);
    const url = URL.createObjectURL(new Blob([u8], { type: mime }));
    blobCache.set(absPath, url);
    console.log('Created blob URL:', url, 'for', absPath);
    return url;
  } catch (e) {
    console.error('toBlobURL error for', absPath, ':', e);
    throw e;
  }
}

// アプリ同梱リソースをBlob URL化
async function toBlobURLApp(relPath, mime = 'application/octet-stream') {
  const key = `app:${relPath}`;
  if (blobCache.has(key)) return blobCache.get(key);
  const buf = await api.fsReadApp(relPath);
  if (!buf) throw new Error('読み込み失敗(app): ' + relPath);
  const u8 = new Uint8Array(buf);
  const url = URL.createObjectURL(new Blob([u8], { type: mime }));
  blobCache.set(key, url);
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
    showModal('アセット準備中...');
    setProgress(0, 'アセット準備中');

    // パスの検証
    if (!pmxAbsPath || !pmxAbsPath.toLowerCase().endsWith('.pmx')) {
      throw new Error('無効なPMXファイルパス');
    }

    const baseDir = pmxAbsPath.substring(0, pmxAbsPath.lastIndexOf('/'));
    const allFiles = await api.fsListFiles(baseDir);

    if (!allFiles || allFiles.length === 0) {
      console.warn('No files found in base directory:', baseDir);
    }

    // テクスチャファイルのキャッシュ
    const imageExt = ['png', 'jpg', 'jpeg', 'bmp', 'tga'];
    const imageFiles = allFiles.filter(p => {
      const ext = p.split('.').pop()?.toLowerCase();
      return imageExt.includes(ext);
    });
    
    if (imageFiles.length > 0) {
      setProgress(10, 'テクスチャキャッシュ中');
      const imagePromises = imageFiles.map(async (p) => {
        try {
          const ext = p.split('.').pop()?.toLowerCase();
          return await toBlobURL(p, `image/${ext}`);
        } catch (err) {
          console.warn('Failed to cache texture:', p, err);
          return null;
        }
      });
      await Promise.all(imagePromises);
      console.log(`${imageFiles.length} texture files cached.`);
    }

    setProgress(20, 'PMXファイル読み込み中');
    const pmxBuf = await api.fsRead(pmxAbsPath);
    if (!pmxBuf) { 
      throw new Error('PMXファイル読込失敗: ファイルが見つからないか、読み込み権限がありません'); 
    }

    const pmxURL = URL.createObjectURL(new Blob([new Uint8Array(pmxBuf)], { type: 'application/octet-stream' }));
    const DUMMY_PMX_URL = 'dummy.pmx';

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (url === DUMMY_PMX_URL) {
        return pmxURL;
      }
      if (url.startsWith('data:')) {
        return url;
      }

      let relPath = decodeURIComponent(url.replace(/\\/g, '/'));
      if (relPath.startsWith('blob:file:///')) {
        relPath = relPath.substring('blob:file:///'.length);
      }

      const absolutePath = resolveRelative(pmxAbsPath, relPath);

      if (blobCache.has(absolutePath)) {
        return blobCache.get(absolutePath);
      }

      console.warn(`Texture not in cache, using placeholder: ${absolutePath} (from: ${url})`);
      return placeholderDataURL();
    });

    const loader = new MMDLoader(manager);

    // 既存のモデルを削除
    const parent = state.modelRoot || state.scene;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const o = parent.children[i];
      if (o.userData?.tag === 'pmx') {
        parent.remove(o);
        // リソースのクリーンアップ
        if (o.traverse) {
          o.traverse((child) => {
            if (child.isMesh) {
              if (child.geometry) child.geometry.dispose();
              if (child.material) {
                if (Array.isArray(child.material)) {
                  child.material.forEach(mat => mat.dispose());
                } else {
                  child.material.dispose();
                }
              }
            }
          });
        }
      }
    }

    setProgress(30, 'PMXパース中');
    setStatus('PMX読み込み中');
    
    const mesh = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('読み込みタイムアウト（30秒）'));
      }, 30000);

      loader.load(DUMMY_PMX_URL, (loadedMesh) => {
        clearTimeout(timeout);
        resolve(loadedMesh);
      }, (e) => {
        const p = Math.round((e.loaded || 0) / (e.total || 1) * 100);
        setStatus(`読込 ${p}%`);
        setProgress(30 + (p * 0.4), `アセット読み込み ${p}%`);
      }, (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    if (!mesh) {
      throw new Error('モデルの読み込みに失敗しました');
    }

    setProgress(80, 'モデル配置中');
    mesh.userData.tag = 'pmx';
    autoPlace(mesh);
    state.modelRoot.add(mesh);
    state.model = mesh;

    console.log('Model successfully loaded:');
    console.log('  - Position:', state.modelRoot.position);
    console.log('  - Scale:', mesh.scale);
    console.log('  - Camera:', state.camera.position);

    setProgress(90, '品質設定適用中');
    applyQualityPreset();
    
    if (state.physics) { 
      await ensurePhysics(); 
      updatePhysicsBodyFromModel(); 
    }
    
    if (state.textureMax && state.textureMax > 0) {
      setProgress(95, 'テクスチャ縮小');
      await downsampleModelTextures(state.model, state.textureMax);
    }

    setProgress(100, '完了');
    setStatus('PMX読み込み完了');
    
    // Blob URLのクリーンアップ
    setTimeout(() => {
      URL.revokeObjectURL(pmxURL);
    }, 1000);
    
    hideModal();
  } catch (e) {
    console.error('PMX loading error:', e);
    setStatus('PMX読み込み失敗: ' + (e?.message || String(e)));
    showModal('読み込み失敗');
    pushError(String(e?.message || e));
    
    // エラー時もモーダルは適切な時間で閉じる
    setTimeout(() => {
      hideModal();
    }, 5000);
  }
}

function autoPlace(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  
  console.log('Model bounding box size:', size.x, size.y, size.z);
  console.log('Model center:', center.x, center.y, center.z);
  
  // モデルを原点に移動（バウンディングボックスの底面の中心を基準に）
  obj.position.set(-center.x, -box.min.y, -center.z);
  
  // 適切なスケールを計算（画面の40%程度になるように調整）
  const targetScreenRatio = 0.4;
  const maxDimension = Math.max(size.x, size.y, size.z);
  const scale = maxDimension > 0 ? targetScreenRatio / maxDimension : 1.0;
  obj.scale.setScalar(scale);
  filt.scale = scale; // スケール変更の基準値を設定
  
  // モデルルートを初期位置に配置（画面中央、地面に立つように）
  state.modelRoot.position.set(0, 0, 0);
  state.modelRoot.rotation.set(0, 0, 0);

  // カメラ位置を適切に調整
  const cam = state.camera;
  const scaledHeight = size.y * scale;
  const scaledMaxDim = maxDimension * scale;
  
  // カメラの距離は、モデル全体が見えるように計算
  const fov = cam.fov * Math.PI / 180; // ラジアンに変換
  const distance = Math.max(3.0, scaledMaxDim / (2 * Math.tan(fov / 2)) * 1.5);
  
  // カメラをモデルの少し前方、やや上から見下ろす位置に配置
  cam.position.set(0, scaledHeight * 0.6, distance);
  cam.lookAt(new THREE.Vector3(0, scaledHeight * 0.5, 0));
  
  // カメラの描画範囲を調整
  cam.near = Math.max(0.1, distance * 0.1);
  cam.far = Math.max(20, distance * 3);
  cam.updateProjectionMatrix();
  
  console.log('Applied scale:', scale);
  console.log('Camera distance:', distance);
  console.log('Camera position:', cam.position.x, cam.position.y, cam.position.z);
  console.log('Final model position:', obj.position.x, obj.position.y, obj.position.z);
  console.log('Model root position:', state.modelRoot.position.x, state.modelRoot.position.y, state.modelRoot.position.z);
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
let pinchScaleBaseline = null;
let yawScalePrev = null;
let yawPrev = null;
// 擬似Z用（片手ピンチ強度→Z平面）
let pinchZBaseline = null;
let fbZGrabStart = 0;
let oneZPlane = null;
state._grabbing = false;
state._grabbing2 = false;
async function initHandTracking() {
  if (inferTimer) { clearInterval(inferTimer); inferTimer = null; }
  try {
    // 事前確認: パッケージ有無
    const hasVision = await api.fsExistsApp('node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
    if (!hasVision) throw new Error('tasks-vision未導入');
    // 動的import（importmap経由）
    const mod = await import('@mediapipe/tasks-vision');
    vision = mod;

    // モデルをアプリ同梱assetsから読み込み（安全経路）
    const modelBuf = await api.fsReadApp('assets/hand_landmarker.task');
    if (!modelBuf) { if (assetHint) assetHint.hidden = false; throw new Error('モデル未配置: assets/hand_landmarker.task'); }

    // 正しいWASMパスでFilesetResolverを作成
    const fileset = await vision.FilesetResolver.forVisionTasks(
      "../../node_modules/@mediapipe/tasks-vision/wasm/"
    );
    handLm = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetBuffer: new Uint8Array(modelBuf)
      },
      runningMode: 'VIDEO',
      numHands: 2
    });
  } catch (e) {
    // 未導入時は情報メッセージに留め、FBジェスチャ骨格のみ継続
    const msg = (e && (e.stack || e.message)) ? (e.stack || e.message) : (typeof e === 'string' ? e : (e?.type ? `Event:${e.type}` : String(e)));
    if (state.logLevel !== 'silent') console.info('手トラッキング未導入: ', msg);
    state._needHandModel = msg.includes('モデル未配置');
    if (state._needHandModel) { setStatus('手検出モデル未配置: assetsへ配置'); if (assetHint) assetHint.hidden = false; }
    else { setStatus('手トラッキング未導入: 雛形動作'); if (assetHint) assetHint.hidden = true; }
    handLm = null;
  }

  // 推論ループ（導入済みなら実推論、未導入ならメトリクスのみ更新）
  const period = Math.max(1, Math.round(1000 / Math.max(1, state.inferFps)));
  inferTimer = setInterval(() => {
    const t0 = performance.now();
    if (handLm && els.video.readyState >= 2) {
      try {
        const res = handLm.detectForVideo(els.video, performance.now());
        state.lastHands = (res?.landmarks || []).length;
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

// 操作状態の管理
const gestureState = {
  currentMode: 'none', // 'move', 'rotate', 'scale', 'camera'
  lastMode: 'none',
  modeStartTime: 0,
  handsHistory: [],
  gestureConfidence: 0
};

function updateFromHands(result) {
  if (!state.modelRoot) return;
  const hands = result?.landmarks || [];
  const h0 = hands[0];
  const h1 = hands[1];
  const dt = Math.max(1e-3, state.inferMs / 1000);

  // 手の検出情報を履歴に追加（安定性向上のため）
  gestureState.handsHistory.push({ h0, h1, timestamp: performance.now() });
  if (gestureState.handsHistory.length > 5) {
    gestureState.handsHistory.shift();
  }

  // ジェスチャー認識と操作モード決定
  const newMode = determineGestureMode(h0, h1);
  if (newMode !== gestureState.currentMode) {
    gestureState.lastMode = gestureState.currentMode;
    gestureState.currentMode = newMode;
    gestureState.modeStartTime = performance.now();
    console.log(`Gesture mode changed: ${gestureState.lastMode} -> ${gestureState.currentMode}`);
  }

  // 操作の実行
  executeGestureOperation(h0, h1, dt);
  
  // 状態の更新（レガシー互換）
  updateLegacyGrabState(h0, h1);
}

function determineGestureMode(h0, h1) {
  if (!h0) return 'none';
  
  // 両手が検出されている場合
  if (h0 && h1) {
    const isPinchBoth = pinchDistance(h0) < state.gesture.T_grab && 
                       pinchDistance(h1) < state.gesture.T_grab;
    const isOpenBoth = isOpenPalmGesture(h0) && isOpenPalmGesture(h1);
    const distance = getHandDistance(h0, h1);
    
    if (isPinchBoth && distance > 0.3) {
      return 'scale'; // 両手ピンチで離れている = スケール
    } else if (isOpenBoth) {
      return 'camera'; // 両手パー = カメラ操作
    } else if (isPinchBoth) {
      return 'rotate'; // 両手ピンチで近い = 回転
    }
  }
  
  // 片手の場合
  if (h0) {
    const isPinch = pinchDistance(h0) < state.gesture.T_grab;
    const isPointing = isPointingGesture(h0);
    const isOpenPalm = isOpenPalmGesture(h0);
    const isFist = isFistGesture(h0);
    const isPeace = isPeaceSignGesture(h0);
    
    if (isPinch) {
      return 'move'; // ピンチ = 移動
    } else if (isPointing) {
      return 'point'; // 指差し = ポイント（将来的な機能用）
    } else if (isFist) {
      return 'reset'; // グー = リセット
    } else if (isPeace) {
      return 'special'; // ピース = 特殊操作
    }
  }
  
  return 'none';
}

function executeGestureOperation(h0, h1, dt) {
  const mode = gestureState.currentMode;
  
  switch (mode) {
    case 'move':
      handleMoveGesture(h0, dt);
      break;
    case 'rotate':
      handleRotateGesture(h0, h1, dt);
      break;
    case 'scale':
      handleScaleGesture(h0, h1, dt);
      break;
    case 'camera':
      handleCameraGesture(h0, h1, dt);
      break;
    case 'reset':
      handleResetGesture(h0);
      break;
    case 'special':
      handleSpecialGesture(h0, dt);
      break;
    default:
      // 何もしない
      break;
  }
}

function handleMoveGesture(h0, dt) {
  // ピンチの中心点を使用（より正確な操作点）
  const pinchCenter = getPinchCenter(h0);
  const pt = screenToWorld(pinchCenter.x, pinchCenter.y, 0);
  if (pt) {
    if (state.gesture.filter === 'oneeuro') {
      onePosX ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
      onePosY ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
      onePosZ ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
      const x = onePosX.filter(pt.x, dt), y = onePosY.filter(pt.y, dt), z = onePosZ.filter(pt.z, dt);
      filt.pos.set(x, y, z);
    } else {
      filt.pos.lerp(pt, state.gesture.posAlpha * 1.2); // 移動時は適度に敏感に
    }
    state.modelRoot.position.copy(filt.pos);
  }
}

function handleRotateGesture(h0, h1, dt) {
  // 両手のピンチ中心を使った回転
  const c0 = getPinchCenter(h0);
  const c1 = getPinchCenter(h1);
  const centerX = (c0.x + c1.x) / 2;
  const angle = Math.atan2(c1.y - c0.y, c1.x - c0.x);
  
  if (state.gesture.filter === 'oneeuro') {
    oneYaw ||= new OneEuroFilter(state.gesture.minCutoff, state.gesture.beta, state.gesture.dCutoff);
    const y = oneYaw.filter(angle, dt);
    filt.rotY = y;
  } else {
    filt.rotY = lerpAngle(filt.rotY, angle, state.gesture.rotAlpha * 0.8); // 回転は少し控えめに
  }
  state.modelRoot.rotation.y = filt.rotY;
}

function handleScaleGesture(h0, h1, dt) {
  // 両手のピンチ中心間の距離からスケールを計算
  const c0 = getPinchCenter(h0);
  const c1 = getPinchCenter(h1);
  const distance = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  
  if (!pinchScaleBaseline) {
    pinchScaleBaseline = distance;
    return;
  }
  
  const scaleRatio = distance / pinchScaleBaseline;
  const targetScale = Math.max(0.1, Math.min(10.0, filt.scale * scaleRatio));
  
  // スケール変更は滑らかに
  filt.scale = filt.scale + (targetScale - filt.scale) * state.gesture.posAlpha * 0.3;
  if (state.model) {
    state.model.scale.setScalar(filt.scale);
  }
  
  pinchScaleBaseline = distance; // 基準を更新
}

function handleCameraGesture(h0, h1, dt) {
  // 両手でカメラを操作（将来的な機能）
  const c0 = handCenter(h0);
  const c1 = handCenter(h1);
  const centerX = (c0.x + c1.x) / 2;
  const centerY = (c0.y + c1.y) / 2;
  
  // カメラの回転操作を実装
  // 現在は何もしない（プレースホルダー）
}

function handleResetGesture(h0) {
  // グーでリセット操作
  const modeSwitchDelay = 1000; // 1秒間グーを維持でリセット
  if (performance.now() - gestureState.modeStartTime > modeSwitchDelay) {
    resetModelTransform();
    gestureState.currentMode = 'none'; // リセット後は通常状態に
  }
}

function handleSpecialGesture(h0, dt) {
  // ピースサインでの特殊操作（例：品質切替、アニメーション等）
  // 現在は何もしない（プレースホルダー）
}

function resetModelTransform() {
  if (state.model && state.modelRoot) {
    // モデルを初期位置にリセット
    state.modelRoot.position.set(0, 0, 0);
    state.modelRoot.rotation.set(0, 0, 0);
    filt.scale = 1.0;
    state.model.scale.setScalar(filt.scale);
    
    // フィルター状態もリセット
    filt.pos.set(0, 0, 0);
    filt.rotY = 0;
    
    // OneEuroFilterのリセット
    onePosX = onePosY = onePosZ = oneYaw = null;
    pinchScaleBaseline = null;
    yawScalePrev = null;
    
    console.log('Model transform reset');
    setStatus('モデルをリセットしました');
  }
}

// レガシー互換のための状態更新
function updateLegacyGrabState(h0, h1) {
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
}

const _raycaster = new THREE.Raycaster();
function screenToWorld(nx, ny, zPlane = 0) {
  // nx, ny: 0..1（左上原点）→ NDCへ
  // 手の座標は既にhandCenter()で反転済みなので、そのまま使用
  const x = nx * 2 - 1;
  const y = ny * -2 + 1;
  _raycaster.setFromCamera({ x, y }, state.camera);
  
  // より精密な平面との交差計算
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
  // XR強制指定時に未対応なら即FB固定
  if (state.xrMode === 'xr') {
    if (!state.hasXR) {
      setStatus('XR未対応: Fallbackへ固定');
      state.xrMode = 'fb';
      try { els.selXR.value = 'fb'; } catch {}
      stopXR();
      requestAnimationFrame(tick);
      return;
    }
    await startXR();
    return;
  }
  // Autoかつ対応時のみXR開始
  if (state.xrMode === 'auto' && state.hasXR) {
    await startXR();
    return;
  }
  // それ以外はFB描画
  stopXR();
  requestAnimationFrame(tick);
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
    // 事前対応確認（未対応なら静かにFBへ）
    if (navigator.xr.isSessionSupported) {
      const ok = await navigator.xr.isSessionSupported('immersive-ar');
      if (!ok) { setStatus('XR未対応: Fallbackへ切替'); stopXR(); requestAnimationFrame(tick); return; }
    }
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

// 基本的なジェスチャー検出関数
function pinchDistance(h) { const a = h[4], b = h[8]; return Math.hypot(a.x - b.x, a.y - b.y); }
function handCenter(h) { 
  const cx = (h[0].x + h[5].x + h[17].x) / 3; 
  const cy = (h[0].y + h[5].y + h[17].y) / 3; 
  // カメラが左右反転されているので、手の座標も反転する
  return { x: 1.0 - cx, y: cy }; 
}
function handYaw(h) { const a = h[0], b = h[9]; const vx = b.x - a.x, vy = b.y - a.y; return Math.atan2(-vx, -vy); }
function handRoll(h) { const p1 = h[5], p2 = h[17]; const vx = p2.x - p1.x, vy = p2.y - p1.y; return Math.atan2(vy, vx); }
function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; return a + d * t; }

// 新しいジェスチャー検出関数
function isPointingGesture(h) {
  // 人差し指を立てて他の指を曲げているかチェック
  const thumb = h[4], index = h[8], middle = h[12], ring = h[16], pinky = h[20];
  const wrist = h[0];
  
  // 座標は既に正規化されているので距離計算はそのまま使用
  // 人差し指が伸びているか（手首から遠い）
  const indexExtended = Math.hypot(index.x - wrist.x, index.y - wrist.y) > 0.15;
  // 中指、薬指、小指が曲がっているか（手首に近い）
  const middleBent = Math.hypot(middle.x - wrist.x, middle.y - wrist.y) < 0.12;
  const ringBent = Math.hypot(ring.x - wrist.x, ring.y - wrist.y) < 0.10;
  const pinkyBent = Math.hypot(pinky.x - wrist.x, pinky.y - wrist.y) < 0.08;
  
  return indexExtended && middleBent && ringBent && pinkyBent;
}

function isOpenPalmGesture(h) {
  // 手のひらを開いているかチェック（全ての指が広がっている）
  const fingers = [h[4], h[8], h[12], h[16], h[20]]; // 各指の先端
  const wrist = h[0];
  
  // 全ての指が手首から十分離れているか
  return fingers.every(finger => 
    Math.hypot(finger.x - wrist.x, finger.y - wrist.y) > 0.12
  );
}

function isFistGesture(h) {
  // 握りこぶしかチェック（全ての指が曲がっている）
  const fingers = [h[4], h[8], h[12], h[16], h[20]];
  const wrist = h[0];
  
  // 全ての指が手首に近いか
  return fingers.every(finger => 
    Math.hypot(finger.x - wrist.x, finger.y - wrist.y) < 0.10
  );
}

function isPeaceSignGesture(h) {
  // ピースサイン（人差し指と中指を立てる）
  const index = h[8], middle = h[12], ring = h[16], pinky = h[20];
  const wrist = h[0];
  
  const indexExtended = Math.hypot(index.x - wrist.x, index.y - wrist.y) > 0.14;
  const middleExtended = Math.hypot(middle.x - wrist.x, middle.y - wrist.y) > 0.14;
  const ringBent = Math.hypot(ring.x - wrist.x, ring.y - wrist.y) < 0.10;
  const pinkyBent = Math.hypot(pinky.x - wrist.x, pinky.y - wrist.y) < 0.08;
  
  return indexExtended && middleExtended && ringBent && pinkyBent;
}

function getHandDistance(h1, h2) {
  // 両手の距離を計算
  const c1 = handCenter(h1);
  const c2 = handCenter(h2);
  return Math.hypot(c1.x - c2.x, c1.y - c2.y);
}

function getPinchCenter(h) {
  // ピンチしている指先の中心点を計算（親指と人差し指）
  const thumb = h[4]; // 親指の先端
  const index = h[8]; // 人差し指の先端
  const cx = (thumb.x + index.x) / 2;
  const cy = (thumb.y + index.y) / 2;
  // カメラが左右反転されているので、X座標も反転
  return { x: 1.0 - cx, y: cy };
}

function getImprovedHandCenter(h) {
  // より正確な手の中心を計算（手首、中手骨基部を重視）
  const wrist = h[0];
  const middleBase = h[9]; // 中指の付け根
  const cx = (wrist.x * 0.3 + middleBase.x * 0.7); // 中指付け根を重視
  const cy = (wrist.y * 0.3 + middleBase.y * 0.7);
  return { x: 1.0 - cx, y: cy };
}
