// IdeaShel Vale · captura y organización de ideas por voz
import { db, loadSettings, saveSetting } from './db.js';
import * as AI from './ai.js';
import { Dictation, voiceSupported, voiceErrorMessage, VOICE_LANGS } from './voice.js';
import { AudioRecorder, audioSupported, micErrorMessage, fmtDuration, toWavChunks, blobToBase64, base64ToBlob } from './recorder.js';
import {
  $, $$, esc, uid, debounce, normalize, normTag, extractHashtags, autoTitle,
  fmtFull, fmtShortDate, fmtRelative, daysBetween, stamp
} from './util.js';

const APP_VERSION = '1.1.0';
const TRASH_DAYS = 30;

const DEFAULT_CATEGORIES = [
  { id: 'trabajo', name: 'Trabajo', color: '#5B3FD9', order: 0 },
  { id: 'personal', name: 'Personal', color: '#FF7A59', order: 1 },
  { id: 'proyectos', name: 'Proyectos', color: '#1F9D6B', order: 2 },
  { id: 'estudios', name: 'Estudios', color: '#2F80ED', order: 3 }
];
const CAT_COLORS = ['#5B3FD9', '#FF7A59', '#1F9D6B', '#2F80ED', '#E0A100', '#D93F7A', '#0FA3B1', '#8A5A44'];
const STATUS = { nueva: 'Nueva', desarrollo: 'En desarrollo', hecha: 'Hecha' };
const SORTS = {
  new: 'Más recientes primero',
  old: 'Más antiguas primero',
  edited: 'Editadas recientemente',
  az: 'Título (A–Z)'
};

const DEFAULT_SETTINGS = {
  aiProvider: 'none',
  geminiKey: '',
  claudeKey: '',
  geminiModel: 'gemini-flash-latest',
  claudeModel: 'claude-haiku-5-5',
  theme: 'auto',
  voiceLang: 'es-CL',
  backupEveryDays: 7,
  lastBackupAt: 0,
  reminderSnoozedUntil: 0,
  sort: 'new',
  firstRunAt: 0,
  initialized: false,
  userName: '',
  viewMode: 'grid',
  aiAbout: '',
  aiInstructions: '',
  autoOrganize: true,
  liveTranscript: true,
  backupAudio: false
};

const state = {
  ideas: [],
  categories: [],
  settings: { ...DEFAULT_SETTINGS },
  filters: { q: '', category: 'all', tag: '', fav: false, status: '', archived: false, audio: false, scheduled: false },
  view: 'ideas',
  storageOk: true,
  persisted: null,
  randomId: null,
  organizeResult: null,
  processing: new Map(),
  globalChat: [],
  recording: false
};

// ---------------------------------------------------------------- datos

const activeIdeas = () => state.ideas.filter((i) => !i.deletedAt);
const trashIdeas = () => state.ideas.filter((i) => i.deletedAt);
const catById = (id) => state.categories.find((c) => c.id === id);
const sortedCats = () => [...state.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'es'));

function allTags() {
  const counts = new Map();
  for (const idea of activeIdeas()) for (const t of idea.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(([t]) => t);
}

function aiConfig() {
  const s = state.settings;
  const extra = { about: s.aiAbout || '', instructions: s.aiInstructions || '' };
  if (s.aiProvider === 'gemini' && s.geminiKey) return { provider: 'gemini', key: s.geminiKey, model: s.geminiModel, ...extra };
  if (s.aiProvider === 'claude' && s.claudeKey) return { provider: 'claude', key: s.claudeKey, model: s.claudeModel, ...extra };
  return null;
}

async function setSetting(key, value) {
  state.settings[key] = value;
  try {
    await saveSetting(key, value);
  } catch (err) {
    storageFailed(err);
  }
}

function storageFailed(err) {
  console.error(err);
  toast(err && err.message ? err.message : 'No se pudo guardar en el teléfono.', { error: true, duration: 6000 });
}

async function persistIdea(idea, { touch = true } = {}) {
  if (touch) idea.updatedAt = Date.now();
  const idx = state.ideas.findIndex((i) => i.id === idea.id);
  if (idx === -1) state.ideas.push(idea); else state.ideas[idx] = idea;
  try {
    await db.put('ideas', idea);
    return true;
  } catch (err) {
    storageFailed(err);
    return false;
  }
}

async function persistCategory(cat) {
  const idx = state.categories.findIndex((c) => c.id === cat.id);
  if (idx === -1) state.categories.push(cat); else state.categories[idx] = cat;
  try { await db.put('categories', cat); } catch (err) { storageFailed(err); }
}

// Audios: se guardan como ArrayBuffer (compatible con todas las versiones de Safari)
async function saveAudio(id, blob, mime) {
  const data = await blob.arrayBuffer();
  await db.put('audio', { id, mime, data });
}

async function getAudioBlob(id) {
  const row = await db.get('audio', id);
  if (!row) return null;
  return row.data instanceof Blob ? row.data : new Blob([row.data], { type: row.mime || 'audio/mp4' });
}

async function deleteAudios(ids) {
  if (!ids.length) return;
  try { await db.bulkDelete('audio', ids); } catch (err) { console.warn(err); }
}

/** Mantiene el título automático al día (las grabaciones sin texto conservan "Grabación …"). */
function refreshAutoTitle(idea) {
  if (!idea.titleAuto) return;
  if ((idea.text || '').trim()) idea.title = autoTitle(idea.text);
  else if (idea.audio) idea.title = `Grabación de ${fmtDuration(idea.audio.duration)}`;
}

function newIdea(text, category) {
  const now = Date.now();
  return {
    id: uid(),
    title: autoTitle(text),
    titleAuto: true,
    text,
    category: category || null,
    tags: extractHashtags(text),
    favorite: false,
    pinned: false,
    status: 'nueva',
    archived: false,
    deletedAt: null,
    steps: [],
    summary: '',
    note: '',
    chat: [],
    remindAt: null,
    audio: null,
    createdAt: now,
    updatedAt: now
  };
}

async function loadData() {
  const [ideas, cats, settings] = await Promise.all([db.getAll('ideas'), db.getAll('categories'), loadSettings()]);
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  state.ideas = ideas || [];
  state.categories = cats || [];
  if (!state.settings.initialized) {
    if (!state.categories.length) {
      state.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      await db.bulkPut('categories', state.categories);
    }
    await setSetting('initialized', true);
    await setSetting('firstRunAt', Date.now());
  }
}

async function purgeTrash() {
  const limit = Date.now() - TRASH_DAYS * 86400000;
  const old = state.ideas.filter((i) => i.deletedAt && i.deletedAt < limit);
  if (!old.length) return;
  state.ideas = state.ideas.filter((i) => !old.includes(i));
  try { await db.bulkDelete('ideas', old.map((i) => i.id)); } catch (err) { console.warn(err); }
  await deleteAudios(old.filter((i) => i.audio).map((i) => i.id));
}

// ---------------------------------------------------------------- UI helpers

let toastTimer;
function toast(message, { action, onAction, error = false, duration = 3200 } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.classList.toggle('error', error);
  el.classList.add('show');
  if (action) {
    el.querySelector('button').onclick = () => { el.classList.remove('show'); onAction && onAction(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(duration, 5000) : duration);
}

const sheetStack = [];

function openSheet({ html, full = false, side = false, modal = false, label = '', className = '', onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = `sheet-backdrop${side ? ' side' : ''}`;
  const sheet = document.createElement('div');
  sheet.className = `sheet ${full ? 'full' : ''} ${side ? 'drawer' : ''} ${className}`.replace(/\s+/g, ' ').trim();
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (label) sheet.setAttribute('aria-label', label);
  sheet.innerHTML = html;
  backdrop.appendChild(sheet);
  $('#sheetRoot').appendChild(backdrop);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => backdrop.classList.add('open'));
  let closed = false;
  const api = {
    el: sheet,
    modal,
    close() {
      if (closed) return;
      closed = true;
      backdrop.classList.remove('open');
      const i = sheetStack.indexOf(api);
      if (i !== -1) sheetStack.splice(i, 1);
      setTimeout(() => {
        backdrop.remove();
        if (!$('#sheetRoot').children.length) document.body.classList.remove('no-scroll');
      }, 200);
      onClose && onClose();
    }
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !modal) api.close(); });
  sheetStack.push(api);
  return api;
}

document.addEventListener('keydown', (e) => {
  const top = sheetStack[sheetStack.length - 1];
  if (e.key === 'Escape' && top && !top.modal) top.close();
});

/** Diálogo genérico. buttons: [{label, value, style}] → Promise(value | null). */
function dialog({ title, message = '', buttons = [{ label: 'Aceptar', value: true, style: 'primary' }], input = null }) {
  return new Promise((resolve) => {
    let result = null;
    const inputHtml = input
      ? `<input class="input" id="dlgInput" type="text" maxlength="${input.maxlength || 40}" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">`
      : '';
    const s = openSheet({
      className: 'dialog',
      label: title,
      html: `
        <h2 class="dlg-title">${esc(title)}</h2>
        ${message ? `<p class="dlg-msg">${esc(message)}</p>` : ''}
        ${inputHtml}
        ${input && input.extraHtml ? input.extraHtml : ''}
        <div class="dlg-actions">
          ${buttons.map((b, i) => `<button type="button" class="btn ${b.style || 'ghost'}" data-i="${i}">${esc(b.label)}</button>`).join('')}
        </div>`,
      onClose: () => resolve(result)
    });
    const inp = s.el.querySelector('#dlgInput');
    if (inp) setTimeout(() => inp.focus(), 50);
    s.el.querySelectorAll('[data-i]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = buttons[Number(btn.dataset.i)];
        result = b.value;
        if (input && b.value) {
          result = { value: inp.value.trim(), button: b.value, el: s.el };
        }
        s.close();
      });
    });
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); s.el.querySelector('.btn.primary')?.click(); }
      });
    }
  });
}

const confirmDialog = (title, message, confirmText = 'Confirmar', danger = false) =>
  dialog({
    title,
    message,
    buttons: [
      { label: 'Cancelar', value: false, style: 'ghost' },
      { label: confirmText, value: true, style: danger ? 'danger' : 'primary' }
    ]
  }).then(Boolean);

const alertDialog = (title, message) => dialog({ title, message, buttons: [{ label: 'Entendido', value: true, style: 'primary' }] });

function showBanner(html, kind = 'info') {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

function categoryOptions(selected, { includeNone = true } = {}) {
  return (includeNone ? `<option value="">Sin categoría</option>` : '') +
    sortedCats().map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const metas = $$('meta[name="theme-color"]');
  const light = '#F6F4FF';
  const dark = '#14111F';
  if (metas[0]) metas[0].content = t === 'dark' ? dark : light;
  if (metas[1]) metas[1].content = t === 'light' ? light : dark;
}

// ---------------------------------------------------------------- navegación

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'ideas') renderIdeas();
  if (view === 'explore') renderExplore();
  if (view === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

function goIdeas(patch = {}) {
  clearFilters();
  Object.assign(state.filters, patch);
  state.filters.q = '';
  $('#search').value = '';
  setView('ideas');
}

/** Menú lateral con secciones, categorías y etiquetas. */
function openDrawer() {
  const ideas = activeIdeas();
  const visible = ideas.filter((i) => !i.archived);
  const count = (fn) => visible.filter(fn).length;
  const f = state.filters;
  const isAll = state.view === 'ideas' && f.category === 'all' && !f.fav && !f.audio && !f.scheduled && !f.archived && !f.tag;
  const tagCounts = new Map();
  visible.forEach((i) => (i.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
  const ai = aiConfig();
  const item = (attrs, icon, label, n, on = false) =>
    `<button type="button" class="drawer-item ${on ? 'on' : ''}" ${attrs}><span class="di-icon" aria-hidden="true">${icon}</span><span class="di-label">${label}</span>${n !== undefined ? `<span class="di-count">${n}</span>` : ''}</button>`;

  const s = openSheet({
    side: true,
    label: 'Menú',
    html: `
      <div class="drawer-head">
        <div class="brand"><img src="icons/favicon.svg" alt="" width="30" height="30"><span class="brand-name">IdeaShel Vale</span></div>
        <button type="button" class="icon-btn ghost-icon" data-close aria-label="Cerrar menú">✕</button>
      </div>
      <div class="drawer-actions">
        <button type="button" class="btn primary" data-go="record">🎙️ Nueva grabación</button>
        ${ai ? '<button type="button" class="btn soft" data-go="askall">💬 Preguntar a mis ideas</button>' : ''}
      </div>
      <nav class="drawer-sec">
        ${item('data-go="all"', '◎', 'Todas las ideas', visible.length, isAll)}
        ${item('data-go="fav"', '★', 'Favoritas', count((i) => i.favorite), state.view === 'ideas' && f.fav)}
        ${item('data-go="audio"', '🎙', 'Grabaciones', count((i) => i.audio), state.view === 'ideas' && f.audio)}
        ${item('data-go="scheduled"', '⏰', 'Programadas', count((i) => i.remindAt), state.view === 'ideas' && f.scheduled)}
        ${item('data-go="explore"', '✦', 'Explorar', undefined, state.view === 'explore')}
      </nav>
      <h3 class="drawer-title">Categorías</h3>
      <nav class="drawer-sec">
        ${sortedCats().map((c) => item(`data-go="cat" data-id="${esc(c.id)}" style="--c:${esc(c.color)}"`, '<span class="cat-dot big"></span>', esc(c.name), count((i) => i.category === c.id), state.view === 'ideas' && f.category === c.id)).join('')}
        ${item('data-go="cat" data-id="none"', '▢', 'Sin categoría', count((i) => !i.category || !catById(i.category)), state.view === 'ideas' && f.category === 'none')}
        ${item('data-go="newcat"', '＋', 'Nueva categoría')}
      </nav>
      <nav class="drawer-sec">
        ${item('data-go="archived"', '🗄', 'Archivadas', ideas.filter((i) => i.archived).length, state.view === 'ideas' && f.archived)}
        ${item('data-go="trash"', '🗑', 'Borradas recientemente', trashIdeas().length)}
      </nav>
      ${tags.length ? `
      <h3 class="drawer-title">Etiquetas <button type="button" class="link-btn small" data-go="edittags">Editar</button></h3>
      <nav class="drawer-sec">
        ${tags.slice(0, 40).map(([t, n]) => item(`data-go="tag" data-id="${esc(t)}"`, '#', esc(t), n, state.view === 'ideas' && f.tag === t)).join('')}
      </nav>` : ''}
      <nav class="drawer-sec">
        ${item('data-go="personalize"', '✨', 'Personalizar la IA')}
        ${item('data-go="settings"', '⚙', 'Ajustes', undefined, state.view === 'settings')}
      </nav>`
  });
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  const close = () => { s.close(); $('#menuBtn').setAttribute('aria-expanded', 'false'); };
  s.el.querySelector('[data-close]').onclick = close;
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const go = b.dataset.go;
    close();
    switch (go) {
      case 'record': setTimeout(openRecorder, 220); break;
      case 'askall': setTimeout(openAskAll, 220); break;
      case 'all': goIdeas(); break;
      case 'fav': goIdeas({ fav: true }); break;
      case 'audio': goIdeas({ audio: true }); break;
      case 'scheduled': goIdeas({ scheduled: true }); break;
      case 'archived': goIdeas({ archived: true }); break;
      case 'cat': goIdeas({ category: b.dataset.id }); break;
      case 'tag': goIdeas({ tag: b.dataset.id }); break;
      case 'newcat': setTimeout(() => editCategory(null), 220); break;
      case 'trash': setTimeout(openTrash, 220); break;
      case 'edittags': setTimeout(openTagManager, 220); break;
      case 'explore': setView('explore'); break;
      case 'settings': setView('settings'); break;
      case 'personalize':
        setView('settings');
        setTimeout(() => $('#personalizeCard')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
        break;
      default: break;
    }
  });
}

// ---------------------------------------------------------------- captura

function setupCapture() {
  const text = $('#newText');
  const composer = $('#composer');
  const recBtn = $('#recBtn');
  if (!audioSupported && !voiceSupported) {
    recBtn.hidden = true;
    const n = $('#voiceUnavailable');
    n.hidden = false;
    n.innerHTML = '🎙️ La grabación no está disponible en este navegador. ' +
      'No se preocupe: toque el cuadro de abajo y use el <strong>micrófono del teclado del iPhone</strong> para dictar su idea.';
  }
  const expand = () => composer.classList.toggle('expanded', document.activeElement === text || !!text.value.trim());
  text.addEventListener('focus', expand);
  text.addEventListener('input', () => { autoGrow(text, 140); expand(); });
  text.addEventListener('blur', () => setTimeout(expand, 150));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNew();
  });
  $('#saveNewBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('#saveNewBtn').addEventListener('click', saveNew);
  recBtn.addEventListener('click', openRecorder);
  $('#newCategory').addEventListener('change', (e) => { state.lastCategory = e.target.value; });
}

function autoGrow(el, max = 320) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
}

function defaultNewCategory({ recording = false } = {}) {
  const f = state.filters.category;
  // Las grabaciones toman la carpeta abierta; si no hay, la IA elige la categoría al organizar
  if (recording) return f !== 'all' && f !== 'none' ? f : null;
  const sel = $('#newCategory');
  return sel ? sel.value || null : null;
}

async function saveNew() {
  const textEl = $('#newText');
  const text = textEl.value.trim();
  if (!text) {
    toast('Primero grabe o escriba su idea.');
    textEl.focus();
    return;
  }
  const idea = newIdea(text, defaultNewCategory());
  const ok = await persistIdea(idea, { touch: false });
  if (!ok) return;
  textEl.value = '';
  autoGrow(textEl, 140);
  textEl.blur();
  $('#composer').classList.remove('expanded');
  renderIdeas();
  toast('Idea guardada ✨', { action: 'Abrir', onAction: () => openEditor(idea.id) });
}

// ---------------------------------------------------------------- grabadora

/**
 * Pantalla de grabación: graba el audio (se guarda en el teléfono) y, si el navegador lo permite,
 * muestra la transcripción en vivo. Sin MediaRecorder, funciona como dictado (solo texto).
 */
async function openRecorder() {
  if (state.recording) return;
  const mode = audioSupported ? 'audio' : (voiceSupported ? 'dictado' : null);
  if (!mode) {
    alertDialog('Grabación no disponible', 'Este navegador no permite grabar. Use el micrófono del teclado del iPhone para dictar en el cuadro de texto.');
    return;
  }
  const wantLive = voiceSupported && (mode === 'dictado' || state.settings.liveTranscript);
  const BARS = 28;
  state.recording = true;
  const s = openSheet({
    modal: true,
    className: 'recorder',
    label: 'Grabación',
    html: `
      <div class="rec-top">
        <span class="rec-dot" aria-hidden="true"></span>
        <span id="rStatus">${mode === 'audio' ? 'Preparando micrófono…' : 'Escuchando…'}</span>
      </div>
      <div class="rec-time" id="rTime">0:00</div>
      <div class="rec-bars" id="rBars" aria-hidden="true">${'<i></i>'.repeat(BARS)}</div>
      <div class="rec-live" id="rLive" aria-live="polite">${wantLive ? '<span class="muted">La transcripción aparecerá aquí mientras habla…</span>' : '<span class="muted">Hable con calma. El audio queda guardado en su teléfono.</span>'}</div>
      <p class="rec-note" id="rNote">${mode === 'audio' ? 'Mantenga IdeaShel Vale abierta mientras graba: si bloquea el teléfono, la grabación puede detenerse.' : ''}</p>
      <div class="rec-controls">
        <button type="button" class="btn ghost" id="rCancel">Descartar</button>
        <button type="button" class="round-btn" id="rPause" aria-label="Pausar">
          <svg viewBox="0 0 24 24" class="ic-pause" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.5"/><rect x="13.5" y="5" width="4" height="14" rx="1.5"/></svg>
          <svg viewBox="0 0 24 24" class="ic-play" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>
        </button>
        <button type="button" class="btn primary" id="rStop">Guardar</button>
      </div>`
  });
  const el = s.el;
  const bars = [...el.querySelectorAll('#rBars i')];
  const levels = [];
  let peaks = [];
  let lastPeakAt = 0;
  const recorder = new AudioRecorder();
  const dict = new Dictation();
  let liveFinal = '';
  let sessionFin = '';
  let liveOn = wantLive;
  let paused = false;
  let finished = false;
  let wakeLock = null;
  let dictStart = 0;
  let clock;

  const liveText = () => [liveFinal, sessionFin].filter(Boolean).join(' ').trim();
  const showLive = (interim = '') => {
    const t = [liveText(), interim].filter(Boolean).join(' ');
    if (t) {
      el.querySelector('#rLive').innerHTML = `${esc(liveText())} <span class="interim">${esc(interim)}</span>`;
      el.querySelector('#rLive').scrollTop = 1e6;
    }
  };
  const onLevel = (lv) => {
    levels.push(lv);
    if (levels.length > BARS) levels.shift();
    bars.forEach((b, i) => { b.style.transform = `scaleY(${Math.max(0.08, levels[i] ?? 0)})`; });
    const now = performance.now();
    if (now - lastPeakAt > 250) { peaks.push(Math.round(lv * 100) / 100); lastPeakAt = now; }
  };

  const startLive = () => {
    if (!liveOn || paused || finished) return;
    dictStart = Date.now();
    dict.start({
      lang: state.settings.voiceLang || 'es-CL',
      onText: (fin, interim) => { sessionFin = fin; showLive(interim); },
      onEnd: () => {
        liveFinal = liveText();
        sessionFin = '';
        // El reconocimiento se corta solo tras silencios: se reanuda mientras se sigue grabando
        if (liveOn && !paused && !finished && Date.now() - dictStart > 800) setTimeout(startLive, 200);
      },
      onError: (code) => {
        if (code === 'no-speech') return;
        liveOn = false;
        if (mode === 'dictado') {
          finished = true;
          stopAll();
          s.close();
          alertDialog('Grabación por voz', voiceErrorMessage(code));
          return;
        }
        el.querySelector('#rLive').innerHTML = '<span class="muted">La transcripción en vivo no está disponible aquí, pero el audio se sigue grabando. Podrá transcribirlo con IA al terminar.</span>';
      }
    });
  };

  const tickClock = () => {
    const sec = mode === 'audio' ? recorder.duration : (Date.now() - startedAt) / 1000;
    el.querySelector('#rTime').textContent = fmtDuration(sec);
  };
  const startedAt = Date.now();

  async function stopAll() {
    clearInterval(clock);
    try { dict.stop(); } catch (e) { /* nada */ }
    try { wakeLock && (await wakeLock.release()); } catch (e) { /* nada */ }
    state.recording = false;
  }

  async function finish(interrupted = false) {
    if (finished) return;
    finished = true;
    el.querySelector('#rStatus').textContent = 'Guardando…';
    el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const result = mode === 'audio' ? await recorder.stop() : null;
    await stopAll();
    if (mode === 'dictado') await new Promise((r) => setTimeout(r, 450));
    const text = liveText();
    s.close();
    if (mode === 'dictado' && !text) { toast('No se escuchó nada. Intente de nuevo.'); return; }
    if (mode === 'audio' && (!result || result.blob.size < 500 || result.duration < 0.8)) {
      toast('La grabación quedó vacía. Intente de nuevo.');
      return;
    }
    const idea = newIdea(text, defaultNewCategory({ recording: true }));
    if (result) {
      const step = Math.max(1, Math.ceil(peaks.length / 60));
      const compact = [];
      for (let i = 0; i < peaks.length; i += step) compact.push(Math.max(...peaks.slice(i, i + step)));
      idea.audio = { mime: result.mime, duration: Math.round(result.duration * 10) / 10, size: result.blob.size, peaks: compact };
      idea.transcript = text;
      refreshAutoTitle(idea);
      try {
        await saveAudio(idea.id, result.blob, result.mime);
      } catch (err) {
        storageFailed(err);
        return;
      }
    }
    if (!(await persistIdea(idea, { touch: false }))) return;
    renderIdeas();
    if (interrupted) toast('La grabación se detuvo (el teléfono pausó la app). Se guardó lo grabado.', { duration: 6000 });
    openEditor(idea.id);
    const cfg = aiConfig();
    if (cfg && state.settings.autoOrganize) {
      if (idea.audio && AI.canHearAudio(cfg)) processIdea(idea.id, { transcribe: true });
      else if ((idea.text || '').trim()) processIdea(idea.id);
    }
  }

  el.querySelector('#rStop').onclick = () => finish(false);
  el.querySelector('#rCancel').onclick = async () => {
    const secs = mode === 'audio' ? recorder.duration : (Date.now() - startedAt) / 1000;
    if (secs > 5 && !(await confirmDialog('¿Descartar la grabación?', 'Lo grabado no se guardará.', 'Descartar', true))) return;
    finished = true;
    if (mode === 'audio') recorder.cancel();
    await stopAll();
    s.close();
  };
  el.querySelector('#rPause').onclick = () => {
    paused = !paused;
    const btn = el.querySelector('#rPause');
    btn.classList.toggle('paused', paused);
    btn.setAttribute('aria-label', paused ? 'Continuar' : 'Pausar');
    el.querySelector('#rStatus').textContent = paused ? 'En pausa' : 'Grabando';
    el.classList.toggle('is-paused', paused);
    if (paused) {
      if (mode === 'audio') recorder.pause();
      try { dict.stop(); } catch (e) { /* nada */ }
    } else {
      if (mode === 'audio') recorder.resume();
      startLive();
    }
  };

  // Arranque
  try {
    if (mode === 'audio') {
      await recorder.start({ onLevel, onInterrupted: () => finish(true) });
    }
  } catch (err) {
    finished = true;
    await stopAll();
    s.close();
    alertDialog('No se pudo grabar', micErrorMessage(err));
    return;
  }
  if (finished) return;
  el.querySelector('#rStatus').textContent = 'Grabando';
  el.classList.add('is-live');
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  clock = setInterval(tickClock, 250);
  if (mode === 'dictado') {
    // Animación simple sin medidor real
    const fake = setInterval(() => { if (finished) clearInterval(fake); else onLevel(paused ? 0 : 0.15 + Math.random() * 0.35); }, 120);
  }
  startLive();
}

// ---------------------------------------------------------------- lista

function setupSearch() {
  const input = $('#search');
  const run = debounce(() => { state.filters.q = input.value; renderIdeas(); }, 150);
  input.addEventListener('input', run);
  input.addEventListener('search', run);
  $('#filterBtn').addEventListener('click', openFilters);

  $('#catChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (chip) {
      state.filters.category = chip.dataset.cat;
      renderIdeas();
      return;
    }
    if (e.target.closest('[data-favchip]')) {
      state.filters.fav = !state.filters.fav;
      renderIdeas();
    }
  });

  $('#activeFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clear]');
    if (!b) return;
    const k = b.dataset.clear;
    if (k === 'tag') state.filters.tag = '';
    if (k === 'status') state.filters.status = '';
    if (k === 'archived') state.filters.archived = false;
    if (k === 'audio') state.filters.audio = false;
    if (k === 'scheduled') state.filters.scheduled = false;
    if (k === 'all') clearFilters();
    renderIdeas();
  });

  $('#ideaList').addEventListener('click', async (e) => {
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      state.filters.tag = tagBtn.dataset.tag;
      renderIdeas();
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      const idea = state.ideas.find((i) => i.id === fav.dataset.fav);
      if (idea) {
        idea.favorite = !idea.favorite;
        await persistIdea(idea, { touch: false });
        renderIdeas();
      }
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openEditor(open.dataset.open);
  });
}

function clearFilters() {
  state.filters = { q: state.filters.q, category: 'all', tag: '', fav: false, status: '', archived: false, audio: false, scheduled: false };
}

function filteredIdeas() {
  const f = state.filters;
  const q = normalize(f.q.trim());
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  let list = activeIdeas().filter((i) => (f.archived ? i.archived : !i.archived));
  if (f.category === 'none') list = list.filter((i) => !i.category || !catById(i.category));
  else if (f.category !== 'all') list = list.filter((i) => i.category === f.category);
  if (f.fav) list = list.filter((i) => i.favorite);
  if (f.tag) list = list.filter((i) => (i.tags || []).includes(f.tag));
  if (f.status) list = list.filter((i) => (i.status || 'nueva') === f.status);
  if (f.audio) list = list.filter((i) => i.audio);
  if (f.scheduled) list = list.filter((i) => i.remindAt);
  if (terms.length) {
    list = list.filter((i) => {
      const hay = normalize([i.title, i.text, i.summary, i.note, (i.tags || []).join(' '), catById(i.category)?.name, (i.steps || []).map((s) => s.text).join(' ')].join(' '));
      return terms.every((t) => hay.includes(t.replace(/^#/, '')));
    });
  }
  const sort = state.settings.sort || 'new';
  const cmp = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    edited: (a, b) => b.updatedAt - a.updatedAt,
    az: (a, b) => (a.title || '').localeCompare(b.title || '', 'es')
  }[sort] || ((a, b) => b.createdAt - a.createdAt);
  if (f.scheduled) return list.sort((a, b) => a.remindAt - b.remindAt);
  return list.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || cmp(a, b));
}

function highlight(text, q) {
  const safe = esc(text);
  const terms = normalize(q).trim().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return safe;
  // Resaltado simple (insensible a mayúsculas) en una sola pasada, sin tocar entidades HTML
  const alt = terms.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(&[a-z#0-9]+;)|(${alt})`, 'gi');
  return safe.replace(re, (m, entity, hit) => (entity ? entity : `<mark>${hit}</mark>`));
}

function miniWave(peaks, n = 22) {
  const src = peaks && peaks.length ? peaks : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = src.length ? src[Math.floor((i / n) * src.length)] : 0.3 + 0.25 * Math.sin(i * 1.7);
    out.push(`<i style="height:${Math.round(18 + Math.min(1, v * 1.4) * 82)}%"></i>`);
  }
  return out.join('');
}

function reminderLabel(ts) {
  if (!ts) return '';
  const overdue = ts < Date.now();
  return `<span class="mini-pill ${overdue ? 'due' : 'remind'}">⏰ ${esc(fmtRelative(ts))}</span>`;
}

function ideaCard(idea) {
  const cat = catById(idea.category);
  const q = state.filters.q;
  const proc = state.processing.get(idea.id);
  let snippetSrc = idea.summary || idea.text || '';
  if (!snippetSrc && idea.audio) snippetSrc = aiConfig() ? 'Audio sin transcribir. Ábralo para transcribirlo y organizarlo con IA.' : 'Grabación de audio. Ábrala para escucharla.';
  const max = state.settings.viewMode === 'grid' ? 150 : 180;
  const snippet = snippetSrc.length > max ? snippetSrc.slice(0, max - 3) + '…' : snippetSrc;
  const steps = idea.steps || [];
  const done = steps.filter((s) => s.done).length;
  const status = idea.status || 'nueva';
  return `
  <article class="idea-card ${idea.pinned ? 'pinned' : ''} ${idea.audio ? 'has-audio' : ''}" style="--c:${esc(cat ? cat.color : '#9A93B5')}">
    <button type="button" class="card-open" data-open="${esc(idea.id)}" aria-label="Abrir idea: ${esc(idea.title)}"></button>
    <div class="card-top">
      <span class="cat-badge"><span class="cat-dot"></span>${esc(cat ? cat.name : 'Sin categoría')}</span>
      <time datetime="${new Date(idea.createdAt).toISOString()}">${esc(fmtRelative(idea.createdAt))}</time>
    </div>
    ${idea.audio ? `<div class="card-audio"><span class="wave-mini" aria-hidden="true">${miniWave(idea.audio.peaks)}</span><span class="dur">🎙 ${esc(fmtDuration(idea.audio.duration))}</span></div>` : ''}
    <h3>${highlight(idea.title || 'Idea sin título', q)}</h3>
    ${proc ? `<p class="processing-line"><span class="spinner"></span>${esc(proc)}</p>` : ''}
    ${snippet ? `<p class="snippet">${highlight(snippet, q)}</p>` : ''}
    <div class="card-foot">
      ${idea.pinned ? '<span class="mini-pill">📌</span>' : ''}
      ${status !== 'nueva' ? `<span class="mini-pill status-${status}">${esc(STATUS[status])}</span>` : ''}
      ${reminderLabel(idea.remindAt)}
      ${idea.note ? '<span class="mini-pill ai">✨ Organizada</span>' : ''}
      ${steps.length ? `<span class="mini-pill">☑ ${done}/${steps.length}</span>` : ''}
      ${(idea.tags || []).slice(0, 4).map((t) => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
    </div>
    <button type="button" class="star ${idea.favorite ? 'on' : ''}" data-fav="${esc(idea.id)}" aria-pressed="${idea.favorite}" aria-label="${idea.favorite ? 'Quitar de favoritas' : 'Marcar como favorita'}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.5l-5.1 2.7 1-5.6-4.1-4 5.7-.8Z"/></svg>
    </button>
  </article>`;
}

function renderChips() {
  const f = state.filters;
  const ideas = activeIdeas().filter((i) => !i.archived);
  const hasNone = ideas.some((i) => !i.category || !catById(i.category));
  const chips = [
    `<button type="button" class="chip ${f.category === 'all' ? 'on' : ''}" data-cat="all">Todas</button>`,
    `<button type="button" class="chip fav ${f.fav ? 'on' : ''}" data-favchip="1" aria-pressed="${f.fav}">★ Favoritas</button>`,
    ...sortedCats().map((c) => `<button type="button" class="chip ${f.category === c.id ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}"><span class="cat-dot"></span>${esc(c.name)}</button>`)
  ];
  if (hasNone || f.category === 'none') chips.push(`<button type="button" class="chip ${f.category === 'none' ? 'on' : ''}" data-cat="none">Sin categoría</button>`);
  $('#catChips').innerHTML = chips.join('');
}

function greetingText() {
  const h = new Date().getHours();
  const base = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
  const name = (state.settings.userName || '').trim();
  return name ? `${base}, ${name}` : base;
}

function filterTitle() {
  const f = state.filters;
  if (f.archived) return 'Archivadas';
  if (f.scheduled) return 'Programadas';
  if (f.audio) return 'Grabaciones';
  if (f.fav && f.category === 'all') return 'Favoritas';
  if (f.tag && f.category === 'all') return '#' + f.tag;
  if (f.category === 'none') return 'Sin categoría';
  if (f.category !== 'all') return catById(f.category)?.name || 'Ideas';
  return '';
}

function renderIdeas() {
  renderChips();
  const sel = $('#newCategory');
  const fromFilter = state.filters.category !== 'all' && state.filters.category !== 'none' ? state.filters.category : '';
  // Solo la carpeta abierta o la que el usuario eligió a mano; nunca una de paso
  const current = fromFilter || state.lastCategory || '';
  sel.innerHTML = categoryOptions(current);

  const list = filteredIdeas();
  const f = state.filters;
  const grid = state.settings.viewMode !== 'list';
  const ft = filterTitle();
  $('#greeting').textContent = ft || greetingText();
  const all = activeIdeas().filter((i) => !i.archived);
  const recs = all.filter((i) => i.audio).length;
  $('#homeSub').textContent = ft
    ? `${list.length} ${list.length === 1 ? 'idea' : 'ideas'}`
    : all.length ? `${all.length} ${all.length === 1 ? 'idea' : 'ideas'}${recs ? ` · ${recs} ${recs === 1 ? 'grabación' : 'grabaciones'}` : ''}` : '¿Qué se le ocurrió hoy?';

  const active = [];
  if (f.tag) active.push(`<button type="button" class="chip small on" data-clear="tag">#${esc(f.tag)} ✕</button>`);
  if (f.status) active.push(`<button type="button" class="chip small on" data-clear="status">${esc(STATUS[f.status])} ✕</button>`);
  if (f.archived) active.push(`<button type="button" class="chip small on" data-clear="archived">Archivadas ✕</button>`);
  if (f.audio) active.push(`<button type="button" class="chip small on" data-clear="audio">🎙 Grabaciones ✕</button>`);
  if (f.scheduled) active.push(`<button type="button" class="chip small on" data-clear="scheduled">⏰ Programadas ✕</button>`);
  const total = all.length;
  $('#activeFilters').innerHTML = (total ? `<span class="count">${list.length} ${list.length === 1 ? 'idea' : 'ideas'}</span>` : '') + active.join('');
  $('#filterDot').hidden = !(f.tag || f.status || f.archived || f.audio || f.scheduled || (state.settings.sort && state.settings.sort !== 'new'));

  const listEl = $('#ideaList');
  listEl.classList.toggle('grid', grid);
  const vt = $('#viewToggle');
  vt.classList.toggle('is-grid', grid);
  vt.setAttribute('aria-label', grid ? 'Cambiar a vista de lista' : 'Cambiar a vista de cuadrícula');
  listEl.innerHTML = list.map(ideaCard).join('');
  const empty = $('#emptyState');
  if (list.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    if (!activeIdeas().length) {
      empty.innerHTML = `<div class="empty-art" aria-hidden="true">✦</div>
        <h3>Su primera idea</h3>
        <p>Toque el micrófono de abajo y diga su idea en voz alta, o escríbala. Todo queda guardado solo en este teléfono.</p>
        <button type="button" class="btn ghost" id="loadSamples">Ver con ideas de ejemplo</button>`;
      $('#loadSamples').onclick = loadSamples;
    } else {
      empty.innerHTML = `<div class="empty-art" aria-hidden="true">🔍</div>
        <h3>No hay ideas aquí</h3>
        <p>Pruebe con otra búsqueda o vea todas sus ideas.</p>
        <button type="button" class="btn ghost" id="clearAllBtn">Ver todas</button>`;
      $('#clearAllBtn').onclick = () => {
        clearFilters();
        state.filters.q = '';
        $('#search').value = '';
        renderIdeas();
      };
    }
  }
}

function openFilters() {
  const f = state.filters;
  const tags = allTags();
  const s = openSheet({
    label: 'Filtros y orden',
    html: `
      <div class="sheet-grabber"></div>
      <h2 class="sheet-title">Filtros y orden</h2>
      <label class="field"><span>Ordenar</span>
        <select class="select" id="fSort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${state.settings.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Etiqueta</span>
        <select class="select" id="fTag"><option value="">Todas las etiquetas</option>${tags.map((t) => `<option value="${esc(t)}" ${f.tag === t ? 'selected' : ''}>#${esc(t)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Estado</span>
        <select class="select" id="fStatus"><option value="">Todos los estados</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </label>
      <label class="switch-row"><span>Solo favoritas</span><input type="checkbox" id="fFav" ${f.fav ? 'checked' : ''}><i></i></label>
      <label class="switch-row"><span>Ver archivadas</span><input type="checkbox" id="fArch" ${f.archived ? 'checked' : ''}><i></i></label>
      <div class="dlg-actions">
        <button type="button" class="btn ghost" id="fClear">Limpiar</button>
        <button type="button" class="btn primary" id="fApply">Aplicar</button>
      </div>`
  });
  s.el.querySelector('#fClear').onclick = async () => {
    clearFilters();
    await setSetting('sort', 'new');
    renderIdeas();
    s.close();
  };
  s.el.querySelector('#fApply').onclick = async () => {
    f.tag = s.el.querySelector('#fTag').value;
    f.status = s.el.querySelector('#fStatus').value;
    f.fav = s.el.querySelector('#fFav').checked;
    f.archived = s.el.querySelector('#fArch').checked;
    await setSetting('sort', s.el.querySelector('#fSort').value);
    renderIdeas();
    s.close();
  };
}

// ---------------------------------------------------------------- editor

const CHAT_SUGGESTIONS = [
  '¿Qué tareas debo hacer según esta nota?',
  'Haga una lista de pendientes',
  '¿De qué temas se habló?',
  'Resuma en 3 puntos clave',
  '¿Qué decisiones se tomaron?'
];

function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openEditor(id) {
  const idea = state.ideas.find((i) => i.id === id);
  if (!idea) return;
  idea.chat = idea.chat || [];
  const ai = aiConfig();
  let cleanupPlayer = null;
  const s = openSheet({
    full: true,
    label: 'Editar idea',
    className: 'editor',
    onClose: () => {
      save.flush();
      document.removeEventListener('idea-change', onChange);
      if (cleanupPlayer) cleanupPlayer();
      if (edDict.active) edDict.stop();
      renderIdeas();
      if (state.view === 'explore') renderExplore();
    },
    html: `
      <div class="sheet-head">
        <button type="button" class="btn ghost back" data-act="close">‹ Listo</button>
        <div class="head-actions">
          <button type="button" class="icon-btn star-btn ${idea.favorite ? 'on' : ''}" data-act="fav" aria-pressed="${idea.favorite}" aria-label="Favorita">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.5l-5.1 2.7 1-5.6-4.1-4 5.7-.8Z"/></svg>
          </button>
          <button type="button" class="icon-btn" data-act="share" aria-label="Compartir">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sheet-body">
        <label class="field"><span>Título</span>
          <div class="input-row">
            <input class="input title-input" id="edTitle" type="text" maxlength="120" value="${esc(idea.title)}">
            <button type="button" class="icon-btn" data-act="retitle" aria-label="Título automático" title="Título automático">↻</button>
          </div>
        </label>
        <p class="meta">Creada ${esc(fmtFull(idea.createdAt))}${idea.updatedAt && idea.updatedAt - idea.createdAt > 60000 ? ` · editada ${esc(fmtRelative(idea.updatedAt))}` : ''}</p>

        <div id="procBox"></div>
        ${idea.audio ? '<div id="playerBox" class="block player-block"></div>' : ''}
        <div id="primaryAI"></div>
        <section class="block note-block" id="noteBlock" hidden></section>

        <label class="field"><span id="textLabel">${idea.audio ? 'Transcripción' : 'Idea'}</span>
          <textarea class="input" id="edText" rows="6" placeholder="${idea.audio ? 'Aquí aparecerá la transcripción. También puede escribirla.' : 'Escriba su idea…'}">${esc(idea.text)}</textarea>
        </label>
        ${voiceSupported ? `<button type="button" class="btn soft full-w" data-act="dictate" id="edDictate">🎙️ Dictar y agregar al texto</button>` : ''}
        <div class="grid2">
          <label class="field"><span>Categoría</span><select class="select" id="edCat">${categoryOptions(idea.category)}</select></label>
          <label class="field"><span>Estado</span><select class="select" id="edStatus">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(idea.status || 'nueva') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <div class="field"><span>Etiquetas</span>
          <div class="tag-editor" id="tagEditor">
            <div class="tag-list" id="edTags"></div>
            <input class="tag-input" id="edTagInput" type="text" placeholder="Agregar etiqueta…" enterkeyhint="done" autocomplete="off" list="tagSuggestions" maxlength="30">
            <datalist id="tagSuggestions">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          </div>
        </div>
        <div class="field"><span>⏰ Recordarme</span>
          <div class="input-row">
            <input class="input" type="datetime-local" id="edRemind" value="${toLocalInput(idea.remindAt)}">
            <button type="button" class="icon-btn" data-act="clearremind" aria-label="Quitar recordatorio">✕</button>
          </div>
          <button type="button" class="btn ghost full-w small cal-btn" data-act="calendar" id="calBtn" ${idea.remindAt ? '' : 'hidden'}>📅 Agregar al Calendario del iPhone (con aviso)</button>
        </div>
        <label class="switch-row"><span>📌 Fijar arriba en la lista</span><input type="checkbox" id="edPin" ${idea.pinned ? 'checked' : ''}><i></i></label>
        <label class="switch-row"><span>🗄️ Archivar (ocultar de la lista)</span><input type="checkbox" id="edArch" ${idea.archived ? 'checked' : ''}><i></i></label>

        <section class="block" id="summaryBlock"></section>
        <section class="block" id="stepsBlock"></section>

        ${ai ? `
        <section class="block ai-block">
          <h3 class="block-title">✨ Más herramientas de IA <small>${ai.provider === 'gemini' ? 'Gemini' : 'Claude'}</small></h3>
          <div class="ai-actions">
            <button type="button" class="btn soft" data-ai="summary">Resumir</button>
            <button type="button" class="btn soft" data-ai="suggest">Sugerir título, categoría y etiquetas</button>
            <button type="button" class="btn soft" data-ai="steps">Convertir en lista de pasos</button>
            <button type="button" class="btn soft" data-ai="expand">Expandir idea</button>
          </div>
          <div id="aiResult" class="ai-result" hidden></div>
        </section>

        <section class="block chat-block" id="chatBlock">
          <h3 class="block-title">💬 Hablar con la IA sobre esta nota</h3>
          <div id="chatMount"></div>
        </section>` : ''}

        <div class="editor-footer">
          <button type="button" class="btn ghost" data-act="copy">Copiar texto</button>
          <button type="button" class="btn danger-ghost" data-act="delete">Mover a la papelera</button>
        </div>
      </div>`
  });

  const el = s.el;
  const titleEl = el.querySelector('#edTitle');
  const textEl = el.querySelector('#edText');
  autoGrowSoon(textEl);

  const save = debounce(() => persistIdea(idea), 350);

  titleEl.addEventListener('input', () => {
    idea.title = titleEl.value;
    idea.titleAuto = false;
    save();
  });
  textEl.addEventListener('input', () => {
    idea.text = textEl.value;
    refreshAutoTitle(idea);
    if (idea.titleAuto) titleEl.value = idea.title;
    autoGrow(textEl);
    renderPrimaryAI();
    save();
  });
  textEl.addEventListener('blur', () => {
    const found = extractHashtags(idea.text).filter((t) => !(idea.tags || []).includes(t));
    if (found.length) { idea.tags = [...(idea.tags || []), ...found]; renderTags(); save(); }
  });
  el.querySelector('#edCat').addEventListener('change', (e) => { idea.category = e.target.value || null; save(); });
  el.querySelector('#edStatus').addEventListener('change', (e) => { idea.status = e.target.value; save(); });
  el.querySelector('#edPin').addEventListener('change', (e) => { idea.pinned = e.target.checked; save(); });
  el.querySelector('#edArch').addEventListener('change', (e) => {
    idea.archived = e.target.checked;
    save();
    toast(idea.archived ? 'Idea archivada. Está en el menú → Archivadas.' : 'Idea de vuelta en la lista.');
  });
  el.querySelector('#edRemind').addEventListener('change', (e) => {
    idea.remindAt = e.target.value ? new Date(e.target.value).getTime() : null;
    el.querySelector('#calBtn').hidden = !idea.remindAt;
    save();
    if (idea.remindAt) toast('Recordatorio guardado. Para recibir un aviso, agréguelo al Calendario.');
  });

  // Etiquetas
  const tagInput = el.querySelector('#edTagInput');
  function renderTags() {
    el.querySelector('#edTags').innerHTML = (idea.tags || []).map((t) =>
      `<span class="tag on">#${esc(t)}<button type="button" data-rmtag="${esc(t)}" aria-label="Quitar etiqueta ${esc(t)}">✕</button></span>`).join('');
  }
  function addTagsFrom(value) {
    const parts = value.split(/[,\n]/).map(normTag).filter(Boolean);
    let changed = false;
    for (const t of parts) {
      if (!(idea.tags || []).includes(t)) { idea.tags = [...(idea.tags || []), t]; changed = true; }
    }
    if (changed) { renderTags(); save(); }
  }
  renderTags();
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTagsFrom(tagInput.value);
      tagInput.value = '';
    } else if (e.key === 'Backspace' && !tagInput.value && idea.tags?.length) {
      idea.tags = idea.tags.slice(0, -1);
      renderTags();
      save();
    }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) { addTagsFrom(tagInput.value); tagInput.value = ''; }
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) { addTagsFrom(tagInput.value); tagInput.value = ''; } });
  el.querySelector('#edTags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmtag]');
    if (!b) return;
    idea.tags = (idea.tags || []).filter((t) => t !== b.dataset.rmtag);
    renderTags();
    save();
  });

  // Estado del procesamiento con IA
  function renderProc() {
    const box = el.querySelector('#procBox');
    const msg = state.processing.get(idea.id);
    if (msg) {
      box.innerHTML = `<div class="proc-box"><span class="spinner"></span><div><strong>${esc(msg)}</strong><p>Puede seguir usando la app; el resultado aparecerá aquí solo.</p></div></div>`;
    } else if (idea.processError) {
      box.innerHTML = `<div class="ai-error" role="alert"><strong>No se pudo completar</strong><p>${esc(idea.processError)}</p></div>`;
    } else {
      box.innerHTML = '';
    }
  }

  // Botón principal de IA (transcribir / organizar)
  function renderPrimaryAI() {
    const box = el.querySelector('#primaryAI');
    const cfg = aiConfig();
    const busy = state.processing.has(idea.id);
    const hasText = !!(idea.text || '').trim();
    if (busy) { box.innerHTML = ''; return; }
    if (!cfg) {
      box.innerHTML = idea.audio && !hasText
        ? '<div class="hint-box">✨ Configure Gemini (gratis) en Ajustes para que la IA transcriba y organice sus grabaciones. <button type="button" class="link-btn" data-act="gosettings">Ir a Ajustes</button></div>'
        : '';
      return;
    }
    const btns = [];
    const canHear = idea.audio && AI.canHearAudio(cfg);
    if (canHear && !idea.transcribed) {
      btns.push('<button type="button" class="btn primary full-w" data-act="process-audio">✨ Transcribir y organizar con IA</button>');
    } else if (hasText) {
      btns.push(`<button type="button" class="btn ${idea.note ? 'soft' : 'primary'} full-w" data-act="process-text">✨ ${idea.note ? 'Reorganizar con IA' : 'Organizar con IA'}</button>`);
      if (canHear) btns.push('<button type="button" class="link-btn small center" data-act="process-audio">Volver a transcribir el audio</button>');
    }
    if (idea.audio && !AI.canHearAudio(cfg) && !hasText) {
      btns.push('<div class="hint-box">Claude no puede escuchar audios. Para transcribir esta grabación configure Gemini (gratis) en Ajustes, o escriba el texto abajo y use "Organizar con IA".</div>');
    }
    box.innerHTML = btns.length ? `<div class="primary-ai">${btns.join('')}</div>` : '';
  }

  // Nota organizada
  let noteEditing = false;
  function renderNote() {
    const box = el.querySelector('#noteBlock');
    if (!idea.note) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    if (noteEditing) {
      box.innerHTML = `<h3 class="block-title">✨ Nota organizada</h3>
        <textarea class="input mono-soft" id="noteEdit" rows="12">${esc(idea.note)}</textarea>
        <p class="muted small">Use "## " para títulos y "- " para viñetas.</p>
        <div class="dlg-actions"><button type="button" class="btn primary" data-act="note-done">Listo</button></div>`;
      autoGrowSoon(box.querySelector('#noteEdit'));
      return;
    }
    box.innerHTML = `
      <h3 class="block-title">✨ Nota organizada ${idea.organizedAt ? `<small>${esc(fmtRelative(idea.organizedAt))}</small>` : ''}</h3>
      <div class="note-body md" id="noteBody">${renderMd(idea.note)}</div>
      <button type="button" class="link-btn see-more" data-act="note-more" hidden>Ver más ▾</button>
      <div class="note-actions">
        <button type="button" class="btn ghost small" data-act="note-copy">Copiar</button>
        <button type="button" class="btn ghost small" data-act="note-share">Compartir</button>
        <button type="button" class="btn ghost small" data-act="note-edit">Editar</button>
        <button type="button" class="btn danger-ghost small" data-act="note-remove">Quitar</button>
      </div>`;
    requestAnimationFrame(() => {
      const body = box.querySelector('#noteBody');
      if (body && body.scrollHeight > 340) {
        body.classList.add('collapsed');
        box.querySelector('[data-act="note-more"]').hidden = false;
      }
    });
  }

  // Resumen
  function renderSummary() {
    const box = el.querySelector('#summaryBlock');
    if (!idea.summary) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<h3 class="block-title">Resumen <button type="button" class="link-btn" data-act="rmsummary">Quitar</button></h3><p class="summary-text">${esc(idea.summary)}</p>`;
  }

  // Pasos
  function renderSteps() {
    const box = el.querySelector('#stepsBlock');
    const steps = idea.steps || [];
    const done = steps.filter((x) => x.done).length;
    box.innerHTML = `
      <h3 class="block-title">Pasos y tareas ${steps.length ? `<small>${done}/${steps.length} hechos</small>` : ''}</h3>
      ${steps.length ? `<div class="progress"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>` : ''}
      <ul class="steps">
        ${steps.map((st, i) => `
          <li class="${st.done ? 'done' : ''}">
            <label><input type="checkbox" data-step="${i}" ${st.done ? 'checked' : ''}><span>${esc(st.text)}</span></label>
            <button type="button" class="icon-btn small" data-rmstep="${i}" aria-label="Quitar paso">✕</button>
          </li>`).join('')}
      </ul>
      <div class="input-row">
        <input class="input" id="newStep" type="text" placeholder="Agregar un paso…" enterkeyhint="done" maxlength="200">
        <button type="button" class="btn soft" data-act="addstep">Agregar</button>
      </div>`;
  }

  function refreshAll() {
    if (document.activeElement !== titleEl) titleEl.value = idea.title;
    if (document.activeElement !== textEl) { textEl.value = idea.text || ''; autoGrow(textEl); }
    el.querySelector('#edCat').value = idea.category || '';
    el.querySelector('#edStatus').value = idea.status || 'nueva';
    renderProc();
    renderPrimaryAI();
    renderNote();
    renderTags();
    renderSummary();
    renderSteps();
  }
  refreshAll();

  // Reproductor
  if (idea.audio) {
    mountPlayer(el.querySelector('#playerBox'), idea).then((fn) => { cleanupPlayer = fn; });
  }

  // Chat con la IA sobre la nota
  if (ai) {
    mountChat(el.querySelector('#chatMount'), {
      history: idea.chat,
      suggestions: CHAT_SUGGESTIONS,
      placeholder: 'Pregúntele a la IA sobre esta nota…',
      ask: (history) => AI.chatIdea(aiConfig(), idea, history),
      onChange: () => save(),
      addLabel: 'Agregar a la nota',
      onAdd: (answer, question) => {
        idea.note = `${(idea.note || '').trim()}${idea.note ? '\n\n' : ''}## ${question}\n${answer}`.trim();
        renderNote();
        save();
        toast('Respuesta agregada a la nota.');
      }
    });
  }

  // Cambios externos (procesamiento con IA en segundo plano)
  function onChange(e) {
    if (e.detail && e.detail.id === idea.id) refreshAll();
  }
  document.addEventListener('idea-change', onChange);

  el.querySelector('#stepsBlock').addEventListener('change', (e) => {
    const cb = e.target.closest('[data-step]');
    if (!cb) return;
    const st = idea.steps[Number(cb.dataset.step)];
    st.done = cb.checked;
    if (idea.steps.length && idea.steps.every((x) => x.done) && idea.status !== 'hecha') {
      idea.status = 'hecha';
      el.querySelector('#edStatus').value = 'hecha';
      toast('¡Todos los pasos listos! Idea marcada como Hecha 🎉');
    }
    renderSteps();
    save();
  });
  el.querySelector('#stepsBlock').addEventListener('keydown', (e) => {
    if (e.target.id === 'newStep' && e.key === 'Enter') { e.preventDefault(); addStep(); }
  });
  function addStep() {
    const inp = el.querySelector('#newStep');
    const v = inp.value.trim();
    if (!v) return;
    idea.steps = [...(idea.steps || []), { text: v, done: false }];
    renderSteps();
    save();
    el.querySelector('#newStep').focus();
  }

  // Dictado dentro del editor
  const edDict = new Dictation();
  let dictBase = '';

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const rmStep = e.target.closest('[data-rmstep]');
    if (rmStep) {
      idea.steps.splice(Number(rmStep.dataset.rmstep), 1);
      renderSteps();
      save();
      return;
    }
    const aiBtn = e.target.closest('[data-ai]');
    if (aiBtn) { runIdeaAI(aiBtn.dataset.ai, idea, el, { save, renderSummary, renderSteps, renderTags, titleEl, textEl }); return; }
    if (!act) return;
    switch (act) {
      case 'close':
        s.close();
        break;
      case 'fav': {
        idea.favorite = !idea.favorite;
        const b = el.querySelector('[data-act="fav"]');
        b.classList.toggle('on', idea.favorite);
        b.setAttribute('aria-pressed', String(idea.favorite));
        save();
        break;
      }
      case 'retitle':
        idea.titleAuto = true;
        refreshAutoTitle(idea);
        titleEl.value = idea.title;
        save();
        break;
      case 'share':
        shareIdea(idea);
        break;
      case 'copy':
        copyText(ideaAsText(idea));
        break;
      case 'gosettings':
        s.close();
        setView('settings');
        break;
      case 'process-audio':
        save.flush();
        processIdea(idea.id, { transcribe: true });
        break;
      case 'process-text':
        save.flush();
        processIdea(idea.id);
        break;
      case 'note-more': {
        const body = el.querySelector('#noteBody');
        const open = body.classList.toggle('collapsed');
        e.target.textContent = open ? 'Ver más ▾' : 'Ver menos ▴';
        break;
      }
      case 'note-copy':
        copyText(`${idea.title}\n\n${mdToPlain(idea.note)}`);
        break;
      case 'note-share':
        shareText(idea.title, `${idea.title}\n\n${mdToPlain(idea.note)}`);
        break;
      case 'note-edit':
        noteEditing = true;
        renderNote();
        break;
      case 'note-done':
        idea.note = el.querySelector('#noteEdit').value.trim();
        noteEditing = false;
        renderNote();
        save();
        break;
      case 'note-remove':
        if (await confirmDialog('¿Quitar la nota organizada?', 'El texto original de la idea se mantiene.', 'Quitar', true)) {
          idea.note = '';
          renderNote();
          renderPrimaryAI();
          save();
        }
        break;
      case 'clearremind':
        idea.remindAt = null;
        el.querySelector('#edRemind').value = '';
        el.querySelector('#calBtn').hidden = true;
        save();
        break;
      case 'calendar':
        addToCalendar(idea);
        break;
      case 'rmsummary':
        idea.summary = '';
        renderSummary();
        save();
        break;
      case 'addstep':
        addStep();
        break;
      case 'dictate': {
        const btn = el.querySelector('#edDictate');
        if (edDict.active) { edDict.stop(); return; }
        dictBase = textEl.value.trim();
        edDict.start({
          lang: state.settings.voiceLang,
          onStart: () => { btn.classList.add('recording'); btn.textContent = '⏹ Detener dictado'; },
          onText: (fin, interim) => {
            const spoken = [fin, interim].filter(Boolean).join(' ');
            textEl.value = [dictBase, spoken].filter(Boolean).join(dictBase && spoken ? ' ' : '');
            idea.text = textEl.value;
            refreshAutoTitle(idea);
            if (idea.titleAuto) titleEl.value = idea.title;
            autoGrow(textEl);
            save();
          },
          onEnd: () => { btn.classList.remove('recording'); btn.textContent = '🎙️ Dictar y agregar al texto'; renderPrimaryAI(); },
          onError: (code) => {
            btn.classList.remove('recording');
            btn.textContent = '🎙️ Dictar y agregar al texto';
            if (code === 'no-speech') toast(voiceErrorMessage(code)); else alertDialog('Dictado', voiceErrorMessage(code));
          }
        });
        break;
      }
      case 'delete': {
        const ok = await confirmDialog('¿Mover a la papelera?', `“${idea.title}” quedará en la papelera por ${TRASH_DAYS} días y podrá restaurarla desde el menú → Borradas recientemente.`, 'Mover a la papelera', true);
        if (!ok) return;
        idea.deletedAt = Date.now();
        await persistIdea(idea, { touch: false });
        s.close();
        toast('Idea movida a la papelera.', {
          action: 'Deshacer',
          onAction: async () => { idea.deletedAt = null; await persistIdea(idea, { touch: false }); renderIdeas(); }
        });
        break;
      }
      default:
        break;
    }
  });
}

function autoGrowSoon(el) { requestAnimationFrame(() => autoGrow(el)); }

function ideaAsText(idea) {
  const cat = catById(idea.category);
  const lines = [idea.title, ''];
  if (idea.note) lines.push(mdToPlain(idea.note), '');
  if (idea.text) lines.push(idea.note ? `Texto original:\n${idea.text}` : idea.text);
  if (idea.steps?.length) {
    lines.push('', 'Pasos:');
    idea.steps.forEach((s) => lines.push(`${s.done ? '☑' : '☐'} ${s.text}`));
  }
  const meta = [cat ? cat.name : '', ...(idea.tags || []).map((t) => '#' + t)].filter(Boolean).join(' · ');
  if (meta) lines.push('', meta);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Texto copiado.');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
    toast(ok ? 'Texto copiado.' : 'No se pudo copiar. Mantenga presionado el texto para copiarlo.');
  }
}

async function shareIdea(idea) {
  const text = ideaAsText(idea);
  if (navigator.share) {
    try {
      await navigator.share({ title: idea.title, text });
    } catch (e) {
      if (e.name !== 'AbortError') copyText(text);
    }
  } else {
    copyText(text);
  }
}

// ---------------------------------------------------------------- notas con formato

function inlineMd(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** Formato simple y seguro: "## título", "- viñeta" (con sangría) y **negrita**. */
function renderMd(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let html = '';
  let depth = 0;
  const closeTo = (d) => { while (depth > d) { html += '</ul>'; depth--; } };
  for (const raw of lines) {
    if (!raw.trim()) { closeTo(0); continue; }
    const h = raw.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { closeTo(0); html += `<h4>${inlineMd(h[1])}</h4>`; continue; }
    const li = raw.match(/^(\s*)[-*•]\s+(.*)$/) || raw.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (li) {
      const d = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1);
      while (depth < d) { html += '<ul>'; depth++; }
      closeTo(d);
      html += `<li>${inlineMd(li[2])}</li>`;
      continue;
    }
    closeTo(0);
    html += `<p>${inlineMd(raw.trim())}</p>`;
  }
  closeTo(0);
  return html;
}

function mdToPlain(md) {
  return String(md || '')
    .replace(/^\s*#{1,6}\s+(.*)$/gm, (m, t) => t.toUpperCase())
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/\*\*(.+?)\*\*/g, '$1');
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copyText(text);
}

// ---------------------------------------------------------------- procesamiento con IA

function emitChange(id) {
  document.dispatchEvent(new CustomEvent('idea-change', { detail: { id } }));
  if (state.view === 'ideas' && !document.querySelector('.sheet.recorder')) renderIdeas();
}

function setProcessing(id, msg) {
  if (msg) state.processing.set(id, msg); else state.processing.delete(id);
  emitChange(id);
}

/**
 * Transcribe (si hay audio y la IA puede escucharlo) y luego organiza la idea en una nota.
 * Corre en segundo plano: el resultado aparece solo en la tarjeta y en la pantalla de la idea.
 */
async function processIdea(id, { transcribe = false } = {}) {
  const cfg = aiConfig();
  const idea = state.ideas.find((i) => i.id === id);
  if (!cfg || !idea || state.processing.has(id)) return;
  idea.processError = '';
  try {
    if (transcribe && idea.audio && AI.canHearAudio(cfg)) {
      setProcessing(id, 'Preparando el audio…');
      const blob = await getAudioBlob(id);
      if (!blob) throw new AI.AIError('no_audio', 'El audio de esta grabación no está en este teléfono.');
      let wavs;
      try {
        wavs = await toWavChunks(blob, 240);
      } catch (e) {
        throw new AI.AIError('decode', 'No se pudo leer el audio para transcribirlo. Intente de nuevo o con una grabación más corta.');
      }
      const chunks = [];
      for (const w of wavs) chunks.push({ mime: 'audio/wav', base64: await blobToBase64(w) });
      const text = await AI.transcribe(cfg, chunks, {
        lang: state.settings.voiceLang,
        onProgress: (i, n) => setProcessing(id, n > 1 ? `Transcribiendo parte ${i + 1} de ${n}…` : 'Transcribiendo…')
      });
      idea.transcript = text;
      idea.transcribed = true;
      if (text) {
        idea.text = text;
        refreshAutoTitle(idea);
      }
      await persistIdea(idea);
      if (!text) {
        setProcessing(id, null);
        toast('No se detectó voz en la grabación.');
        return;
      }
    }
    if (!(idea.text || '').trim()) { setProcessing(id, null); return; }
    setProcessing(id, 'Organizando con IA…');
    const cats = sortedCats();
    const r = await AI.organizeNote(cfg, idea, cats.map((c) => c.name), allTags());
    idea.note = r.note;
    if (r.summary) idea.summary = r.summary;
    if (r.title && (idea.titleAuto || /^Grabación de /.test(idea.title))) { idea.title = r.title; idea.titleAuto = false; }
    const cat = cats.find((c) => normalize(c.name) === normalize(r.category));
    if (cat && !idea.category) idea.category = cat.id;
    const tags = r.tags.map(normTag).filter(Boolean);
    idea.tags = [...new Set([...(idea.tags || []), ...tags])].slice(0, 8);
    if (r.tasks.length && !(idea.steps || []).length) idea.steps = r.tasks.map((t) => ({ text: t, done: false }));
    idea.organizedAt = Date.now();
    await persistIdea(idea);
    setProcessing(id, null);
    toast(`“${idea.title}” quedó organizada ✨`, { action: 'Ver', onAction: () => { if (!document.querySelector('.sheet.editor')) openEditor(id); } });
  } catch (err) {
    console.warn(err);
    idea.processError = err instanceof AI.AIError ? err.message : 'Ocurrió un error inesperado con la IA. Intente de nuevo.';
    await persistIdea(idea, { touch: false });
    setProcessing(id, null);
    toast(idea.processError, { error: true, duration: 6000 });
  }
}

// ---------------------------------------------------------------- reproductor

async function mountPlayer(box, idea) {
  box.innerHTML = '<div class="loading"><span class="spinner"></span>Cargando audio…</div>';
  let blob = null;
  try { blob = await getAudioBlob(idea.id); } catch (e) { blob = null; }
  if (!blob) {
    box.innerHTML = '<p class="muted">🎙 El audio de esta grabación no está en este teléfono (por ejemplo, si vino de un respaldo sin audios).</p>';
    return null;
  }
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : idea.audio.duration || 0);
  const peaks = idea.audio.peaks && idea.audio.peaks.length ? idea.audio.peaks : null;
  const N = 48;
  const bars = [];
  for (let i = 0; i < N; i++) {
    const v = peaks ? peaks[Math.floor((i / N) * peaks.length)] : 0.35 + 0.3 * Math.abs(Math.sin(i * 0.9));
    bars.push(`<i style="height:${Math.round(14 + Math.min(1, v * 1.4) * 86)}%"></i>`);
  }
  box.innerHTML = `
    <div class="player">
      <div class="pwave" aria-hidden="true">${bars.join('')}</div>
      <input type="range" class="seek" min="0" max="1000" value="0" step="1" aria-label="Posición del audio">
      <div class="ptimes"><span class="cur">0:00</span><button type="button" class="speed" aria-label="Velocidad">1×</button><span class="rem">-${fmtDuration(total())}</span></div>
      <div class="pcontrols">
        <button type="button" class="icon-btn" data-p="back" aria-label="Retroceder 15 segundos">↺<small>15</small></button>
        <button type="button" class="play-btn" data-p="play" aria-label="Reproducir">
          <svg viewBox="0 0 24 24" class="ic-play" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>
          <svg viewBox="0 0 24 24" class="ic-pause" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.5"/><rect x="13.5" y="5" width="4" height="14" rx="1.5"/></svg>
        </button>
        <button type="button" class="icon-btn" data-p="fwd" aria-label="Adelantar 15 segundos">↻<small>15</small></button>
        <button type="button" class="icon-btn" data-p="save" aria-label="Guardar o compartir el audio">⤓</button>
      </div>
    </div>`;
  const seek = box.querySelector('.seek');
  const cur = box.querySelector('.cur');
  const rem = box.querySelector('.rem');
  const playBtn = box.querySelector('[data-p="play"]');
  const barsEl = [...box.querySelectorAll('.pwave i')];
  const speeds = [1, 1.25, 1.5, 2];
  let si = 0;
  let dragging = false;
  const paint = () => {
    const t = total();
    const p = t ? audio.currentTime / t : 0;
    if (!dragging) seek.value = String(Math.round(p * 1000));
    cur.textContent = fmtDuration(audio.currentTime);
    rem.textContent = '-' + fmtDuration(Math.max(0, t - audio.currentTime));
    const lit = Math.round(p * N);
    barsEl.forEach((b, i) => b.classList.toggle('lit', i < lit));
  };
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('play', () => { playBtn.classList.add('playing'); playBtn.setAttribute('aria-label', 'Pausar'); });
  audio.addEventListener('pause', () => { playBtn.classList.remove('playing'); playBtn.setAttribute('aria-label', 'Reproducir'); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  audio.addEventListener('error', () => toast('Este navegador no puede reproducir el audio.', { error: true }));
  seek.addEventListener('input', () => { dragging = true; cur.textContent = fmtDuration((Number(seek.value) / 1000) * total()); });
  seek.addEventListener('change', () => { dragging = false; audio.currentTime = (Number(seek.value) / 1000) * total(); paint(); });
  box.querySelector('.speed').addEventListener('click', (e) => {
    si = (si + 1) % speeds.length;
    audio.playbackRate = speeds[si];
    e.target.textContent = `${speeds[si]}×`.replace('.', ',');
  });
  box.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]')?.dataset.p;
    if (p === 'play') { if (audio.paused) audio.play().catch(() => toast('No se pudo reproducir el audio.')); else audio.pause(); }
    if (p === 'back') { audio.currentTime = Math.max(0, audio.currentTime - 15); paint(); }
    if (p === 'fwd') { audio.currentTime = Math.min(total(), audio.currentTime + 15); paint(); }
    if (p === 'save') {
      const ext = (idea.audio.mime || '').includes('webm') ? 'webm' : (idea.audio.mime || '').includes('ogg') ? 'ogg' : 'm4a';
      shareOrDownload(blob, `${normTag(idea.title).slice(0, 40) || 'grabacion'}.${ext}`, idea.title);
    }
  });
  return () => { audio.pause(); audio.removeAttribute('src'); URL.revokeObjectURL(url); };
}

// ---------------------------------------------------------------- chat

/** Interfaz de chat reutilizable (por nota o con todas las ideas). history se modifica en el lugar. */
function mountChat(box, { history, suggestions = [], placeholder = 'Escriba su pregunta…', ask, onChange, onAdd, addLabel }) {
  let errorMsg = '';
  let busy = false;
  const dict = new Dictation();
  box.innerHTML = `
    <div class="chat-msgs" aria-live="polite"></div>
    <div class="chat-sugs"></div>
    <div class="chat-input">
      <textarea rows="1" class="chat-text" placeholder="${esc(placeholder)}" enterkeyhint="send"></textarea>
      ${voiceSupported ? '<button type="button" class="icon-btn chat-mic" aria-label="Dictar pregunta">🎙️</button>' : ''}
      <button type="button" class="chat-send" aria-label="Enviar">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;
  const msgsEl = box.querySelector('.chat-msgs');
  const sugEl = box.querySelector('.chat-sugs');
  const input = box.querySelector('.chat-text');
  const render = () => {
    msgsEl.innerHTML = history.map((m, i) => m.role === 'user'
      ? `<div class="bubble user">${esc(m.text)}</div>`
      : `<div class="bubble ai"><div class="md">${renderMd(m.text)}</div>
          <div class="bubble-actions"><button type="button" class="link-btn small" data-copy="${i}">Copiar</button>${onAdd ? `<button type="button" class="link-btn small" data-add="${i}">${esc(addLabel || 'Agregar')}</button>` : ''}</div></div>`).join('') +
      (busy ? '<div class="bubble ai typing"><span></span><span></span><span></span></div>' : '') +
      (errorMsg ? `<div class="ai-error" role="alert"><p>${esc(errorMsg)}</p></div>` : '') +
      (history.length && !busy ? '<button type="button" class="link-btn small clear-chat" data-clear-chat>Borrar conversación</button>' : '');
    sugEl.innerHTML = history.length ? '' : suggestions.map((q) => `<button type="button" class="sug-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  };
  const sendQ = async (q) => {
    q = (q || '').trim();
    if (!q || busy) return;
    errorMsg = '';
    history.push({ role: 'user', text: q, at: Date.now() });
    busy = true;
    input.value = '';
    autoGrow(input, 120);
    render();
    try {
      const ans = await ask(history);
      history.push({ role: 'ai', text: ans, at: Date.now() });
    } catch (err) {
      history.pop();
      input.value = q;
      errorMsg = err instanceof AI.AIError ? err.message : 'No se pudo obtener respuesta. Intente de nuevo.';
    }
    busy = false;
    onChange && onChange();
    render();
    const last = msgsEl.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  box.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-q]')) sendQ(t.closest('[data-q]').dataset.q);
    else if (t.closest('.chat-send')) sendQ(input.value);
    else if (t.closest('[data-copy]')) copyText(mdToPlain(history[Number(t.closest('[data-copy]').dataset.copy)].text));
    else if (t.closest('[data-add]')) {
      const i = Number(t.closest('[data-add]').dataset.add);
      const q = history[i - 1] && history[i - 1].role === 'user' ? history[i - 1].text : 'Respuesta de la IA';
      onAdd(history[i].text, q);
    } else if (t.closest('[data-clear-chat]')) {
      if (await confirmDialog('¿Borrar la conversación?', 'Se borrarán las preguntas y respuestas de este chat.', 'Borrar', true)) {
        history.splice(0, history.length);
        errorMsg = '';
        onChange && onChange();
        render();
      }
    } else if (t.closest('.chat-mic')) {
      const mic = t.closest('.chat-mic');
      if (dict.active) { dict.stop(); return; }
      const base = input.value.trim();
      dict.start({
        lang: state.settings.voiceLang,
        onStart: () => mic.classList.add('recording'),
        onText: (fin, interim) => { input.value = [base, fin, interim].filter(Boolean).join(' '); autoGrow(input, 120); },
        onEnd: () => mic.classList.remove('recording'),
        onError: (code) => { mic.classList.remove('recording'); if (code !== 'no-speech') toast(voiceErrorMessage(code)); }
      });
    }
  });
  input.addEventListener('input', () => autoGrow(input, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQ(input.value); }
  });
  render();
}

function describeForChat(i) {
  const cat = catById(i.category);
  const body = (i.summary || i.text || '').replace(/\s+/g, ' ').slice(0, 300);
  return `"${i.title}" (${fmtShortDate(i.createdAt)}${cat ? ', ' + cat.name : ''}${i.tags?.length ? ', ' + i.tags.map((t) => '#' + t).join(' ') : ''}${i.status && i.status !== 'nueva' ? ', ' + STATUS[i.status] : ''}): ${body}`;
}

function openAskAll() {
  const cfg = aiConfig();
  if (!cfg) { setView('settings'); toast('Configure una clave de IA para usar el chat.'); return; }
  const s = openSheet({
    full: true,
    label: 'Preguntar a mis ideas',
    className: 'askall',
    html: `
      <div class="sheet-head">
        <button type="button" class="btn ghost back" data-close>‹ Volver</button>
        <strong>💬 Preguntar a mis ideas</strong>
        <span></span>
      </div>
      <div class="sheet-body">
        <p class="muted">La IA lee el título y el resumen de sus ideas (hasta 200) y responde sus preguntas.</p>
        <div id="askMount"></div>
      </div>`
  });
  s.el.querySelector('[data-close]').onclick = () => s.close();
  mountChat(s.el.querySelector('#askMount'), {
    history: state.globalChat,
    suggestions: [
      '¿Qué tareas tengo pendientes en todas mis ideas?',
      '¿Qué ideas tengo sobre trabajo?',
      'Resuma lo que grabé esta semana',
      '¿Qué ideas se parecen o se repiten?',
      '¿En qué idea debería enfocarme primero?'
    ],
    placeholder: 'Pregunte sobre todas sus ideas…',
    ask: (history) => AI.chatAll(aiConfig(), activeIdeas().filter((i) => !i.archived).sort((a, b) => b.createdAt - a.createdAt), history, describeForChat)
  });
}

// ---------------------------------------------------------------- recordatorios

function icsEscape(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
}

function icsDate(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function addToCalendar(idea) {
  if (!idea.remindAt) { toast('Primero elija la fecha y hora del recordatorio.'); return; }
  const body = (idea.summary || idea.text || '').slice(0, 900);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IdeaShel Vale//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${idea.id}@ideashel-vale`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(idea.remindAt)}`,
    `DTEND:${icsDate(idea.remindAt + 30 * 60000)}`,
    `SUMMARY:${icsEscape('💡 ' + idea.title)}`,
    `DESCRIPTION:${icsEscape(body + '\n\nAbra IdeaShel Vale para ver la idea completa.')}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(idea.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  await shareOrDownload(blob, `recordatorio-${normTag(idea.title).slice(0, 30) || 'idea'}.ics`, idea.title);
}

function checkDueReminders() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const due = activeIdeas().filter((i) => i.remindAt && i.remindAt <= end.getTime() && i.status !== 'hecha' && !i.archived);
  if (!due.length || !$('#banner').hidden) return;
  showBanner(`<span>⏰ Tiene ${due.length} ${due.length === 1 ? 'idea programada' : 'ideas programadas'} para hoy o atrasadas.</span>
    <div class="banner-actions"><button type="button" class="btn small primary" id="bnDue">Ver</button><button type="button" class="btn small ghost" id="bnDueLater">Cerrar</button></div>`, 'info');
  $('#bnDue').onclick = () => { hideBanner(); goIdeas({ scheduled: true }); };
  $('#bnDueLater').onclick = hideBanner;
}

// ---------------------------------------------------------------- etiquetas

function openTagManager() {
  const s = openSheet({ label: 'Editar etiquetas', html: '' });
  const render = () => {
    const counts = new Map();
    activeIdeas().forEach((i) => (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    const tags = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
    s.el.innerHTML = `
      <div class="sheet-grabber"></div>
      <h2 class="sheet-title">Etiquetas</h2>
      ${tags.length ? `<ul class="trash-list">${tags.map(([t, n]) => `
        <li><div><strong>#${esc(t)}</strong><span class="muted small">${n} ${n === 1 ? 'idea' : 'ideas'}</span></div>
          <button type="button" class="btn soft small" data-rename="${esc(t)}">Renombrar</button>
          <button type="button" class="icon-btn small" data-deltag="${esc(t)}" aria-label="Borrar etiqueta ${esc(t)}">🗑</button></li>`).join('')}</ul>`
        : '<p class="muted center">Aún no hay etiquetas.</p>'}
      <div class="dlg-actions"><button type="button" class="btn primary" data-close>Cerrar</button></div>`;
  };
  const apply = async (fn) => {
    const changed = [];
    for (const i of activeIdeas()) {
      const before = (i.tags || []).join('|');
      i.tags = [...new Set(fn(i.tags || []).map(normTag).filter(Boolean))];
      if (i.tags.join('|') !== before) changed.push(i);
    }
    try { await db.bulkPut('ideas', changed); } catch (err) { storageFailed(err); }
    return changed.length;
  };
  s.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) { s.close(); renderIdeas(); return; }
    const rn = e.target.closest('[data-rename]');
    const dl = e.target.closest('[data-deltag]');
    if (rn) {
      const old = rn.dataset.rename;
      const res = await dialog({ title: 'Renombrar etiqueta', input: { value: old, maxlength: 30 }, buttons: [{ label: 'Cancelar', value: false, style: 'ghost' }, { label: 'Guardar', value: true, style: 'primary' }] });
      if (!res || !res.value) return;
      const nt = normTag(res.value);
      const n = await apply((tags) => tags.map((t) => (t === old ? nt : t)));
      if (state.filters.tag === old) state.filters.tag = nt;
      toast(`Etiqueta actualizada en ${n} ${n === 1 ? 'idea' : 'ideas'}.`);
      render();
    }
    if (dl) {
      const t = dl.dataset.deltag;
      if (!(await confirmDialog(`¿Borrar #${t}?`, 'Se quitará de todas las ideas. Las ideas no se borran.', 'Borrar etiqueta', true))) return;
      await apply((tags) => tags.filter((x) => x !== t));
      if (state.filters.tag === t) state.filters.tag = '';
      render();
    }
  });
  render();
}

// ---------------------------------------------------------------- ideas de ejemplo

async function loadSamples() {
  const now = Date.now();
  const H = 3600000;
  const mk = (o) => ({ ...newIdea(o.text, o.category), ...o, id: uid(), titleAuto: false, createdAt: now - o.ago, updatedAt: now - o.ago });
  const samples = [
    mk({
      ago: 2 * H, category: 'trabajo', title: 'Reunión de proveedores y residuos',
      text: 'Revisamos con el equipo el manejo de residuos de la planta. Se habló de cambiar de proveedor para el retiro de residuos peligrosos y de pedir cotización directa, sin intermediarios. Falta digitalizar la documentación para cumplir con la fiscalización. Hay que coordinar una visita a la planta el próximo jueves.',
      summary: 'Se acordó pedir cotización directa a un nuevo proveedor de residuos y digitalizar la documentación para la fiscalización.',
      note: '## Proveedores de residuos\n- Evaluar cambio de proveedor para residuos peligrosos\n- Pedir **cotización directa**, sin intermediarios\n## Cumplimiento normativo\n- Digitalizar la documentación pendiente\n- Prepararse para la **fiscalización**\n## Próximos pasos\n- Visita a la planta el **jueves**',
      tags: ['proveedores', 'residuos'], organizedAt: now - 2 * H + 60000,
      steps: [{ text: 'Pedir cotización directa al proveedor', done: false }, { text: 'Digitalizar documentación de residuos', done: false }, { text: 'Coordinar visita a la planta el jueves', done: true }],
      status: 'desarrollo', favorite: true, remindAt: now + 20 * H
    }),
    mk({ ago: 5 * H, category: 'proyectos', title: 'App de gastos con fotos de boletas', text: 'Crear una app para registrar los gastos del hogar sacando fotos a las boletas, que sume por mes y avise cuando nos pasamos del presupuesto. #finanzas', tags: ['finanzas', 'hogar'] }),
    mk({ ago: 26 * H, category: 'personal', title: 'Regalo de cumpleaños', text: 'Comprar regalo de cumpleaños: pensar en una experiencia (cena o paseo) en vez de un objeto.', tags: ['cumpleaños'] }),
    mk({ ago: 50 * H, category: 'estudios', title: 'Repasar estadística', text: 'Repasar capítulo 4 de estadística y hacer los ejercicios de probabilidad antes del control. #examen', tags: ['examen'], status: 'hecha' }),
    mk({ ago: 75 * H, category: 'trabajo', title: 'Presentación del trimestre', text: 'Preparar presentación de resultados del trimestre: ventas por región, comparación con el año pasado y tres propuestas de mejora.', tags: ['reunion'] })
  ];
  try { await db.bulkPut('ideas', samples); } catch (err) { storageFailed(err); return; }
  state.ideas.push(...samples);
  renderIdeas();
  toast('Se agregaron 5 ideas de ejemplo. Puede borrarlas cuando quiera.');
}

// ---------------------------------------------------------------- IA por idea

const AI_LABELS = {
  summary: 'Resumiendo…',
  suggest: 'Buscando título, categoría y etiquetas…',
  steps: 'Armando la lista de pasos…',
  expand: 'Desarrollando la idea…'
};

async function runIdeaAI(kind, idea, el, ui) {
  const cfg = aiConfig();
  const box = el.querySelector('#aiResult');
  if (!cfg || !box) return;
  if (!(idea.text || '').trim()) { toast('La idea está vacía. Escriba algo primero.'); return; }
  const buttons = el.querySelectorAll('[data-ai]');
  buttons.forEach((b) => { b.disabled = true; });
  box.hidden = false;
  box.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(AI_LABELS[kind])}</div>`;
  try {
    if (kind === 'summary') {
      const summary = await AI.summarize(cfg, idea);
      box.innerHTML = `<p class="ai-text">${esc(summary)}</p>
        <div class="dlg-actions"><button type="button" class="btn ghost" data-r="no">Descartar</button><button type="button" class="btn primary" data-r="ok">Guardar resumen</button></div>`;
      await choice(box, {
        ok: () => { idea.summary = summary; ui.renderSummary(); ui.save(); toast('Resumen guardado.'); }
      });
    } else if (kind === 'suggest') {
      const cats = sortedCats();
      const sug = await AI.suggestMeta(cfg, idea, cats.map((c) => c.name), allTags());
      const cat = cats.find((c) => normalize(c.name) === normalize(sug.category));
      const tags = [...new Set(sug.tags.map(normTag).filter(Boolean))].slice(0, 5);
      box.innerHTML = `
        <div class="sug">
          <label class="check-row"><input type="checkbox" id="sgT" ${sug.title ? 'checked' : 'disabled'}><span><small>Título</small>${esc(sug.title || '—')}</span></label>
          <label class="check-row"><input type="checkbox" id="sgC" ${cat ? 'checked' : 'disabled'}><span><small>Categoría</small>${esc(cat ? cat.name : (sug.category ? sug.category + ' (no existe)' : '—'))}</span></label>
          <label class="check-row"><input type="checkbox" id="sgE" ${tags.length ? 'checked' : 'disabled'}><span><small>Etiquetas</small>${tags.map((t) => '#' + esc(t)).join(' ') || '—'}</span></label>
        </div>
        <div class="dlg-actions"><button type="button" class="btn ghost" data-r="no">Descartar</button><button type="button" class="btn primary" data-r="ok">Aplicar lo marcado</button></div>`;
      await choice(box, {
        ok: () => {
          if (box.querySelector('#sgT').checked && sug.title) { idea.title = sug.title; idea.titleAuto = false; ui.titleEl.value = idea.title; }
          if (box.querySelector('#sgC').checked && cat) { idea.category = cat.id; el.querySelector('#edCat').value = cat.id; }
          if (box.querySelector('#sgE').checked && tags.length) { idea.tags = [...new Set([...(idea.tags || []), ...tags])]; ui.renderTags(); }
          ui.save();
          toast('Sugerencias aplicadas.');
        }
      });
    } else if (kind === 'steps') {
      const steps = await AI.toSteps(cfg, idea);
      const hasSteps = (idea.steps || []).length > 0;
      box.innerHTML = `<ol class="ai-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <div class="dlg-actions"><button type="button" class="btn ghost" data-r="no">Descartar</button>
        ${hasSteps ? '<button type="button" class="btn soft" data-r="add">Agregar a los pasos</button>' : ''}
        <button type="button" class="btn primary" data-r="ok">${hasSteps ? 'Reemplazar pasos' : 'Guardar como pasos'}</button></div>`;
      await choice(box, {
        ok: () => { idea.steps = steps.map((t) => ({ text: t, done: false })); ui.renderSteps(); ui.save(); toast('Lista de pasos guardada.'); },
        add: () => { idea.steps = [...idea.steps, ...steps.map((t) => ({ text: t, done: false }))]; ui.renderSteps(); ui.save(); toast('Pasos agregados.'); }
      });
    } else if (kind === 'expand') {
      const text = await AI.expand(cfg, idea);
      box.innerHTML = `<div class="ai-text pre">${esc(text)}</div>
        <div class="dlg-actions"><button type="button" class="btn ghost" data-r="no">Descartar</button>
        <button type="button" class="btn soft" data-r="replace">Reemplazar texto</button>
        <button type="button" class="btn primary" data-r="ok">Agregar al final</button></div>`;
      await choice(box, {
        ok: () => { idea.text = `${idea.text.trim()}\n\n${text}`; ui.textEl.value = idea.text; autoGrow(ui.textEl); ui.save(); toast('Texto agregado a la idea.'); },
        replace: async () => {
          if (await confirmDialog('¿Reemplazar el texto?', 'El texto original de la idea se reemplazará por la versión expandida.', 'Reemplazar')) {
            idea.text = text; ui.textEl.value = text; autoGrow(ui.textEl); ui.save(); toast('Texto reemplazado.');
          }
        }
      });
    }
  } catch (err) {
    showAIError(box, err);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function choice(box, handlers) {
  return new Promise((resolve) => {
    box.querySelectorAll('[data-r]').forEach((b) => {
      b.addEventListener('click', async () => {
        const h = handlers[b.dataset.r];
        if (h) await h();
        box.hidden = true;
        box.innerHTML = '';
        resolve(b.dataset.r);
      });
    });
  });
}

function showAIError(box, err) {
  console.warn(err);
  const msg = err instanceof AI.AIError ? err.message : 'Ocurrió un error inesperado con la IA. Intente de nuevo.';
  const goSettings = err && ['invalid_key', 'model', 'no_key'].includes(err.code);
  box.hidden = false;
  box.innerHTML = `<div class="ai-error" role="alert"><strong>No se pudo completar</strong><p>${esc(msg)}</p>
    ${goSettings ? '<button type="button" class="btn soft" data-goset="1">Ir a Ajustes</button>' : ''}</div>`;
  const b = box.querySelector('[data-goset]');
  if (b) b.onclick = () => { while (sheetStack.length) sheetStack[sheetStack.length - 1].close(); setView('settings'); };
}

// ---------------------------------------------------------------- explorar

function renderExplore() {
  const view = $('#view-explore');
  const ideas = activeIdeas();
  const visible = ideas.filter((i) => !i.archived);
  const weekAgo = Date.now() - 7 * 86400000;
  const thisWeek = ideas.filter((i) => i.createdAt >= weekAgo).length;
  const favs = ideas.filter((i) => i.favorite).length;
  const done = ideas.filter((i) => i.status === 'hecha').length;
  const streak = computeStreak(ideas);
  const counts = sortedCats().map((c) => ({ c, n: ideas.filter((i) => i.category === c.id).length }));
  const none = ideas.filter((i) => !i.category || !catById(i.category)).length;
  if (none) counts.push({ c: { name: 'Sin categoría', color: '#9A93B5' }, n: none });
  const max = Math.max(1, ...counts.map((x) => x.n));
  const ai = aiConfig();

  if (!state.randomId || !visible.some((i) => i.id === state.randomId)) {
    state.randomId = visible.length ? visible[Math.floor(Math.random() * visible.length)].id : null;
  }
  const rnd = visible.find((i) => i.id === state.randomId);
  const topTags = allTags().slice(0, 12);

  view.innerHTML = `
    <h1 class="view-title">Explorar</h1>

    <div class="card rediscover">
      <h2 class="card-title">🔮 Redescubra una idea</h2>
      ${rnd ? `
        <p class="rd-date">${esc(fmtShortDate(rnd.createdAt))} · ${esc(catById(rnd.category)?.name || 'Sin categoría')}</p>
        <h3 class="rd-title">${esc(rnd.title)}</h3>
        <p class="rd-text">${esc((rnd.text || '').slice(0, 240))}${(rnd.text || '').length > 240 ? '…' : ''}</p>
        <div class="dlg-actions"><button type="button" class="btn ghost" id="rdNext">Otra al azar</button><button type="button" class="btn primary" id="rdOpen">Abrir</button></div>`
        : '<p class="muted">Cuando tenga algunas ideas guardadas, aquí le mostraremos una al azar para retomarla.</p>'}
    </div>

    <div class="stats">
      <div class="stat"><b>${ideas.length}</b><span>ideas</span></div>
      <div class="stat"><b>${thisWeek}</b><span>esta semana</span></div>
      <div class="stat"><b>${ideas.filter((i) => i.audio).length}</b><span>grabaciones</span></div>
      <div class="stat"><b>${done}</b><span>hechas</span></div>
    </div>
    ${streak > 1 ? `<p class="streak">🔥 Lleva ${streak} días seguidos capturando ideas.</p>` : ''}

    <div class="card">
      <h2 class="card-title">Por categoría</h2>
      ${ideas.length ? `<ul class="bars">${counts.map(({ c, n }) => `
        <li style="--c:${esc(c.color)}"><span class="bar-label">${esc(c.name)}</span><span class="bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span><b>${n}</b></li>`).join('')}</ul>`
        : '<p class="muted">Aún no hay ideas.</p>'}
    </div>

    ${topTags.length ? `<div class="card"><h2 class="card-title">Etiquetas más usadas</h2><div class="tag-cloud">${topTags.map((t) => `<button type="button" class="tag" data-gotag="${esc(t)}">#${esc(t)}</button>`).join('')}</div></div>` : ''}

    ${ai ? `
    <div class="card ai-card">
      <h2 class="card-title">💬 Preguntar a mis ideas</h2>
      <p class="muted">Converse con la IA sobre todas sus ideas: pendientes, temas que se repiten, qué grabó esta semana…</p>
      <button type="button" class="btn primary full-w" id="askAllBtn" ${visible.length ? '' : 'disabled'}>Abrir chat</button>
    </div>` : ''}

    ${ai ? `
    <div class="card ai-card">
      <h2 class="card-title">✨ Organizar mis ideas</h2>
      <p class="muted">La IA agrupa sus ideas parecidas por tema y le propone etiquetas para encontrarlas más fácil. Se envían a ${ai.provider === 'gemini' ? 'Gemini' : 'Claude'} el título y el inicio de hasta 150 ideas.</p>
      <button type="button" class="btn primary full-w" id="organizeBtn" ${visible.length < 2 ? 'disabled' : ''}>Organizar ${visible.length} ideas</button>
      <div id="organizeOut"></div>
    </div>` : `
    <div class="card muted-card">
      <h2 class="card-title">✨ Funciones de IA</h2>
      <p class="muted">Opcional: configure una clave gratuita de Gemini (o una de Claude) en Ajustes para resumir, sugerir etiquetas, crear pasos y agrupar ideas parecidas.</p>
      <button type="button" class="btn soft" id="goAiSettings">Configurar IA</button>
    </div>`}

    <div class="card">
      <h2 class="card-title">Exportar como texto</h2>
      <p class="muted">Genere un documento con todas sus ideas ordenadas por categoría, para leer o compartir (Notas, correo, WhatsApp…).</p>
      <button type="button" class="btn soft full-w" id="exportMd" ${ideas.length ? '' : 'disabled'}>Exportar ideas en texto</button>
    </div>`;

  view.querySelector('#rdNext')?.addEventListener('click', () => {
    const others = visible.filter((i) => i.id !== state.randomId);
    if (others.length) state.randomId = others[Math.floor(Math.random() * others.length)].id;
    renderExplore();
  });
  view.querySelector('#rdOpen')?.addEventListener('click', () => openEditor(state.randomId));
  view.querySelector('#goAiSettings')?.addEventListener('click', () => setView('settings'));
  view.querySelector('#exportMd')?.addEventListener('click', exportMarkdown);
  view.querySelectorAll('[data-gotag]').forEach((b) => b.addEventListener('click', () => {
    clearFilters();
    state.filters.tag = b.dataset.gotag;
    setView('ideas');
    renderIdeas();
  }));
  view.querySelector('#organizeBtn')?.addEventListener('click', runOrganize);
  view.querySelector('#askAllBtn')?.addEventListener('click', openAskAll);
  if (state.organizeResult) renderOrganize(state.organizeResult);
}

function computeStreak(ideas) {
  const days = new Set(ideas.map((i) => { const d = new Date(i.createdAt); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }));
  let streak = 0;
  const d = new Date();
  const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (!days.has(key(d))) d.setDate(d.getDate() - 1);
  while (days.has(key(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

async function runOrganize() {
  const cfg = aiConfig();
  const out = $('#organizeOut');
  const btn = $('#organizeBtn');
  if (!cfg || !out) return;
  const ideas = activeIdeas().filter((i) => !i.archived).sort((a, b) => b.createdAt - a.createdAt);
  btn.disabled = true;
  out.innerHTML = `<div class="loading"><span class="spinner"></span>Agrupando ideas parecidas…</div>`;
  try {
    const groups = await AI.organize(cfg, ideas);
    state.organizeResult = groups;
    renderOrganize(groups);
  } catch (err) {
    showAIError(out, err);
  } finally {
    btn.disabled = false;
  }
}

function renderOrganize(groups) {
  const out = $('#organizeOut');
  if (!out) return;
  out.innerHTML = `
    <div class="groups">
      ${groups.map((g, gi) => `
        <div class="group">
          <h3>${esc(g.name)} <small>${g.ids.length}</small></h3>
          ${g.description ? `<p class="muted">${esc(g.description)}</p>` : ''}
          <ul>${g.ids.map((id) => { const i = state.ideas.find((x) => x.id === id); return i ? `<li><button type="button" class="link-btn" data-openidea="${esc(id)}">${esc(i.title)}</button></li>` : ''; }).join('')}</ul>
          <button type="button" class="btn soft small" data-tagroup="${gi}">Etiquetar como #${esc(normTag(g.name))}</button>
        </div>`).join('')}
    </div>
    <div class="dlg-actions">
      <button type="button" class="btn ghost" id="orgClear">Cerrar</button>
      <button type="button" class="btn primary" id="orgAll">Aplicar todas las etiquetas</button>
    </div>`;
  const tagGroup = async (g) => {
    const tag = normTag(g.name);
    const changed = [];
    for (const id of g.ids) {
      const idea = state.ideas.find((x) => x.id === id);
      if (idea && !(idea.tags || []).includes(tag)) { idea.tags = [...(idea.tags || []), tag]; changed.push(idea); }
    }
    for (const idea of changed) await persistIdea(idea, { touch: false });
    return changed.length;
  };
  out.querySelectorAll('[data-openidea]').forEach((b) => b.addEventListener('click', () => openEditor(b.dataset.openidea)));
  out.querySelectorAll('[data-tagroup]').forEach((b) => b.addEventListener('click', async () => {
    const g = groups[Number(b.dataset.tagroup)];
    const n = await tagGroup(g);
    b.disabled = true;
    b.textContent = `✓ Etiquetadas ${n}`;
  }));
  out.querySelector('#orgAll').addEventListener('click', async () => {
    let n = 0;
    for (const g of groups) n += await tagGroup(g);
    state.organizeResult = null;
    toast(`Listo: se agregaron etiquetas a ${n} ideas.`);
    renderExplore();
  });
  out.querySelector('#orgClear').addEventListener('click', () => { state.organizeResult = null; renderExplore(); });
}

async function exportMarkdown() {
  const ideas = activeIdeas().sort((a, b) => b.createdAt - a.createdAt);
  const lines = [`# Mis ideas en IdeaShel Vale`, ``, `Exportado el ${fmtFull(Date.now())} · ${ideas.length} ideas`, ``];
  const groups = [...sortedCats().map((c) => ({ name: c.name, list: ideas.filter((i) => i.category === c.id) })),
    { name: 'Sin categoría', list: ideas.filter((i) => !i.category || !catById(i.category)) }];
  for (const g of groups) {
    if (!g.list.length) continue;
    lines.push(`## ${g.name}`, '');
    for (const i of g.list) {
      lines.push(`### ${i.favorite ? '★ ' : ''}${i.title}`);
      lines.push(`_${fmtFull(i.createdAt)}${i.status && i.status !== 'nueva' ? ' · ' + STATUS[i.status] : ''}${i.archived ? ' · archivada' : ''}_`, '');
      if (i.summary) lines.push(`> ${i.summary}`, '');
      lines.push(i.text || '', '');
      if (i.steps?.length) { i.steps.forEach((s) => lines.push(`- [${s.done ? 'x' : ' '}] ${s.text}`)); lines.push(''); }
      if (i.tags?.length) lines.push(i.tags.map((t) => '#' + t).join(' '), '');
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  await shareOrDownload(blob, `ideashel-vale-ideas-${stamp()}.md`, 'Mis ideas (IdeaShel Vale)');
}

// ---------------------------------------------------------------- respaldo

async function shareOrDownload(blob, filename, title) {
  let file = null;
  try { file = new File([blob], filename, { type: blob.type }); } catch (e) { file = null; }
  if (file && navigator.canShare && navigator.share) {
    let can = false;
    try { can = navigator.canShare({ files: [file] }); } catch (e) { can = false; }
    if (can) {
      try {
        await navigator.share({ files: [file], title });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

async function buildBackup(withAudio) {
  const s = state.settings;
  let audio = [];
  if (withAudio) {
    const rows = await db.getAll('audio');
    for (const r of rows) {
      const blob = r.data instanceof Blob ? r.data : new Blob([r.data], { type: r.mime });
      audio.push({ id: r.id, mime: r.mime, base64: await blobToBase64(blob) });
    }
  }
  return {
    app: 'chispa',
    format: 2,
    audio,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    ideas: state.ideas,
    categories: state.categories,
    // Nunca se exportan las claves de IA
    settings: { theme: s.theme, voiceLang: s.voiceLang, backupEveryDays: s.backupEveryDays, sort: s.sort }
  };
}

async function exportBackup() {
  const withAudio = !!state.settings.backupAudio && state.ideas.some((i) => i.audio);
  if (withAudio) toast('Preparando respaldo con audios…');
  let data;
  try {
    data = await buildBackup(withAudio);
  } catch (err) {
    storageFailed(err);
    return;
  }
  const blob = new Blob([JSON.stringify(data, withAudio ? null : undefined, withAudio ? 0 : 2)], { type: 'application/json' });
  const ok = await shareOrDownload(blob, `ideashel-vale-respaldo-${stamp()}.json`, 'Respaldo de IdeaShel Vale');
  if (!ok) return;
  await setSetting('lastBackupAt', Date.now());
  hideBanner();
  toast('Respaldo creado. Guárdelo en Archivos, iCloud Drive o envíeselo por correo.', { duration: 5000 });
  if (state.view === 'settings') renderSettings();
}

function toTs(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
}

function sanitizeIdea(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : autoTitle(text);
  if (!text && !title) return null;
  const now = Date.now();
  const createdAt = toTs(raw.createdAt, now);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    title,
    titleAuto: Boolean(raw.titleAuto),
    text,
    category: typeof raw.category === 'string' && raw.category ? raw.category : null,
    tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(normTag).filter(Boolean))] : [],
    favorite: Boolean(raw.favorite),
    pinned: Boolean(raw.pinned),
    status: STATUS[raw.status] ? raw.status : 'nueva',
    archived: Boolean(raw.archived),
    deletedAt: raw.deletedAt ? toTs(raw.deletedAt, null) : null,
    steps: Array.isArray(raw.steps) ? raw.steps.filter((s) => s && typeof s.text === 'string').map((s) => ({ text: s.text, done: Boolean(s.done) })) : [],
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    transcript: typeof raw.transcript === 'string' ? raw.transcript : '',
    transcribed: Boolean(raw.transcribed),
    organizedAt: raw.organizedAt ? toTs(raw.organizedAt, null) : null,
    chat: Array.isArray(raw.chat) ? raw.chat.filter((m) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'ai')).map((m) => ({ role: m.role, text: m.text, at: toTs(m.at, createdAt) })) : [],
    remindAt: raw.remindAt ? toTs(raw.remindAt, null) : null,
    audio: raw.audio && typeof raw.audio === 'object' && Number.isFinite(Number(raw.audio.duration))
      ? { mime: String(raw.audio.mime || 'audio/mp4'), duration: Number(raw.audio.duration), size: Number(raw.audio.size) || 0, peaks: Array.isArray(raw.audio.peaks) ? raw.audio.peaks.map(Number).slice(0, 200) : [] }
      : null,
    createdAt,
    updatedAt: toTs(raw.updatedAt, createdAt)
  };
}

function sanitizeCategory(raw, i) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name: raw.name.trim().slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : CAT_COLORS[i % CAT_COLORS.length],
    order: Number.isFinite(raw.order) ? raw.order : i
  };
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    await alertDialog('No se pudo importar', 'El archivo no es un respaldo válido (el JSON está dañado o no es de IdeaShel Vale).');
    return;
  }
  if (!data || !Array.isArray(data.ideas)) {
    await alertDialog('No se pudo importar', 'El archivo no parece un respaldo de IdeaShel Vale: no contiene una lista de ideas.');
    return;
  }
  const ideas = data.ideas.map(sanitizeIdea).filter(Boolean);
  const cats = (Array.isArray(data.categories) ? data.categories : []).map(sanitizeCategory).filter(Boolean);
  const audios = (Array.isArray(data.audio) ? data.audio : []).filter((a) => a && typeof a.id === 'string' && typeof a.base64 === 'string');
  const when = data.exportedAt ? ` del ${fmtFull(toTs(data.exportedAt, Date.now()))}` : '';
  const mode = await dialog({
    title: 'Importar respaldo',
    message: `El respaldo${when} tiene ${ideas.length} ideas${audios.length ? `, ${audios.length} audios` : ''} y ${cats.length} categorías. ¿Cómo desea importarlo?`,
    buttons: [
      { label: 'Combinar con mis ideas', value: 'merge', style: 'primary' },
      { label: 'Reemplazar todo', value: 'replace', style: 'danger-ghost' },
      { label: 'Cancelar', value: null, style: 'ghost' }
    ]
  });
  if (!mode) return;
  try {
    if (mode === 'replace') {
      const ok = await confirmDialog('¿Reemplazar todo?', `Se borrarán las ${state.ideas.length} ideas actuales de este teléfono y quedarán solo las del respaldo. Esta acción no se puede deshacer.`, 'Sí, reemplazar', true);
      if (!ok) return;
      const finalCats = cats.length ? cats : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      await db.replaceAll('ideas', ideas);
      await db.replaceAll('categories', finalCats);
      if (audios.length) await db.replaceAll('audio', []);
      state.ideas = ideas;
      state.categories = finalCats;
      toast(`Respaldo restaurado: ${ideas.length} ideas.`);
    } else {
      const byId = new Map(state.ideas.map((i) => [i.id, i]));
      const toPut = ideas.filter((i) => { const cur = byId.get(i.id); return !cur || (i.updatedAt || 0) > (cur.updatedAt || 0); });
      const catNames = new Map(state.categories.map((c) => [normalize(c.name), c.id]));
      const catIds = new Set(state.categories.map((c) => c.id));
      const newCats = [];
      for (const c of cats) {
        if (catIds.has(c.id)) continue;
        const sameName = catNames.get(normalize(c.name));
        if (sameName) {
          // Misma categoría con otro id: reasignar las ideas importadas
          toPut.forEach((i) => { if (i.category === c.id) i.category = sameName; });
        } else {
          c.order = state.categories.length + newCats.length;
          newCats.push(c);
        }
      }
      if (newCats.length) await db.bulkPut('categories', newCats);
      if (toPut.length) await db.bulkPut('ideas', toPut);
      state.categories.push(...newCats);
      for (const i of toPut) {
        const idx = state.ideas.findIndex((x) => x.id === i.id);
        if (idx === -1) state.ideas.push(i); else state.ideas[idx] = i;
      }
      toast(toPut.length ? `Se importaron ${toPut.length} ideas.` : 'No había ideas nuevas en el respaldo.');
    }
    for (const a of audios) {
      if (mode === 'merge' && (await db.get('audio', a.id))) continue;
      const blob = base64ToBlob(a.base64, a.mime || 'audio/mp4');
      await saveAudio(a.id, blob, a.mime || 'audio/mp4');
    }
  } catch (err) {
    storageFailed(err);
  }
  renderIdeas();
  renderSettings();
}

function checkBackupReminder() {
  const s = state.settings;
  const days = Number(s.backupEveryDays) || 0;
  const count = activeIdeas().length;
  if (!days || !count) return;
  const now = Date.now();
  if (now < (s.reminderSnoozedUntil || 0)) return;
  const last = s.lastBackupAt || s.firstRunAt || now;
  if (now - last < days * 86400000) return;
  const msg = s.lastBackupAt
    ? `Hace ${daysBetween(s.lastBackupAt, now)} días que no respalda sus ${count} ideas.`
    : `Aún no ha respaldado sus ${count} ideas.`;
  showBanner(`<span>💾 ${esc(msg)} Si pierde o cambia el teléfono, el respaldo es la única copia.</span>
    <div class="banner-actions"><button type="button" class="btn small primary" id="bnBackup">Respaldar ahora</button><button type="button" class="btn small ghost" id="bnLater">Más tarde</button></div>`, 'warn');
  $('#bnBackup').onclick = exportBackup;
  $('#bnLater').onclick = async () => { await setSetting('reminderSnoozedUntil', Date.now() + 86400000); hideBanner(); };
}

// ---------------------------------------------------------------- ajustes

function renderSettings() {
  const view = $('#view-settings');
  const s = state.settings;
  const counts = new Map();
  activeIdeas().forEach((i) => counts.set(i.category, (counts.get(i.category) || 0) + 1));
  const trash = trashIdeas().length;
  const keyField = (prov, label, value, placeholder) => `
    <div class="key-box ${s.aiProvider === prov ? 'active' : ''}" data-prov="${prov}">
      <div class="key-head">
        <label class="radio-row"><input type="radio" name="aiProv" value="${prov}" ${s.aiProvider === prov ? 'checked' : ''}><span>${label}</span></label>
        ${value ? '<span class="mini-pill ok">Clave guardada</span>' : ''}
      </div>
      <div class="input-row">
        <input class="input mono" type="password" id="key-${prov}" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text">
        <button type="button" class="icon-btn" data-toggle-key="${prov}" aria-label="Mostrar u ocultar clave">👁</button>
      </div>
      <label class="field"><span>Modelo</span>
        <select class="select" id="model-${prov}">${(prov === 'gemini' ? AI.GEMINI_MODELS : AI.CLAUDE_MODELS).map((m) => `<option value="${m.id}" ${(prov === 'gemini' ? s.geminiModel : s.claudeModel) === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      </label>
      <div class="btn-row">
        <button type="button" class="btn primary small" data-savekey="${prov}">Guardar clave</button>
        <button type="button" class="btn soft small" data-testkey="${prov}" ${value ? '' : 'disabled'}>Probar</button>
        <button type="button" class="btn danger-ghost small" data-delkey="${prov}" ${value ? '' : 'disabled'}>Borrar clave</button>
      </div>
      <p class="key-status" id="status-${prov}" role="status"></p>
    </div>`;

  view.innerHTML = `
    <h1 class="view-title">Ajustes</h1>

    <div class="card">
      <h2 class="card-title">Saludo</h2>
      <label class="field"><span>Su nombre (aparece en el saludo de inicio)</span>
        <input class="input" id="userName" type="text" maxlength="30" value="${esc(s.userName)}" placeholder="Por ejemplo: Vale" autocomplete="given-name">
      </label>
    </div>

    <div class="card">
      <h2 class="card-title">Categorías</h2>
      <ul class="cat-list">
        ${sortedCats().map((c, i, arr) => `
          <li style="--c:${esc(c.color)}">
            <span class="cat-dot big"></span>
            <span class="cat-name">${esc(c.name)}</span>
            <span class="muted small">${counts.get(c.id) || 0}</span>
            <button type="button" class="icon-btn small" data-catup="${esc(c.id)}" aria-label="Subir ${esc(c.name)}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn small" data-catedit="${esc(c.id)}" aria-label="Editar ${esc(c.name)}">✎</button>
            <button type="button" class="icon-btn small" data-catdel="${esc(c.id)}" aria-label="Borrar ${esc(c.name)}">🗑</button>
          </li>`).join('')}
      </ul>
      <button type="button" class="btn soft full-w" id="addCat">+ Nueva categoría</button>
    </div>

    <div class="card">
      <h2 class="card-title">Inteligencia artificial <small>(opcional)</small></h2>
      <p class="muted">Sin clave, IdeaShel Vale funciona completa y las funciones de IA quedan ocultas. Elija un proveedor:</p>
      <label class="radio-row standalone"><input type="radio" name="aiProv" value="none" ${s.aiProvider === 'none' ? 'checked' : ''}><span>Sin IA</span></label>
      ${keyField('gemini', 'Gemini de Google · nivel gratuito', s.geminiKey, 'Pegue su clave de Google AI Studio')}
      ${keyField('claude', 'Claude de Anthropic · pago por uso', s.claudeKey, 'Pegue su clave sk-ant-…')}
      <p class="lock-note">🔒 Su clave queda guardada solo en este teléfono. IdeaShel Vale la envía únicamente al proveedor elegido (Google o Anthropic) cuando usted pide una función de IA, y nunca se incluye en los respaldos.</p>
      ${(s.geminiKey || s.claudeKey) ? '<button type="button" class="btn danger-ghost full-w" id="delAllKeys">Borrar todas las claves</button>' : ''}
    </div>

    <div class="card" id="personalizeCard">
      <h2 class="card-title">✨ Personalizar la IA</h2>
      <p class="muted">Cuéntele a la IA quién es usted y cómo prefiere sus notas. Se usa en todas las funciones de IA.</p>
      <label class="field"><span>Sobre usted (contexto)</span>
        <textarea class="input" id="aiAbout" rows="3" maxlength="1500" placeholder="Ej.: Trabajo en una planta industrial en Concepción. En mis reuniones se habla de proveedores, residuos y seguridad.">${esc(s.aiAbout)}</textarea>
      </label>
      <label class="field"><span>Cómo quiere las respuestas</span>
        <textarea class="input" id="aiInstructions" rows="3" maxlength="1500" placeholder="Ej.: Notas cortas, con viñetas, y siempre una lista de tareas con responsables.">${esc(s.aiInstructions)}</textarea>
      </label>
      <label class="switch-row"><span>Organizar automáticamente las grabaciones nuevas</span><input type="checkbox" id="autoOrg" ${s.autoOrganize ? 'checked' : ''}><i></i></label>
      <p class="muted small">Con Gemini, las grabaciones se transcriben y organizan solas al terminar. Con Claude se organiza el texto dictado (Claude no escucha audios).</p>
    </div>

    <div class="card">
      <h2 class="card-title">Respaldo</h2>
      <p class="muted">Último respaldo: <strong>${s.lastBackupAt ? esc(fmtFull(s.lastBackupAt)) : 'nunca'}</strong></p>
      <div class="btn-col">
        <button type="button" class="btn primary" id="doExport">Exportar respaldo (JSON)</button>
        <button type="button" class="btn soft" id="doImport">Importar respaldo</button>
      </div>
      <label class="switch-row"><span>Incluir audios en el respaldo (archivo más pesado)</span><input type="checkbox" id="bkAudio" ${s.backupAudio ? 'checked' : ''}><i></i></label>
      <p class="muted small" id="storageUse"></p>
      <label class="field"><span>Recordarme respaldar</span>
        <select class="select" id="remindSel">
          ${[[0, 'Nunca'], [3, 'Cada 3 días'], [7, 'Cada semana'], [14, 'Cada 2 semanas'], [30, 'Cada mes']].map(([v, l]) => `<option value="${v}" ${Number(s.backupEveryDays) === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>

    <div class="card">
      <h2 class="card-title">Apariencia</h2>
      <div class="segmented" role="radiogroup" aria-label="Tema">
        ${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${s.theme === v}" class="${s.theme === v ? 'on' : ''}" data-theme-set="${v}">${l}</button>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Voz y grabación</h2>
      <p class="muted">${audioSupported ? 'Las grabaciones guardan el audio en este teléfono.' : voiceSupported ? 'Este navegador permite dictado por voz (sin guardar audio).' : 'La grabación con botón no está disponible aquí; use el micrófono del teclado.'}</p>
      ${audioSupported && voiceSupported ? `<label class="switch-row"><span>Transcripción en vivo mientras graba</span><input type="checkbox" id="liveTr" ${s.liveTranscript ? 'checked' : ''}><i></i></label>
      <p class="muted small">Si en su iPhone la transcripción en vivo falla, desactívela: el audio se graba igual y la IA lo transcribe después.</p>` : ''}
      <label class="field"><span>Idioma del reconocimiento</span>
        <select class="select" id="langSel">${VOICE_LANGS.map((l) => `<option value="${l.id}" ${s.voiceLang === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}</select>
      </label>
    </div>

    <div class="card">
      <h2 class="card-title">Papelera</h2>
      <p class="muted">Las ideas borradas se guardan ${TRASH_DAYS} días antes de eliminarse para siempre.</p>
      <button type="button" class="btn soft full-w" id="openTrash">Ver papelera (${trash})</button>
    </div>

    <div class="card about">
      <h2 class="card-title">Acerca de IdeaShel Vale</h2>
      <p class="muted">Versión ${APP_VERSION} · Funciona sin internet · Sus datos viven solo en este teléfono.</p>
      <p class="muted small" id="storageInfo">${state.persisted === true ? '✓ Almacenamiento protegido contra borrado automático.' : state.persisted === false ? 'Consejo: instale IdeaShel Vale en la pantalla de inicio para proteger mejor sus datos y haga respaldos periódicos.' : ''}</p>
    </div>`;

  // Categorías
  view.querySelector('#addCat').onclick = () => editCategory(null);
  view.querySelectorAll('[data-catedit]').forEach((b) => { b.onclick = () => editCategory(b.dataset.catedit); });
  view.querySelectorAll('[data-catdel]').forEach((b) => { b.onclick = () => deleteCategory(b.dataset.catdel); });
  view.querySelectorAll('[data-catup]').forEach((b) => {
    b.onclick = async () => {
      const list = sortedCats();
      const i = list.findIndex((c) => c.id === b.dataset.catup);
      if (i <= 0) return;
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      list.forEach((c, idx) => { c.order = idx; });
      try { await db.bulkPut('categories', list); } catch (err) { storageFailed(err); }
      renderSettings();
      renderIdeas();
    };
  });

  // IA
  view.querySelectorAll('input[name="aiProv"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const prov = r.value;
      if (prov !== 'none' && !(prov === 'gemini' ? s.geminiKey : s.claudeKey)) {
        await setSetting('aiProvider', prov);
        renderSettings();
        $(`#key-${prov}`)?.focus();
        toast('Pegue su clave y toque “Guardar clave”.');
        return;
      }
      await setSetting('aiProvider', prov);
      renderSettings();
      toast(prov === 'none' ? 'IA desactivada.' : `IA activada con ${prov === 'gemini' ? 'Gemini' : 'Claude'}.`);
    });
  });
  view.querySelectorAll('[data-toggle-key]').forEach((b) => {
    b.onclick = () => { const inp = $(`#key-${b.dataset.toggleKey}`); inp.type = inp.type === 'password' ? 'text' : 'password'; };
  });
  view.querySelectorAll('[data-savekey]').forEach((b) => {
    b.onclick = async () => {
      const prov = b.dataset.savekey;
      const val = $(`#key-${prov}`).value.trim().replace(/\s+/g, '');
      const status = $(`#status-${prov}`);
      if (!val) { status.textContent = 'Pegue una clave primero.'; status.className = 'key-status err'; return; }
      if (prov === 'claude' && !val.startsWith('sk-ant-')) {
        status.textContent = 'Las claves de Claude empiezan con “sk-ant-”. Revise que la copió completa.';
        status.className = 'key-status err';
        return;
      }
      await setSetting(prov === 'gemini' ? 'geminiKey' : 'claudeKey', val);
      await setSetting(prov === 'gemini' ? 'geminiModel' : 'claudeModel', $(`#model-${prov}`).value);
      await setSetting('aiProvider', prov);
      renderSettings();
      toast('Clave guardada en este teléfono. Probando conexión…');
      testKey(prov);
    };
  });
  view.querySelectorAll('[data-testkey]').forEach((b) => { b.onclick = () => testKey(b.dataset.testkey); });
  view.querySelectorAll('select[id^="model-"]').forEach((sel) => {
    sel.onchange = async () => {
      const prov = sel.id.replace('model-', '');
      await setSetting(prov === 'gemini' ? 'geminiModel' : 'claudeModel', sel.value);
      toast('Modelo actualizado.');
    };
  });
  view.querySelectorAll('[data-delkey]').forEach((b) => {
    b.onclick = async () => {
      const prov = b.dataset.delkey;
      const ok = await confirmDialog('¿Borrar la clave?', `Se borrará la clave de ${prov === 'gemini' ? 'Gemini' : 'Claude'} de este teléfono.`, 'Borrar', true);
      if (!ok) return;
      await setSetting(prov === 'gemini' ? 'geminiKey' : 'claudeKey', '');
      if (s.aiProvider === prov) await setSetting('aiProvider', 'none');
      renderSettings();
      toast('Clave borrada.');
    };
  });
  view.querySelector('#delAllKeys')?.addEventListener('click', async () => {
    const ok = await confirmDialog('¿Borrar todas las claves?', 'Se borrarán las claves de Gemini y Claude de este teléfono y se desactivará la IA.', 'Borrar todo', true);
    if (!ok) return;
    await setSetting('geminiKey', '');
    await setSetting('claudeKey', '');
    await setSetting('aiProvider', 'none');
    renderSettings();
    toast('Claves borradas.');
  });

  // Respaldo
  view.querySelector('#doExport').onclick = exportBackup;
  view.querySelector('#doImport').onclick = () => $('#importFile').click();
  view.querySelector('#remindSel').onchange = async (e) => {
    await setSetting('backupEveryDays', Number(e.target.value));
    toast(Number(e.target.value) ? 'Recordatorio actualizado.' : 'Recordatorio desactivado.');
  };

  // Tema y voz
  view.querySelectorAll('[data-theme-set]').forEach((b) => {
    b.onclick = async () => { await setSetting('theme', b.dataset.themeSet); applyTheme(); renderSettings(); };
  });
  view.querySelector('#langSel').onchange = async (e) => { await setSetting('voiceLang', e.target.value); toast('Idioma de voz actualizado.'); };
  view.querySelector('#liveTr')?.addEventListener('change', (e) => setSetting('liveTranscript', e.target.checked));
  view.querySelector('#bkAudio').addEventListener('change', (e) => setSetting('backupAudio', e.target.checked));
  view.querySelector('#autoOrg').addEventListener('change', (e) => setSetting('autoOrganize', e.target.checked));
  view.querySelector('#userName').addEventListener('change', async (e) => { await setSetting('userName', e.target.value.trim()); toast('Saludo actualizado.'); });
  const saveText = (id, key) => {
    const el = view.querySelector(id);
    const fn = debounce(() => setSetting(key, el.value.trim()), 500);
    el.addEventListener('input', fn);
    el.addEventListener('blur', () => fn.flush());
  };
  saveText('#aiAbout', 'aiAbout');
  saveText('#aiInstructions', 'aiInstructions');
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      const el = $('#storageUse');
      if (el && Number.isFinite(usage)) el.textContent = `Espacio usado por IdeaShel Vale en este teléfono: ${(usage / 1048576).toFixed(1).replace('.', ',')} MB.`;
    }).catch(() => {});
  }

  view.querySelector('#openTrash').onclick = openTrash;
}

async function testKey(prov) {
  const s = state.settings;
  const status = $(`#status-${prov}`);
  const key = prov === 'gemini' ? s.geminiKey : s.claudeKey;
  if (!key || !status) return;
  status.className = 'key-status';
  status.innerHTML = '<span class="spinner"></span> Probando conexión…';
  try {
    await AI.testConnection({ provider: prov, key, model: prov === 'gemini' ? s.geminiModel : s.claudeModel });
    status.className = 'key-status ok';
    status.textContent = '✓ Conexión correcta. Las funciones de IA ya están disponibles.';
  } catch (err) {
    status.className = 'key-status err';
    status.textContent = err instanceof AI.AIError ? err.message : 'No se pudo probar la clave.';
  }
}

async function editCategory(id) {
  const cat = id ? catById(id) : null;
  const current = cat ? cat.color : CAT_COLORS[state.categories.length % CAT_COLORS.length];
  const res = await dialog({
    title: cat ? 'Editar categoría' : 'Nueva categoría',
    input: {
      value: cat ? cat.name : '',
      placeholder: 'Nombre (por ejemplo: Viajes)',
      maxlength: 40,
      extraHtml: `<div class="color-pick" role="radiogroup" aria-label="Color">${CAT_COLORS.map((c) => `<label style="--c:${c}"><input type="radio" name="catColor" value="${c}" ${c === current ? 'checked' : ''}><span></span></label>`).join('')}</div>`
    },
    buttons: [{ label: 'Cancelar', value: false, style: 'ghost' }, { label: 'Guardar', value: true, style: 'primary' }]
  });
  if (!res || !res.value) return;
  const color = res.el.querySelector('input[name="catColor"]:checked')?.value || current;
  const dup = state.categories.find((c) => normalize(c.name) === normalize(res.value) && c.id !== id);
  if (dup) { toast('Ya existe una categoría con ese nombre.'); return; }
  if (cat) {
    cat.name = res.value;
    cat.color = color;
    await persistCategory(cat);
  } else {
    await persistCategory({ id: uid(), name: res.value, color, order: state.categories.length });
  }
  renderSettings();
  renderIdeas();
  toast('Categoría guardada.');
}

async function deleteCategory(id) {
  const cat = catById(id);
  if (!cat) return;
  const n = state.ideas.filter((i) => i.category === id).length;
  const ok = await confirmDialog(`¿Borrar “${cat.name}”?`, n ? `Sus ${n} ideas no se borran: quedarán como “Sin categoría”.` : 'La categoría está vacía.', 'Borrar categoría', true);
  if (!ok) return;
  try {
    const affected = state.ideas.filter((i) => i.category === id);
    affected.forEach((i) => { i.category = null; });
    if (affected.length) await db.bulkPut('ideas', affected);
    await db.delete('categories', id);
    state.categories = state.categories.filter((c) => c.id !== id);
    if (state.filters.category === id) state.filters.category = 'all';
  } catch (err) {
    storageFailed(err);
  }
  renderSettings();
  renderIdeas();
}

function openTrash() {
  const s = openSheet({ label: 'Papelera', className: 'trash', html: '' });
  const render = () => {
    const list = trashIdeas().sort((a, b) => b.deletedAt - a.deletedAt);
    s.el.innerHTML = `
      <div class="sheet-grabber"></div>
      <h2 class="sheet-title">Papelera</h2>
      ${list.length ? `<ul class="trash-list">${list.map((i) => {
        const left = Math.max(0, TRASH_DAYS - daysBetween(i.deletedAt, Date.now()));
        return `<li><div><strong>${esc(i.title)}</strong><span class="muted small">Se elimina en ${left} ${left === 1 ? 'día' : 'días'}</span></div>
          <button type="button" class="btn soft small" data-restore="${esc(i.id)}">Restaurar</button>
          <button type="button" class="icon-btn small" data-purge="${esc(i.id)}" aria-label="Eliminar para siempre">🗑</button></li>`;
      }).join('')}</ul>
      <button type="button" class="btn danger-ghost full-w" id="emptyTrash">Vaciar papelera</button>`
        : '<p class="muted center">La papelera está vacía.</p>'}
      <div class="dlg-actions"><button type="button" class="btn primary" id="trashClose">Cerrar</button></div>`;
    s.el.querySelector('#trashClose').onclick = () => s.close();
    s.el.querySelectorAll('[data-restore]').forEach((b) => {
      b.onclick = async () => {
        const idea = state.ideas.find((i) => i.id === b.dataset.restore);
        idea.deletedAt = null;
        await persistIdea(idea, { touch: false });
        toast('Idea restaurada.');
        render(); renderIdeas(); renderSettings();
      };
    });
    s.el.querySelectorAll('[data-purge]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog('¿Eliminar para siempre?', 'Esta idea se borrará definitivamente. No se puede deshacer.', 'Eliminar', true))) return;
        try { await db.delete('ideas', b.dataset.purge); } catch (err) { storageFailed(err); return; }
        await deleteAudios([b.dataset.purge]);
        state.ideas = state.ideas.filter((i) => i.id !== b.dataset.purge);
        render(); renderSettings();
      };
    });
    s.el.querySelector('#emptyTrash')?.addEventListener('click', async () => {
      const ids = trashIdeas().map((i) => i.id);
      if (!(await confirmDialog('¿Vaciar la papelera?', `Se eliminarán para siempre ${ids.length} ideas. No se puede deshacer.`, 'Vaciar', true))) return;
      try { await db.bulkDelete('ideas', ids); } catch (err) { storageFailed(err); return; }
      await deleteAudios(ids);
      state.ideas = state.ideas.filter((i) => !ids.includes(i.id));
      render(); renderSettings();
    });
  };
  render();
}

// ---------------------------------------------------------------- sistema

function setupOnline() {
  const pill = $('#offlinePill');
  const update = () => { pill.hidden = navigator.onLine; };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      state.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch (e) { state.persisted = null; }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const notify = (worker) => {
      toast('Hay una nueva versión de IdeaShel Vale.', { action: 'Actualizar', duration: 10000, onAction: () => worker.postMessage('skipWaiting') });
    };
    if (reg.waiting && hadController) notify(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) notify(nw);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('Service worker no registrado:', err));
}

async function init() {
  applyTheme();
  try {
    await loadData();
  } catch (err) {
    state.storageOk = false;
    console.error(err);
    state.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    showBanner(`<span>⚠️ ${esc(err.message || 'No se pudo abrir el almacenamiento del teléfono.')} Las ideas nuevas podrían no guardarse.</span>`, 'error');
  }
  applyTheme();
  setupCapture();
  setupSearch();
  document.body.dataset.view = 'ideas';
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#viewToggle').addEventListener('click', async () => {
    await setSetting('viewMode', state.settings.viewMode === 'list' ? 'grid' : 'list');
    if (state.view !== 'ideas') setView('ideas'); else renderIdeas();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await importBackup(f);
  });
  renderIdeas();
  setupOnline();
  registerSW();
  if (state.storageOk) {
    await purgeTrash();
    checkBackupReminder();
    checkDueReminders();
    requestPersist();
  }
  document.documentElement.classList.add('ready');
}

window.addEventListener('unhandledrejection', (e) => console.error('Error no controlado:', e.reason));

init();
