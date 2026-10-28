import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

const $ = (selector) => document.querySelector(selector);
const SETTINGS_KEY = 'sonicforge-settings-v1';
const HISTORY_KEY = 'sonicforge-history-v1';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 7 * 60;
const ALLOWED_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac']);

const elements = {
  dropZone: $('#drop-zone'), fileInput: $('#file-input'), fileSummary: $('#file-summary'),
  fileName: $('#file-name'), fileMeta: $('#file-meta'), originalPlayer: $('#original-player'),
  removeFile: $('#remove-file'), speedRange: $('#speed-range'), speedValue: $('#speed-value'),
  speedReset: $('#speed-reset'), gainRange: $('#gain-range'), gainValue: $('#gain-value'),
  gainReset: $('#gain-reset'), restoreSpeed: $('#restore-speed'), copyRestore: $('#copy-restore'),
  processButton: $('#process-button'), processStatus: $('#process-status'), processedResult: $('#processed-result'),
  outputName: $('#output-name'), outputMeta: $('#output-meta'), processedPlayer: $('#processed-player'),
  downloadButton: $('#download-button'), uploadButton: $('#upload-button'), apiKey: $('#api-key'),
  toggleKey: $('#toggle-key'), rememberKey: $('#remember-key'), creatorType: $('#creator-type'),
  creatorId: $('#creator-id'), creatorIdLabel: $('#creator-id-label'), assetName: $('#asset-name'),
  assetDescription: $('#asset-description'), verifyButton: $('#verify-button'), apiStatus: $('#api-status'),
  historyList: $('#history-list'), clearHistory: $('#clear-history'), toast: $('#toast'),
  heroSpeed: $('#hero-speed'), heroGain: $('#hero-gain')
};

let sourceFile = null;
let sourceObjectUrl = null;
let processedFile = null;
let processedObjectUrl = null;
let sourceDuration = null;
let ffmpeg = null;
let ffmpegLoading = null;
let currentFfmpegLogs = null;
let toastTimer = null;
let historyItems = loadHistory();
let isProcessing = false;
let isUploading = false;

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function loadHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(data) ? data.slice(0, 12) : [];
  } catch { return []; }
}
function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems.slice(0, 12))); }
  catch { showToast('Could not save local history. Browser storage may be full.'); }
}
function saveSettings() {
  const settings = {
    creatorType: elements.creatorType.value,
    creatorId: elements.creatorId.value.trim(),
    assetName: elements.assetName.value,
    assetDescription: elements.assetDescription.value,
    rememberKey: elements.rememberKey.checked,
    apiKey: elements.rememberKey.checked ? elements.apiKey.value.trim() : ''
  };
  try {
    if (settings.apiKey || settings.creatorId || settings.assetName || settings.assetDescription) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } else {
      localStorage.removeItem(SETTINGS_KEY);
    }
  } catch {
    setApiStatus('Browser storage is unavailable. The key will only remain in this tab.', 'bad');
  }
}
function restoreSettings() {
  const settings = loadSettings();
  elements.apiKey.value = settings.apiKey || '';
  elements.rememberKey.checked = settings.rememberKey !== false;
  elements.creatorType.value = settings.creatorType === 'group' ? 'group' : 'user';
  elements.creatorId.value = settings.creatorId || '';
  elements.assetName.value = settings.assetName || 'My Roblox audio';
  elements.assetDescription.value = settings.assetDescription || '';
  updateCreatorLabel();
}
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
}
function setApiStatus(message, kind = '') {
  elements.apiStatus.className = `api-status ${kind}`.trim();
  elements.apiStatus.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-indicator';
  const text = document.createElement('span');
  text.textContent = message;
  elements.apiStatus.append(dot, text);
}
function setProcessStatus(message, kind = '') {
  elements.processStatus.textContent = message;
  elements.processStatus.className = `inline-status ${kind}`.trim();
  elements.processStatus.classList.remove('hidden');
}
function hideProcessStatus() { elements.processStatus.classList.add('hidden'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Unknown duration';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'audio';
}
function extension(fileName) {
  return (fileName.split('.').pop() || '').toLowerCase();
}
function escapeSpeed(value) { return `${Number(value).toFixed(2)}×`; }
function gainText(value) { return `${Number(value) > 0 ? '+' : ''}${Number(value)} dB`; }
function updateAudioNumbers() {
  const speed = Number(elements.speedRange.value);
  const gain = Number(elements.gainRange.value);
  elements.speedValue.textContent = escapeSpeed(speed);
  elements.gainValue.textContent = gainText(gain);
  const restore = 1 / speed;
  elements.restoreSpeed.textContent = escapeSpeed(restore);
  elements.heroSpeed.textContent = escapeSpeed(speed);
  elements.heroGain.textContent = gainText(gain);
  if (sourceDuration && sourceDuration / speed >= MAX_SECONDS) {
    elements.processButton.disabled = true;
    setProcessStatus('At this speed, the exported audio would be 7 minutes or longer. Increase the speed or choose a shorter file.', 'error');
  } else if (sourceFile && !isProcessing) {
    elements.processButton.disabled = false;
    if (!elements.processStatus.classList.contains('hidden') && elements.processStatus.classList.contains('error')) hideProcessStatus();
  }
}
function updateCreatorLabel() {
  const isGroup = elements.creatorType.value === 'group';
  elements.creatorIdLabel.textContent = isGroup ? 'Group ID' : 'User ID';
  elements.creatorId.placeholder = isGroup ? 'e.g. 12345678' : 'e.g. 123456789';
}
function validCreatorId() {
  return /^\d{1,20}$/.test(elements.creatorId.value.trim());
}
function validApiKey() {
  const key = elements.apiKey.value.trim();
  return key.length >= 10 && key.length <= 512 && !/\s/.test(key);
}
function readError(data, fallback = 'Request failed.') {
  return data?.error?.message || data?.message || data?.error || fallback;
}

async function apiRequest(path, { method = 'GET', apiKey = elements.apiKey.value.trim(), body } = {}) {
  const headers = {};
  if (apiKey) headers['x-roblox-api-key'] = apiKey;
  const response = await fetch(path, { method, headers, body, cache: 'no-store' });
  let data;
  try { data = await response.json(); }
  catch { data = { message: `The server returned a non-JSON response (${response.status}).` }; }
  if (!response.ok) {
    const message = readError(data, `Request failed (${response.status}).`);
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function verifyConnection() {
  saveSettings();
  if (!validApiKey()) {
    setApiStatus('Enter a valid-looking Open Cloud API key first.', 'bad');
    return;
  }
  if (!validCreatorId()) {
    setApiStatus('Enter a numeric creator ID first.', 'bad');
    return;
  }
  if (elements.creatorType.value === 'group') {
    setApiStatus('The available connection test checks user asset quotas. For a group creator, the first upload will validate the key and group permissions.', '');
    return;
  }
  elements.verifyButton.disabled = true;
  elements.verifyButton.innerHTML = '<span class="loading-spinner"></span> CHECKING KEY…';
  setApiStatus('Checking the key against the Roblox Open Cloud user asset-quota endpoint…');
  try {
    const data = await apiRequest(`/api/verify?userId=${encodeURIComponent(elements.creatorId.value.trim())}`);
    const quotas = Array.isArray(data?.assetQuotas) ? ` ${data.assetQuotas.length} quota record(s) returned.` : '';
    setApiStatus(`Roblox accepted the key for this endpoint.${quotas} Confirm that asset:write is also enabled for uploads.`, 'good');
    showToast('Roblox API key connection verified.');
  } catch (error) {
    setApiStatus(`${error.message} Check key permissions, creator access, and asset:read scope.`, 'bad');
  } finally {
    elements.verifyButton.disabled = false;
    elements.verifyButton.innerHTML = 'TEST CONNECTION <span>↗</span>';
  }
}

function releaseAudioUrls() {
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  if (processedObjectUrl) URL.revokeObjectURL(processedObjectUrl);
  sourceObjectUrl = null;
  processedObjectUrl = null;
}
function clearSourceFile() {
  sourceFile = null;
  processedFile = null;
  sourceDuration = null;
  releaseAudioUrls();
  elements.fileInput.value = '';
  elements.fileSummary.classList.add('hidden');
  elements.originalPlayer.classList.add('hidden');
  elements.processedPlayer.removeAttribute('src');
  elements.processedPlayer.load();
  elements.processedResult.classList.add('hidden');
  elements.processButton.disabled = true;
  hideProcessStatus();
}
async function chooseFile(file) {
  if (!file) return;
  if (!ALLOWED_EXTENSIONS.has(extension(file.name))) {
    showToast('Unsupported format. Choose MP3, OGG, WAV, or FLAC.');
    return;
  }
  if (file.size > MAX_BYTES) {
    showToast('This file is over Roblox’s 20 MB audio upload limit.');
    return;
  }
  clearSourceFile();
  sourceFile = file;
  sourceObjectUrl = URL.createObjectURL(file);
  elements.fileName.textContent = file.name;
  elements.fileMeta.textContent = `${formatBytes(file.size)} · Reading duration…`;
  elements.fileSummary.classList.remove('hidden');
  elements.originalPlayer.src = sourceObjectUrl;
  elements.originalPlayer.classList.remove('hidden');
  elements.processButton.disabled = true;
  hideProcessStatus();
  try {
    const duration = await new Promise((resolve, reject) => {
      const audio = new Audio();
      const timeout = setTimeout(() => reject(new Error('Could not read audio metadata.')), 12000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => { clearTimeout(timeout); URL.revokeObjectURL(audio.src); resolve(audio.duration); };
      audio.onerror = () => { clearTimeout(timeout); URL.revokeObjectURL(audio.src); reject(new Error('The browser could not read this audio metadata.')) };
      audio.src = URL.createObjectURL(file);
    });
    sourceDuration = duration;
    elements.fileMeta.textContent = `${formatBytes(file.size)} · ${formatDuration(duration)} · ${extension(file.name).toUpperCase()}`;
    if (duration >= MAX_SECONDS) {
      setProcessStatus('Roblox accepts audio shorter than 7 minutes. This file is too long; trim it and try again.', 'error');
      elements.processButton.disabled = true;
    } else {
      elements.processButton.disabled = false;
      setProcessStatus('File loaded. Adjust the controls, then process your audio.', '');
    }
  } catch (error) {
    sourceDuration = null;
    elements.fileMeta.textContent = `${formatBytes(file.size)} · Metadata unavailable`;
    setProcessStatus('Browser preview could not read this file metadata. The FFmpeg engine will inspect it when you process it.', '');
    elements.processButton.disabled = false;
  }
  updateAudioNumbers();
}

async function ensureFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => { if (currentFfmpegLogs) currentFfmpegLogs.push(message); });
    ffmpeg.on('progress', ({ progress }) => {
      if (isProcessing && Number.isFinite(progress)) {
        const percentage = Math.max(0, Math.min(99, Math.round(progress * 100)));
        setProcessStatus(`Processing audio in your browser… ${percentage}%`);
      }
    });
    setProcessStatus('Loading the audio engine for the first time. The engine is cached by your browser…');
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
    });
    return ffmpeg;
  })();
  try { return await ffmpegLoading; }
  finally { ffmpegLoading = null; }
}

async function probeSampleRate(engine, inputName) {
  const logs = [];
  currentFfmpegLogs = logs;
  try { await engine.exec(['-hide_banner', '-i', inputName]); }
  catch { /* FFmpeg exits non-zero when probing without an output; its log is still useful. */ }
  currentFfmpegLogs = null;
  const text = logs.join('\n');
  const match = text.match(/Audio:\s*[^\n]*?,\s*(\d{4,6})\s*Hz/i) || text.match(/Audio:\s*[^\n]*?(\d{4,6})\s*Hz/i);
  if (!match) throw new Error('Could not detect the source sample rate. Try an MP3, OGG, WAV, or FLAC file.');
  const sampleRate = Number(match[1]);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error(`The detected sample rate (${sampleRate}) is not supported.`);
  const durationMatch = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
  return { sampleRate, duration };
}

async function processAudio() {
  if (!sourceFile || isProcessing) return;
  const speed = Number(elements.speedRange.value);
  const gain = Number(elements.gainRange.value);
  if (sourceDuration != null && sourceDuration / speed >= MAX_SECONDS) {
    setProcessStatus('At this speed, the output would be 7 minutes or longer. Increase the speed or use a shorter file.', 'error');
    return;
  }
  isProcessing = true;
  elements.processButton.disabled = true;
  elements.processButton.innerHTML = '<span class="loading-spinner"></span> PROCESSING…';
  elements.processedResult.classList.add('hidden');
  processedFile = null;
  try {
    setProcessStatus('Preparing the browser audio engine…');
    const engine = await ensureFFmpeg();
    const ext = extension(sourceFile.name);
    const inputName = `input.${ext}`;
    const outputFileName = `${baseName(sourceFile.name)}-roblox.ogg`;
    const outputName = 'processed.ogg';
    try { await engine.deleteFile(inputName); } catch {}
    try { await engine.deleteFile(outputName); } catch {}
    setProcessStatus('Reading the source audio and detecting its sample rate…');
    await engine.writeFile(inputName, await fetchFile(sourceFile));
    const probe = await probeSampleRate(engine, inputName);
    const sampleRate = probe.sampleRate;
    if (sourceDuration == null && probe.duration != null) sourceDuration = probe.duration;
    if (sourceDuration == null || !Number.isFinite(sourceDuration)) throw new Error('Could not detect this audio duration. Try an MP3, OGG, WAV, or FLAC file.');
    if (sourceDuration >= MAX_SECONDS || sourceDuration / speed >= MAX_SECONDS) throw new Error('The audio output must be shorter than 7 minutes. Use a shorter source file or increase processing speed.');
    elements.fileMeta.textContent = `${formatBytes(sourceFile.size)} · ${formatDuration(sourceDuration)} · ${extension(sourceFile.name).toUpperCase()} · ${Math.round(sampleRate / 1000)} kHz source`;
    const adjustedRate = Math.max(8000, Math.round(sampleRate * speed));
    const filter = `asetrate=${adjustedRate},aresample=48000,volume=${gain}dB,alimiter=limit=0.98`;
    setProcessStatus('Processing audio in your browser… 0%');
    const code = await engine.exec([
      '-hide_banner', '-y', '-i', inputName, '-map', '0:a:0', '-vn',
      '-af', filter, '-ar', '48000', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', outputName
    ]);
    if (code !== 0) throw new Error('FFmpeg could not export this audio. Try another supported file format.');
    const outputBytes = await engine.readFile(outputName);
    if (!outputBytes || !outputBytes.length) throw new Error('The exported audio file is empty. Try processing again.');
    if (outputBytes.byteLength > MAX_BYTES) throw new Error(`The processed OGG is ${formatBytes(outputBytes.byteLength)} and exceeds Roblox’s 20 MB limit. Try a shorter audio file.`);
    const outputBlob = new Blob([outputBytes], { type: 'audio/ogg' });
    processedFile = new File([outputBlob], outputFileName, { type: 'audio/ogg' });
    if (processedObjectUrl) URL.revokeObjectURL(processedObjectUrl);
    processedObjectUrl = URL.createObjectURL(outputBlob);
    elements.processedPlayer.src = processedObjectUrl;
    elements.outputName.textContent = outputFileName;
    elements.outputMeta.textContent = `OGG Vorbis · 48 kHz · ${formatBytes(outputBytes.byteLength)} · approx. ${formatDuration(sourceDuration / speed)}`;
    elements.processedResult.classList.remove('hidden');
    setProcessStatus('Audio processing complete. Preview the result, download the OGG, or upload it to Roblox.', 'success');
    showToast('Audio processed successfully.');
    try { await engine.deleteFile(inputName); } catch {}
    try { await engine.deleteFile(outputName); } catch {}
  } catch (error) {
    setProcessStatus(error?.message || 'Audio processing failed. Try a different audio file.', 'error');
    console.error('SonicForge processing error:', error);
  } finally {
    isProcessing = false;
    elements.processButton.disabled = !sourceFile || (sourceDuration != null && sourceDuration / Number(elements.speedRange.value) >= MAX_SECONDS);
    elements.processButton.innerHTML = '<span class="button-spark">✦</span> PROCESS AUDIO <span class="button-arrow">→</span>';
  }
}

function downloadProcessed() {
  if (!processedFile || !processedObjectUrl) return;
  const anchor = document.createElement('a');
  anchor.href = processedObjectUrl;
  anchor.download = processedFile.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function normalizeModeration(data) {
  const candidates = [
    data?.response?.moderationResult,
    data?.moderationResult,
    data?.asset?.moderationResult,
    data?.response?.asset?.moderationResult
  ].filter(Boolean);
  for (const result of candidates) {
    const state = String(result.moderationState || result.state || result.status || '').toUpperCase();
    if (state.includes('APPROVED')) return { status: 'approved', state, message: 'Roblox reports this asset as approved.' };
    if (state.includes('REJECTED') || state.includes('DECLINED') || state.includes('FAILED')) return { status: 'rejected', state, message: 'Roblox reports that this asset did not pass moderation.' };
    if (state.includes('PENDING') || state.includes('REVIEW') || state.includes('QUEUED') || state.includes('UNSPECIFIED')) {
      return { status: 'pending', state, message: `Moderation is not final yet (${state.replace('MODERATION_STATE_', '').replaceAll('_', ' ').toLowerCase()}).` };
    }
  }
  return null;
}
function extractAssetId(data) {
  const possible = data?.response?.assetId || data?.assetId || data?.response?.path?.match(/assets\/(\d+)/)?.[1] || data?.path?.match(/assets\/(\d+)/)?.[1];
  return possible ? String(possible) : '';
}
function extractOperationId(pathOrData) {
  const path = typeof pathOrData === 'string' ? pathOrData : (pathOrData?.path || '');
  const match = String(path).match(/operations\/([A-Za-z0-9._-]+)/);
  return match ? match[1] : '';
}
function saveRecord(record) {
  const idx = historyItems.findIndex(item => item.id === record.id);
  if (idx >= 0) historyItems[idx] = { ...historyItems[idx], ...record };
  else historyItems.unshift(record);
  historyItems = historyItems.slice(0, 12);
  saveHistory();
  renderHistory();
}
function statusLabel(status) {
  return ({ approved: 'APPROVED', rejected: 'REJECTED', pending: 'MODERATION PENDING', processing: 'PROCESSING', uploaded: 'UPLOADED', unknown: 'STATUS UNKNOWN', failed: 'UPLOAD FAILED' })[status] || 'STATUS UNKNOWN';
}
function createHistoryButton(label, handler, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}
function renderHistory() {
  elements.historyList.replaceChildren();
  if (!historyItems.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    const icon = document.createElement('span'); icon.className = 'empty-icon'; icon.textContent = '◌';
    const title = document.createElement('strong'); title.textContent = 'No uploads yet';
    const desc = document.createElement('span'); desc.textContent = 'Your uploads and moderation status will appear here.';
    empty.append(icon, title, desc); elements.historyList.append(empty); return;
  }
  for (const record of historyItems) {
    const item = document.createElement('article'); item.className = 'history-item';
    const nameWrap = document.createElement('div'); nameWrap.className = 'history-name';
    const name = document.createElement('strong'); name.textContent = record.displayName || record.fileName || 'Roblox audio';
    const meta = document.createElement('span');
    const dateText = record.createdAt ? new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Saved locally';
    meta.textContent = `${record.assetId ? `ID ${record.assetId}` : 'Asset ID pending'} · ${dateText}`;
    nameWrap.append(name, meta);
    const statusWrap = document.createElement('div'); statusWrap.className = 'history-status';
    const pill = document.createElement('span'); pill.className = `status-pill ${record.status || 'unknown'}`; pill.textContent = statusLabel(record.status);
    const message = document.createElement('span'); message.textContent = record.message || 'Check Roblox for the latest status.';
    statusWrap.append(pill, message);
    const actions = document.createElement('div'); actions.className = 'history-actions';
    if (record.assetId) actions.append(createHistoryButton('COPY ID', () => copyText(record.assetId, 'Asset ID copied.'), 'id-copy'));
    if (record.assetId || record.operationId) actions.append(createHistoryButton(record.checking ? 'CHECKING…' : 'CHECK STATUS', () => checkRecordStatus(record.id, true), ''));
    else actions.append(createHistoryButton('NO ID YET', () => {}, ''));
    item.append(nameWrap, statusWrap, actions); elements.historyList.append(item);
  }
}

async function uploadProcessed() {
  if (!processedFile || isUploading) return;
  saveSettings();
  if (!validApiKey()) { setApiStatus('Enter your Roblox Open Cloud API key before uploading.', 'bad'); elements.apiKey.focus(); return; }
  if (!validCreatorId()) { setApiStatus('Enter a numeric creator ID before uploading.', 'bad'); elements.creatorId.focus(); return; }
  if (processedFile.size > MAX_BYTES) { showToast('Processed file exceeds Roblox’s 20 MB limit.'); return; }
  const displayName = (elements.assetName.value.trim() || baseName(processedFile.name)).slice(0, 50);
  const description = elements.assetDescription.value.trim().slice(0, 1000);
  isUploading = true;
  elements.uploadButton.disabled = true;
  elements.uploadButton.innerHTML = '<span class="loading-spinner"></span> UPLOADING…';
  setApiStatus('Uploading the processed audio to Roblox Open Cloud. Keep this page open…');
  const record = {
    id: (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    displayName, fileName: processedFile.name, status: 'processing', message: 'Sending audio to Roblox…',
    createdAt: new Date().toISOString(), speed: Number(elements.speedRange.value),
    restoreSpeed: Number((1 / Number(elements.speedRange.value)).toFixed(4)), operationId: '', assetId: '', checking: false
  };
  saveRecord(record);
  try {
    const form = new FormData();
    form.append('file', processedFile, processedFile.name);
    form.append('displayName', displayName);
    form.append('description', description);
    form.append('creatorType', elements.creatorType.value);
    form.append('creatorId', elements.creatorId.value.trim());
    const result = await apiRequest('/api/upload', { method: 'POST', body: form });
    record.operationId = extractOperationId(result);
    record.assetId = extractAssetId(result);
    const firstState = normalizeModeration(result);
    if (firstState) {
      record.status = firstState.status;
      record.message = firstState.message;
    } else {
      record.status = result?.done ? 'pending' : 'processing';
      record.message = result?.done ? 'Upload operation completed; checking moderation.' : 'Upload accepted. Waiting for Roblox to finish processing…';
    }
    saveRecord(record);
    if (!record.operationId && !record.assetId && result?.done) {
      record.status = 'unknown';
      record.message = 'Roblox accepted the request but did not return an asset ID or operation ID.';
      saveRecord(record);
    } else {
      await pollAfterUpload(record.id);
    }
    setApiStatus(`Upload request finished. ${record.assetId ? `Asset ID: ${record.assetId}.` : 'See Upload Monitor for details.'}`, record.status === 'approved' ? 'good' : '');
    if (record.assetId) showToast(`Roblox asset created: ${record.assetId}`);
  } catch (error) {
    record.status = 'failed';
    record.message = error.message || 'Roblox rejected the upload request.';
    saveRecord(record);
    setApiStatus(`Upload failed: ${record.message}`, 'bad');
    showToast('Upload failed. Check the API key and creator permissions.');
  } finally {
    isUploading = false;
    elements.uploadButton.disabled = false;
    elements.uploadButton.innerHTML = 'UPLOAD TO ROBLOX <span class="button-arrow">→</span>';
    saveSettings();
  }
}

async function pollAfterUpload(recordId) {
  let record = historyItems.find(item => item.id === recordId);
  if (!record) return;
  // First wait for the Open Cloud upload operation to finish.
  if (record.operationId && !record.assetId) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(3000);
      record = historyItems.find(item => item.id === recordId);
      if (!record) return;
      try {
        const operation = await apiRequest(`/api/operations/${encodeURIComponent(record.operationId)}`);
        const assetId = extractAssetId(operation);
        if (assetId) record.assetId = assetId;
        if (operation?.done) {
          if (operation.error) {
            record.status = 'failed';
            record.message = operation.error.message || 'Roblox failed to process this upload.';
            saveRecord(record); return;
          }
          const moderation = normalizeModeration(operation);
          if (moderation && ['approved', 'rejected'].includes(moderation.status)) {
            record.status = moderation.status; record.message = moderation.message; saveRecord(record); return;
          }
          record.status = 'pending';
          record.message = record.assetId ? 'Upload processed; checking moderation status…' : 'Upload processed, but the asset ID was not returned. Check Creator Dashboard.';
          saveRecord(record);
          break;
        }
        record.status = 'processing';
        record.message = `Roblox is processing the upload (${attempt + 1}/30)…`;
        saveRecord(record);
      } catch (error) {
        record.status = 'processing'; record.message = `Could not read operation status yet: ${error.message}`; saveRecord(record);
      }
    }
    record = historyItems.find(item => item.id === recordId);
    if (record?.status === 'processing' && !record.assetId) {
      record.message = 'Upload is still processing or status could not be read. Use Check Status to retry.';
      saveRecord(record); return;
    }
  }
  record = historyItems.find(item => item.id === recordId);
  if (!record?.assetId) return;
  // Moderation is separate from the upload operation, so check it independently.
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(12000);
    record = historyItems.find(item => item.id === recordId);
    if (!record) return;
    try {
      const assetData = await apiRequest(`/api/assets/${encodeURIComponent(record.assetId)}`);
      const moderation = normalizeModeration(assetData);
      if (moderation) {
        record.status = moderation.status;
        record.message = moderation.message;
        saveRecord(record);
        if (['approved', 'rejected'].includes(moderation.status)) return;
      } else {
        record.status = 'pending';
        record.message = 'Upload is complete; Roblox has not returned a final moderation state yet.';
        saveRecord(record);
      }
    } catch (error) {
      record.status = 'pending';
      record.message = `Upload complete; moderation status is not available through this API response (${error.message}).`;
      saveRecord(record);
    }
  }
  record = historyItems.find(item => item.id === recordId);
  if (record && !['approved', 'rejected', 'failed'].includes(record.status)) {
    record.status = 'pending';
    record.message = 'Moderation is still pending or not exposed yet. You can recheck later in this page or Creator Dashboard.';
    saveRecord(record);
  }
}

async function checkRecordStatus(recordId, deep = false) {
  const record = historyItems.find(item => item.id === recordId);
  if (!record || record.checking) return;
  if (!validApiKey()) { setApiStatus('Enter your saved Open Cloud API key to check upload status.', 'bad'); return; }
  record.checking = true;
  record.message = 'Checking Roblox status…';
  saveRecord(record);
  try {
    if (record.assetId) {
      const data = await apiRequest(`/api/assets/${encodeURIComponent(record.assetId)}`);
      const moderation = normalizeModeration(data);
      if (moderation) {
        record.status = moderation.status; record.message = moderation.message;
      } else {
        record.status = 'pending'; record.message = 'Roblox did not return a final moderation state yet.';
      }
      saveRecord(record);
      if (deep && record.status === 'pending') await pollAfterUpload(recordId);
    } else if (record.operationId) {
      const data = await apiRequest(`/api/operations/${encodeURIComponent(record.operationId)}`);
      const assetId = extractAssetId(data);
      if (assetId) record.assetId = assetId;
      if (data.done && data.error) { record.status = 'failed'; record.message = data.error.message || 'Roblox could not process this upload.'; }
      else if (data.done) {
        const moderation = normalizeModeration(data);
        record.status = moderation?.status || 'pending';
        record.message = moderation?.message || 'Upload finished; moderation result is not final yet.';
      } else { record.status = 'processing'; record.message = 'Roblox is still processing this upload.'; }
      saveRecord(record);
      if (deep && record.status !== 'failed') await pollAfterUpload(recordId);
    } else {
      record.status = 'unknown'; record.message = 'No operation ID or asset ID was saved. Check Creator Dashboard.';
      saveRecord(record);
    }
  } catch (error) {
    record.message = `Status check failed: ${error.message}`;
    if (!record.assetId) record.status = 'unknown';
    saveRecord(record);
  } finally {
    const latest = historyItems.find(item => item.id === recordId);
    if (latest) { latest.checking = false; saveRecord(latest); }
  }
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(String(text));
  } catch {
    const input = document.createElement('textarea'); input.value = String(text); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select();
    const ok = document.execCommand('copy'); input.remove();
    if (!ok) { showToast('Copy failed. Select and copy the value manually.'); return; }
  }
  showToast(successMessage);
}

function bindEvents() {
  elements.dropZone.addEventListener('click', () => elements.fileInput.click());
  elements.dropZone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
  });
  elements.fileInput.addEventListener('change', event => chooseFile(event.target.files?.[0]));
  for (const eventName of ['dragenter', 'dragover']) elements.dropZone.addEventListener(eventName, event => { event.preventDefault(); elements.dropZone.classList.add('drag-over'); });
  for (const eventName of ['dragleave', 'drop']) elements.dropZone.addEventListener(eventName, event => { event.preventDefault(); elements.dropZone.classList.remove('drag-over'); });
  elements.dropZone.addEventListener('drop', event => chooseFile(event.dataTransfer?.files?.[0]));
  elements.removeFile.addEventListener('click', clearSourceFile);
  elements.speedRange.addEventListener('input', updateAudioNumbers);
  elements.gainRange.addEventListener('input', updateAudioNumbers);
  elements.speedReset.addEventListener('click', () => { elements.speedRange.value = '1'; updateAudioNumbers(); });
  elements.gainReset.addEventListener('click', () => { elements.gainRange.value = '0'; updateAudioNumbers(); });
  elements.copyRestore.addEventListener('click', () => copyText((1 / Number(elements.speedRange.value)).toFixed(2), 'Recommended Roblox PlaybackSpeed copied.'));
  elements.processButton.addEventListener('click', processAudio);
  elements.downloadButton.addEventListener('click', downloadProcessed);
  elements.uploadButton.addEventListener('click', uploadProcessed);
  elements.toggleKey.addEventListener('click', () => {
    const reveal = elements.apiKey.type === 'password';
    elements.apiKey.type = reveal ? 'text' : 'password';
    elements.toggleKey.textContent = reveal ? 'HIDE' : 'SHOW';
    elements.toggleKey.setAttribute('aria-label', reveal ? 'Hide API key' : 'Show API key');
  });
  elements.rememberKey.addEventListener('change', () => { saveSettings(); if (!elements.rememberKey.checked) showToast('API key will not be saved after you close this tab.'); });
  for (const field of [elements.apiKey, elements.creatorId, elements.creatorType, elements.assetName, elements.assetDescription]) {
    field.addEventListener('change', () => { saveSettings(); if (field === elements.creatorType) updateCreatorLabel(); });
  }
  elements.apiKey.addEventListener('blur', saveSettings);
  elements.verifyButton.addEventListener('click', verifyConnection);
  elements.clearHistory.addEventListener('click', () => {
    if (!historyItems.length) return;
    historyItems = []; saveHistory(); renderHistory(); showToast('Local upload history cleared. This does not delete assets from Roblox.');
  });
}

restoreSettings();
bindEvents();
updateAudioNumbers();
renderHistory();
if (elements.apiKey.value && elements.creatorId.value) setApiStatus(elements.rememberKey.checked ? 'Saved locally on this device. Ready to connect.' : 'Key restored for this tab. Ready to connect.', 'good');
