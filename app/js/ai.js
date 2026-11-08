// IA opcional: Gemini (Google AI Studio) o Claude (Anthropic).
// Las llamadas van directo desde el teléfono al proveedor; no hay servidor intermedio.

export const GEMINI_MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (siempre la versión vigente) · recomendado' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (más rápido)' }
];

export const CLAUDE_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · económico, recomendado' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · más capaz, más caro' }
];

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AIError';
    this.code = code;
  }
}

const SYSTEM = 'Usted es el asistente de IdeaShel Vale, una app para capturar y ordenar ideas. ' +
  'Responda siempre en español de Chile, claro y breve, tratando al usuario de usted. ' +
  'Trabaje solo con la información de las ideas entregadas; no invente datos.';

const OFFLINE_MSG = 'Sin conexión a internet. Las funciones de IA necesitan internet; el resto de IdeaShel Vale funciona igual sin conexión.';

async function fetchJSON(url, options, timeoutMs = 60000) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AIError('offline', OFFLINE_MSG);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new AIError('timeout', 'La IA tardó demasiado en responder. Intente de nuevo en un momento.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AIError('offline', OFFLINE_MSG);
    throw new AIError('network', 'No se pudo conectar con el servicio de IA. Revise su conexión a internet e intente de nuevo.');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { res, data };
}

// ---------- Gemini ----------

function geminiError(status, data) {
  const msg = (data && data.error && data.error.message) || '';
  const st = (data && data.error && data.error.status) || '';
  if (/api key|api_key/i.test(msg) || status === 401 || (status === 403 && st === 'PERMISSION_DENIED')) {
    return new AIError('invalid_key', 'La clave de Gemini no es válida. Revísela en Ajustes (cópiela completa desde Google AI Studio).');
  }
  if (status === 429 || st === 'RESOURCE_EXHAUSTED') {
    return new AIError('quota', 'Alcanzó el límite gratuito de Gemini por ahora. Espere unos minutos (o hasta mañana) e intente de nuevo.');
  }
  if (status === 404) {
    return new AIError('model', 'El modelo de Gemini elegido no está disponible. Elija otro modelo en Ajustes → Inteligencia artificial.');
  }
  if (/location is not supported|region/i.test(msg)) {
    return new AIError('region', 'El nivel gratuito de Gemini no está disponible en su región para esta clave.');
  }
  if (status >= 500) {
    return new AIError('overloaded', 'Gemini está saturado o con problemas en este momento. Intente de nuevo en unos minutos.');
  }
  return new AIError('unknown', 'Gemini respondió con un error' + (msg ? ': ' + msg : '.'));
}

async function callGemini({ key, model, prompt, json }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };
  const { res, data } = await fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw geminiError(res.status, data);
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    if (data && data.promptFeedback && data.promptFeedback.blockReason) {
      throw new AIError('blocked', 'Gemini no quiso procesar este texto. Pruebe redactando la idea de otra forma.');
    }
    throw new AIError('empty', 'Gemini no devolvió respuesta. Intente de nuevo.');
  }
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!text) throw new AIError('empty', 'Gemini no devolvió respuesta. Intente de nuevo.');
  return text;
}

// ---------- Claude ----------

function claudeError(status, data) {
  const type = (data && data.error && data.error.type) || '';
  const msg = (data && data.error && data.error.message) || '';
  if (status === 401 || type === 'authentication_error') {
    return new AIError('invalid_key', 'La clave de Claude no es válida. Revísela en Ajustes (debe empezar con "sk-ant-").');
  }
  if (/credit balance|billing|purchase credits/i.test(msg) || type === 'billing_error' || status === 402) {
    return new AIError('no_credits', 'Su cuenta de Claude no tiene créditos. Cargue saldo en console.anthropic.com → Billing.');
  }
  if (status === 403 || type === 'permission_error') {
    return new AIError('invalid_key', 'La clave de Claude no tiene permiso para usar este modelo.');
  }
  if (status === 404 || type === 'not_found_error') {
    return new AIError('model', 'El modelo de Claude elegido no está disponible. Elija otro modelo en Ajustes.');
  }
  if (status === 429 || type === 'rate_limit_error') {
    if (/spend|usage limit/i.test(msg)) {
      return new AIError('no_credits', 'Alcanzó el límite de gasto de su cuenta de Claude. Revise sus límites en console.anthropic.com.');
    }
    return new AIError('rate', 'Hizo muchas solicitudes seguidas a Claude. Espere un minuto e intente de nuevo.');
  }
  if (status === 529 || status >= 500 || type === 'overloaded_error') {
    return new AIError('overloaded', 'Claude está saturado en este momento. Intente de nuevo en unos minutos.');
  }
  return new AIError('unknown', 'Claude respondió con un error' + (msg ? ': ' + msg : '.'));
}

async function callClaude({ key, model, prompt }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const body = {
    model,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' }
  };
  if (model === 'claude-sonnet-5-5') {
    // Si Sonnet rechaza una solicitud por sus filtros, el servidor reintenta con otro modelo.
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const { res, data } = await fetchJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw claudeError(res.status, data);
  if (data && data.stop_reason === 'refusal') {
    throw new AIError('blocked', 'Claude no pudo procesar esta solicitud. Pruebe redactando la idea de otra forma.');
  }
  const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new AIError('empty', 'Claude no devolvió respuesta. Intente de nuevo.');
  return text;
}

// ---------- Interfaz común ----------

async function ask(cfg, prompt, json = false) {
  if (!cfg) throw new AIError('no_key', 'Configure una clave de IA en Ajustes para usar esta función.');
  if (cfg.provider === 'gemini') return callGemini({ ...cfg, prompt, json });
  if (cfg.provider === 'claude') return callClaude({ ...cfg, prompt, json });
  throw new AIError('no_key', 'Configure una clave de IA en Ajustes para usar esta función.');
}

export function parseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AIError('format', 'La IA respondió en un formato inesperado. Intente de nuevo.');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new AIError('format', 'La IA respondió en un formato inesperado. Intente de nuevo.');
  }
}

function ideaBlock(idea) {
  return `Título: ${idea.title || '(sin título)'}\nIdea:\n"""\n${(idea.text || '').slice(0, 6000)}\n"""`;
}

export async function testConnection(cfg) {
  const out = await ask(cfg, 'Responda solamente con la palabra: OK');
  return out;
}

export async function summarize(cfg, idea) {
  const prompt = 'Resuma la siguiente idea en 1 a 3 frases, conservando lo esencial. ' +
    'Devuelva solo el resumen, sin encabezados ni comillas.\n\n' + ideaBlock(idea);
  return (await ask(cfg, prompt)).replace(/^["“]|["”]$/g, '').trim();
}

export async function suggestMeta(cfg, idea, categoryNames, existingTags) {
  const prompt = 'Analice la idea y sugiera:\n' +
    '1) un título breve y claro (máximo 8 palabras),\n' +
    `2) la categoría más adecuada, eligiendo EXACTAMENTE una de esta lista: ${JSON.stringify(categoryNames)},\n` +
    '3) entre 1 y 4 etiquetas cortas, en minúsculas, sin el símbolo #' +
    (existingTags.length ? `, reutilizando estas etiquetas existentes cuando calcen: ${JSON.stringify(existingTags.slice(0, 60))}` : '') + '.\n' +
    'Responda solo con JSON con esta forma: {"titulo":"...","categoria":"...","etiquetas":["..."]}\n\n' +
    ideaBlock(idea);
  const data = parseJSON(await ask(cfg, prompt, true));
  return {
    title: String(data.titulo || data.title || '').trim().slice(0, 80),
    category: String(data.categoria || data.category || '').trim(),
    tags: Array.isArray(data.etiquetas || data.tags) ? (data.etiquetas || data.tags).map(String) : []
  };
}

export async function toSteps(cfg, idea) {
  const prompt = 'Convierta la idea en una lista de 3 a 8 pasos concretos y ordenados para llevarla a cabo. ' +
    'Cada paso debe empezar con un verbo en infinitivo y tener máximo 15 palabras. ' +
    'Responda solo con JSON con esta forma: {"pasos":["...","..."]}\n\n' + ideaBlock(idea);
  const data = parseJSON(await ask(cfg, prompt, true));
  const steps = Array.isArray(data.pasos || data.steps) ? (data.pasos || data.steps) : [];
  const clean = steps.map((s) => String(s).replace(/^\s*(\d+[.)-]|[-•*])\s*/, '').trim()).filter(Boolean);
  if (!clean.length) throw new AIError('format', 'La IA no devolvió pasos. Intente de nuevo.');
  return clean.slice(0, 12);
}

export async function expand(cfg, idea) {
  const prompt = 'Desarrolle y amplíe esta idea: agregue contexto, posibles enfoques, beneficios, riesgos y un primer paso concreto. ' +
    'Use párrafos cortos o viñetas que empiecen con "- ". Máximo 250 palabras. ' +
    'No use asteriscos, negritas ni títulos con #.\n\n' + ideaBlock(idea);
  return (await ask(cfg, prompt)).replace(/\*\*/g, '').trim();
}

/** Agrupa ideas parecidas. Devuelve [{name, description, ids:[...]}]. */
export async function organize(cfg, ideas) {
  const list = ideas.slice(0, 150);
  const lines = list.map((idea, i) => {
    const text = (idea.text || '').replace(/\s+/g, ' ').slice(0, 240);
    return `${i + 1}. ${idea.title || ''} — ${text}`;
  }).join('\n');
  const prompt = 'Agrupe las siguientes ideas por tema, juntando las que sean parecidas o relacionadas. ' +
    'Cree entre 2 y 8 grupos con un nombre corto (1 a 3 palabras) y una descripción de una frase. ' +
    'Cada idea debe ir en un solo grupo. Use los números de las ideas. ' +
    'Responda solo con JSON con esta forma: {"grupos":[{"nombre":"...","descripcion":"...","ideas":[1,2]}]}\n\n' +
    'Ideas:\n' + lines;
  const data = parseJSON(await ask(cfg, prompt, true));
  const groups = Array.isArray(data.grupos || data.groups) ? (data.grupos || data.groups) : [];
  const result = groups.map((g) => {
    const nums = Array.isArray(g.ideas || g.ids) ? (g.ideas || g.ids) : [];
    const ids = [...new Set(nums.map((n) => list[Number(n) - 1]).filter(Boolean).map((idea) => idea.id))];
    return {
      name: String(g.nombre || g.name || 'Grupo').trim().slice(0, 40),
      description: String(g.descripcion || g.description || '').trim().slice(0, 200),
      ids
    };
  }).filter((g) => g.ids.length);
  if (!result.length) throw new AIError('format', 'La IA no pudo agrupar las ideas. Intente de nuevo.');
  return result;
}
