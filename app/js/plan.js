// Plan de trabajo: lector de Excel (.xlsx) sin librerías, interpretación del plan y cálculos de avance.
// Todo ocurre en el teléfono: el archivo nunca sale del dispositivo.
import { normalize, uid } from './util.js';

// ---------------------------------------------------------------- fechas (AAAA-MM-DD, hora local)

export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fromYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function todayYmd() { return ymd(new Date()); }
export function addDays(s, n) { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
export function diffDays(a, b) { return Math.round((fromYmd(b) - fromYmd(a)) / 86400000); }

function serialToYmd(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Acepta número de serie de Excel, texto dd/mm/aaaa o AAAA-MM-DD. */
function toYmd(v, fallbackYear) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return serialToYmd(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? Number(m[3]) : fallbackYear || new Date().getFullYear();
    if (y < 100) y += 2000;
    return ymd(new Date(y, Number(m[2]) - 1, Number(m[1])));
  }
  return null;
}

// ---------------------------------------------------------------- ZIP + XML (formato .xlsx)

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Este navegador no puede leer archivos Excel. Actualice iOS a la versión 16.4 o superior.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un Excel válido (.xlsx).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const raw = new Uint8Array(buffer, start, e.csize);
      if (e.method === 0) return dec.decode(raw);
      if (e.method === 8) return dec.decode(await inflateRaw(raw));
      throw new Error('El Excel usa una compresión no soportada.');
    }
  };
}

function xmlDecode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textOf(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return xmlDecode(out);
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Lee un .xlsx y devuelve { nombreHoja: filas[][] } con los valores ya calculados. */
export async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  const wb = await zip.text('xl/workbook.xml');
  if (!wb) throw new Error('El archivo no parece un Excel (.xlsx). Si es .xls antiguo, guárdelo como .xlsx.');
  const rels = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) relMap.set(m[1], m[2]);
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) if (!relMap.has(m[2])) relMap.set(m[2], m[1]);
  const shared = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const sheets = {};
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = xmlDecode((attrs.match(/name="([^"]*)"/) || [])[1] || 'Hoja');
    const rid = (attrs.match(/r:id="([^"]*)"/) || attrs.match(/\bid="([^"]*)"/) || [])[1];
    let target = relMap.get(rid) || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = await zip.text(`xl/${target}`);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const rowXml = r[1] || '';
      const rowNum = Number(((r[0].match(/\br="(\d+)"/) || [])[1]) || rows.length + 1);
      const row = [];
      for (const c of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1];
        const ref = (a.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const t = (a.match(/\bt="([^"]+)"/) || [])[1];
        const inner = c[2] || '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = v !== undefined ? shared[Number(v)] ?? '' : null;
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = v !== undefined ? xmlDecode(v) : null;
        else if (t === 'b') val = v === '1';
        else if (v !== undefined) val = Number(v);
        const idx = ref ? colIndex(ref) : row.length;
        row[idx] = val;
      }
      rows[rowNum - 1] = Array.from(row, (x) => (x === undefined ? null : x));
    }
    sheets[name] = Array.from(rows, (x) => x || []);
  }
  return sheets;
}

// ---------------------------------------------------------------- interpretación del plan

export const STATUSES = ['Pendiente', 'En curso', 'Completada', 'Bloqueada'];
export const DELIV_STATUSES = ['Pendiente', 'Entregado', 'Validado'];
const FRONT_COLORS = ['#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#60A5FA', '#FB7185', '#2DD4BF', '#C084FC'];

const n = (v) => normalize(v === null || v === undefined ? '' : String(v)).trim();
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const dash = (s) => (/^[—–-]?$/.test(str(s)) ? '' : str(s));

function normStatus(v, list = STATUSES) {
  const t = n(v);
  if (!t) return list[0];
  if (/complet|termin|hech|listo/.test(t)) return list === STATUSES ? 'Completada' : 'Entregado';
  if (/valid/.test(t)) return list === STATUSES ? 'Completada' : 'Validado';
  if (/entreg/.test(t)) return list === STATUSES ? 'Completada' : 'Entregado';
  if (/curso|progres|avanc/.test(t)) return list === STATUSES ? 'En curso' : 'Pendiente';
  if (/bloq/.test(t)) return list === STATUSES ? 'Bloqueada' : 'Pendiente';
  return list[0];
}

function pct(v) {
  if (v === null || v === undefined || v === '') return 0;
  const x = Number(String(v).replace('%', '').replace(',', '.'));
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x <= 1 ? Math.round(x * 100) : Math.round(x)));
}

/** Busca la fila de encabezados que contiene todas las palabras pedidas. */
function findTable(sheets, words) {
  for (const [name, rows] of Object.entries(sheets)) {
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const head = (rows[r] || []).map(n);
      if (words.every((w) => head.some((h) => h === w || h.startsWith(w)))) {
        const col = (w) => head.findIndex((h) => h === w || h.startsWith(w));
        return { name, rows, r, head, col };
      }
    }
  }
  return null;
}

function splitPeople(s) {
  return dash(s)
    .split(/\s*(?:,|\/|;|\by\b)\s*/)
    .map((x) => x.trim())
    .filter((x) => x && x !== '—' && x.length > 1);
}

/** Convierte las hojas del Excel en un plan ordenado. */
export function parsePlan(sheets, sourceName = '') {
  const first = Object.values(sheets)[0] || [];
  const firstText = first.flat().filter((x) => typeof x === 'string');
  const plan = {
    id: uid(),
    sourceName,
    importedAt: Date.now(),
    updatedAt: Date.now(),
    header: str(firstText[0]),
    title: str(firstText[1]) || 'Plan de trabajo',
    subtitle: str(firstText[2]),
    info: [],
    fronts: [],
    activities: [],
    deliverables: [],
    goals: [],
    log: [],
    weekTemplate: [],
    rules: [],
    inputs: [],
    holidays: []
  };

  // Actividades (obligatorio)
  const act = findTable(sheets, ['fecha', 'actividad']);
  if (!act) throw new Error('No encontré una hoja de actividades. Debe tener columnas "FECHA" y "ACTIVIDAD".');
  const c = {
    id: act.col('id'), week: act.col('sem'), date: act.col('fecha'), day: act.col('dia'), mode: act.col('modalidad'),
    front: act.col('frente'), title: act.col('actividad'), with: act.col('con quien'), deliv: act.col('entregable'),
    status: act.col('estado'), pct: act.col('% avance'), real: act.col('fecha real'), notes: act.col('observaciones')
  };
  let year = new Date().getFullYear();
  for (let r = act.r + 1; r < act.rows.length; r++) {
    const row = act.rows[r] || [];
    const title = str(row[c.title]);
    const date = toYmd(row[c.date], year);
    if (!title || !date) continue;
    year = Number(date.slice(0, 4));
    const status = normStatus(row[c.status]);
    plan.activities.push({
      id: str(row[c.id]) || `A${plan.activities.length + 1}`,
      week: Number(row[c.week]) || null,
      date,
      mode: c.mode >= 0 ? str(row[c.mode]) : '',
      front: c.front >= 0 ? str(row[c.front]) : '',
      title,
      with: c.with >= 0 ? dash(row[c.with]) : '',
      deliverable: c.deliv >= 0 ? dash(row[c.deliv]) : '',
      status,
      progress: status === 'Completada' ? 100 : pct(row[c.pct]),
      realDate: c.real >= 0 ? toYmd(row[c.real], year) : null,
      notes: c.notes >= 0 ? str(row[c.notes]) : ''
    });
  }
  if (!plan.activities.length) throw new Error('La hoja de actividades no tiene filas con fecha y actividad.');
  plan.activities.sort((a, b) => a.date.localeCompare(b.date));

  // Semanas: si no vienen, se calculan desde la primera fecha
  const start0 = plan.activities[0].date;
  for (const a of plan.activities) if (!a.week) a.week = Math.floor(diffDays(start0, a.date) / 7) + 1;

  // Entregables
  const del = findTable(sheets, ['entregable', 'fecha comprometida']);
  if (del) {
    const col = { id: del.col('id'), name: del.col('entregable'), front: del.col('frente'), date: del.col('fecha comprometida'), by: del.col('valida'), folder: del.col('carpeta'), status: del.col('estado'), real: del.col('fecha entrega'), notes: del.col('observaciones') };
    for (let r = del.r + 1; r < del.rows.length; r++) {
      const row = del.rows[r] || [];
      const name = str(row[col.name]);
      const date = toYmd(row[col.date], year);
      if (!name || !date) continue;
      plan.deliverables.push({
        id: str(row[col.id]) || `E${plan.deliverables.length + 1}`,
        name, date,
        front: col.front >= 0 ? str(row[col.front]) : '',
        validatedBy: col.by >= 0 ? dash(row[col.by]) : '',
        folder: col.folder >= 0 ? dash(row[col.folder]) : '',
        status: normStatus(row[col.status], DELIV_STATUSES),
        realDate: col.real >= 0 ? toYmd(row[col.real], year) : null,
        notes: col.notes >= 0 ? str(row[col.notes]) : ''
      });
    }
    plan.deliverables.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Metas
  const goals = findTable(sheets, ['indicador', 'meta']);
  if (goals) {
    const col = { front: goals.col('frente'), ind: goals.col('indicador'), meta: goals.col('meta'), real: goals.col('real'), date: goals.col('fecha meta'), src: goals.col('fuente') };
    for (let r = goals.r + 1; r < goals.rows.length; r++) {
      const row = goals.rows[r] || [];
      const ind = str(row[col.ind]);
      const meta = Number(row[col.meta]);
      if (!ind || !Number.isFinite(meta) || meta <= 0) continue;
      plan.goals.push({
        id: `M${plan.goals.length + 1}`,
        front: col.front >= 0 ? str(row[col.front]) : '',
        indicator: ind,
        meta,
        real: Number(row[col.real]) || 0,
        isPct: /\(%\)|porcentaje/i.test(ind) || (meta === 1 && /\bpct\b/i.test(ind)),
        date: col.date >= 0 ? toYmd(row[col.date], year) : null,
        source: col.src >= 0 ? str(row[col.src]) : ''
      });
    }
  }

  // Bitácora
  const log = findTable(sheets, ['fecha', 'reuniones']);
  if (log) {
    const col = { date: log.col('fecha'), meet: log.col('reuniones'), agr: log.col('acuerdos'), docs: log.col('documentos'), alerts: log.col('alertas'), next: log.col('pendientes'), sent: log.col('enviada') };
    for (let r = log.r + 1; r < log.rows.length; r++) {
      const row = log.rows[r] || [];
      const date = toYmd(row[col.date], year);
      if (!date) continue;
      const meet = str(row[col.meet]);
      plan.log.push({
        date,
        meetings: /^ej\.?:/i.test(meet) ? '' : meet,
        agreements: col.agr >= 0 ? str(row[col.agr]) : '',
        docs: col.docs >= 0 ? str(row[col.docs]) : '',
        alerts: col.alerts >= 0 ? str(row[col.alerts]) : '',
        tomorrow: col.next >= 0 ? str(row[col.next]) : '',
        sent: col.sent >= 0 ? /^(si|sí|x|1|true|enviad)/i.test(str(row[col.sent])) : false
      });
    }
  }

  // Resumen: datos clave y frentes con su peso
  // Solo la primera hoja (Resumen), hasta la primera tabla
  for (const row of first.slice(0, 20)) {
    const k = str(row && row[0]);
    const v = row && row[1];
    if (/^frente$|^id$/i.test(k)) break;
    if (k && typeof v === 'string' && v.length > 3 && k.length < 30 && !/transcurrid|corte/i.test(n(k))) {
      if (!plan.info.some((x) => x.label === k)) plan.info.push({ label: k, value: v });
    }
  }
  const fr = findTable(sheets, ['frente', 'peso']);
  if (fr) {
    for (let r = fr.r + 1; r < fr.rows.length; r++) {
      const row = fr.rows[r] || [];
      const label = str(row[fr.col('frente')]);
      const w = Number(row[fr.col('peso')]);
      if (!label || /avance ponderado|total/i.test(label) || !Number.isFinite(w) || w <= 0 || label.length > 60) continue;
      const m = label.match(/^([A-Z](?:\s*[–-]\s*[A-Z])?)\.?\s+(.*)$/);
      plan.fronts.push({ code: m ? m[1].replace(/\s/g, '') : label, name: m ? m[2] : label, weight: w <= 1 ? w : w / 100 });
    }
  }
  // Frentes que aparecen en actividades pero no en el resumen
  const codes = new Set(plan.fronts.map((f) => f.code));
  for (const a of plan.activities) {
    if (a.front && !codes.has(a.front)) { codes.add(a.front); plan.fronts.push({ code: a.front, name: `Frente ${a.front}`, weight: 0 }); }
  }
  if (plan.fronts.length && plan.fronts.every((f) => !f.weight)) plan.fronts.forEach((f) => { f.weight = 1 / plan.fronts.length; });
  plan.fronts.forEach((f, i) => { f.color = FRONT_COLORS[i % FRONT_COLORS.length]; });

  // Referencia: semana tipo, reglas e insumos
  const wk = findTable(sheets, ['dia', 'foco']);
  if (wk) {
    let section = 'week';
    for (let r = wk.r + 1; r < wk.rows.length; r++) {
      const row = wk.rows[r] || [];
      const a = str(row[0]);
      const b = str(row[1]);
      const c2 = str(row[2]);
      if (!a && !b) continue;
      if (!b && /limites|reglas/i.test(n(a))) { section = 'rules'; continue; }
      if (!b && /insumos/i.test(n(a))) { section = 'inputs'; continue; }
      if (!b) continue;
      if (section === 'week') plan.weekTemplate.push({ day: a, focus: b, routine: c2 });
      else if (section === 'rules') plan.rules.push({ label: a, text: b });
      else plan.inputs.push({ label: a, text: b });
    }
  }

  // Feriados mencionados en el texto ("8/12/2026 (feriado)", "Martes 8/12 feriado")
  const allText = Object.values(sheets).flat(2).filter((x) => typeof x === 'string').join(' ');
  for (const m of allText.matchAll(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*\(?\s*feriado/gi)) {
    const d = ymd(new Date(Number(m[3] || year), Number(m[2]) - 1, Number(m[1])));
    if (!plan.holidays.includes(d)) plan.holidays.push(d);
  }

  const lastDates = [plan.activities[plan.activities.length - 1].date, ...plan.deliverables.map((d) => d.date), ...plan.holidays];
  plan.start = plan.activities[0].date;
  plan.end = lastDates.sort().pop();
  return plan;
}

// ---------------------------------------------------------------- cálculos

export function isLate(a, today = todayYmd()) {
  return a.status !== 'Completada' && a.date < today;
}

export function frontOf(plan, code) {
  return plan.fronts.find((f) => f.code === code) || { code, name: code || 'Sin frente', color: '#C9B8E0', weight: 0 };
}

export function activityProgress(a) {
  if (a.status === 'Completada') return 100;
  return a.progress || (a.status === 'En curso' ? 50 : 0);
}

/** Avance planificado vs real por frente y ponderado. */
export function planStats(plan, today = todayYmd()) {
  const totalDays = Math.max(1, diffDays(plan.start, plan.end) + 1);
  const elapsed = Math.max(0, Math.min(totalDays, diffDays(plan.start, today) + 1));
  const acts = plan.activities;
  const fronts = plan.fronts.map((f) => {
    const list = acts.filter((a) => a.front === f.code);
    const planned = list.length ? list.filter((a) => a.date <= today).length / list.length : 0;
    const real = list.length ? list.reduce((s, a) => s + activityProgress(a), 0) / (list.length * 100) : 0;
    return { ...f, count: list.length, done: list.filter((a) => a.status === 'Completada').length, planned, real };
  });
  const wsum = fronts.reduce((s, f) => s + (f.count ? f.weight : 0), 0) || 1;
  const weighted = (k) => fronts.reduce((s, f) => s + (f.count ? f.weight * f[k] : 0), 0) / wsum;
  const del = plan.deliverables;
  const in7 = addDays(today, 7);
  return {
    totalDays,
    elapsed,
    planned: weighted('planned'),
    real: weighted('real'),
    fronts,
    acts: {
      total: acts.length,
      done: acts.filter((a) => a.status === 'Completada').length,
      doing: acts.filter((a) => a.status === 'En curso').length,
      blocked: acts.filter((a) => a.status === 'Bloqueada').length,
      late: acts.filter((a) => isLate(a, today)).length,
      today: acts.filter((a) => a.date === today).length
    },
    del: {
      total: del.length,
      delivered: del.filter((d) => d.status !== 'Pendiente').length,
      validated: del.filter((d) => d.status === 'Validado').length,
      late: del.filter((d) => d.status === 'Pendiente' && d.date < today).length,
      soon: del.filter((d) => d.status === 'Pendiente' && d.date >= today && d.date <= in7).length
    },
    goals: {
      total: plan.goals.length,
      met: plan.goals.filter((g) => g.real >= g.meta).length
    },
    log: {
      total: plan.log.length,
      filled: plan.log.filter((l) => l.meetings || l.agreements || l.alerts).length,
      sent: plan.log.filter((l) => l.sent).length
    }
  };
}

/** Personas mencionadas en "Con quién" y "Valida", unificando nombres cortos con los completos. */
export function planPeople(plan) {
  const map = new Map();
  const add = (name, kind, item) => {
    const key = normalize(name);
    if (!map.has(key)) map.set(key, { name: name.charAt(0).toUpperCase() + name.slice(1), acts: [], dels: [] });
    map.get(key)[kind].push(item);
  };
  plan.activities.forEach((a) => splitPeople(a.with).forEach((p) => add(p, 'acts', a)));
  plan.deliverables.forEach((d) => splitPeople(d.validatedBy).forEach((p) => add(p, 'dels', d)));
  // "Mauricio" + "Mauricio Hernández" → una sola persona
  const list = [...map.values()];
  for (const short of list) {
    if (short.name.includes(' ')) continue;
    const full = list.find((o) => o !== short && o.name.includes(' ') && normalize(o.name).split(' ')[0] === normalize(short.name));
    if (full) { full.acts.push(...short.acts); full.dels.push(...short.dels); short.merged = true; }
  }
  return list.filter((p) => !p.merged)
    .map((p) => ({ ...p, acts: [...new Set(p.acts)].sort((a, b) => a.date.localeCompare(b.date)), dels: [...new Set(p.dels)] }))
    .sort((a, b) => (b.acts.length + b.dels.length) - (a.acts.length + a.dels.length));
}

const WEEK_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** Foco de la "semana tipo" para una fecha. */
export function focusFor(plan, date) {
  const wd = WEEK_NAMES[fromYmd(date).getDay()];
  return plan.weekTemplate.find((w) => normalize(w.day).startsWith(wd)) || null;
}

export function weeksOf(plan) {
  const weeks = new Map();
  for (const a of plan.activities) {
    if (!weeks.has(a.week)) weeks.set(a.week, { n: a.week, acts: [], from: a.date, to: a.date });
    const w = weeks.get(a.week);
    w.acts.push(a);
    if (a.date < w.from) w.from = a.date;
    if (a.date > w.to) w.to = a.date;
  }
  return [...weeks.values()].sort((a, b) => a.n - b.n);
}

/** Reporte semanal listo para enviar (texto). */
export function weeklyReport(plan, week, fmtDate) {
  const w = weeksOf(plan).find((x) => x.n === week);
  if (!w) return '';
  const st = planStats(plan);
  const next = weeksOf(plan).find((x) => x.n === week + 1);
  const dels = plan.deliverables.filter((d) => d.date >= w.from && d.date <= addDays(w.to, 2));
  const line = (a) => `• ${a.title}${a.with ? ` (${a.with})` : ''}`;
  const out = [
    `${plan.title} · Reporte semana ${week}`,
    `${fmtDate(w.from)} al ${fmtDate(w.to)}`,
    '',
    `Avance ponderado: ${Math.round(st.real * 100)} % (planificado ${Math.round(st.planned * 100)} %)`,
    `Actividades de la semana: ${w.acts.filter((a) => a.status === 'Completada').length} de ${w.acts.length} completadas`,
    ''
  ];
  const done = w.acts.filter((a) => a.status === 'Completada');
  const doing = w.acts.filter((a) => a.status === 'En curso');
  const blocked = w.acts.filter((a) => a.status === 'Bloqueada');
  const pending = w.acts.filter((a) => a.status === 'Pendiente');
  if (done.length) out.push('Completadas:', ...done.map(line), '');
  if (doing.length) out.push('En curso:', ...doing.map(line), '');
  if (blocked.length) out.push('Bloqueos (requieren apoyo):', ...blocked.map((a) => `${line(a)}${a.notes ? ` — ${a.notes}` : ''}`), '');
  if (pending.length) out.push('Pendientes de la semana:', ...pending.map(line), '');
  if (dels.length) out.push('Entregables:', ...dels.map((d) => `• ${d.id} ${d.name} — ${d.status}${d.status === 'Pendiente' && d.date < todayYmd() ? ' (atrasado)' : ''}`), '');
  if (next) out.push(`Próxima semana (${next.acts.length} actividades):`, ...next.acts.slice(0, 6).map(line), '');
  return out.join('\n').trim();
}

/** CSV (separado por ";", para Excel en español) con el avance. */
export function planCsv(plan) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['ID', 'SEM', 'FECHA', 'FRENTE', 'ACTIVIDAD', 'CON QUIÉN', 'ENTREGABLE', 'ESTADO', '% AVANCE', 'FECHA REAL', 'OBSERVACIONES']];
  plan.activities.forEach((a) => rows.push([a.id, a.week, a.date, a.front, a.title, a.with, a.deliverable, a.status, a.progress, a.realDate || '', a.notes]));
  rows.push([]);
  rows.push(['ID', 'ENTREGABLE', 'FRENTE', 'FECHA COMPROMETIDA', 'VALIDA', 'CARPETA', 'ESTADO', 'FECHA ENTREGA', 'OBSERVACIONES']);
  plan.deliverables.forEach((d) => rows.push([d.id, d.name, d.front, d.date, d.validatedBy, d.folder, d.status, d.realDate || '', d.notes]));
  return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
}
