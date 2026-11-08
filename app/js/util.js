// Utilidades generales de Chispa

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function uid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function debounce(fn, ms = 400) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

/** Minúsculas y sin tildes, para buscar sin importar acentos. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function normTag(tag) {
  return String(tag ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 30);
}

const HASHTAG_RE = /#([\p{L}\p{N}_-]{2,30})/gu;

export function extractHashtags(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(HASHTAG_RE)) out.add(normTag(m[1]));
  return [...out];
}

const FILLERS = /^(eh+|em+|mm+|este|bueno|ya|ok|okay|entonces|o sea|mira|oye|pues|a ver|ah+|y)[,.\s]+/i;

/** Genera un título corto a partir del texto de la idea. */
export function autoTitle(text) {
  let t = String(text ?? '').replace(HASHTAG_RE, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) t = t.replace(FILLERS, '');
  if (!t) return 'Idea sin título';
  const firstSentence = (t.match(/^[^.!?\n]+/) || [t])[0].trim();
  const words = firstSentence.split(' ').filter(Boolean);
  let title = words.slice(0, 8).join(' ').replace(/[,;:]+$/, '');
  if (title.length > 60) title = title.slice(0, 57).trim() + '…';
  else if (words.length > 8) title += '…';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

const dateFmt = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeStyle: 'short' });

export function fmtFull(ts) {
  return ts ? fullFmt.format(new Date(ts)) : '';
}

export function fmtShortDate(ts) {
  return ts ? dateFmt.format(new Date(ts)) : '';
}

/** "hoy 14:32", "ayer 09:10" o "3 nov 2026". */
export function fmtRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) return 'hoy ' + timeFmt.format(d);
  if (ts >= startOfToday - 86400000) return 'ayer ' + timeFmt.format(d);
  return dateFmt.format(d);
}

export function daysBetween(a, b) {
  return Math.floor(Math.abs(b - a) / 86400000);
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
}
