// Graba un video de demostración de IdeaShel Vale en tamaño iPhone, con subtítulos.
// Uso: node tools/demo-video.mjs <carpeta-salida>
// La IA se simula con respuestas de ejemplo (no usa claves reales). Micrófono falso de Chromium.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'demo'));
mkdirSync(out, { recursive: true });

const PORT = 4190;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: join(root, 'app'), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const iPhone = devices['iPhone 13'];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({
  ...iPhone,
  locale: 'es-CL',
  permissions: ['microphone'],
  recordVideo: { dir: out, size: { width: 390, height: 844 } }
});

// Subtítulos y marca de toque, para que el video se entienda sin audio
await context.addInitScript(() => {
  window.__caption = (text) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 58px);z-index:9999;padding:10px 14px;border-radius:14px;background:rgba(20,14,40,.88);color:#fff;font:600 15px/1.35 -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none;transition:opacity .25s';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = text ? '1' : '0';
  };
  document.addEventListener('pointerdown', (e) => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;background:rgba(255,122,89,.45);border:2px solid #FF7A59;z-index:10000;pointer-events:none;transition:transform .45s,opacity .45s`;
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(1.6)'; d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 600);
  }, true);
});

// IA simulada (Gemini)
await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const body = JSON.parse(route.request().postData());
  const allText = body.contents.map((c) => c.parts.map((p) => p.text || '').join(' ')).join('\n');
  let text = 'OK';
  await new Promise((r) => setTimeout(r, 1400));
  if (body.contents[0].parts.some((p) => p.inline_data)) {
    text = 'Bueno, resumen de la reunión con el equipo de mantención. Primero, el proveedor de repuestos se está atrasando dos semanas, así que hay que pedir cotización a otro proveedor esta semana. Segundo, la capacitación de seguridad queda para el martes 18 a las 9. Y tercero, Carla va a preparar el informe de costos para el viernes.';
  } else if (allText.includes('Organice')) {
    text = JSON.stringify({
      titulo: 'Reunión de mantención: proveedor y capacitación',
      resumen: 'El proveedor de repuestos viene atrasado; se pedirá otra cotización. Capacitación el martes 18 e informe de costos el viernes.',
      nota: '## Proveedor de repuestos\n- Viene **atrasado dos semanas**\n- Pedir cotización a otro proveedor **esta semana**\n## Capacitación de seguridad\n- **Martes 18 a las 9:00**\n## Informe de costos\n- Lo prepara **Carla** para el viernes',
      etiquetas: ['mantencion', 'proveedores'],
      categoria: 'Trabajo',
      tareas: ['Pedir cotización a otro proveedor', 'Confirmar sala para la capacitación', 'Revisar informe de costos de Carla']
    });
  } else if (allText.includes('Esta es la idea o nota')) {
    text = 'Según la nota, sus tareas son:\n- Pedir **cotización a otro proveedor** esta semana\n- Confirmar la capacitación del **martes 18**\n- Revisar el informe de Carla el viernes';
  } else if (allText.includes('Estas son las ideas guardadas')) {
    text = 'Esta semana tiene pendiente:\n- "Reunión de mantención": pedir otra cotización\n- "Reunión de proveedores y residuos": visita a la planta el jueves\n- "Presentación del trimestre": preparar gráficos';
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }) });
});

const page = await context.newPage();
const cap = (t) => page.evaluate((x) => window.__caption(x), t);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => document.documentElement.classList.contains('ready'));
// Preparación: clave de prueba, nombre y ejemplos
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
await page.click('.tabbar2 [data-nav="ideas"]');
await wait(300);
await page.click('#loadSamples');
await wait(400);
await page.evaluate(() => document.getElementById('toast').classList.remove('show'));

await cap('IdeaShel Vale: nuevo diseño pastel, con el panel "Hoy"');
await wait(2600);
await cap('Menú lateral: grabaciones, programadas, categorías y etiquetas');
await page.click('#menuBtn');
await wait(2600);
await page.click('.sheet.drawer [data-close]');
await wait(500);

await cap('Escriba o dicte: la app detecta fecha, categoría y tareas');
await page.fill('#newText', 'Hay que llamar a Carla mañana a las 10 por el informe de costos, y tengo que revisar el presupuesto del proveedor');
await wait(1800);
await page.click('#saveNewBtn');
await wait(3200);
await cap('Un toque y queda el recordatorio');
await page.click('#toast button');
await wait(2200);
await page.locator('.idea-card', { hasText: 'Carla' }).locator('.card-open').click();
await cap('Sugerencias inteligentes, sin internet');
await wait(2400);
await page.click('.smart-chip[data-smart="tasks"]');
await wait(2000);
await page.click('.sheet.editor [data-act="close"]');
await wait(600);
await cap('Tareas: todo lo pendiente en una sola lista');
await page.click('#menuBtn');
await wait(500);
await page.click('.sheet.drawer [data-go="tasks"]');
await wait(2400);
await page.locator('.task-group', { hasText: 'Carla' }).locator('input[type="checkbox"]').first().check();
await wait(1600);
await cap('Tablero: mueva sus ideas de Nueva a Hecha');
await page.click('#menuBtn');
await wait(500);
await page.click('.sheet.drawer [data-go="board"]');
await wait(1800);
await page.locator('.col-nueva .board-card', { hasText: 'Carla' }).locator('[data-dir="1"]').click();
await wait(2200);
await page.click('.tabbar2 [data-nav="ideas"]');
await cap('Plantillas: reunión, proyecto, negocio, compras, diario…');
await page.click('#tplBtn');
await wait(2800);
await page.keyboard.press('Escape');
await wait(500);

await cap('1. Toque el micrófono para grabar una idea o una reunión');
await wait(1500);
await page.click('#recBtn');
await wait(800);
await cap('Graba el audio en el teléfono: puede pausar y seguir');
await wait(3500);
await page.click('#rPause');
await cap('En pausa…');
await wait(1500);
await page.click('#rPause');
await cap('Grabando de nuevo');
await wait(2000);
await cap('2. Toque Guardar');
await wait(900);
await page.click('#rStop');
await cap('3. La IA transcribe y organiza la grabación sola');
await page.waitForSelector('#noteBlock:not([hidden]) .md h4', { timeout: 30000 });
await wait(800);
await cap('Nota organizada: título, temas, tareas y etiquetas');
await wait(3200);
await page.evaluate(() => document.querySelector('#noteBlock').scrollIntoView({ block: 'start', behavior: 'smooth' }));
await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop -= 80; });
await wait(2600);
await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop = 0; });
await cap('Reproductor: escuche el audio, adelante 15 s, cambie la velocidad');
await wait(800);
await page.click('[data-p="play"]');
await wait(2200);
await page.click('.ptimes .speed');
await wait(1200);
await page.click('[data-p="play"]');
await wait(600);

await cap('4. Hable con la IA sobre la nota');
await page.evaluate(() => document.querySelector('#chatBlock').scrollIntoView({ block: 'start', behavior: 'smooth' }));
await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop -= 70; });
await wait(1800);
await page.click('#chatBlock .sug-chip >> nth=0');
await page.waitForSelector('#chatBlock .bubble.ai .md');
await wait(3000);
await cap('Agregue la respuesta a la nota con un toque');
await page.click('#chatBlock [data-add="1"]');
await wait(2000);

await cap('5. Recordatorio con aviso en el Calendario del iPhone');
await page.evaluate(() => document.querySelector('#edRemind').scrollIntoView({ block: 'center', behavior: 'smooth' }));
await wait(1200);
const d = new Date(Date.now() + 86400000);
const p2 = (n) => String(n).padStart(2, '0');
await page.fill('#edRemind', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T09:00`);
await page.dispatchEvent('#edRemind', 'change');
await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
await wait(2600);
await page.click('.sheet.editor [data-act="close"]');
await wait(800);
await cap('La tarjeta muestra el audio, el recordatorio y que está organizada');
await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
await wait(3000);

await cap('6. Pregúntele a la IA sobre todas sus ideas');
await page.click('#menuBtn');
await wait(900);
await page.click('.sheet.drawer [data-go="askall"]');
await wait(1200);
await page.click('.sheet.askall .sug-chip >> nth=0');
await page.waitForSelector('.sheet.askall .bubble.ai .md');
await wait(3500);
await page.click('.sheet.askall [data-close]');
await wait(600);

await cap('7. Personalice la IA: quién es usted y cómo quiere sus notas');
await page.click('#menuBtn');
await wait(800);
await page.click('.sheet.drawer [data-go="personalize"]');
await wait(3500);
await page.emulateMedia({ colorScheme: 'dark' });
await page.click('#menuBtn');
await wait(700);
await page.click('.sheet.drawer [data-go="all"]');
await cap('Modo oscuro automático. Todo queda en su teléfono y funciona sin internet');
await wait(3500);
await cap('');
await wait(400);

await context.close();
await browser.close();
server.kill();
const vid = readdirSync(out).find((f) => f.endsWith('.webm'));
renameSync(join(out, vid), join(out, 'demo-ideashel-vale.webm'));
console.log('Video:', join(out, 'demo-ideashel-vale.webm'));
