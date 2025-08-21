#!/usr/bin/env node
/*
 * PoC-XR setup script
 * - assets/hand_landmarker.task の自動取得/配置
 * - 初回起動に必要な最低限の環境を整える
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const repoRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(repoRoot, 'assets');
const modelPath = path.join(assetsDir, 'hand_landmarker.task');

const MODEL_CANDIDATES = [
  // MediaPipe Tasks Hand Landmarker official buckets (優先順)
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/1/hand_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float32/latest/hand_landmarker.task'
];

function log(msg) { process.stdout.write(`[setup] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[setup] ${msg}\n`); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let finished = false;
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        file.close();
        fs.unlink(dest, () => {});
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { finished = true; file.close(() => resolve(true)); });
    });
    req.on('error', (err) => {
      if (!finished) {
        file.close();
        fs.unlink(dest, () => {});
      }
      reject(err);
    });
  });
}

async function ensureModel() {
  ensureDir(assetsDir);
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) {
    log('モデル存在確認: assets/hand_landmarker.task');
    return true;
  }
  log('モデル未検出: ダウンロードを試行');
  for (const url of MODEL_CANDIDATES) {
    try {
      log(`取得開始: ${url}`);
      await download(url, modelPath);
      log('取得完了: assets/hand_landmarker.task');
      return true;
    } catch (e) {
      warn(`取得失敗: ${url} (${e.message})`);
    }
  }
  warn('自動取得に失敗: ネットワーク到達性またはURLを確認');
  warn('手動で以下を配置: assets/hand_landmarker.task');
  warn('参考: https://developers.google.com/mediapipe/solutions/vision/hand_landmarker');
  return false;
}

async function main() {
  const ok = await ensureModel();
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { warn(e.stack || String(e)); process.exitCode = 1; });

