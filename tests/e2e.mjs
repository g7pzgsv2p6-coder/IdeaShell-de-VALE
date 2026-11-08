// Prueba de punta a punta de IdeaShel Vale en tamaño iPhone, con capturas.
// Uso: node tests/e2e.mjs   (sirve la carpeta app/ en /IdeaShell-de-VALE/ como en GitHub Pages)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'capturas');
mkdirSync(shots, { recursive: true });

const PORT = 4173;
const REPO = 'IdeaShell-de-VALE';
const BASE = `http://localhost:${PORT}/${REPO}/`;

// Servidor estático que imita la ruta de GitHub Pages
const site = mkdtempSync(join(tmpdir(), 'chispa-site-'));
symlinkSync(join(root, 'app'), join(site, REPO));
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: site, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const iPhone = devices['iPhone 13'];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: iPhone.viewport,
  screen: iPhone.screen,
  userAgent: iPhone.userAgent,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: 'es-CL',
  colorScheme: 'light',
  acceptDownloads: true
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

try {
  // ---------- carga y PWA ----------
  await page.goto(BASE);
  await ready();
  check('La app carga en la ruta de GitHub Pages', true);

  const swActive = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  check('Service worker instalado y activo', swActive);
  await page.reload();
  await ready();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check('Service worker controla la página', controlled);

  const manRes = await page.request.get(BASE + 'manifest.webmanifest');
  const man = await manRes.json();
  check('Manifest válido', manRes.ok() && man.display === 'standalone' && man.start_url === './' && man.scope === './' && !!man.name && !!man.short_name,
    `display=${man.display}, start_url=${man.start_url}`);
  for (const icon of man.icons) {
    const r = await page.request.get(BASE + icon.src);
    const [w, h] = pngSize(Buffer.from(await r.body()));
    check(`Ícono ${icon.src} (${icon.sizes}, ${icon.purpose})`, r.ok() && `${w}x${h}` === icon.sizes);
  }
  const apple = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
  const appleRes = await page.request.get(BASE + apple);
  check('apple-touch-icon 180×180', appleRes.ok() && pngSize(Buffer.from(await appleRes.body())).join('x') === '180x180');
  const metas = await page.evaluate(() => ({
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
    title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
    viewport: document.querySelector('meta[name="viewport"]')?.content
  }));
  check('Meta tags de iOS', metas.capable === 'yes' && metas.title === 'IdeaShel Vale' && metas.viewport.includes('viewport-fit=cover'));

  const voiceBtn = await page.isVisible('#recBtn');
  check('Botón grande de grabar visible (navegador con reconocimiento de voz)', voiceBtn);

  await shot('01-inicio.png');

  // ---------- agregar ideas ----------
  const add = async (text, cat) => {
    await page.fill('#newText', text);
    if (cat) await page.selectOption('#newCategory', cat);
    await page.click('#saveNewBtn');
    await page.waitForTimeout(150);
  };
  await add('Bueno, crear una app para registrar los gastos del hogar con fotos de boletas #finanzas', 'proyectos');
  await add('Llamar al dentista el lunes para pedir hora de control', 'personal');
  await add('Preparar presentación de resultados del trimestre para el equipo #reunion', 'trabajo');
  await add('Repasar capítulo 4 de estadística y hacer los ejercicios #examen', 'estudios');
  await add('Idea para el taller: usar la app de ideas para lluvia de ideas con los alumnos #taller', 'trabajo');
  const count = await page.locator('.idea-card').count();
  check('Agregar ideas (5 guardadas)', count === 5, `${count} tarjetas`);
  const firstTitle = await page.locator('.idea-card h3').nth(0).innerText();
  check('Título automático sin muletillas', firstTitle.startsWith('Idea para el taller'), firstTitle);
  const titles = await page.locator('.idea-card h3').allInnerTexts();
  check('Quita "Bueno," del inicio del título', titles.includes('Crear una app para registrar los gastos del…'), titles.join(' | '));
  const tagCount = await page.locator('.idea-card .tag').count();
  check('Etiquetas automáticas desde #hashtags', tagCount >= 4, `${tagCount} etiquetas`);

  await page.fill('#newText', 'Comprar regalo de cumpleaños para la Vale');
  await shot('02-agregar-idea.png');
  await page.click('#saveNewBtn');
  await page.waitForTimeout(200);

  // ---------- editar ----------
  await page.locator('.idea-card .card-open').first().click();
  await page.waitForSelector('.sheet.editor');
  await page.waitForTimeout(300);
  await page.click('.sheet.editor [data-act="fav"]');
  await page.fill('#edTagInput', 'cumpleaños');
  await page.press('#edTagInput', 'Enter');
  await page.fill('#newStep', 'Pensar en ideas de regalo');
  await page.press('#newStep', 'Enter');
  await page.fill('#newStep', 'Comprar antes del viernes');
  await page.press('#newStep', 'Enter');
  await page.selectOption('#edStatus', 'desarrollo');
  await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.sheet.editor').scrollTop = 0; });
  await shot('03-editar-idea.png');
  await page.click('.sheet.editor [data-act="close"]');
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('chispa-db');
    r.onsuccess = () => {
      const tx = r.result.transaction('ideas').objectStore('ideas').getAll();
      tx.onsuccess = () => res(tx.result.find((i) => i.text.startsWith('Comprar regalo')));
    };
  }));
  check('Edición guardada en IndexedDB (favorita, etiqueta, pasos, estado)',
    persisted.favorite && persisted.tags.includes('cumpleaños') && persisted.steps.length === 2 && persisted.status === 'desarrollo');

  // ---------- búsqueda y filtros ----------
  await page.fill('#search', 'presentacion');
  await page.waitForTimeout(300);
  const found = await page.locator('.idea-card').count();
  check('Búsqueda sin importar tildes ("presentacion")', found === 1, `${found} resultado(s)`);
  await page.fill('#search', 'app');
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.activeElement?.blur(); const y = document.querySelector('.searchbar').getBoundingClientRect().top + scrollY - 70; scrollTo(0, y); });
  await shot('04-busqueda.png');
  await page.fill('#search', '');
  await page.waitForTimeout(250);
  await page.click('[data-favchip]');
  const favs = await page.locator('.idea-card').count();
  check('Filtro de favoritas', favs === 1, `${favs}`);
  await page.click('[data-favchip]');
  await page.click('[data-cat="trabajo"]');
  const work = await page.locator('.idea-card').count();
  check('Filtro por categoría (Trabajo; la última categoría elegida se recuerda)', work === 3, `${work}`);
  await page.click('[data-cat="all"]');
  await page.locator('.idea-card .tag', { hasText: '#examen' }).click();
  const byTag = await page.locator('.idea-card').count();
  check('Filtro por etiqueta (#examen)', byTag === 1, `${byTag}`);
  await page.click('[data-clear="tag"]');
  await page.click('#filterBtn');
  await page.selectOption('#fSort', 'old');
  await page.click('#fApply');
  await page.waitForTimeout(300);
  const oldest = await page.locator('.idea-card h3').nth(0).innerText();
  check('Orden por fecha (más antiguas primero)', oldest.startsWith('Crear una app'), oldest);
  await page.click('#filterBtn');
  await page.click('#fClear');
  await page.waitForTimeout(300);

  // ---------- borrar con confirmación ----------
  await page.locator('.idea-card', { hasText: 'dentista' }).locator('.card-open').click();
  await page.waitForSelector('.sheet.editor');
  await page.waitForTimeout(250);
  await page.click('.sheet.editor [data-act="delete"]');
  await page.waitForSelector('.sheet.dialog');
  await page.waitForTimeout(250);
  await shot('05-confirmar-borrado.png');
  await page.click('.sheet.dialog .btn.danger');
  await page.waitForTimeout(500);
  const afterDel = await page.locator('.idea-card').count();
  check('Borrar con confirmación (va a la papelera)', afterDel === 5, `${afterDel}`);

  // ---------- ajustes ----------
  await page.click('.tabbar [data-view="settings"]');
  await page.waitForTimeout(300);
  await shot('06-ajustes.png');
  await shot('06b-ajustes-completo.png', { fullPage: true });
  const trashBtn = await page.innerText('#openTrash');
  check('Papelera muestra la idea borrada', trashBtn.includes('(1)'), trashBtn);
  const lockNote = await page.innerText('.lock-note');
  check('Aviso "su clave queda guardada solo en este teléfono"', /su clave queda guardada solo en este teléfono/i.test(lockNote));

  // Nueva categoría
  await page.click('#addCat');
  await page.fill('#dlgInput', 'Viajes');
  await page.click('.sheet.dialog .btn.primary');
  await page.waitForTimeout(300);
  check('Crear categoría nueva', (await page.locator('.cat-list li').count()) === 5);

  // ---------- IA con Claude (respuestas simuladas) ----------
  let claudeHeaders = null;
  let claudeBody = null;
  let claudeMode = 'ok';
  await context.route('https://api.anthropic.com/v1/messages', async (route) => {
    claudeHeaders = route.request().headers();
    claudeBody = JSON.parse(route.request().postData());
    const prompt = claudeBody.messages[0].content;
    if (claudeMode === '401') {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    }
    if (claudeMode === 'credits') {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
    }
    let text = 'OK';
    if (prompt.includes('Resuma')) text = 'App para registrar gastos del hogar usando fotos de boletas.';
    if (prompt.includes('sugiera')) text = '{"titulo":"App de gastos con boletas","categoria":"Proyectos","etiquetas":["finanzas","hogar"]}';
    if (prompt.includes('pasos')) text = '{"pasos":["Definir funciones básicas","Diseñar pantallas","Probar con boletas reales"]}';
    if (prompt.includes('Desarrolle')) text = 'La idea puede crecer así:\n- Escanear boletas\n- Ver gastos por mes';
    if (prompt.includes('Agrupe')) text = '{"grupos":[{"nombre":"Trabajo y taller","descripcion":"Ideas del trabajo.","ideas":[1,3]},{"nombre":"Hogar","descripcion":"Ideas personales.","ideas":[2,4,5]}]}';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: claudeBody.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }) });
  });

  await page.check('input[name="aiProv"][value="claude"]');
  await page.waitForTimeout(200);
  await page.fill('#key-claude', 'sk-ant-api03-PRUEBA-DE-MENTIRA');
  await page.click('[data-savekey="claude"]');
  await page.waitForSelector('#status-claude.ok', { timeout: 5000 });
  check('Guardar clave de Claude y probar conexión', true);
  check('Headers correctos hacia Claude',
    claudeHeaders['x-api-key'] === 'sk-ant-api03-PRUEBA-DE-MENTIRA' &&
    claudeHeaders['anthropic-version'] === '2023-06-01' &&
    claudeHeaders['anthropic-dangerous-direct-browser-access'] === 'true');
  check('Modelo por defecto claude-haiku-5-5', claudeBody.model === 'claude-haiku-5-5', claudeBody.model);
  await shot('07-ajustes-ia.png');

  await page.click('.tabbar [data-view="ideas"]');
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
  check('IA: Sugerir título, categoría y etiquetas',
    (await page.inputValue('#edTitle')) === 'App de gastos con boletas' && (await page.inputValue('#edCat')) === 'proyectos' && (await page.innerText('#edTags')).includes('#hogar'));
  await page.click('[data-ai="steps"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Convertir en lista de pasos', (await page.locator('.steps li').count()) === 3);
  await page.click('[data-ai="expand"]');
  await page.waitForSelector('#aiResult [data-r="ok"]');
  await page.evaluate(() => document.querySelector('.ai-block').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => { document.querySelector('.sheet.editor').scrollTop -= 60; });
  await shot('08-ia-expandir.png');
  await page.click('#aiResult [data-r="ok"]');
  check('IA: Expandir idea', (await page.inputValue('#edText')).includes('Escanear boletas'));

  claudeMode = '401';
  await page.click('[data-ai="summary"]');
  await page.waitForSelector('.ai-error');
  check('Error de clave inválida en español', (await page.innerText('.ai-error')).includes('no es válida'));
  claudeMode = 'credits';
  await page.click('[data-ai="summary"]');
  await page.waitForFunction(() => document.querySelector('.ai-error')?.innerText.includes('créditos'));
  check('Error de sin créditos en español', true);
  await shot('09-ia-error.png');
  claudeMode = 'ok';
  await page.click('.sheet.editor [data-act="close"]');
  await page.waitForTimeout(400);

  await page.click('.tabbar [data-view="explore"]');
  await page.waitForTimeout(250);
  await page.click('#organizeBtn');
  await page.waitForSelector('.group');
  check('IA: Organizar mis ideas (agrupa)', (await page.locator('.group').count()) === 2);
  await shot('10-explorar-organizar.png', { fullPage: true });
  await page.click('#orgAll');
  await page.waitForTimeout(300);

  // Gemini: límite gratuito y sin conexión
  await context.route('https://generativelanguage.googleapis.com/**', (route) => route.fulfill({
    status: 429, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })
  }));
  await page.click('.tabbar [data-view="settings"]');
  await page.check('input[name="aiProv"][value="gemini"]');
  await page.waitForTimeout(250);
  await page.fill('#key-gemini', 'AIzaPRUEBA');
  await page.click('[data-savekey="gemini"]');
  await page.waitForSelector('#status-gemini.err', { timeout: 5000 });
  { const st = await page.innerText('#status-gemini'); check('Gemini: mensaje de límite gratuito alcanzado', st.includes('límite gratuito'), st); }

  // ---------- respaldo ----------
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#doExport')]);
  const backupPath = join(site, 'respaldo.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  check('Exportar respaldo JSON', backup.app === 'chispa' && backup.ideas.length === 6 && backup.categories.length === 5, `${backup.ideas.length} ideas`);
  const raw = readFileSync(backupPath, 'utf8');
  check('El respaldo NO incluye claves de IA', !raw.includes('sk-ant-') && !raw.includes('AIzaPRUEBA'));

  // Importar (reemplazar) un respaldo con 1 idea extra
  backup.ideas.push({ id: 'importada-1', title: 'Idea importada', text: 'Esta idea viene del respaldo', createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000 });
  const importPath = join(site, 'importar.json');
  writeFileSync(importPath, JSON.stringify(backup));
  await page.setInputFiles('#importFile', importPath);
  await page.waitForSelector('.sheet.dialog');
  await page.waitForTimeout(250);
  await page.click('.sheet.dialog .btn.primary'); // Combinar
  await page.waitForTimeout(500);
  await page.click('.tabbar [data-view="ideas"]');
  check('Importar respaldo (combinar)', (await page.locator('.idea-card', { hasText: 'Idea importada' }).count()) === 1);

  // Borrar claves
  await page.click('.tabbar [data-view="settings"]');
  await page.click('#delAllKeys');
  await page.click('.sheet.dialog .btn.danger');
  await page.waitForTimeout(300);
  const keysLeft = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('chispa-db');
    r.onsuccess = () => {
      const q = r.result.transaction('settings').objectStore('settings').getAll();
      q.onsuccess = () => res(q.result.filter((x) => /Key$/.test(x.key) && x.value).length);
    };
  }));
  check('Botón para borrar claves', keysLeft === 0);
  await page.click('.tabbar [data-view="ideas"]');
  const aiHidden = await page.evaluate(() => !document.querySelector('.ai-block'));
  check('Sin clave, las funciones de IA quedan ocultas', aiHidden);

  // ---------- modo oscuro ----------
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('Modo oscuro automático', bg === 'rgb(20, 17, 31)', bg);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('11-modo-oscuro.png');
  await page.evaluate(() => { const y = document.querySelector('.searchbar').getBoundingClientRect().top + scrollY - 70; scrollTo(0, y); });
  await shot('11b-modo-oscuro-lista.png');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('.tabbar [data-view="settings"]');
  await page.waitForTimeout(200);
  await shot('12-ajustes-oscuro.png');
  await page.click('.tabbar [data-view="ideas"]');

  // ---------- sin scroll horizontal ----------
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('Sin scroll horizontal', !overflowX);

  // ---------- sin conexión ----------
  await context.setOffline(true);
  await page.reload();
  await ready();
  const offlineCards = await page.locator('.idea-card').count();
  const pill = await page.isVisible('#offlinePill');
  check('Abre sin conexión con las ideas guardadas', offlineCards === 6 && pill, `${offlineCards} ideas, aviso=${pill}`);
  await shot('13-sin-conexion.png');
  const cold = await context.newPage();
  await cold.goto(BASE);
  await cold.waitForFunction(() => document.documentElement.classList.contains('ready'));
  check('Pestaña nueva sin conexión también abre', (await cold.locator('.idea-card').count()) === 6);
  await cold.close();
  await context.setOffline(false);

  // ---------- navegador sin reconocimiento de voz ----------
  const ctx2 = await browser.newContext({ viewport: iPhone.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await ctx2.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE);
  await p2.waitForFunction(() => document.documentElement.classList.contains('ready'));
  check('Sin Web Speech: oculta el botón y muestra aviso amable',
    !(await p2.isVisible('#recBtn')) && (await p2.innerText('#voiceUnavailable')).includes('micrófono del teclado'));
  await ctx2.close();

  const relevantErrors = errors.filter((e) => !/Failed to load resource/.test(e));
  check('Sin errores de JavaScript en la consola', relevantErrors.length === 0, relevantErrors.join(' | '));
} catch (err) {
  check('Prueba completa sin excepciones', false, err.stack || String(err));
  await shot('error.png').catch(() => {});
} finally {
  await browser.close();
  server.kill();
  rmSync(site, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificaciones correctas.`);
process.exit(failed.length ? 1 : 0);
