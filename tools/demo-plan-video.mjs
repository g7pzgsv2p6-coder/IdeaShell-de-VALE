// Video de demostración del Plan de trabajo, a partir de un Excel que usted elija.
// Uso: node tools/demo-plan-video.mjs <plan.xlsx> <carpeta-salida>
// El archivo se usa solo en esta máquina; el video queda en la carpeta de salida.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const xlsx = resolve(process.argv[2]);
const out = resolve(process.argv[3] || join(root, 'demo'));
mkdirSync(out, { recursive: true });

const PORT = 4191;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: join(root, 'app'), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'es-CL', recordVideo: { dir: out, size: { width: 390, height: 844 } } });
await context.addInitScript(() => {
  window.__caption = (text) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);z-index:9999;padding:10px 14px;border-radius:14px;background:rgba(40,20,60,.9);color:#fff;font:600 15px/1.35 -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none;transition:opacity .25s';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = text ? '1' : '0';
  };
  document.addEventListener('pointerdown', (e) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;background:rgba(242,123,180,.4);border:2px solid #F27BB4;z-index:10000;pointer-events:none;transition:transform .45s,opacity .45s`;
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(1.6)'; d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 600);
  }, true);
});
await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
  await new Promise((r) => setTimeout(r, 1200));
  const text = 'Para hoy le sugiero este orden:\n- **T01** Inducción de seguridad, primero porque habilita el acceso\n- **T02** Reunión de arranque: confirme prioridades y contactos\n- **T03** Pida los documentos base en esa misma reunión\n- **T04** Cree el repositorio al cierre del día (vence **E01** hoy)';
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }) });
});

const page = await context.newPage();
const cap = (t) => page.evaluate((x) => window.__caption(x), t);
const wait = (ms) => page.waitForTimeout(ms);
const quiet = () => page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
const sec = async (k, caption, ms = 2800) => {
  await page.click(`[data-sec="${k}"]`);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await cap(caption);
  await wait(ms);
};

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => document.documentElement.classList.contains('ready'));
await page.evaluate(async () => {
  const put = (key, value) => new Promise((res) => {
    const r = indexedDB.open('chispa-db');
    r.onsuccess = () => { const t = r.result.transaction('settings', 'readwrite'); t.objectStore('settings').put({ key, value }); t.oncomplete = res; };
  });
  await put('aiProvider', 'gemini');
  await put('geminiKey', 'DEMO');
  await put('userName', 'Vale');
});
await page.reload();
await page.waitForFunction(() => document.documentElement.classList.contains('ready'));

await cap('Nuevo inicio: importe su plan de trabajo en Excel');
await wait(2200);
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-h="import"]')]);
await fc.setFiles(xlsx);
await page.waitForSelector('.plan-hero');
await quiet();
await cap('Resumen: avance ponderado, días, alertas y totales');
await wait(3200);
await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' }));
await cap('Avance por frente: planificado vs. real');
await wait(3000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await wait(600);

await sec('agenda', 'Agenda: lo de hoy con su foco y rutina del día', 3000);
await page.locator('[data-check]').first().click();
await cap('Un toque para marcarla completada ✓');
await wait(2000);
await quiet();
await page.locator('.act-row .act-main').nth(1).click();
await cap('Detalle: estado, avance, fecha real y bloqueos');
await wait(1500);
await page.click('.act-sheet [data-status="En curso"]');
await wait(900);
await page.fill('#progRange', '60').catch(() => {});
await page.dispatchEvent('#progRange', 'input');
await wait(1600);
await page.click('.act-sheet [data-close]');
await wait(700);

await sec('calendario', 'Calendario: colores por frente y ◆ entregables', 3000);
await page.locator('.cal-cell[data-day]').filter({ hasText: '18' }).first().click();
await cap('Toque un día para ver qué hay programado');
await wait(3000);
await sec('semanas', 'Semanas: línea de tiempo de las 5 semanas', 3600);
await sec('entregables', 'Entregables: cuenta regresiva y quién valida', 2600);
await page.locator('[data-del]').first().click();
await wait(1300);
await page.click('.act-sheet [data-dstatus="Entregado"]');
await wait(1500);
await page.click('.act-sheet [data-close]');
await quiet();
await wait(600);
await sec('metas', 'Metas: real vs. meta, se actualizan con + y −', 1800);
await page.locator('[data-goal] [data-step="1"]').nth(2).click();
await wait(1800);
await quiet();
await sec('personas', 'Personas: qué tiene con cada uno', 2200);
await page.locator('.person').first().click();
await wait(2800);
await page.click('.sheet [data-close]');
await wait(500);
await sec('bitacora', 'Bitácora diaria: se completa sola con su día', 1600);
await page.locator('.log-row.is-today, [data-log="0"]').first().click();
await wait(900);
await page.click('[data-fill]');
await quiet();
await wait(3000);
await page.click('.log-sheet [data-close]');
await wait(500);
await sec('reporte', 'Reporte semanal listo para enviar', 3400);
await sec('reglas', 'Reglas y semana tipo, con el día de hoy destacado', 2800);
await sec('resumen', 'Y puede preguntarle a la IA sobre su plan', 1200);
await page.click('#planChat');
await wait(900);
await page.click('.sheet.askall .sug-chip >> nth=0');
await page.waitForSelector('.sheet.askall .bubble.ai .md');
await wait(3800);
await page.click('.sheet.askall [data-close]');
await wait(500);
await page.click('.tabbar2 [data-nav="home"]');
await cap('Inicio: foco del día, siguiente actividad y avance');
await wait(3200);
await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'smooth' }));
await cap('Frentes de trabajo y acciones rápidas');
await wait(3000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await page.click('[data-range="semana"]');
await cap('Vista Semana: toque un día');
await wait(2600);
await page.click('[data-range="mes"]');
await cap('Vista Mes: calendario del plan');
await wait(2600);
await page.click('[data-range="hoy"]');
await page.emulateMedia({ colorScheme: 'dark' });
await cap('También en modo oscuro. Todo queda solo en su teléfono');
await wait(3200);
await cap('');
await wait(300);

await context.close();
await browser.close();
server.kill();
const vid = readdirSync(out).find((f) => f.endsWith('.webm') && !f.startsWith('demo-plan'));
renameSync(join(out, vid), join(out, 'demo-plan.webm'));
console.log('Video:', join(out, 'demo-plan.webm'));
