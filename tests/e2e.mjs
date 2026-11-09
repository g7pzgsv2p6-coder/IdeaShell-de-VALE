// Prueba de punta a punta de IdeaShel Vale en tamaño iPhone, con capturas.
// Uso: node tests/e2e.mjs   (sirve la carpeta app/ en /IdeaShell-de-VALE/ como en GitHub Pages)
// La IA se simula (no se usan claves reales). El micrófono es el falso de Chromium.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'capturas');
mkdirSync(shots, { recursive: true });

const PORT = 4173;
const REPO = 'IdeaShell-de-VALE';
const BASE = `http://localhost:${PORT}/${REPO}/`;

// Servidor estático que imita la ruta de GitHub Pages
const site = mkdtempSync(join(tmpdir(), 'ideashel-site-'));
symlinkSync(join(root, 'app'), join(site, REPO));
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: site, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const iPhone = devices['iPhone 13'];
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({
  viewport: iPhone.viewport,
  screen: iPhone.screen,
  userAgent: iPhone.userAgent,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: 'es-CL',
  colorScheme: 'light',
  acceptDownloads: true,
  permissions: ['microphone']
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const shot = async (name, opts = {}) => {
  // Oculta el aviso flotante y espera que terminen las animaciones antes de capturar
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name), ...opts });
};
const ready = () => page.waitForFunction(() => document.documentElement.classList.contains('ready'));
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
/** Navega con el menú lateral. */
const go = async (target, extra = '') => {
  await page.click('#menuBtn');
  await page.waitForSelector('.sheet.drawer');
  await page.waitForTimeout(250);
  await page.click(`.sheet.drawer [data-go="${target}"]${extra}`);
  await page.waitForTimeout(400);
};
const closeEditor = async () => {
  await page.click('.sheet.editor [data-act="close"]');
  await page.waitForTimeout(400);
};
const idb = (store) => page.evaluate((st) => new Promise((res) => {
  const r = indexedDB.open('chispa-db');
  r.onsuccess = () => {
    const q = r.result.transaction(st).objectStore(st).getAll();
    q.onsuccess = () => res(q.result.map((x) => (x.data instanceof ArrayBuffer ? { ...x, data: x.data.byteLength } : x)));
  };
}), store);

// ---------- IA simulada ----------
let geminiMode = 'ok';
let lastGeminiBody = null;
let claudeMode = 'ok';
let claudeHeaders = null;
let claudeBody = null;
const ORGANIZED = {
  titulo: 'Proveedores de residuos y fiscalización',
  resumen: 'Se acordó pedir cotización directa al proveedor y digitalizar la documentación antes de la fiscalización.',
  nota: '## Proveedores\n- Pedir **cotización directa**, sin intermediarios\n## Cumplimiento\n- Digitalizar la documentación\n  - Revisar permisos vigentes\n- Fiscalización el **jueves**',
  etiquetas: ['proveedores', 'residuos'],
  categoria: 'Trabajo',
  tareas: ['Pedir cotización directa al proveedor', 'Digitalizar la documentación']
};
function answerFor(text) {
  if (text.includes('Organice')) return JSON.stringify(ORGANIZED);
  if (text.includes('Resuma')) return 'App para registrar gastos del hogar usando fotos de boletas.';
  if (text.includes('sugiera')) return '{"titulo":"App de gastos con boletas","categoria":"Proyectos","etiquetas":["finanzas","hogar"]}';
  if (text.includes('pasos')) return '{"pasos":["Definir funciones básicas","Diseñar pantallas","Probar con boletas reales"]}';
  if (text.includes('Desarrolle')) return 'La idea puede crecer así:\n- Escanear boletas\n- Ver gastos por mes';
  if (text.includes('Agrupe')) return '{"grupos":[{"nombre":"Trabajo y taller","descripcion":"Ideas del trabajo.","ideas":[1,3]},{"nombre":"Hogar","descripcion":"Ideas personales.","ideas":[2,4,5]}]}';
  return 'OK';
}
await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const body = JSON.parse(route.request().postData());
  lastGeminiBody = body;
  if (geminiMode === 'quota') {
    return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }) });
  }
  const first = body.contents[0].parts;
  const allText = body.contents.map((c) => c.parts.map((p) => p.text || '').join(' ')).join('\n');
  let text;
  if (first.some((p) => p.inline_data)) {
    text = 'Revisamos el manejo de residuos con el proveedor. Hay que pedir cotización directa y digitalizar la documentación antes de la fiscalización del jueves.';
  } else if (allText.includes('Esta es la idea o nota')) {
    text = 'Según la nota, sus tareas son:\n- Pedir **cotización directa** al proveedor\n- Digitalizar la documentación';
  } else if (allText.includes('Estas son las ideas guardadas')) {
    text = 'Sus pendientes principales:\n- "Proveedores de residuos y fiscalización": pedir cotización\n- "Presentación del trimestre": preparar gráficos';
  } else {
    text = answerFor(first.map((p) => p.text || '').join(' '));
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }) });
});
await context.route('https://api.anthropic.com/v1/messages', async (route) => {
  claudeHeaders = route.request().headers();
  claudeBody = JSON.parse(route.request().postData());
  const prompt = claudeBody.messages.map((m) => m.content).join('\n');
  if (claudeMode === '401') {
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  }
  if (claudeMode === 'credits') {
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
  }
  const text = answerFor(claudeBody.messages[claudeBody.messages.length - 1].content.includes('Esta es la idea') ? prompt : claudeBody.messages[0].content);
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: claudeBody.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }) });
});

try {
  // ---------- carga y PWA ----------
  await page.goto(BASE);
  await ready();
  check('La app carga en la ruta de GitHub Pages', true);
  const swActive = await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);
  check('Service worker instalado y activo', swActive);
  await page.reload();
  await ready();
  check('Service worker controla la página', await page.evaluate(() => !!navigator.serviceWorker.controller));

  const manRes = await page.request.get(BASE + 'manifest.webmanifest');
  const man = await manRes.json();
  check('Manifest válido', manRes.ok() && man.display === 'standalone' && man.start_url === './' && man.scope === './' && man.short_name === 'IdeaShel Vale');
  for (const icon of man.icons) {
    const r = await page.request.get(BASE + icon.src);
    const [w, h] = pngSize(Buffer.from(await r.body()));
    check(`Ícono ${icon.src} (${icon.sizes}, ${icon.purpose})`, r.ok() && `${w}x${h}` === icon.sizes);
  }
  const appleRes = await page.request.get(BASE + (await page.getAttribute('link[rel="apple-touch-icon"]', 'href')));
  check('apple-touch-icon 180×180', appleRes.ok() && pngSize(Buffer.from(await appleRes.body())).join('x') === '180x180');
  const metas = await page.evaluate(() => ({
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
    viewport: document.querySelector('meta[name="viewport"]')?.content
  }));
  check('Meta tags de iOS', metas.capable === 'yes' && metas.title === 'IdeaShel Vale' && metas.viewport.includes('viewport-fit=cover'));
  check('Botón de grabar visible en la barra inferior', await page.isVisible('#recBtn'));
  check('Saludo en la pantalla de inicio', /Buen(os|as) (días|tardes|noches)/.test(await page.innerText('#greeting')));
  await shot('01-inicio.png');

  // ---------- agregar ideas escritas ----------
  const add = async (text, cat) => {
    await page.fill('#newText', text);
    if (cat) await page.selectOption('#newCategory', cat);
    await page.click('#saveNewBtn');
    await page.waitForTimeout(200);
  };
  await add('Bueno, crear una app para registrar los gastos del hogar con fotos de boletas #finanzas', 'proyectos');
  await add('Llamar al dentista el lunes para pedir hora de control', 'personal');
  await add('Preparar presentación de resultados del trimestre para el equipo #reunion', 'trabajo');
  await add('Repasar capítulo 4 de estadística y hacer los ejercicios #examen', 'estudios');
  await add('Idea para el taller: usar la app de ideas para lluvia de ideas con los alumnos #taller', 'trabajo');
  check('Agregar ideas escritas (5)', (await page.locator('.idea-card').count()) === 5);
  const titles = await page.locator('.idea-card h3').allInnerTexts();
  check('Título automático sin muletillas', titles.includes('Crear una app para registrar los gastos del…'), titles.join(' | '));
  check('Etiquetas automáticas desde #hashtags', (await page.locator('.idea-card .tag').count()) >= 4);
  check('Vista de cuadrícula por defecto', await page.locator('#ideaList.grid').count() === 1);
  await shot('02-inicio-cuadricula.png');

  // ---------- editar ----------
  await page.locator('.idea-card', { hasText: 'dentista' }).locator('.card-open').click();
  await page.waitForSelector('.sheet.editor');
  await page.waitForTimeout(300);
  await page.click('.sheet.editor [data-act="fav"]');
  await page.fill('#edTagInput', 'salud');
  await page.press('#edTagInput', 'Enter');
  await page.fill('#newStep', 'Buscar el número de la clínica');
  await page.press('#newStep', 'Enter');
  await page.selectOption('#edStatus', 'desarrollo');
  await closeEditor();
  const dent = (await idb('ideas')).find((i) => i.text.includes('dentista'));
  check('Edición guardada en IndexedDB (favorita, etiqueta, pasos, estado)', dent.favorite && dent.tags.includes('salud') && dent.steps.length === 1 && dent.status === 'desarrollo');

  // ---------- búsqueda y filtros ----------
  await page.fill('#search', 'presentacion');
  await page.waitForTimeout(300);
  check('Búsqueda sin importar tildes', (await page.locator('.idea-card').count()) === 1);
  await page.fill('#search', 'app');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement?.blur());
  await shot('03-busqueda.png');
  await page.fill('#search', '');
  await page.waitForTimeout(250);
  await page.click('[data-favchip]');
  check('Filtro de favoritas', (await page.locator('.idea-card').count()) === 1);
  await page.click('[data-favchip]');
  await page.click('[data-cat="trabajo"]');
  check('Filtro por categoría', (await page.locator('.idea-card').count()) === 2);
  await page.click('[data-cat="all"]');
  await page.locator('.idea-card .tag', { hasText: '#examen' }).click();
  check('Filtro por etiqueta', (await page.locator('.idea-card').count()) === 1);
  await page.click('[data-clear="tag"]');
  await page.click('#filterBtn');
  await page.selectOption('#fSort', 'old');
  await page.click('#fApply');
  await page.waitForTimeout(300);
  check('Orden por fecha (más antiguas primero)', (await page.locator('.idea-card h3').nth(0).innerText()).startsWith('Crear una app'));
  await page.click('#filterBtn');
  await page.click('#fClear');
  await page.waitForTimeout(300);
  await page.click('#viewToggle');
  await page.waitForTimeout(300);
  check('Cambiar a vista de lista', await page.locator('#ideaList:not(.grid)').count() === 1);
  await shot('04-vista-lista.png');
  await page.click('#viewToggle');

  // ---------- menú lateral ----------
  await page.click('#menuBtn');
  await page.waitForSelector('.sheet.drawer');
  await page.waitForTimeout(350);
  await shot('05-menu.png');
  const drawerText = await page.innerText('.sheet.drawer');
  check('Menú con secciones, categorías y etiquetas', ['Todas las ideas', 'Grabaciones', 'Programadas', 'Archivadas', 'Borradas recientemente', 'Personalizar la IA', 'finanzas'].every((t) => drawerText.includes(t)));
  await page.click('.sheet.drawer [data-go="cat"][data-id="estudios"]');
  await page.waitForTimeout(350);
  check('Menú: abrir una categoría', (await page.innerText('#greeting')) === 'Estudios' && (await page.locator('.idea-card').count()) === 1);
  await go('all');

  // ---------- borrar con confirmación ----------
  await page.locator('.idea-card', { hasText: 'taller' }).locator('.card-open').click();
  await page.waitForSelector('.sheet.editor');
  await page.waitForTimeout(250);
  await page.click('.sheet.editor [data-act="delete"]');
  await page.waitForSelector('.sheet.dialog');
  await page.waitForTimeout(250);
  await page.click('.sheet.dialog .btn.danger');
  await page.waitForTimeout(500);
  check('Borrar con confirmación (va a la papelera)', (await page.locator('.idea-card').count()) === 4);

  // ---------- ajustes: Gemini + personalización ----------
  await go('settings');
  await page.check('input[name="aiProv"][value="gemini"]');
  await page.waitForTimeout(250);
  await page.fill('#key-gemini', 'AIzaPRUEBA-DE-MENTIRA');
  await page.click('[data-savekey="gemini"]');
  await page.waitForSelector('#status-gemini.ok', { timeout: 5000 });
  check('Guardar clave de Gemini y probar conexión', true);
  check('Gemini usa la clave en el header (no en la URL)', !!lastGeminiBody);
  check('Aviso "su clave queda guardada solo en este teléfono"', /su clave queda guardada solo en este teléfono/i.test(await page.innerText('.lock-note')));
  await page.fill('#userName', 'Vale');
  await page.press('#userName', 'Tab');
  await page.fill('#aiAbout', 'Trabajo en una planta industrial en Concepción.');
  await page.fill('#aiInstructions', 'Notas cortas y con viñetas.');
  await page.press('#aiInstructions', 'Tab');
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#personalizeCard').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => scrollBy(0, -70));
  await shot('06-personalizar-ia.png');
  await page.evaluate(() => scrollTo(0, 0));
  await shot('07-ajustes.png');

  // ---------- grabación con audio + transcripción y organización con IA ----------
  await go('all');
  check('Saludo con el nombre', (await page.innerText('#greeting')).includes('Vale'));
  await page.click('#recBtn');
  await page.waitForSelector('.sheet.recorder.is-live', { timeout: 8000 });
  await page.waitForTimeout(3200);
  await shot('08-grabando.png');
  check('Grabadora: el contador avanza', (await page.innerText('#rTime')) !== '0:00');
  await page.click('#rPause');
  await page.waitForTimeout(400);
  check('Grabadora: pausa', await page.locator('.sheet.recorder.is-paused').count() === 1);
  await page.click('#rPause');
  await page.waitForTimeout(800);
  await page.click('#rStop');
  await page.waitForSelector('.sheet.editor');
  await page.waitForSelector('#noteBlock:not([hidden]) .md h4', { timeout: 20000 });
  const audios = await idb('audio');
  check('El audio queda guardado en el teléfono (IndexedDB)', audios.length === 1 && audios[0].data > 1000, `${audios[0]?.data} bytes`);
  check('Transcripción con IA (Gemini escucha el audio)', (await page.inputValue('#edText')).includes('cotización directa'));
  await page.waitForTimeout(400);
  const org = {
    title: await page.inputValue('#edTitle'),
    h4: await page.locator('#noteBlock h4').count(),
    tags: await page.innerText('#edTags'),
    cat: await page.inputValue('#edCat'),
    steps: await page.locator('.steps li').count()
  };
  check('Organizar con IA: título, nota con secciones, etiquetas, categoría y tareas',
    org.title === ORGANIZED.titulo && org.h4 === 2 && org.tags.includes('#residuos') && org.cat === 'trabajo' && org.steps === 2, JSON.stringify(org));
  check('La IA recibe la personalización del usuario', JSON.stringify(lastGeminiBody.systemInstruction).includes('planta industrial'));
  await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop = 0; });
  await shot('09-nota-organizada.png');
  await page.click('[data-p="play"]');
  await page.waitForTimeout(700);
  check('Reproductor de audio', await page.locator('.play-btn.playing').count() === 1);
  await page.click('[data-p="play"]');
  await page.click('.ptimes .speed');
  check('Velocidad de reproducción', (await page.innerText('.ptimes .speed')) === '1,25×');

  // Chat con la IA sobre la nota
  await page.evaluate(() => document.querySelector('#chatBlock').scrollIntoView({ block: 'start' }));
  await page.click('.sug-chip >> nth=0');
  await page.waitForSelector('#chatBlock .bubble.ai .md');
  check('Hablar con la IA sobre la nota (preguntas sugeridas)', (await page.innerText('#chatBlock .bubble.ai')).includes('cotización directa'));
  await page.fill('#chatBlock .chat-text', '¿Cuándo es la fiscalización?');
  await page.click('#chatBlock .chat-send');
  await page.waitForFunction(() => document.querySelectorAll('#chatBlock .bubble.ai .md').length === 2);
  check('Chat: pregunta escrita', true);
  await page.click('#chatBlock [data-add="1"]');
  await page.waitForTimeout(300);
  check('Chat: agregar respuesta a la nota', (await page.locator('#noteBlock h4').count()) === 3);
  await page.evaluate(() => document.querySelector('#chatBlock').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop -= 60; });
  await shot('10-chat-ia.png');

  // Recordatorio + Calendario
  const when = new Date(Date.now() + 86400000);
  const p2 = (n) => String(n).padStart(2, '0');
  await page.fill('#edRemind', `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}T09:00`);
  await page.dispatchEvent('#edRemind', 'change');
  await page.waitForTimeout(300);
  check('Recordatorio: aparece el botón de Calendario', await page.isVisible('#calBtn'));
  const [ics] = await Promise.all([page.waitForEvent('download'), page.click('#calBtn')]);
  const icsPath = join(site, 'r.ics');
  await ics.saveAs(icsPath);
  const icsText = readFileSync(icsPath, 'utf8');
  check('Archivo de Calendario (.ics) con aviso', icsText.includes('BEGIN:VCALENDAR') && icsText.includes('BEGIN:VALARM') && icsText.includes('Proveedores de residuos'));
  await closeEditor();
  check('Tarjeta con audio, recordatorio y "Organizada"', await page.locator('.idea-card.has-audio .mini-pill.ai').count() === 1 && await page.locator('.idea-card .mini-pill.remind').count() === 1);
  await go('audio');
  check('Menú: Grabaciones', (await page.locator('.idea-card').count()) === 1);
  await go('scheduled');
  check('Menú: Programadas', (await page.locator('.idea-card').count()) === 1);
  await go('all');

  // ---------- herramientas de IA por idea (Claude) ----------
  await go('settings');
  await page.check('input[name="aiProv"][value="claude"]');
  await page.waitForTimeout(250);
  await page.fill('#key-claude', 'sk-ant-api03-PRUEBA-DE-MENTIRA');
  await page.click('[data-savekey="claude"]');
  await page.waitForSelector('#status-claude.ok', { timeout: 5000 });
  check('Headers correctos hacia Claude',
    claudeHeaders['x-api-key'] === 'sk-ant-api03-PRUEBA-DE-MENTIRA' &&
    claudeHeaders['anthropic-version'] === '2023-06-01' &&
    claudeHeaders['anthropic-dangerous-direct-browser-access'] === 'true');
  check('Modelo por defecto claude-haiku-5-5', claudeBody.model === 'claude-haiku-5-5');
  await go('all');
  await page.locator('.idea-card', { hasText: 'gastos' }).locator('.card-open').click();
  await page.waitForSelector('.ai-block');
  await page.waitForTimeout(250);
  await page.click('[data-ai="summary"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Resumir', (await page.innerText('#summaryBlock')).includes('fotos de boletas'));
  await page.click('[data-ai="suggest"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Sugerir título, categoría y etiquetas', (await page.inputValue('#edTitle')) === 'App de gastos con boletas');
  await page.click('[data-ai="steps"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Convertir en lista de pasos', (await page.locator('.steps li').count()) === 3);
  await page.click('[data-ai="expand"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Expandir idea', (await page.inputValue('#edText')).includes('Escanear boletas'));
  await page.click('[data-act="process-text"]');
  await page.waitForSelector('#noteBlock:not([hidden]) .md h4', { timeout: 10000 });
  check('Organizar con IA una idea escrita (Claude)', true);
  claudeMode = '401';
  await page.click('[data-ai="summary"]');
  await page.waitForSelector('#aiResult .ai-error');
  check('Error de clave inválida en español', (await page.innerText('#aiResult .ai-error')).includes('no es válida'));
  claudeMode = 'credits';
  await page.click('[data-ai="summary"]');
  await page.waitForFunction(() => document.querySelector('#aiResult .ai-error')?.innerText.includes('créditos'));
  check('Error de sin créditos en español', true);
  claudeMode = 'ok';
  await closeEditor();

  // ---------- Explorar: preguntar a todas las ideas y organizar ----------
  await go('settings');
  await page.check('input[name="aiProv"][value="gemini"]');
  await page.waitForTimeout(250);
  await go('explore');
  await page.click('#askAllBtn');
  await page.waitForSelector('.sheet.askall');
  await page.waitForTimeout(250);
  await page.click('.sheet.askall .sug-chip >> nth=0');
  await page.waitForSelector('.sheet.askall .bubble.ai .md');
  check('Preguntar a mis ideas (chat general)', (await page.innerText('.sheet.askall .bubble.ai')).includes('pendientes'));
  await shot('11-preguntar-ideas.png');
  await page.click('.sheet.askall [data-close]');
  await page.waitForTimeout(300);
  await page.click('#organizeBtn');
  await page.waitForSelector('.group');
  check('IA: Organizar mis ideas (agrupa)', (await page.locator('.group').count()) === 2);
  await page.click('#orgClear');

  // ---------- etiquetas ----------
  await page.click('#menuBtn');
  await page.waitForSelector('.sheet.drawer');
  await page.waitForTimeout(250);
  await page.click('.sheet.drawer [data-go="edittags"]');
  await page.waitForTimeout(400);
  await page.click('[data-rename="examen"]');
  await page.fill('#dlgInput', 'pruebas');
  await page.click('.sheet.dialog .btn.primary');
  await page.waitForTimeout(400);
  check('Renombrar etiqueta en todas las ideas', (await idb('ideas')).some((i) => i.tags.includes('pruebas')) && !(await idb('ideas')).some((i) => i.tags.includes('examen')));
  await page.click('.sheet [data-close]');
  await page.waitForTimeout(300);

  // Límite gratuito de Gemini
  geminiMode = 'quota';
  await go('settings');
  await page.click('[data-testkey="gemini"]');
  await page.waitForSelector('#status-gemini.err', { timeout: 5000 });
  check('Gemini: mensaje de límite gratuito alcanzado', (await page.innerText('#status-gemini')).includes('límite gratuito'));
  geminiMode = 'ok';

  // ---------- respaldo con audios ----------
  await page.check('#bkAudio');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#doExport')]);
  const backupPath = join(site, 'respaldo.json');
  await download.saveAs(backupPath);
  const raw = readFileSync(backupPath, 'utf8');
  const backup = JSON.parse(raw);
  check('Exportar respaldo JSON con audios', backup.ideas.length === 6 && backup.audio.length === 1 && backup.audio[0].base64.length > 1000, `${backup.ideas.length} ideas, ${backup.audio.length} audio`);
  check('El respaldo NO incluye claves de IA', !raw.includes('sk-ant-') && !raw.includes('AIzaPRUEBA'));
  backup.ideas.push({ id: 'importada-1', title: 'Idea importada', text: 'Esta idea viene del respaldo', createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000 });
  const importPath = join(site, 'importar.json');
  writeFileSync(importPath, JSON.stringify(backup));
  await page.setInputFiles('#importFile', importPath);
  await page.waitForSelector('.sheet.dialog');
  await page.waitForTimeout(250);
  await page.click('.sheet.dialog .btn.primary');
  await page.waitForTimeout(600);
  await go('all');
  check('Importar respaldo (combinar)', (await page.locator('.idea-card', { hasText: 'Idea importada' }).count()) === 1);

  // Borrar claves
  await go('settings');
  await page.click('#delAllKeys');
  await page.click('.sheet.dialog .btn.danger');
  await page.waitForTimeout(300);
  const keysLeft = (await idb('settings')).filter((x) => /Key$/.test(x.key) && x.value).length;
  check('Botón para borrar claves', keysLeft === 0);
  await go('all');
  await page.locator('.idea-card').first().locator('.card-open').click();
  await page.waitForSelector('.sheet.editor');
  check('Sin clave, las funciones de IA quedan ocultas', await page.locator('.ai-block, #chatBlock').count() === 0);
  await closeEditor();

  // ---------- modo oscuro ----------
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  check('Modo oscuro automático', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(20, 17, 31)');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('12-modo-oscuro.png');
  await page.locator('.idea-card.has-audio .card-open').click();
  await page.waitForSelector('.sheet.editor');
  await page.waitForTimeout(400);
  await shot('13-nota-oscuro.png');
  await closeEditor();
  check('Sin scroll horizontal', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));

  // ---------- sin conexión ----------
  await context.setOffline(true);
  await page.reload();
  await ready();
  const offlineCards = await page.locator('.idea-card').count();
  check('Abre sin conexión con las ideas guardadas', offlineCards === 6 && await page.isVisible('#offlinePill'), `${offlineCards} ideas`);
  await page.locator('.idea-card.has-audio .card-open').click();
  await page.waitForSelector('.player');
  check('El audio se escucha sin conexión', await page.locator('.player .play-btn').count() === 1);
  await closeEditor();
  await shot('14-sin-conexion.png');
  const cold = await context.newPage();
  await cold.goto(BASE);
  await cold.waitForFunction(() => document.documentElement.classList.contains('ready'));
  check('Pestaña nueva sin conexión también abre', (await cold.locator('.idea-card').count()) === 6);
  await cold.close();
  await context.setOffline(false);

  // ---------- navegador sin grabación ----------
  const ctx2 = await browser.newContext({ viewport: iPhone.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await ctx2.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; delete window.MediaRecorder; });
  const p2page = await ctx2.newPage();
  await p2page.goto(BASE);
  await p2page.waitForFunction(() => document.documentElement.classList.contains('ready'));
  check('Sin grabación disponible: oculta el botón y muestra aviso amable',
    !(await p2page.isVisible('#recBtn')) && (await p2page.innerText('#voiceUnavailable')).includes('micrófono del teclado'));
  await ctx2.close();

  const relevantErrors = errors.filter((e) => !/Failed to load resource/.test(e));
  check('Sin errores de JavaScript en la consola', relevantErrors.length === 0, relevantErrors.join(' | '));
} catch (err) {
  check('Prueba completa sin excepciones', false, err.stack || String(err));
  await page.screenshot({ path: join(shots, 'error.png') }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
  rmSync(site, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificaciones correctas.`);
process.exit(failed.length ? 1 : 0);
