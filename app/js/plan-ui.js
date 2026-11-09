// Interfaz del Plan de trabajo: resumen, agenda, calendario, semanas, entregables, metas,
// personas, bitácora, reporte semanal y reglas. Recibe las utilidades de la app en `ctx`.
import {
  readXlsx, parsePlan, planStats, planPeople, weeksOf, weeklyReport, planCsv, focusFor,
  isLate, frontOf, activityProgress, todayYmd, fromYmd, addDays, diffDays, ymd, STATUSES, DELIV_STATUSES
} from './plan.js';

const SECTIONS = [
  ['resumen', 'Resumen'], ['agenda', 'Agenda'], ['calendario', 'Calendario'], ['semanas', 'Semanas'],
  ['entregables', 'Entregables'], ['metas', 'Metas'], ['personas', 'Personas'], ['bitacora', 'Bitácora'],
  ['reporte', 'Reporte'], ['reglas', 'Reglas']
];
const STATUS_CLASS = { Pendiente: 'st-pend', 'En curso': 'st-doing', Completada: 'st-done', Bloqueada: 'st-block' };

const dayFmt = new Intl.DateTimeFormat('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
const longFmt = new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
const monthFmt = new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric' });
export const fmtDay = (s) => dayFmt.format(fromYmd(s)).replace(/\./g, '');
export const fmtLong = (s) => longFmt.format(fromYmd(s));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function createPlanUI(ctx) {
  const { $, esc, state } = ctx;
  let planFileInput;

  const plan = () => state.plan;
  const save = () => ctx.savePlan(plan());

  function countdown(date) {
    const d = diffDays(todayYmd(), date);
    if (d < 0) return { text: `atrasado ${-d} ${d === -1 ? 'día' : 'días'}`, cls: 'late' };
    if (d === 0) return { text: 'hoy', cls: 'today' };
    if (d === 1) return { text: 'mañana', cls: 'soon' };
    if (d <= 7) return { text: `en ${d} días`, cls: 'soon' };
    return { text: `en ${d} días`, cls: '' };
  }

  const frontChip = (p, code) => {
    const f = frontOf(p, code);
    return `<span class="front-chip" style="--c:${esc(f.color)}" title="${esc(f.name)}">${esc(f.code || '—')}</span>`;
  };

  // ------------------------------------------------------------ importar

  function ensureFileInput() {
    if (planFileInput) return planFileInput;
    planFileInput = document.createElement('input');
    planFileInput.type = 'file';
    planFileInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    planFileInput.hidden = true;
    planFileInput.id = 'planFile';
    document.body.appendChild(planFileInput);
    planFileInput.addEventListener('change', async () => {
      const f = planFileInput.files && planFileInput.files[0];
      planFileInput.value = '';
      if (f) await importFile(f);
    });
    return planFileInput;
  }

  /** Mezcla el avance registrado en el teléfono con un plan nuevo (mismos ID). */
  function keepProgress(next, prev) {
    const byId = new Map(prev.activities.map((a) => [a.id, a]));
    next.activities.forEach((a) => {
      const o = byId.get(a.id);
      if (o && (o.status !== 'Pendiente' || o.notes || o.progress)) Object.assign(a, { status: o.status, progress: o.progress, realDate: o.realDate, notes: o.notes || a.notes });
    });
    const dById = new Map(prev.deliverables.map((d) => [d.id, d]));
    next.deliverables.forEach((d) => { const o = dById.get(d.id); if (o && o.status !== 'Pendiente') Object.assign(d, { status: o.status, realDate: o.realDate, notes: o.notes || d.notes }); });
    const gById = new Map(prev.goals.map((g) => [g.indicator, g]));
    next.goals.forEach((g) => { const o = gById.get(g.indicator); if (o && o.real > g.real) g.real = o.real; });
    const lByDate = new Map(prev.log.map((l) => [l.date, l]));
    next.log.forEach((l) => { const o = lByDate.get(l.date); if (o) Object.assign(l, o); });
    next.id = prev.id;
    return next;
  }

  async function importFile(file) {
    let parsed;
    try {
      const sheets = await readXlsx(await file.arrayBuffer());
      parsed = parsePlan(sheets, file.name);
    } catch (err) {
      console.warn(err);
      await ctx.alertDialog('No se pudo leer el plan', err.message || 'El archivo no se pudo leer. Revise que sea un Excel (.xlsx).');
      return;
    }
    const prev = plan();
    if (prev) {
      const choice = await ctx.dialog({
        title: 'Ya tiene un plan cargado',
        message: `El archivo trae ${parsed.activities.length} actividades y ${parsed.deliverables.length} entregables. ¿Qué desea hacer?`,
        buttons: [
          { label: 'Actualizar y mantener mi avance', value: 'merge', style: 'primary' },
          { label: 'Reemplazar todo', value: 'replace', style: 'danger-ghost' },
          { label: 'Cancelar', value: null, style: 'ghost' }
        ]
      });
      if (!choice) return;
      if (choice === 'merge') parsed = keepProgress(parsed, prev);
      else parsed.id = prev.id;
    }
    state.plan = parsed;
    await ctx.savePlan(parsed, { now: true });
    state.planSection = 'resumen';
    render();
    ctx.toast(`Plan cargado: ${parsed.activities.length} actividades, ${parsed.deliverables.length} entregables y ${parsed.goals.length} metas ✨`, { duration: 5000 });
  }

  function renderEmpty(view) {
    ctx.setHead(ctx.greetingText(), 'Plan de trabajo');
    view.innerHTML = `
      <div class="card plan-empty">
        <div class="pe-art" aria-hidden="true">📋</div>
        <h2>Importe su plan de trabajo</h2>
        <p>Elija su archivo Excel (.xlsx) desde Archivos, iCloud Drive o un correo. Se lee en este teléfono y <strong>no se sube a ningún lado</strong>.</p>
        <button type="button" class="btn primary full-w" id="planImport">Elegir archivo Excel</button>
        <details class="pe-help"><summary>¿Qué columnas reconoce?</summary>
          <ul>
            <li><strong>Actividades:</strong> FECHA y ACTIVIDAD (opcionales: ID, SEM, MODALIDAD, FRENTE, CON QUIÉN, ENTREGABLE, ESTADO, % AVANCE, OBSERVACIONES).</li>
            <li><strong>Entregables:</strong> ENTREGABLE y FECHA COMPROMETIDA (VALIDA, CARPETA, ESTADO).</li>
            <li><strong>Metas:</strong> INDICADOR y META (REAL, FECHA META, FUENTE).</li>
            <li><strong>Bitácora:</strong> FECHA y REUNIONES SOSTENIDAS.</li>
            <li><strong>Resumen:</strong> FRENTE y PESO. <strong>Referencia:</strong> DÍA y FOCO PRIORITARIO.</li>
          </ul>
        </details>
      </div>`;
    view.querySelector('#planImport').onclick = () => ensureFileInput().click();
  }

  // ------------------------------------------------------------ render principal

  function render() {
    const view = $('#view-plan');
    const p = plan();
    if (!p) { renderEmpty(view); return; }
    const sec = state.planSection || 'resumen';
    const st = planStats(p);
    ctx.setHead(p.title, `Día ${st.elapsed} de ${st.totalDays} · avance ${Math.round(st.real * 100)} %`);
    view.innerHTML = `
      <nav class="plan-nav" aria-label="Secciones del plan">
        ${SECTIONS.map(([k, l]) => `<button type="button" class="chip ${sec === k ? 'on' : ''}" data-sec="${k}">${l}${k === 'agenda' && st.acts.late ? ` <span class="badge">${st.acts.late}</span>` : ''}</button>`).join('')}
      </nav>
      <div id="planBody"></div>`;
    view.querySelectorAll('[data-sec]').forEach((b) => { b.onclick = () => { state.planSection = b.dataset.sec; ctx.setSetting('planSection', b.dataset.sec); render(); window.scrollTo({ top: 0 }); }; });
    const active = view.querySelector('.plan-nav .on');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
    const body = view.querySelector('#planBody');
    const fn = { resumen, agenda, calendario, semanas, entregables, metas, personas, bitacora, reporte, reglas }[sec] || resumen;
    fn(body, p, st);
  }

  // ------------------------------------------------------------ Resumen

  function ring(real, planned) {
    const R = 46;
    const C = 2 * Math.PI * R;
    return `<svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F27BB4"/><stop offset="1" stop-color="#A57CF0"/></linearGradient></defs>
      <circle cx="60" cy="60" r="${R}" class="ring-bg"/>
      <circle cx="60" cy="60" r="${R}" class="ring-plan" ${planned > 0.004 ? '' : 'hidden'} stroke-dasharray="${(planned * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)"/>
      <circle cx="60" cy="60" r="${R - 12}" class="ring-bg thin"/>
      <circle cx="60" cy="60" r="${R - 12}" class="ring-real" ${real > 0.004 ? '' : 'hidden'} stroke="url(#rg)" stroke-dasharray="${(real * 2 * Math.PI * (R - 12)).toFixed(1)} ${(2 * Math.PI * (R - 12)).toFixed(1)}" transform="rotate(-90 60 60)"/>
      <text x="60" y="58" class="ring-num">${Math.round(real * 100)}%</text>
      <text x="60" y="76" class="ring-sub">real</text>
    </svg>`;
  }

  function resumen(body, p, st) {
    const today = todayYmd();
    const late = p.activities.filter((a) => isLate(a, today));
    const blocked = p.activities.filter((a) => a.status === 'Bloqueada');
    const lateDel = p.deliverables.filter((d) => d.status === 'Pendiente' && d.date < today);
    const nextDel = p.deliverables.filter((d) => d.status === 'Pendiente' && d.date >= today).slice(0, 4);
    const diff = Math.round((st.real - st.planned) * 100);
    const tile = (k, n, label, cls = '') => `<button type="button" class="kpi ${cls}" data-go="${k}"><b>${n}</b><span>${label}</span></button>`;
    body.innerHTML = `
      <div class="card plan-hero">
        ${ring(st.real, st.planned)}
        <div class="ph-text">
          <p class="ph-label">Avance ponderado</p>
          <p class="ph-big">${Math.round(st.real * 100)} % <small>de ${Math.round(st.planned * 100)} % planificado</small></p>
          <p class="ph-state ${diff < -5 ? 'bad' : 'good'}">${diff < -5 ? `⚠️ ${-diff} puntos bajo lo planificado` : diff > 5 ? `🚀 ${diff} puntos adelantada` : '✓ Al día con lo planificado'}</p>
          <div class="days-bar" aria-label="Días transcurridos"><span style="width:${Math.round((st.elapsed / st.totalDays) * 100)}%"></span></div>
          <p class="ph-days">Día ${st.elapsed} de ${st.totalDays} · ${fmtDay(p.start)} → ${fmtDay(p.end)}</p>
        </div>
      </div>

      <div class="kpis">
        ${tile('agenda', st.acts.today, st.acts.today === 1 ? 'actividad hoy' : 'actividades hoy', st.acts.today ? 'hot' : '')}
        ${tile('agenda', st.acts.late, 'atrasadas', st.acts.late ? 'bad' : '')}
        ${tile('agenda', `${st.acts.done}/${st.acts.total}`, 'completadas')}
        ${tile('agenda', st.acts.doing, 'en curso')}
        ${tile('agenda', st.acts.blocked, 'bloqueadas', st.acts.blocked ? 'bad' : '')}
        ${tile('entregables', st.del.soon, 'entregables en 7 días', st.del.soon ? 'warn' : '')}
        ${tile('entregables', `${st.del.delivered}/${st.del.total}`, 'entregables listos')}
        ${tile('metas', `${st.goals.met}/${st.goals.total}`, 'metas cumplidas')}
      </div>

      <div class="card">
        <h2 class="card-title">Avance por frente</h2>
        <p class="muted small">Barra clara: lo planificado a hoy · barra de color: avance real · % = peso del frente.</p>
        <ul class="front-bars">
          ${st.fronts.filter((f) => f.count).map((f) => `
            <li style="--c:${esc(f.color)}">
              <div class="fb-head"><span class="front-chip" style="--c:${esc(f.color)}">${esc(f.code)}</span><span class="fb-name">${esc(f.name)}</span><span class="fb-w">${Math.round(f.weight * 100)} %</span></div>
              <div class="fb-track"><span class="fb-plan" style="width:${Math.round(f.planned * 100)}%"></span><span class="fb-real" style="width:${Math.round(f.real * 100)}%"></span></div>
              <div class="fb-foot">${f.done}/${f.count} actividades · real ${Math.round(f.real * 100)} % · plan ${Math.round(f.planned * 100)} %</div>
            </li>`).join('')}
        </ul>
      </div>

      <div class="card">
        <h2 class="card-title">🚨 Alertas</h2>
        ${late.length || blocked.length || lateDel.length ? `<ul class="alert-list">
          ${blocked.map((a) => `<li><button type="button" data-act="${esc(a.id)}"><span class="pill-st st-block">Bloqueada</span>${esc(a.title)}</button></li>`).join('')}
          ${lateDel.map((d) => `<li><button type="button" data-del="${esc(d.id)}"><span class="pill-st st-late">Entregable atrasado</span>${esc(d.id)} · ${esc(d.name)}</button></li>`).join('')}
          ${late.slice(0, 6).map((a) => `<li><button type="button" data-act="${esc(a.id)}"><span class="pill-st st-late">${esc(countdown(a.date).text)}</span>${esc(a.title)}</button></li>`).join('')}
          ${late.length > 6 ? `<li class="muted small">y ${late.length - 6} más en Agenda</li>` : ''}
        </ul>` : '<p class="ok-line">✨ Todo al día: sin atrasos ni bloqueos.</p>'}
      </div>

      <div class="card">
        <h2 class="card-title">📦 Próximos entregables</h2>
        ${nextDel.length ? `<ul class="del-mini">${nextDel.map((d) => { const c = countdown(d.date); return `<li><button type="button" data-del="${esc(d.id)}">${frontChip(p, d.front)}<span class="dm-name">${esc(d.name)}</span><span class="cd ${c.cls}">${esc(c.text)}</span></button></li>`; }).join('')}</ul>` : '<p class="muted">No hay entregables pendientes.</p>'}
      </div>

      ${ctx.aiConfig() ? `<div class="card ai-card">
        <h2 class="card-title">💬 Pregúntele a la IA sobre su plan</h2>
        <p class="muted">"¿Qué tengo esta semana con Matías?", "¿Qué entregables dependen de Daniela?", "¿Cómo priorizo el jueves?"</p>
        <button type="button" class="btn primary full-w" id="planChat">Abrir chat del plan</button>
      </div>` : ''}

      <details class="card plan-info">
        <summary><strong>Datos del plan</strong></summary>
        ${p.header ? `<p class="muted small">${esc(p.header)}</p>` : ''}
        <dl>${p.info.map((i) => `<dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd>`).join('')}</dl>
        <p class="muted small">Archivo: ${esc(p.sourceName || '—')} · cargado ${esc(fmtDay(ymd(new Date(p.importedAt))))}</p>
        <div class="btn-col">
          <button type="button" class="btn soft" id="planReimport">Cargar otra versión del Excel</button>
          <button type="button" class="btn soft" id="planCsv">Exportar mi avance (Excel/CSV)</button>
          <button type="button" class="btn danger-ghost" id="planDelete">Quitar el plan de la app</button>
        </div>
      </details>`;
    body.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { state.planSection = b.dataset.go; render(); window.scrollTo({ top: 0 }); }; });
    wireOpeners(body, p);
    body.querySelector('#planChat')?.addEventListener('click', () => openPlanChat(p));
    body.querySelector('#planReimport').onclick = () => ensureFileInput().click();
    body.querySelector('#planCsv').onclick = () => ctx.shareOrDownload(new Blob([planCsv(p)], { type: 'text/csv' }), `avance-plan-${todayYmd()}.csv`, 'Avance del plan');
    body.querySelector('#planDelete').onclick = async () => {
      if (!(await ctx.confirmDialog('¿Quitar el plan?', 'Se borrará el plan y el avance registrado en este teléfono. Su archivo Excel no se modifica.', 'Quitar plan', true))) return;
      await ctx.deletePlan(p);
      state.plan = null;
      render();
    };
  }

  function wireOpeners(root, p) {
    root.querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => { if (e.target.closest('.check')) return; openActivity(p, b.dataset.act); }; });
    root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => openDeliverable(p, b.dataset.del); });
  }

  // ------------------------------------------------------------ Agenda

  function actRow(p, a) {
    const late = isLate(a);
    return `
      <li class="act-row ${a.status === 'Completada' ? 'done' : ''}">
        <button type="button" class="check ${STATUS_CLASS[a.status]}" data-check="${esc(a.id)}" aria-label="${a.status === 'Completada' ? 'Marcar como pendiente' : 'Marcar como completada'}">${a.status === 'Completada' ? '✓' : a.status === 'Bloqueada' ? '!' : a.status === 'En curso' ? '◐' : ''}</button>
        <button type="button" class="act-main" data-act="${esc(a.id)}">
          <span class="act-title">${esc(a.title)}</span>
          <span class="act-meta">${frontChip(p, a.front)}${a.with ? `<span>👤 ${esc(a.with)}</span>` : ''}${a.deliverable ? `<span>📦 ${esc(a.deliverable)}</span>` : ''}${late ? '<span class="pill-st st-late">Atrasada</span>' : ''}${a.status === 'En curso' ? `<span class="pill-st st-doing">${activityProgress(a)} %</span>` : ''}${a.status === 'Bloqueada' ? '<span class="pill-st st-block">Bloqueada</span>' : ''}</span>
        </button>
      </li>`;
  }

  function wireChecks(root, p, rerender) {
    root.querySelectorAll('[data-check]').forEach((b) => {
      b.onclick = () => {
        const a = p.activities.find((x) => x.id === b.dataset.check);
        if (a.status === 'Completada') { a.status = 'Pendiente'; a.progress = 0; a.realDate = null; }
        else { a.status = 'Completada'; a.progress = 100; a.realDate = todayYmd(); ctx.toast('¡Actividad completada! ✓'); }
        save();
        rerender();
      };
    });
  }

  function agenda(body, p) {
    const today = todayYmd();
    const mode = state.agendaMode || 'proximas';
    const late = p.activities.filter((a) => isLate(a, today));
    let list = p.activities;
    if (mode === 'proximas') list = list.filter((a) => a.date >= today);
    if (mode === 'pendientes') list = list.filter((a) => a.status !== 'Completada');
    const days = new Map();
    list.forEach((a) => { if (!days.has(a.date)) days.set(a.date, []); days.get(a.date).push(a); });
    const delByDate = new Map();
    p.deliverables.forEach((d) => { if (!delByDate.has(d.date)) delByDate.set(d.date, []); delByDate.get(d.date).push(d); });
    p.holidays.forEach((h) => { if ((mode !== 'proximas' || h >= today) && !days.has(h)) days.set(h, []); });
    const sorted = [...days.keys()].sort();
    body.innerHTML = `
      <div class="segmented small-seg" role="radiogroup" aria-label="Mostrar">
        ${[['proximas', 'Desde hoy'], ['pendientes', 'Pendientes'], ['todas', 'Todo el plan']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${mode === v}" class="${mode === v ? 'on' : ''}" data-amode="${v}">${l}</button>`).join('')}
      </div>
      ${late.length && mode === 'proximas' ? `<section class="day-block late-block"><h3 class="day-head"><span>⏳ Atrasadas</span><span class="dh-count">${late.length}</span></h3><ul class="act-list">${late.map((a) => actRow(p, a)).join('')}</ul></section>` : ''}
      ${sorted.map((d) => {
        const acts = days.get(d);
        const focus = focusFor(p, d);
        const isHol = p.holidays.includes(d);
        const dels = (delByDate.get(d) || []);
        const modes = [...new Set(acts.map((a) => a.mode).filter(Boolean))];
        const done = acts.filter((a) => a.status === 'Completada').length;
        return `
        <section class="day-block ${d === today ? 'is-today' : ''}" id="day-${d}">
          <h3 class="day-head"><span>${d === today ? 'Hoy · ' : d === addDays(today, 1) ? 'Mañana · ' : ''}${esc(cap(fmtLong(d)))}</span>${modes.map((m) => `<span class="mode-pill ${/remot/i.test(m) ? 'remote' : ''}">${/remot/i.test(m) ? '🏠' : '🏭'} ${esc(m)}</span>`).join('')}${acts.length ? `<span class="dh-count">${done}/${acts.length}</span>` : ''}</h3>
          ${isHol ? '<p class="holiday">🎌 Feriado</p>' : ''}
          ${focus && acts.length ? `<p class="focus-line"><strong>Foco:</strong> ${esc(focus.focus)}${focus.routine ? ` <span class="muted">· ${esc(focus.routine)}</span>` : ''}</p>` : ''}
          <ul class="act-list">${acts.map((a) => actRow(p, a)).join('')}</ul>
          ${dels.length ? `<ul class="del-mini">${dels.map((x) => `<li><button type="button" data-del="${esc(x.id)}">📦 <span class="dm-name">${esc(x.id)} · ${esc(x.name)}</span><span class="pill-st ${x.status === 'Pendiente' ? '' : 'st-done'}">${esc(x.status)}</span></button></li>`).join('')}</ul>` : ''}
        </section>`;
      }).join('') || '<p class="muted center">No hay actividades para mostrar.</p>'}`;
    body.querySelectorAll('[data-amode]').forEach((b) => { b.onclick = () => { state.agendaMode = b.dataset.amode; render(); }; });
    wireChecks(body, p, render);
    wireOpeners(body, p);
  }

  // ------------------------------------------------------------ Calendario

  function calendario(body, p) {
    const today = todayYmd();
    const sel = state.calDay && state.calDay >= p.start && state.calDay <= p.end ? state.calDay : (today >= p.start && today <= p.end ? today : p.start);
    const months = [];
    const m0 = fromYmd(p.start);
    const mEnd = fromYmd(p.end);
    for (let d = new Date(m0.getFullYear(), m0.getMonth(), 1); d <= mEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(new Date(d));
    const byDate = new Map();
    p.activities.forEach((a) => { if (!byDate.has(a.date)) byDate.set(a.date, []); byDate.get(a.date).push(a); });
    const delDates = new Set(p.deliverables.map((d) => d.date));
    const monthHtml = (m) => {
      const first = new Date(m.getFullYear(), m.getMonth(), 1);
      const offset = (first.getDay() + 6) % 7;
      const daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const cells = [];
      for (let i = 0; i < offset; i++) cells.push('<span class="cal-cell empty"></span>');
      for (let dn = 1; dn <= daysIn; dn++) {
        const d = ymd(new Date(m.getFullYear(), m.getMonth(), dn));
        const acts = byDate.get(d) || [];
        const inPlan = d >= p.start && d <= p.end;
        const allDone = acts.length && acts.every((a) => a.status === 'Completada');
        const anyLate = acts.some((a) => isLate(a, today));
        const fronts = [...new Set(acts.map((a) => a.front))];
        cells.push(`<button type="button" class="cal-cell ${inPlan ? 'in' : 'out'} ${d === today ? 'today' : ''} ${d === sel ? 'sel' : ''} ${p.holidays.includes(d) ? 'hol' : ''} ${allDone ? 'alldone' : ''} ${anyLate ? 'haslate' : ''}" data-day="${d}" aria-label="${esc(fmtLong(d))}: ${acts.length} actividades">
          <span class="cn">${dn}</span>
          ${acts.length ? `<span class="dots">${fronts.slice(0, 4).map((f) => `<i style="background:${esc(frontOf(p, f).color)}"></i>`).join('')}</span><span class="cc">${acts.length}</span>` : ''}
          ${delDates.has(d) ? '<span class="dl" aria-hidden="true">◆</span>' : ''}
        </button>`);
      }
      return `<div class="card cal-month"><h3 class="cal-title">${esc(cap(monthFmt.format(m)))}</h3>
        <div class="cal-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((x) => `<span class="cal-wd">${x}</span>`).join('')}${cells.join('')}</div></div>`;
    };
    const acts = byDate.get(sel) || [];
    const dels = p.deliverables.filter((d) => d.date === sel);
    body.innerHTML = `
      <div class="legend">${p.fronts.map((f) => `<span><i style="background:${esc(f.color)}"></i>${esc(f.code)} ${esc(f.name)}</span>`).join('')}<span>◆ entregable</span></div>
      ${months.map(monthHtml).join('')}
      <section class="day-block is-sel">
        <h3 class="day-head"><span>${esc(cap(fmtLong(sel)))}</span>${acts.length ? `<span class="dh-count">${acts.filter((a) => a.status === 'Completada').length}/${acts.length}</span>` : ''}</h3>
        ${p.holidays.includes(sel) ? '<p class="holiday">🎌 Feriado</p>' : ''}
        <ul class="act-list">${acts.map((a) => actRow(p, a)).join('')}</ul>
        ${dels.length ? `<ul class="del-mini">${dels.map((x) => `<li><button type="button" data-del="${esc(x.id)}">📦 <span class="dm-name">${esc(x.id)} · ${esc(x.name)}</span><span class="pill-st">${esc(x.status)}</span></button></li>`).join('')}</ul>` : ''}
        ${!acts.length && !dels.length ? '<p class="muted">Sin actividades este día.</p>' : ''}
      </section>`;
    body.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { state.calDay = b.dataset.day; render(); body.querySelector('.is-sel')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }; });
    wireChecks(body, p, render);
    wireOpeners(body, p);
  }

  // ------------------------------------------------------------ Semanas (línea de tiempo)

  function semanas(body, p) {
    const today = todayYmd();
    const weeks = weeksOf(p);
    body.innerHTML = weeks.map((w) => {
      const monday = addDays(w.from, -((fromYmd(w.from).getDay() + 6) % 7));
      const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
      const fronts = p.fronts.filter((f) => w.acts.some((a) => a.front === f.code));
      const done = w.acts.filter((a) => a.status === 'Completada').length;
      const current = today >= monday && today <= addDays(monday, 6);
      const lateN = w.acts.filter((a) => isLate(a, today)).length;
      return `
      <details class="card week-card ${current ? 'current' : ''}" ${current ? 'open' : ''}>
        <summary>
          <div class="wk-head"><strong>Semana ${w.n}</strong><span class="muted small">${esc(fmtDay(days[0]))} – ${esc(fmtDay(days[4]))}</span>${current ? '<span class="pill-st st-doing">Esta semana</span>' : ''}${lateN ? `<span class="pill-st st-late">${lateN} atrasadas</span>` : ''}</div>
          <div class="wk-prog"><div class="progress"><span style="width:${Math.round((done / w.acts.length) * 100)}%"></span></div><span>${done}/${w.acts.length}</span></div>
          <div class="gantt" style="--cols:5">
            <span></span>${days.map((d) => `<span class="g-day ${d === today ? 'today' : ''}">${esc(fmtDay(d).split(' ')[0].replace(',', ''))}</span>`).join('')}
            ${fronts.map((f) => `<span class="g-front"><span class="front-chip" style="--c:${esc(f.color)}">${esc(f.code)}</span></span>${days.map((d) => {
              const acts = w.acts.filter((a) => a.front === f.code && a.date === d);
              return `<span class="g-cell">${acts.map((a) => `<i class="g-dot ${a.status === 'Completada' ? 'done' : isLate(a, today) ? 'late' : ''}" style="--c:${esc(f.color)}"></i>`).join('')}</span>`;
            }).join('')}`).join('')}
          </div>
        </summary>
        <ul class="act-list">${w.acts.map((a) => actRow(p, a)).join('')}</ul>
      </details>`;
    }).join('');
    wireChecks(body, p, render);
    wireOpeners(body, p);
  }

  // ------------------------------------------------------------ Entregables

  function entregables(body, p) {
    const today = todayYmd();
    const mode = state.delMode || 'proximos';
    let list = p.deliverables;
    if (mode === 'proximos') list = list.filter((d) => d.status === 'Pendiente' && d.date >= today);
    if (mode === 'atrasados') list = list.filter((d) => d.status === 'Pendiente' && d.date < today);
    if (mode === 'listos') list = list.filter((d) => d.status !== 'Pendiente');
    const st = planStats(p);
    body.innerHTML = `
      <div class="del-summary card">
        <div><b>${st.del.delivered}</b><span>entregados</span></div>
        <div><b>${st.del.validated}</b><span>validados</span></div>
        <div class="${st.del.soon ? 'warn' : ''}"><b>${st.del.soon}</b><span>en 7 días</span></div>
        <div class="${st.del.late ? 'bad' : ''}"><b>${st.del.late}</b><span>atrasados</span></div>
      </div>
      <div class="segmented four" role="radiogroup" aria-label="Mostrar">
        ${[['proximos', 'Próximos'], ['atrasados', 'Atrasados'], ['listos', 'Listos'], ['todos', 'Todos']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${mode === v}" class="${mode === v ? 'on' : ''}" data-dmode="${v}">${l}</button>`).join('')}
      </div>
      <ul class="del-list">
        ${list.map((d) => {
          const c = d.status === 'Pendiente' ? countdown(d.date) : { text: d.status, cls: 'ok' };
          return `<li><button type="button" data-del="${esc(d.id)}" class="del-row" style="--c:${esc(frontOf(p, d.front).color)}">
            <span class="dr-top"><span class="dr-id">${esc(d.id)}</span>${frontChip(p, d.front)}<span class="cd ${c.cls}">${esc(c.text)}</span></span>
            <span class="dr-name">${esc(d.name)}</span>
            <span class="dr-meta">📅 ${esc(fmtDay(d.date))}${d.validatedBy ? ` · ✅ valida ${esc(d.validatedBy)}` : ''}${d.folder ? ` · 📁 ${esc(d.folder)}` : ''}</span>
          </button></li>`;
        }).join('') || '<li class="muted center">Nada en esta lista.</li>'}
      </ul>`;
    body.querySelectorAll('[data-dmode]').forEach((b) => { b.onclick = () => { state.delMode = b.dataset.dmode; render(); }; });
    wireOpeners(body, p);
  }

  // ------------------------------------------------------------ Metas

  function metas(body, p) {
    const fmtVal = (g, v) => (g.isPct ? `${Math.round(v * 100)} %` : String(Math.round(v * 100) / 100));
    const groups = new Map();
    p.goals.forEach((g) => { if (!groups.has(g.front)) groups.set(g.front, []); groups.get(g.front).push(g); });
    const st = planStats(p);
    body.innerHTML = `
      <p class="muted">${st.goals.met} de ${st.goals.total} metas cumplidas. Actualice el valor real con − y +.</p>
      ${[...groups.entries()].map(([code, gs]) => {
        const f = frontOf(p, code);
        return `<div class="card goal-card" style="--c:${esc(f.color)}">
          <h2 class="card-title"><span class="front-chip" style="--c:${esc(f.color)}">${esc(f.code)}</span> ${esc(f.name)}</h2>
          ${gs.map((g) => {
            const ratio = Math.min(1, g.real / g.meta);
            const c = g.date ? countdown(g.date) : null;
            return `<div class="goal" data-goal="${esc(g.id)}">
              <p class="g-ind">${esc(g.indicator)}</p>
              <div class="g-row">
                <div class="g-bar"><span style="width:${Math.round(ratio * 100)}%"></span></div>
                <div class="stepper"><button type="button" class="icon-btn small" data-step="-1" aria-label="Restar">−</button><span class="g-val"><b>${fmtVal(g, g.real)}</b> / ${fmtVal(g, g.meta)}</span><button type="button" class="icon-btn small" data-step="1" aria-label="Sumar">+</button></div>
              </div>
              <p class="g-foot">${ratio >= 1 ? '<span class="pill-st st-done">Cumplida</span>' : `<span>${Math.round(ratio * 100)} % de la meta</span>`}${g.date ? ` · meta ${esc(fmtDay(g.date))}${ratio < 1 && c ? ` <span class="cd ${c.cls}">${esc(c.text)}</span>` : ''}` : ''}${g.source ? ` · ${esc(g.source)}` : ''}</p>
            </div>`;
          }).join('')}
        </div>`;
      }).join('') || '<p class="muted center">El plan no trae metas.</p>'}`;
    body.querySelectorAll('[data-goal] [data-step]').forEach((b) => {
      b.onclick = () => {
        const g = p.goals.find((x) => x.id === b.closest('[data-goal]').dataset.goal);
        const step = g.isPct ? 0.1 : 1;
        g.real = Math.max(0, Math.round((g.real + Number(b.dataset.step) * step) * 100) / 100);
        if (g.real >= g.meta) ctx.toast('¡Meta cumplida! 🎉');
        save();
        render();
      };
    });
  }

  // ------------------------------------------------------------ Personas

  function personas(body, p) {
    const today = todayYmd();
    const people = planPeople(p);
    body.innerHTML = `
      <p class="muted">Con quién trabaja y qué depende de cada persona.</p>
      <div class="people-grid">
        ${people.map((x, i) => {
          const next = x.acts.find((a) => a.date >= today && a.status !== 'Completada');
          const pend = x.acts.filter((a) => a.status !== 'Completada').length;
          const initials = x.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
          return `<button type="button" class="person" data-person="${i}">
            <span class="avatar" aria-hidden="true">${esc(initials)}</span>
            <span class="pname">${esc(x.name)}</span>
            <span class="pmeta">${x.acts.length} actividades${x.dels.length ? ` · valida ${x.dels.length}` : ''}</span>
            ${next ? `<span class="pnext">Próx.: ${esc(fmtDay(next.date))}</span>` : pend ? '' : '<span class="pnext">Todo listo ✓</span>'}
          </button>`;
        }).join('')}
      </div>`;
    body.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => openPerson(p, people[Number(b.dataset.person)]); });
  }

  function openPerson(p, person) {
    const s = ctx.openSheet({
      label: person.name,
      html: `
        <div class="sheet-grabber"></div>
        <h2 class="sheet-title">${esc(person.name)}</h2>
        <p class="muted">${person.acts.length} actividades · valida ${person.dels.length} entregables</p>
        ${person.acts.length ? `<h3 class="drawer-title">Actividades</h3><ul class="act-list">${person.acts.map((a) => actRow(p, a)).join('')}</ul>` : ''}
        ${person.dels.length ? `<h3 class="drawer-title">Entregables que valida</h3><ul class="del-mini">${person.dels.map((d) => { const c = d.status === 'Pendiente' ? countdown(d.date) : { text: d.status, cls: 'ok' }; return `<li><button type="button" data-del="${esc(d.id)}">📦 <span class="dm-name">${esc(d.id)} · ${esc(d.name)}</span><span class="cd ${c.cls}">${esc(c.text)}</span></button></li>`; }).join('')}</ul>` : ''}
        <div class="dlg-actions"><button type="button" class="btn soft" data-share>Compartir pendientes</button><button type="button" class="btn primary" data-close>Cerrar</button></div>`
    });
    s.el.querySelector('[data-close]').onclick = () => s.close();
    s.el.querySelector('[data-share]').onclick = () => {
      const pend = person.acts.filter((a) => a.status !== 'Completada');
      const lines = [`Pendientes con ${person.name}`, '', ...pend.map((a) => `• ${fmtDay(a.date)}: ${a.title}`), ...person.dels.filter((d) => d.status === 'Pendiente').map((d) => `• ${fmtDay(d.date)}: entregable ${d.id} ${d.name}`)];
      ctx.shareText(`Pendientes con ${person.name}`, lines.join('\n'));
    };
    wireChecks(s.el, p, () => { s.close(); render(); });
    s.el.querySelectorAll('[data-act]').forEach((b) => { b.onclick = (e) => { if (e.target.closest('.check')) return; s.close(); setTimeout(() => openActivity(p, b.dataset.act), 220); }; });
    s.el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { s.close(); setTimeout(() => openDeliverable(p, b.dataset.del), 220); }; });
  }

  // ------------------------------------------------------------ Bitácora

  function bitacora(body, p) {
    const today = todayYmd();
    const st = planStats(p);
    body.innerHTML = `
      <div class="card log-head">
        <div class="lh-num"><b>${st.log.sent}</b>/${st.log.total}</div>
        <div><strong>Bitácoras enviadas</strong><p class="muted small">Complete la de cada jornada presencial al cierre (17:00–17:30) y compártala.</p>
        <div class="progress"><span style="width:${Math.round((st.log.sent / Math.max(1, st.log.total)) * 100)}%"></span></div></div>
      </div>
      <ul class="log-list">
        ${p.log.map((l, i) => {
          const filled = l.meetings || l.agreements || l.alerts || l.docs || l.tomorrow;
          const state2 = l.sent ? ['Enviada', 'st-done'] : filled ? ['Por enviar', 'st-doing'] : l.date < today ? ['Falta', 'st-late'] : l.date === today ? ['Hoy', 'st-today'] : ['Próxima', ''];
          return `<li><button type="button" data-log="${i}" class="log-row ${l.date === today ? 'is-today' : ''}">
            <span class="lr-date">${esc(cap(fmtDay(l.date)))}</span>
            <span class="lr-text">${esc((l.meetings || l.agreements || 'Sin registrar').slice(0, 70))}</span>
            <span class="pill-st ${state2[1]}">${state2[0]}</span>
          </button></li>`;
        }).join('') || '<li class="muted">El plan no trae bitácora.</li>'}
      </ul>`;
    body.querySelectorAll('[data-log]').forEach((b) => { b.onclick = () => openLog(p, Number(b.dataset.log)); });
  }

  function logText(p, l) {
    const counterpart = (p.info.find((i) => /contraparte/i.test(i.label))?.value || '').split('·')[0].trim();
    return [
      `Bitácora ${fmtLong(l.date)}`,
      counterpart ? `Para: ${counterpart}` : '',
      '',
      'Reuniones sostenidas:', l.meetings || '—', '',
      'Acuerdos y responsables:', l.agreements || '—', '',
      'Documentos recibidos:', l.docs || '—', '',
      'Alertas / escalamientos:', l.alerts || '—', '',
      'Pendientes para mañana:', l.tomorrow || '—'
    ].filter((x, i) => i !== 1 || x).join('\n');
  }

  function openLog(p, idx) {
    const l = p.log[idx];
    const fields = [['meetings', 'Reuniones sostenidas'], ['agreements', 'Acuerdos y responsables'], ['docs', 'Documentos recibidos'], ['alerts', 'Alertas / escalamientos'], ['tomorrow', 'Pendientes para mañana']];
    const s = ctx.openSheet({
      full: true,
      label: 'Bitácora',
      className: 'log-sheet',
      onClose: () => render(),
      html: `
        <div class="sheet-head"><button type="button" class="btn ghost back" data-close>‹ Listo</button><strong>Bitácora · ${esc(fmtDay(l.date))}</strong><span></span></div>
        <div class="sheet-body">
          <button type="button" class="btn soft full-w" data-fill>✨ Completar con las actividades del día</button>
          ${fields.map(([k, label]) => `<label class="field"><span>${label}</span><textarea class="input" rows="3" data-f="${k}">${esc(l[k] || '')}</textarea></label>`).join('')}
          <label class="switch-row"><span>Enviada a la contraparte</span><input type="checkbox" data-sent ${l.sent ? 'checked' : ''}><i></i></label>
          <div class="dlg-actions"><button type="button" class="btn ghost" data-copy>Copiar</button><button type="button" class="btn primary" data-share>Compartir bitácora</button></div>
        </div>`
    });
    const el = s.el;
    const sync = () => { el.querySelectorAll('[data-f]').forEach((t) => { l[t.dataset.f] = t.value.trim(); }); save(); };
    el.querySelectorAll('[data-f]').forEach((t) => t.addEventListener('input', sync));
    el.querySelector('[data-close]').onclick = () => s.close();
    el.querySelector('[data-sent]').onchange = (e) => { l.sent = e.target.checked; save(); };
    el.querySelector('[data-copy]').onclick = () => { sync(); ctx.copyText(logText(p, l)); };
    el.querySelector('[data-share]').onclick = async () => {
      sync();
      await ctx.shareText(`Bitácora ${fmtDay(l.date)}`, logText(p, l));
      if (!l.sent && (await ctx.confirmDialog('¿La envió?', 'Puedo marcar esta bitácora como enviada.', 'Sí, marcar enviada'))) {
        l.sent = true;
        el.querySelector('[data-sent]').checked = true;
        save();
      }
    };
    el.querySelector('[data-fill]').onclick = () => {
      const acts = p.activities.filter((a) => a.date === l.date);
      const next = p.activities.filter((a) => a.date > l.date && a.status !== 'Completada');
      const nextDate = next.length ? next[0].date : null;
      const meet = acts.filter((a) => a.with).map((a) => `• ${a.title} (${a.with})${a.status === 'Completada' ? ' ✓' : ''}`);
      const agr = acts.filter((a) => a.notes).map((a) => `• ${a.title}: ${a.notes}`);
      const docs = acts.filter((a) => a.status === 'Completada' && a.deliverable).map((a) => `• ${a.deliverable}`);
      const alerts = acts.filter((a) => a.status === 'Bloqueada').map((a) => `• Bloqueada: ${a.title}${a.notes ? ` — ${a.notes}` : ''}`);
      const tomorrow = [
        ...acts.filter((a) => a.status !== 'Completada').map((a) => `• (pendiente de hoy) ${a.title}`),
        ...(nextDate ? next.filter((a) => a.date === nextDate).map((a) => `• ${a.title}`) : [])
      ];
      const set = (k, arr) => { const t = el.querySelector(`[data-f="${k}"]`); if (!t.value.trim() && arr.length) t.value = arr.join('\n'); };
      set('meetings', meet); set('agreements', agr); set('docs', docs); set('alerts', alerts); set('tomorrow', tomorrow);
      sync();
      ctx.toast('Borrador listo. Revíselo y complete lo que falte.');
    };
  }

  // ------------------------------------------------------------ Reporte semanal

  function reporte(body, p) {
    const weeks = weeksOf(p);
    const today = todayYmd();
    const cur = (weeks.find((w) => today >= w.from && today <= addDays(w.to, 3)) || weeks[0]).n;
    const sel = state.reportWeek || cur;
    const text = state.reportDraft && state.reportDraft.week === sel ? state.reportDraft.text : weeklyReport(p, sel, fmtDay);
    body.innerHTML = `
      <div class="chips wrap">${weeks.map((w) => `<button type="button" class="chip ${w.n === sel ? 'on' : ''}" data-week="${w.n}">Semana ${w.n}</button>`).join('')}</div>
      <div class="card">
        <h2 class="card-title">📨 Reporte semana ${sel}</h2>
        <p class="muted small">Se arma solo con el estado de sus actividades y entregables. Puede editarlo antes de enviar.</p>
        <textarea class="input report-text" id="reportText" rows="16">${esc(text)}</textarea>
        <div class="btn-row">
          <button type="button" class="btn ghost small" id="rpReset">Rehacer</button>
          ${ctx.aiConfig() ? '<button type="button" class="btn soft small" id="rpAI">✨ Mejorar redacción con IA</button>' : ''}
          <button type="button" class="btn ghost small" id="rpCopy">Copiar</button>
          <button type="button" class="btn primary small" id="rpShare">Compartir</button>
        </div>
        <div id="rpOut"></div>
      </div>`;
    const ta = body.querySelector('#reportText');
    ta.addEventListener('input', () => { state.reportDraft = { week: sel, text: ta.value }; });
    body.querySelectorAll('[data-week]').forEach((b) => { b.onclick = () => { state.reportWeek = Number(b.dataset.week); state.reportDraft = null; render(); }; });
    body.querySelector('#rpReset').onclick = () => { state.reportDraft = null; render(); };
    body.querySelector('#rpCopy').onclick = () => ctx.copyText(ta.value);
    body.querySelector('#rpShare').onclick = () => ctx.shareText(`Reporte semana ${sel}`, ta.value);
    body.querySelector('#rpAI')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const out = body.querySelector('#rpOut');
      btn.disabled = true;
      out.innerHTML = '<div class="loading"><span class="spinner"></span>Mejorando la redacción…</div>';
      try {
        const better = await ctx.AI.polishReport(ctx.aiConfig(), ta.value);
        ta.value = better;
        state.reportDraft = { week: sel, text: better };
        out.innerHTML = '';
        ctx.toast('Redacción mejorada. Revísela antes de enviar.');
      } catch (err) {
        ctx.showAIError(out, err);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ Reglas

  function reglas(body, p) {
    const focus = focusFor(p, todayYmd());
    body.innerHTML = `
      ${p.weekTemplate.length ? `<div class="card"><h2 class="card-title">🗓️ Semana tipo</h2>
        <ul class="week-tpl">${p.weekTemplate.map((w) => `<li class="${focus === w ? 'today' : ''}"><strong>${esc(w.day)}${focus === w ? ' · hoy' : ''}</strong><span>${esc(w.focus)}</span>${w.routine ? `<small>⏱ ${esc(w.routine)}</small>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${p.rules.length ? `<div class="card"><h2 class="card-title">🧭 Límites y reglas</h2>
        <dl class="rules">${p.rules.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.text)}</dd>`).join('')}</dl></div>` : ''}
      ${p.inputs.length ? `<div class="card"><h2 class="card-title">🧰 Insumos</h2>
        <dl class="rules">${p.inputs.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.text)}</dd>`).join('')}</dl></div>` : ''}
      ${!p.weekTemplate.length && !p.rules.length && !p.inputs.length ? '<p class="muted center">El plan no trae hoja de referencia.</p>' : ''}`;
  }

  // ------------------------------------------------------------ hojas de detalle

  function openActivity(p, id) {
    const a = p.activities.find((x) => x.id === id);
    if (!a) return;
    const f = frontOf(p, a.front);
    const s = ctx.openSheet({
      label: 'Actividad',
      className: 'act-sheet',
      onClose: () => render(),
      html: `
        <div class="sheet-grabber"></div>
        <p class="as-top"><span class="front-chip" style="--c:${esc(f.color)}">${esc(f.code)}</span> ${esc(f.name)} · ${esc(a.id)} · semana ${a.week}</p>
        <h2 class="sheet-title">${esc(a.title)}</h2>
        <ul class="as-facts">
          <li>📅 ${esc(cap(fmtLong(a.date)))}${a.mode ? ` · ${/remot/i.test(a.mode) ? '🏠' : '🏭'} ${esc(a.mode)}` : ''}</li>
          ${a.with ? `<li>👤 ${esc(a.with)}</li>` : ''}
          ${a.deliverable ? `<li>📦 ${esc(a.deliverable)}</li>` : ''}
        </ul>
        <div class="segmented four" role="radiogroup" aria-label="Estado">
          ${STATUSES.map((x) => `<button type="button" role="radio" aria-checked="${a.status === x}" class="${a.status === x ? 'on' : ''} ${STATUS_CLASS[x]}" data-status="${x}">${x}</button>`).join('')}
        </div>
        <label class="field" id="progField" ${a.status === 'En curso' || a.status === 'Bloqueada' ? '' : 'hidden'}><span>Avance: <b id="progVal">${activityProgress(a)} %</b></span>
          <input type="range" min="0" max="100" step="10" value="${activityProgress(a)}" id="progRange" class="seek">
        </label>
        <div class="grid2">
          <label class="field"><span>Fecha programada</span><input class="input" type="date" id="asDate" value="${a.date}"></label>
          <label class="field"><span>Fecha real</span><input class="input" type="date" id="asReal" value="${a.realDate || ''}"></label>
        </div>
        <label class="field"><span>Observaciones / bloqueos</span><textarea class="input" rows="3" id="asNotes" placeholder="Qué pasó, qué falta, a quién escalar…">${esc(a.notes || '')}</textarea></label>
        <div class="btn-col">
          <button type="button" class="btn soft" id="asCal">📅 Agregar al Calendario del iPhone</button>
          <button type="button" class="btn soft" id="asIdea">💡 Crear una nota con esta actividad</button>
        </div>
        <div class="dlg-actions"><button type="button" class="btn primary" data-close>Listo</button></div>`
    });
    const el = s.el;
    el.querySelector('[data-close]').onclick = () => s.close();
    el.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = () => {
        a.status = b.dataset.status;
        if (a.status === 'Completada') { a.progress = 100; a.realDate = a.realDate || todayYmd(); el.querySelector('#asReal').value = a.realDate; }
        if (a.status === 'Pendiente') { a.progress = 0; }
        if (a.status === 'En curso' && !a.progress) a.progress = 50;
        el.querySelectorAll('[data-status]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
        el.querySelector('#progField').hidden = !(a.status === 'En curso' || a.status === 'Bloqueada');
        el.querySelector('#progRange').value = activityProgress(a);
        el.querySelector('#progVal').textContent = `${activityProgress(a)} %`;
        if (a.status === 'Bloqueada') { el.querySelector('#asNotes').focus(); ctx.toast('Anote el bloqueo y a quién escalarlo.'); }
        save();
      };
    });
    el.querySelector('#progRange').oninput = (e) => { a.progress = Number(e.target.value); el.querySelector('#progVal').textContent = `${a.progress} %`; save(); };
    el.querySelector('#asDate').onchange = (e) => { if (e.target.value) { a.date = e.target.value; p.activities.sort((x, y) => x.date.localeCompare(y.date)); save(); ctx.toast(`Reprogramada para el ${fmtLong(a.date)}.`); } };
    el.querySelector('#asReal').onchange = (e) => { a.realDate = e.target.value || null; save(); };
    el.querySelector('#asNotes').oninput = (e) => { a.notes = e.target.value; save(); };
    el.querySelector('#asCal').onclick = () => ctx.calendarFile({ uid: `${p.id}-${a.id}`, title: a.title, start: fromYmd(a.date).setHours(9, 0, 0, 0), minutes: 60, description: [a.with && `Con: ${a.with}`, a.deliverable && `Entregable: ${a.deliverable}`, a.notes].filter(Boolean).join('\n') });
    el.querySelector('#asIdea').onclick = async () => {
      const id2 = await ctx.createIdeaFrom(`${a.title}\n\nCon: ${a.with || '—'}\nEntregable: ${a.deliverable || '—'}\n${a.notes || ''}`.trim(), `${a.id} · ${a.title}`, fromYmd(a.date).setHours(9, 0, 0, 0));
      if (id2) { s.close(); ctx.toast('Nota creada con recordatorio.', { action: 'Abrir', onAction: () => ctx.openEditor(id2) }); }
    };
  }

  function openDeliverable(p, id) {
    const d = p.deliverables.find((x) => x.id === id);
    if (!d) return;
    const f = frontOf(p, d.front);
    const c = countdown(d.date);
    const related = p.activities.filter((a) => a.deliverable && d.name && (a.deliverable.toLowerCase().split(' ').slice(0, 2).join(' ') === d.name.toLowerCase().split(' ').slice(0, 2).join(' ') || a.date === d.date && a.front === d.front));
    const s = ctx.openSheet({
      label: 'Entregable',
      className: 'act-sheet',
      onClose: () => render(),
      html: `
        <div class="sheet-grabber"></div>
        <p class="as-top"><span class="front-chip" style="--c:${esc(f.color)}">${esc(f.code)}</span> ${esc(f.name)} · ${esc(d.id)}</p>
        <h2 class="sheet-title">${esc(d.name)}</h2>
        <ul class="as-facts">
          <li>📅 Comprometido: ${esc(cap(fmtLong(d.date)))} ${d.status === 'Pendiente' ? `<span class="cd ${c.cls}">${esc(c.text)}</span>` : ''}</li>
          ${d.validatedBy ? `<li>✅ Valida: ${esc(d.validatedBy)}</li>` : ''}
          ${d.folder ? `<li>📁 Carpeta: ${esc(d.folder)}</li>` : ''}
        </ul>
        <div class="segmented" role="radiogroup" aria-label="Estado">
          ${DELIV_STATUSES.map((x) => `<button type="button" role="radio" aria-checked="${d.status === x}" class="${d.status === x ? 'on' : ''}" data-dstatus="${x}">${x}</button>`).join('')}
        </div>
        <label class="field"><span>Fecha de entrega</span><input class="input" type="date" id="dsReal" value="${d.realDate || ''}"></label>
        <label class="field"><span>Observaciones</span><textarea class="input" rows="3" id="dsNotes">${esc(d.notes || '')}</textarea></label>
        ${related.length ? `<h3 class="drawer-title">Actividades relacionadas</h3><ul class="act-list">${related.map((a) => actRow(p, a)).join('')}</ul>` : ''}
        <div class="btn-col"><button type="button" class="btn soft" id="dsCal">📅 Avisarme en el Calendario (el día antes)</button></div>
        <div class="dlg-actions"><button type="button" class="btn primary" data-close>Listo</button></div>`
    });
    const el = s.el;
    el.querySelector('[data-close]').onclick = () => s.close();
    el.querySelectorAll('[data-dstatus]').forEach((b) => {
      b.onclick = () => {
        d.status = b.dataset.dstatus;
        if (d.status !== 'Pendiente' && !d.realDate) { d.realDate = todayYmd(); el.querySelector('#dsReal').value = d.realDate; }
        el.querySelectorAll('[data-dstatus]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
        if (d.status !== 'Pendiente') ctx.toast(d.status === 'Validado' ? '¡Entregable validado! 🎉' : 'Entregable marcado como entregado.');
        save();
      };
    });
    el.querySelector('#dsReal').onchange = (e) => { d.realDate = e.target.value || null; save(); };
    el.querySelector('#dsNotes').oninput = (e) => { d.notes = e.target.value; save(); };
    el.querySelector('#dsCal').onclick = () => ctx.calendarFile({ uid: `${p.id}-${d.id}`, title: `Entregable ${d.id}: ${d.name}`, start: fromYmd(addDays(d.date, -1)).setHours(16, 0, 0, 0), minutes: 30, description: `Vence: ${fmtLong(d.date)}${d.validatedBy ? `\nValida: ${d.validatedBy}` : ''}${d.folder ? `\nCarpeta: ${d.folder}` : ''}` });
    wireChecks(el, p, () => { s.close(); });
  }

  // ------------------------------------------------------------ chat con IA sobre el plan

  function planAsText(p) {
    const lines = [`Plan: ${p.title}. ${p.header}`, ...p.info.map((i) => `${i.label}: ${i.value}`), `Hoy es ${todayYmd()}.`, '', 'Frentes:'];
    p.fronts.forEach((f) => lines.push(`- ${f.code} ${f.name} (peso ${Math.round(f.weight * 100)}%)`));
    lines.push('', 'Actividades (id | fecha | frente | estado | actividad | con quién | entregable | observaciones):');
    p.activities.forEach((a) => lines.push(`${a.id} | ${a.date} | ${a.front} | ${a.status}${isLate(a) ? ' (atrasada)' : ''} | ${a.title} | ${a.with} | ${a.deliverable} | ${a.notes}`));
    lines.push('', 'Entregables (id | fecha | estado | nombre | valida):');
    p.deliverables.forEach((d) => lines.push(`${d.id} | ${d.date} | ${d.status} | ${d.name} | ${d.validatedBy}`));
    lines.push('', 'Metas (indicador: real / meta):');
    p.goals.forEach((g) => lines.push(`- ${g.indicator}: ${g.real} / ${g.meta}`));
    if (p.rules.length) { lines.push('', 'Reglas:'); p.rules.forEach((r) => lines.push(`- ${r.label}: ${r.text}`)); }
    return lines.join('\n');
  }

  function openPlanChat(p) {
    const s = ctx.openSheet({
      full: true,
      label: 'Chat del plan',
      className: 'askall',
      html: `
        <div class="sheet-head"><button type="button" class="btn ghost back" data-close>‹ Volver</button><strong>💬 Preguntar al plan</strong><span></span></div>
        <div class="sheet-body"><p class="muted">La IA lee su plan (actividades, entregables, metas y reglas) y le ayuda a priorizar.</p><div id="planChatMount"></div></div>`
    });
    s.el.querySelector('[data-close]').onclick = () => s.close();
    state.planChat = state.planChat || [];
    ctx.mountChat(s.el.querySelector('#planChatMount'), {
      history: state.planChat,
      suggestions: ['¿Qué tengo que hacer hoy y qué es lo más importante?', '¿Qué tengo esta semana con Matías?', '¿Qué entregables vencen pronto y quién los valida?', '¿Voy atrasada en algo? ¿Qué priorizo?', 'Prepárame la reunión de planificación del lunes'],
      placeholder: 'Pregunte sobre su plan…',
      ask: (history) => ctx.AI.chatPlan(ctx.aiConfig(), planAsText(p), history)
    });
  }

  return { render, importFile, openActivity, ensureFileInput };
}
