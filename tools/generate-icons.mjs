// Genera los íconos PNG de la app a partir del logo SVG (usa Playwright).
// Uso: node tools/generate-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { logoSVG } from './logo.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'favicon.svg'), logoSVG({ size: 64, rounded: true }));

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180 }
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:#E3B4F0">${logoSVG({ size: t.size, maskable: t.maskable })}</body></html>`);
  await page.screenshot({ path: join(out, t.file), clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log('✓', t.file);
}
await browser.close();
