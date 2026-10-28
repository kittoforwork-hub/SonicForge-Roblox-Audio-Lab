const ROBLOX_API = 'https://apis.roblox.com';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function getApiKey(request) {
  const key = (request.headers.get('x-roblox-api-key') || '').trim();
  if (!key || key.length < 10 || key.length > 512 || /\s/.test(key)) return null;
  return key;
}

async function robloxJson(url, apiKey, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('x-api-key', apiKey);
  headers.set('Accept', 'application/json');
  const response = await fetch(url, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text.slice(0, 1200) || `Roblox returned HTTP ${response.status}.` }; }
  return json(data, response.status);
}

function originAllowed(request, env, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const expectedOrigin = (env.ALLOWED_ORIGIN || url.origin).replace(/\/$/, '');
  return origin.replace(/\/$/, '') === expectedOrigin;
}

async function handleUpload(request) {
  const apiKey = getApiKey(request);
  if (!apiKey) return json({ error: { message: 'Missing or invalid x-roblox-api-key request header.' } }, 401);
  const requestLength = Number(request.headers.get('Content-Length') || 0);
  if (requestLength && requestLength > MAX_AUDIO_BYTES + 1024 * 1024) {
    return json({ error: { message: 'Upload request is larger than the allowed audio size.' } }, 413);
  }

  let incoming;
  try { incoming = await request.formData(); }
  catch { return json({ error: { message: 'Expected multipart form data.' } }, 400); }
  const file = incoming.get('file');
  const displayName = String(incoming.get('displayName') || '').trim().slice(0, 50);
  const description = String(incoming.get('description') || '').trim().slice(0, 1000);
  const creatorType = String(incoming.get('creatorType') || 'user');
  const creatorId = String(incoming.get('creatorId') || '').trim();

  if (!(file instanceof File)) return json({ error: { message: 'No audio file was received.' } }, 400);
  if (!file.size || file.size > MAX_AUDIO_BYTES) return json({ error: { message: 'The audio file must be greater than 0 bytes and no larger than 20 MB.' } }, 413);
  const extension = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return json({ error: { message: 'Supported audio file formats are MP3, OGG, WAV, and FLAC.' } }, 415);
  if (!displayName) return json({ error: { message: 'Enter an asset name.' } }, 400);
  if (!['user', 'group'].includes(creatorType)) return json({ error: { message: 'Creator type must be user or group.' } }, 400);
  if (!/^\d{1,20}$/.test(creatorId)) return json({ error: { message: 'Creator ID must be numeric.' } }, 400);

  const contentTypes = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
  const creationContext = { creator: creatorType === 'group' ? { groupId: creatorId } : { userId: creatorId } };
  const upstreamForm = new FormData();
  upstreamForm.append('request', JSON.stringify({ assetType: 'Audio', displayName, description, creationContext }));
  upstreamForm.append('fileContent', new Blob([file], { type: contentTypes[extension] }), file.name);

  return robloxJson(`${ROBLOX_API}/assets/v1/assets`, apiKey, { method: 'POST', body: upstreamForm });
}

async function routeApi(request, env, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'SonicForge Roblox Audio API' });
  if (!['GET', 'POST'].includes(request.method)) return json({ error: { message: 'Method not allowed.' } }, 405);

  if (url.pathname === '/api/upload' && request.method === 'POST') return handleUpload(request);

  if (url.pathname === '/api/verify' && request.method === 'GET') {
    const apiKey = getApiKey(request);
    if (!apiKey) return json({ error: { message: 'Missing or invalid x-roblox-api-key request header.' } }, 401);
    const userId = url.searchParams.get('userId') || '';
    if (!/^\d{1,20}$/.test(userId)) return json({ error: { message: 'A numeric userId query parameter is required for this connection check.' } }, 400);
    return robloxJson(`${ROBLOX_API}/cloud/v2/users/${encodeURIComponent(userId)}/asset-quotas`, apiKey);
  }

  const operationMatch = url.pathname.match(/^\/api\/operations\/([A-Za-z0-9._-]+)$/);
  if (operationMatch && request.method === 'GET') {
    const apiKey = getApiKey(request);
    if (!apiKey) return json({ error: { message: 'Missing or invalid x-roblox-api-key request header.' } }, 401);
    return robloxJson(`${ROBLOX_API}/assets/v1/operations/${encodeURIComponent(operationMatch[1])}`, apiKey);
  }

  const assetMatch = url.pathname.match(/^\/api\/assets\/(\d+)$/);
  if (assetMatch && request.method === 'GET') {
    const apiKey = getApiKey(request);
    if (!apiKey) return json({ error: { message: 'Missing or invalid x-roblox-api-key request header.' } }, 401);
    return robloxJson(`${ROBLOX_API}/assets/v1/assets/${encodeURIComponent(assetMatch[1])}?readMask=moderationResult`, apiKey);
  }

  return json({ error: { message: 'API route not found.' } }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!originAllowed(request, env, url)) return json({ error: { message: 'Cross-origin request blocked. Use this API from the deployed SonicForge site.' } }, 403);
      try { return await routeApi(request, env, url); }
      catch {
        // Never log API keys or upstream request bodies. Return a generic error instead.
        return json({ error: { message: 'The API proxy could not complete the request. Check the key, network, and Roblox Open Cloud status.' } }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
