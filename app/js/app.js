// Chispa · captura y organización de ideas por voz
import { db, loadSettings, saveSetting } from './db.js';
import * as AI from './ai.js';
import { Dictation, voiceSupported, voiceErrorMessage, VOICE_LANGS } from './voice.js';
import {
  $, $$, esc, uid, debounce, normalize, normTag, extractHashtags, autoTitle,
  fmtFull, fmtShortDate, fmtRelative, daysBetween, stamp
} from './util.js';

const APP_VERSION = '1.0.0';
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
  initialized: false
};

const state = {
  ideas: [],
  categories: [],
  settings: { ...DEFAULT_SETTINGS },
  filters: { q: '', category: 'all', tag: '', fav: false, status: '', archived: false },
  view: 'ideas',
  storageOk: true,
  persisted: null,
  randomId: null,
  organizeResult: null
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
  if (s.aiProvider === 'gemini' && s.geminiKey) return { provider: 'gemini', key: s.geminiKey, model: s.geminiModel };
  if (s.aiProvider === 'claude' && s.claudeKey) return { provider: 'claude', key: s.claudeKey, model: s.claudeModel };
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

function openSheet({ html, full = false, label = '', className = '', onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = `sheet ${full ? 'full' : ''} ${className}`.trim();
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
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) api.close(); });
  sheetStack.push(api);
  return api;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetStack.length) sheetStack[sheetStack.length - 1].close();
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
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (view === 'explore') renderExplore();
  if (view === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- captura

const dictation = new Dictation();

function setupCapture() {
  const recBtn = $('#recBtn');
  const hint = $('#recHint');
  const text = $('#newText');
  if (!voiceSupported) {
    $('#voiceArea').hidden = true;
    const n = $('#voiceUnavailable');
    n.hidden = false;
    n.innerHTML = '🎙️ La grabación con botón no está disponible en este navegador. ' +
      'No se preocupe: toque el cuadro de texto y use el <strong>micrófono del teclado del iPhone</strong> para dictar su idea.';
  }

  let base = '';
  let timer = null;
  let started = 0;
  const stopUI = () => {
    recBtn.classList.remove('recording');
    recBtn.setAttribute('aria-pressed', 'false');
    recBtn.setAttribute('aria-label', 'Grabar idea por voz');
    clearInterval(timer);
    hint.textContent = text.value.trim() ? 'Revise el texto y toque “Guardar idea”' : 'Toque para grabar su idea';
  };

  recBtn.addEventListener('click', () => {
    if (dictation.active) { dictation.stop(); return; }
    base = text.value.trim();
    dictation.start({
      lang: state.settings.voiceLang || 'es-CL',
      onStart: () => {
        recBtn.classList.add('recording');
        recBtn.setAttribute('aria-pressed', 'true');
        recBtn.setAttribute('aria-label', 'Detener grabación');
        started = Date.now();
        hint.textContent = 'Escuchando… toque para terminar · 0:00';
        clearInterval(timer);
        timer = setInterval(() => {
          const s = Math.floor((Date.now() - started) / 1000);
          hint.textContent = `Escuchando… toque para terminar · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 500);
      },
      onText: (fin, interim) => {
        const spoken = [fin, interim].filter(Boolean).join(' ');
        text.value = [base, spoken].filter(Boolean).join(base && spoken ? ' ' : '');
        autoGrow(text);
      },
      onEnd: () => {
        stopUI();
        if (text.value.trim()) $('#saveNewBtn').focus({ preventScroll: true });
      },
      onError: (code) => {
        stopUI();
        if (code === 'no-speech') toast(voiceErrorMessage(code));
        else alertDialog('Grabación por voz', voiceErrorMessage(code));
      }
    });
  });

  text.addEventListener('input', () => autoGrow(text));
  $('#saveNewBtn').addEventListener('click', saveNew);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNew();
  });
  $('#newCategory').addEventListener('change', (e) => { state.lastCategory = e.target.value; });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 320) + 'px';
}

async function saveNew() {
  const textEl = $('#newText');
  const text = textEl.value.trim();
  if (!text) {
    toast('Primero grabe o escriba su idea.');
    textEl.focus();
    return;
  }
  if (dictation.active) dictation.stop();
  const idea = newIdea(text, $('#newCategory').value || null);
  const ok = await persistIdea(idea, { touch: false });
  if (!ok) return;
  textEl.value = '';
  autoGrow(textEl);
  $('#recHint').textContent = 'Toque para grabar su idea';
  renderIdeas();
  toast('Idea guardada ✨', { action: 'Abrir', onAction: () => openEditor(idea.id) });
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
  state.filters = { q: state.filters.q, category: 'all', tag: '', fav: false, status: '', archived: false };
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
  if (terms.length) {
    list = list.filter((i) => {
      const hay = normalize([i.title, i.text, i.summary, (i.tags || []).join(' '), catById(i.category)?.name, (i.steps || []).map((s) => s.text).join(' ')].join(' '));
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

function ideaCard(idea) {
  const cat = catById(idea.category);
  const q = state.filters.q;
  const snippetSrc = idea.summary || idea.text || '';
  const snippet = snippetSrc.length > 180 ? snippetSrc.slice(0, 177) + '…' : snippetSrc;
  const steps = idea.steps || [];
  const done = steps.filter((s) => s.done).length;
  const status = idea.status || 'nueva';
  return `
  <article class="idea-card ${idea.pinned ? 'pinned' : ''}" style="--c:${esc(cat ? cat.color : '#9A93B5')}">
    <button type="button" class="card-open" data-open="${esc(idea.id)}" aria-label="Abrir idea: ${esc(idea.title)}"></button>
    <div class="card-top">
      <span class="cat-badge"><span class="cat-dot"></span>${esc(cat ? cat.name : 'Sin categoría')}</span>
      ${idea.pinned ? '<span class="mini-pill">📌 Fijada</span>' : ''}
      ${status !== 'nueva' ? `<span class="mini-pill status-${status}">${esc(STATUS[status])}</span>` : ''}
      <time datetime="${new Date(idea.createdAt).toISOString()}">${esc(fmtRelative(idea.createdAt))}</time>
    </div>
    <h3>${highlight(idea.title || 'Idea sin título', q)}</h3>
    ${snippet ? `<p class="snippet">${highlight(snippet, q)}</p>` : ''}
    <div class="card-foot">
      ${(idea.tags || []).slice(0, 5).map((t) => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
      ${steps.length ? `<span class="mini-pill">☑ ${done}/${steps.length}</span>` : ''}
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

function renderIdeas() {
  renderChips();
  const sel = $('#newCategory');
  const current = sel.value || state.lastCategory || (state.filters.category !== 'all' && state.filters.category !== 'none' ? state.filters.category : '');
  sel.innerHTML = categoryOptions(current);

  const list = filteredIdeas();
  const f = state.filters;
  const active = [];
  if (f.tag) active.push(`<button type="button" class="chip small on" data-clear="tag">#${esc(f.tag)} ✕</button>`);
  if (f.status) active.push(`<button type="button" class="chip small on" data-clear="status">${esc(STATUS[f.status])} ✕</button>`);
  if (f.archived) active.push(`<button type="button" class="chip small on" data-clear="archived">Archivadas ✕</button>`);
  const total = activeIdeas().filter((i) => !i.archived).length;
  $('#activeFilters').innerHTML = (total ? `<span class="count">${list.length} ${list.length === 1 ? 'idea' : 'ideas'}</span>` : '') + active.join('');
  $('#filterDot').hidden = !(f.tag || f.status || f.archived || (state.settings.sort && state.settings.sort !== 'new'));

  $('#ideaList').innerHTML = list.map(ideaCard).join('');
  const empty = $('#emptyState');
  if (list.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    if (!activeIdeas().length) {
      empty.innerHTML = `<div class="empty-art" aria-hidden="true">✦</div>
        <h3>Su primera chispa</h3>
        <p>Toque el botón morado y diga su idea en voz alta, o escríbala arriba. Todo queda guardado solo en este teléfono.</p>`;
    } else {
      empty.innerHTML = `<div class="empty-art" aria-hidden="true">🔍</div>
        <h3>No hay ideas con estos filtros</h3>
        <p>Pruebe con otra búsqueda o limpie los filtros.</p>
        <button type="button" class="btn ghost" data-clear="all" id="clearAllBtn">Limpiar filtros</button>`;
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

function openEditor(id) {
  const idea = state.ideas.find((i) => i.id === id);
  if (!idea) return;
  const ai = aiConfig();
  const s = openSheet({
    full: true,
    label: 'Editar idea',
    className: 'editor',
    onClose: () => { save.flush(); renderIdeas(); if (state.view === 'explore') renderExplore(); },
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
        <label class="field"><span>Idea</span>
          <textarea class="input" id="edText" rows="7">${esc(idea.text)}</textarea>
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
        <label class="switch-row"><span>📌 Fijar arriba en la lista</span><input type="checkbox" id="edPin" ${idea.pinned ? 'checked' : ''}><i></i></label>
        <label class="switch-row"><span>🗄️ Archivar (ocultar de la lista)</span><input type="checkbox" id="edArch" ${idea.archived ? 'checked' : ''}><i></i></label>

        <section class="block" id="summaryBlock"></section>
        <section class="block" id="stepsBlock"></section>

        ${ai ? `
        <section class="block ai-block">
          <h3 class="block-title">✨ Asistente IA <small>${ai.provider === 'gemini' ? 'Gemini' : 'Claude'}</small></h3>
          <div class="ai-actions">
            <button type="button" class="btn soft" data-ai="summary">Resumir</button>
            <button type="button" class="btn soft" data-ai="suggest">Sugerir título, categoría y etiquetas</button>
            <button type="button" class="btn soft" data-ai="steps">Convertir en lista de pasos</button>
            <button type="button" class="btn soft" data-ai="expand">Expandir idea</button>
          </div>
          <div id="aiResult" class="ai-result" hidden></div>
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
    if (idea.titleAuto) { idea.title = autoTitle(idea.text); titleEl.value = idea.title; }
    autoGrow(textEl);
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
    toast(idea.archived ? 'Idea archivada. Puede verla en Filtros → Ver archivadas.' : 'Idea de vuelta en la lista.');
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
      <h3 class="block-title">Pasos ${steps.length ? `<small>${done}/${steps.length} hechos</small>` : ''}</h3>
      ${steps.length ? `<div class="progress"><span style="width:${steps.length ? Math.round((done / steps.length) * 100) : 0}%"></span></div>` : ''}
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
  renderSummary();
  renderSteps();

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
        if (edDict.active) edDict.stop();
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
        idea.title = autoTitle(idea.text);
        idea.titleAuto = true;
        titleEl.value = idea.title;
        save();
        break;
      case 'share':
        shareIdea(idea);
        break;
      case 'copy':
        copyText(ideaAsText(idea));
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
            if (idea.titleAuto) { idea.title = autoTitle(idea.text); titleEl.value = idea.title; }
            autoGrow(textEl);
            save();
          },
          onEnd: () => { btn.classList.remove('recording'); btn.textContent = '🎙️ Dictar y agregar al texto'; },
          onError: (code) => {
            btn.classList.remove('recording');
            btn.textContent = '🎙️ Dictar y agregar al texto';
            if (code === 'no-speech') toast(voiceErrorMessage(code)); else alertDialog('Dictado', voiceErrorMessage(code));
          }
        });
        break;
      }
      case 'delete': {
        const ok = await confirmDialog('¿Mover a la papelera?', `“${idea.title}” quedará en la papelera por ${TRASH_DAYS} días y podrá restaurarla desde Ajustes.`, 'Mover a la papelera', true);
        if (!ok) return;
        if (edDict.active) edDict.stop();
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
  const lines = [idea.title, '', idea.text];
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
      <div class="stat"><b>${favs}</b><span>favoritas</span></div>
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
  const lines = [`# Mis ideas en Chispa`, ``, `Exportado el ${fmtFull(Date.now())} · ${ideas.length} ideas`, ``];
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
  await shareOrDownload(blob, `chispa-ideas-${stamp()}.md`, 'Mis ideas (Chispa)');
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

function buildBackup() {
  const s = state.settings;
  return {
    app: 'chispa',
    format: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    ideas: state.ideas,
    categories: state.categories,
    // Nunca se exportan las claves de IA
    settings: { theme: s.theme, voiceLang: s.voiceLang, backupEveryDays: s.backupEveryDays, sort: s.sort }
  };
}

async function exportBackup() {
  const data = buildBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const ok = await shareOrDownload(blob, `chispa-respaldo-${stamp()}.json`, 'Respaldo de Chispa');
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
    await alertDialog('No se pudo importar', 'El archivo no es un respaldo válido (el JSON está dañado o no es de Chispa).');
    return;
  }
  if (!data || !Array.isArray(data.ideas)) {
    await alertDialog('No se pudo importar', 'El archivo no parece un respaldo de Chispa: no contiene una lista de ideas.');
    return;
  }
  const ideas = data.ideas.map(sanitizeIdea).filter(Boolean);
  const cats = (Array.isArray(data.categories) ? data.categories : []).map(sanitizeCategory).filter(Boolean);
  const when = data.exportedAt ? ` del ${fmtFull(toTs(data.exportedAt, Date.now()))}` : '';
  const mode = await dialog({
    title: 'Importar respaldo',
    message: `El respaldo${when} tiene ${ideas.length} ideas y ${cats.length} categorías. ¿Cómo desea importarlo?`,
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
      <p class="muted">Sin clave, Chispa funciona completa y las funciones de IA quedan ocultas. Elija un proveedor:</p>
      <label class="radio-row standalone"><input type="radio" name="aiProv" value="none" ${s.aiProvider === 'none' ? 'checked' : ''}><span>Sin IA</span></label>
      ${keyField('gemini', 'Gemini de Google · nivel gratuito', s.geminiKey, 'Pegue su clave de Google AI Studio')}
      ${keyField('claude', 'Claude de Anthropic · pago por uso', s.claudeKey, 'Pegue su clave sk-ant-…')}
      <p class="lock-note">🔒 Su clave queda guardada solo en este teléfono. Chispa la envía únicamente al proveedor elegido (Google o Anthropic) cuando usted pide una función de IA, y nunca se incluye en los respaldos.</p>
      ${(s.geminiKey || s.claudeKey) ? '<button type="button" class="btn danger-ghost full-w" id="delAllKeys">Borrar todas las claves</button>' : ''}
    </div>

    <div class="card">
      <h2 class="card-title">Respaldo</h2>
      <p class="muted">Último respaldo: <strong>${s.lastBackupAt ? esc(fmtFull(s.lastBackupAt)) : 'nunca'}</strong></p>
      <div class="btn-col">
        <button type="button" class="btn primary" id="doExport">Exportar respaldo (JSON)</button>
        <button type="button" class="btn soft" id="doImport">Importar respaldo</button>
      </div>
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
      <h2 class="card-title">Voz</h2>
      <p class="muted">${voiceSupported ? 'La grabación por voz está disponible en este navegador.' : 'La grabación con botón no está disponible aquí; use el micrófono del teclado.'}</p>
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
      <h2 class="card-title">Acerca de Chispa</h2>
      <p class="muted">Versión ${APP_VERSION} · Funciona sin internet · Sus datos viven solo en este teléfono.</p>
      <p class="muted small" id="storageInfo">${state.persisted === true ? '✓ Almacenamiento protegido contra borrado automático.' : state.persisted === false ? 'Consejo: instale Chispa en la pantalla de inicio para proteger mejor sus datos y haga respaldos periódicos.' : ''}</p>
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
        state.ideas = state.ideas.filter((i) => i.id !== b.dataset.purge);
        render(); renderSettings();
      };
    });
    s.el.querySelector('#emptyTrash')?.addEventListener('click', async () => {
      const ids = trashIdeas().map((i) => i.id);
      if (!(await confirmDialog('¿Vaciar la papelera?', `Se eliminarán para siempre ${ids.length} ideas. No se puede deshacer.`, 'Vaciar', true))) return;
      try { await db.bulkDelete('ideas', ids); } catch (err) { storageFailed(err); return; }
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
      toast('Hay una nueva versión de Chispa.', { action: 'Actualizar', duration: 10000, onAction: () => worker.postMessage('skipWaiting') });
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
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
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
    requestPersist();
  }
  document.documentElement.classList.add('ready');
}

window.addEventListener('unhandledrejection', (e) => console.error('Error no controlado:', e.reason));

init();
