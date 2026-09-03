import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { HttpComfyClient } from './comfy-client.js';
import { HttpFlashVsrWorkerClient } from './flashvsr-client.js';
import { HttpDeterministicUpscaleWorkerClient } from './deterministic-upscale-client.js';
import { cacheControlForStaticFile, HTML_CACHE_CONTROL } from './static-cache.js';

const host = process.env.H3_STUDIO_HOST ?? '127.0.0.1';
const port = Number(process.env.H3_STUDIO_PORT ?? 5174);
const app = createApp(
  new HttpComfyClient(process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'),
  new HttpFlashVsrWorkerClient(
    process.env.FLASHVSR_WORKER_URL ?? 'http://127.0.0.1:8190',
    process.env.FLASHVSR_STATE_PATH,
  ),
  {
    deterministicUpscale: new HttpDeterministicUpscaleWorkerClient(
      process.env.DETERMINISTIC_UPSCALE_WORKER_URL ?? 'http://127.0.0.1:8191',
    ),
  },
);
const distPath = resolve(process.cwd(), 'dist');
const indexPath = resolve(distPath, 'index.html');

if (existsSync(indexPath)) {
  app.use(express.static(distPath, {
    index: false,
    setHeaders: (response, filePath) => {
      const cacheControl = cacheControlForStaticFile(filePath);
      if (cacheControl) response.setHeader('Cache-Control', cacheControl);
    },
  }));
  app.get('/{*splat}', (_request, response) => {
    response.setHeader('Cache-Control', HTML_CACHE_CONTROL);
    response.sendFile(indexPath);
  });
}

app.listen(port, host, () => {
  console.log(`H3 Studio is available at http://${host}:${port}`);
});
