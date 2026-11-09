// Funciones "inteligentes" que funcionan sin internet y sin IA:
// fechas en español, tareas en el texto, ideas parecidas y categoría sugerida.
import { normalize } from './util.js';

// ---------------------------------------------------------------- fechas

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUM_WORDS = { una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };

function atTime(d, h, m = 0) {
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
}

/** Busca la hora: "a las 9", "a las 15:30", "9:30", "a las 3 de la tarde", "al mediodía". */
function findTime(t) {
  if (/\bmediodia\b/.test(t)) return { h: 12, m: 0, text: 'mediodía' };
  const re = /\b(?:a las?|tipo|como a las?)\s+(\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:[:.](\d{2}))?\s*(?:hrs?|horas)?\s*(de la (manana|tarde|noche)|am|pm|a\.m\.|p\.m\.)?/;
  const re2 = /\b(\d{1,2})[:.](\d{2})\s*(hrs?|horas|am|pm)?\b/;
  let m = t.match(re);
  let h;
  let min = 0;
  let suffix = '';
  if (m) {
    h = NUM_WORDS[m[1]] || Number(m[1]);
    min = m[2] ? Number(m[2]) : 0;
    suffix = m[3] || '';
  } else if ((m = t.match(re2))) {
    h = Number(m[1]);
    min = Number(m[2]);
    suffix = m[3] || '';
  } else {
    return null;
  }
  if (h > 23 || min > 59) return null;
  if (/tarde|noche|pm|p\.m\./.test(suffix) && h < 12) h += 12;
  // "a las 3" sin "de la mañana" → lo más probable es la tarde
  if (!suffix && h >= 1 && h <= 7) h += 12;
  return { h, m: min, text: m[0] };
}

/**
 * Detecta una fecha/hora en un texto en español.
 * Devuelve { ts, label } o null. Ej.: "mañana a las 9", "el viernes", "martes 18", "18 de noviembre", "en 2 horas".
 */
export function parseDateES(text, now = new Date()) {
  const t = normalize(text);
  const base = new Date(now);
  let day = null;
  let label = '';

  let m;
  if ((m = t.match(/\ben (\d{1,2}|una|dos|tres|cuatro|cinco|seis) (hora|horas|minuto|minutos)\b/))) {
    const n = NUM_WORDS[m[1]] || Number(m[1]);
    const ms = m[2].startsWith('hora') ? n * 3600000 : n * 60000;
    return { ts: now.getTime() + ms, label: `en ${n} ${m[2]}` };
  }
  // "de/en/por la mañana" es la hora del día; "esta mañana" es hoy
  const t2 = t.replace(/\b(de|en|por) la manana\b/g, ' ').replace(/\besta manana\b/g, ' hoy ');
  if (/\bpasado manana\b/.test(t2)) { day = new Date(base); day.setDate(day.getDate() + 2); label = 'pasado mañana'; }
  else if (/\bmanana\b/.test(t2)) { day = new Date(base); day.setDate(day.getDate() + 1); label = 'mañana'; }
  else if (/\b(hoy|esta tarde|esta noche)\b/.test(t2)) { day = new Date(base); label = 'hoy'; }
  else if ((m = t.match(/\ben (\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete) dias\b/))) {
    const n = NUM_WORDS[m[1]] || Number(m[1]);
    day = new Date(base); day.setDate(day.getDate() + n); label = `en ${n} días`;
  } else if (/\b(la )?(proxima|siguiente) semana\b/.test(t)) {
    day = new Date(base);
    const add = ((8 - day.getDay()) % 7) || 7;
    day.setDate(day.getDate() + add);
    label = 'la próxima semana';
  } else if ((m = t.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/))) {
    const mon = m[2] === 'setiembre' ? 8 : MONTHS.indexOf(m[2]);
    day = new Date(base.getFullYear(), mon, Number(m[1]));
    if (day < atTime(base, 0)) day.setFullYear(day.getFullYear() + 1);
    label = `${m[1]} de ${m[2]}`;
  } else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const d = Number(m[1]);
    const mo = Number(m[2]) - 1;
    if (d >= 1 && d <= 31 && mo >= 0 && mo <= 11) {
      let y = m[3] ? Number(m[3]) : base.getFullYear();
      if (y < 100) y += 2000;
      day = new Date(y, mo, d);
      if (!m[3] && day < atTime(base, 0)) day.setFullYear(day.getFullYear() + 1);
      label = m[0];
    }
  } else if ((m = t.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?: (\d{1,2}))?\b/))) {
    const wd = WEEKDAYS.indexOf(m[1]);
    day = new Date(base);
    if (m[2]) {
      // "martes 18": el próximo día 18 (este mes o el siguiente)
      const dn = Number(m[2]);
      day = new Date(base.getFullYear(), base.getMonth(), dn);
      if (day < atTime(base, 0)) day = new Date(base.getFullYear(), base.getMonth() + 1, dn);
    } else {
      let add = (wd - day.getDay() + 7) % 7;
      if (add === 0) add = 7;
      day.setDate(day.getDate() + add);
    }
    label = m[0].replace('miercoles', 'miércoles').replace('sabado', 'sábado');
  }

  const time = findTime(t);
  if (!day && !time) return null;
  if (!day) {
    // Solo hora: hoy si aún no pasa, si no mañana
    day = atTime(base, time.h, time.m);
    if (day <= now) day.setDate(day.getDate() + 1);
    return { ts: day.getTime(), label: time.text };
  }
  const when = time ? atTime(day, time.h, time.m) : atTime(day, 9, 0);
  if (when <= now) return null;
  return { ts: when.getTime(), label: time ? `${label} ${time.text}` : label };
}

// ---------------------------------------------------------------- tareas

const TASK_RE = /(?:^|[.;!?\n]|,\s*y\s+|\by\s+)\s*(?:entonces\s+|tambien\s+|ademas\s+)?(hay que|tengo que|tenemos que|tienes que|debo|debemos|necesito|necesitamos|no olvidar|no olvides|recordar|acordarme de|falta|pendiente:?)\s+([^.;!?\n]{3,120})/gi;

function cap(s) {
  const t = s.trim().replace(/\s+/g, ' ').replace(/[,:]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Encuentra tareas escritas en el texto ("hay que pedir cotización", "- [ ] llamar a Juan"). */
export function extractTasks(text) {
  const src = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (s) => {
    let t = cap(s.replace(/^\s*(hay que|tengo que|tenemos que|debo|debemos|necesito|necesitamos)\s+/i, '').replace(/^(de|que)\s+/i, ''));
    if (t.length < 4) return;
    if (t.length > 90) t = t.slice(0, 87).trim() + '…';
    const k = normalize(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  };
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*[-*•]\s*\[\s?\]\s*(.+)$/) || line.match(/^\s*(?:tarea|todo|por hacer)\s*:\s*(.+)$/i);
    if (m) push(m[1]);
  }
  // Se busca sobre el texto original para conservar tildes
  // Cada línea o párrafo por separado, para no juntar oraciones de párrafos distintos
  for (const para of src.split(/\n+/)) {
    const plain = para.replace(/\s+/g, ' ');
    let m;
    TASK_RE.lastIndex = 0;
    while ((m = TASK_RE.exec(plain))) {
      // Corta en ", y hay que" para separar tareas encadenadas
      m[2].split(/,\s*(?:y\s+)?(?=(?:hay que|tengo que|debo|necesito)\b)/i).forEach((p) => push(p));
    }
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------- similitud

const STOP = new Set(('a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bien cada casi como con contra cual cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque que quien se sea ser si sido sin sobre solo son su sus tambien tan tanto te tener tengo ti tiene tienen todo todos tu tus un una uno unos usted ya yo hace hacer hoy manana ayer bueno entonces osea vez veces cosa cosas idea ideas creo seria puede pueden quiero queremos tenemos debo hay que este esta').split(' '));

export function tokens(text) {
  return normalize(text)
    .replace(/[^a-z0-9ñ\s#]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^#/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 5 ? w.replace(/(es|s)$/, '') : w));
}

function ideaText(i) {
  return [i.title, i.title, i.text, i.summary, (i.tags || []).join(' '), (i.tags || []).join(' ')].join(' ');
}

function vec(text, idf) {
  const tf = new Map();
  for (const w of tokens(text)) tf.set(w, (tf.get(w) || 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [w, c] of tf) {
    const x = (1 + Math.log(c)) * (idf.get(w) || 1);
    v.set(w, x);
    norm += x * x;
  }
  return { v, norm: Math.sqrt(norm) || 1 };
}

function cosine(a, b) {
  let dot = 0;
  const [s, l] = a.v.size < b.v.size ? [a, b] : [b, a];
  for (const [w, x] of s.v) { const y = l.v.get(w); if (y) dot += x * y; }
  return dot / (a.norm * b.norm);
}

function buildIdf(ideas) {
  const df = new Map();
  for (const i of ideas) for (const w of new Set(tokens(ideaText(i)))) df.set(w, (df.get(w) || 0) + 1);
  const n = ideas.length + 1;
  const idf = new Map();
  for (const [w, d] of df) idf.set(w, Math.log(n / d) + 1);
  return idf;
}

/** Ideas parecidas a una idea (o texto), de mayor a menor parecido. */
export function relatedIdeas(target, ideas, { limit = 4, min = 0.12 } = {}) {
  const pool = ideas.filter((i) => i.id !== target.id);
  if (!pool.length) return [];
  const idf = buildIdf(pool.concat([target]));
  const tv = vec(typeof target === 'string' ? target : ideaText(target), idf);
  return pool
    .map((i) => ({ idea: i, score: cosine(tv, vec(ideaText(i), idf)) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Posible duplicado de un texto nuevo. */
export function findDuplicate(text, ideas, threshold = 0.62) {
  const r = relatedIdeas({ id: '__new__', title: '', text }, ideas, { limit: 1, min: threshold });
  return r[0] || null;
}

// ---------------------------------------------------------------- categoría sugerida

const SEEDS = {
  trabajo: 'reunion cliente clientes jefe jefa oficina informe reporte proveedor proveedores equipo planta presentacion trimestre ventas contrato licitacion cotizacion mantencion turno gerencia correo empresa trabajo seguridad auditoria',
  personal: 'casa familia hijo hija mama papa cumpleanos regalo medico dentista doctor salud compras supermercado viaje vacaciones pareja amigo amiga gimnasio pagar cuenta banco mascota perro gato',
  proyectos: 'app aplicacion proyecto crear construir disenar diseno negocio emprender emprendimiento prototipo pagina web sistema plataforma idea lanzar producto',
  estudios: 'estudiar estudio examen prueba control curso clase capitulo ejercicio universidad profesor tarea tesis libro leer aprender certificado diplomado'
};

/**
 * Sugiere una categoría para un texto, aprendiendo de las ideas ya clasificadas
 * (y de palabras típicas para las categorías por defecto). Devuelve { id, confidence } o null.
 */
export function suggestCategory(text, ideas, categories) {
  const tks = tokens(text);
  if (!tks.length || !categories.length) return null;
  const scores = new Map(categories.map((c) => [c.id, 0]));
  const seedKey = (c) => normalize(c.name);
  for (const c of categories) {
    const seed = SEEDS[seedKey(c)];
    if (seed) {
      const set = new Set(tokens(seed));
      for (const w of tks) if (set.has(w)) scores.set(c.id, scores.get(c.id) + 1.2);
    }
    // El nombre de la categoría dentro del texto pesa mucho
    if (tks.includes(tokens(c.name)[0])) scores.set(c.id, scores.get(c.id) + 2);
  }
  const labeled = ideas.filter((i) => i.category && scores.has(i.category) && !i.deletedAt);
  if (labeled.length) {
    for (const r of relatedIdeas({ id: '__new__', title: '', text }, labeled, { limit: 6, min: 0.08 })) {
      scores.set(r.idea.category, scores.get(r.idea.category) + r.score * 4);
    }
  }
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestId, best] = sorted[0];
  const second = sorted[1] ? sorted[1][1] : 0;
  if (best < 1) return null;
  const confidence = Math.min(1, (best - second) / best + Math.min(best, 4) / 8);
  return { id: bestId, confidence };
}
