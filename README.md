# SonicForge — Roblox Audio Lab

A static, English-language audio preparation UI served by a Cloudflare Worker. Audio processing runs in the browser using FFmpeg WebAssembly. The Worker proxies only the required Roblox Open Cloud endpoints and does not store API keys or audio files.

## Features

- Adjust playback speed (0.50×–2.00×) and gain (-12 dB to +12 dB).
- Export OGG Vorbis at 48 kHz, with a limiter to reduce clipping.
- Calculate the inverse `Sound.PlaybackSpeed` value (`1 / processing speed`) to restore the original speed and pitch as closely as Roblox playback allows.
- Upload audio using Roblox Open Cloud Assets API.
- Poll the upload operation, read moderation status when Roblox exposes it, show asset IDs, and copy IDs.
- Remember the Open Cloud API key locally in the browser when “Remember on this device” is checked. The key is not written to Cloudflare Worker storage.
- Keep the last 12 upload records in local browser storage.

## Requirements

- Node.js 22 or later is recommended (Vite 8 requires a current Node.js release).
- A Roblox Open Cloud API key with `asset:write` and `asset:read` permissions and access to the intended user or group creator.
- A Roblox user ID or group ID for the upload target.
- Internet access in the browser for the first FFmpeg WebAssembly download.

## Local development

```bash
npm install
npm run dev
```

The Vite dev server serves the UI, but the API endpoints are provided by the Cloudflare Worker. To test the full upload flow locally, deploy the Worker or use Wrangler local mode after building:

```bash
npm run build
npx wrangler dev
```

## Deploy with GitHub + Cloudflare Workers Builds

1. Create a GitHub repository and upload the contents of this project to its **root** (not a nested project folder).
2. In the Cloudflare dashboard, open **Workers & Pages** and create a Worker using **Connect to Git** / **Workers Builds**.
3. Select the GitHub repository and branch.
4. Set the build command to `npm run build` and the deploy command to `npx wrangler deploy`. Leave the build output directory unset; `wrangler.toml` deploys `dist/` as Worker static assets.
5. Trigger a deployment and open the provided `workers.dev` URL. A custom domain can be attached later in the Worker settings.

For deployment from a terminal instead:

```bash
npm install
npx wrangler login
npm run deploy
```

## Roblox API key setup

1. In Roblox Creator Hub, create an Open Cloud API key.
2. Grant `asset:write` for uploading assets and `asset:read` for reading operation/asset status. Ensure the key is permitted to create assets for the target user or group.
3. Copy the API key into the site, select the creator type, enter the numeric User ID or Group ID, and test the connection (the connection check uses the user asset-quota endpoint; group access is validated by the upload request).
4. Use a narrowly-scoped key and do not share it or publish screenshots containing it.

## Key storage and privacy

- With “Remember on this device” enabled, the API key is stored in this browser's `localStorage` so it survives browser restarts. It is **not encrypted**; anyone with access to the same browser profile or its developer tools may be able to retrieve it. Disable the option and clear the field on a shared computer.
- The browser sends the key only as an `x-roblox-api-key` request header to this site's `/api/*` Worker routes. The Worker forwards it to Roblox as `x-api-key`; it does not write the key to storage and avoids logging request bodies or headers.
- Audio is processed locally and only sent to Roblox after you press **Upload to Roblox**. FFmpeg WebAssembly is downloaded from unpkg on first use.
- This Worker is intended to be deployed with the UI on the same origin. The Worker blocks cross-origin browser requests by default. If you intentionally separate the frontend and API origins, configure `ALLOWED_ORIGIN` as a Worker variable to the exact frontend origin.

## Speed math

The processor changes both duration and pitch using sample-rate conversion. If the file is processed at `1.25×`, set the Roblox `Sound.PlaybackSpeed` to `1 / 1.25 = 0.80` to restore the original timing and pitch as closely as possible. Roblox's audio encoding/playback can cause small differences; preview before publishing.

## Roblox audio constraints

The UI enforces the documented 20 MB file-size limit and a duration shorter than 7 minutes. The processed OGG is resampled to 48 kHz. Roblox also requires users to have the rights to the audio and to comply with its Community Standards and Terms. The monthly upload quota depends on account verification status and Roblox may update API requirements.

## Moderation status caveat

Open Cloud upload operation status and moderation are distinct. This site polls the operation first and then attempts to read `moderationResult` from the asset metadata API. Roblox may leave moderation pending, may not return a final state yet, or may restrict fields based on API permissions. A successful upload is **not** an automatic moderation approval; check Creator Dashboard if the result remains pending or unavailable.
