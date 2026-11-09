// Grabación de audio con MediaRecorder (se guarda en el teléfono) + utilidades de audio.

export const audioSupported = !!(globalThis.navigator && navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function' && typeof globalThis.MediaRecorder === 'function');

function pickMime() {
  const options = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const m of options) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* sigue */ }
  }
  return '';
}

export function micErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'No hay permiso para usar el micrófono. En el iPhone: Ajustes → Apps → Safari → Micrófono → Permitir (o Preguntar), y vuelva a intentar.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró un micrófono en este dispositivo.';
  if (name === 'NotReadableError') return 'El micrófono está ocupado por otra app (por ejemplo, una llamada). Ciérrela e intente de nuevo.';
  return 'No se pudo iniciar la grabación de audio.';
}

/** Grabador con pausa, medidor de nivel y duración real (sin contar pausas). */
export class AudioRecorder {
  constructor() {
    this.state = 'idle';
    this.chunks = [];
    this.elapsed = 0;
    this.startedAt = 0;
  }

  async start({ onLevel, onInterrupted } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    const mime = pickMime();
    const opts = { audioBitsPerSecond: 32000 };
    if (mime) opts.mimeType = mime;
    try {
      this.rec = new MediaRecorder(this.stream, opts);
    } catch (e) {
      this.rec = new MediaRecorder(this.stream);
    }
    this.mime = (this.rec.mimeType || mime || 'audio/mp4').split(';')[0];
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.state = 'recording';
    this.elapsed = 0;
    this.startedAt = performance.now();

    const track = this.stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (this.state !== 'idle') onInterrupted && onInterrupted(); };

    // Medidor de nivel (solo visual)
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        if (this.state === 'idle') return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const level = this.state === 'paused' ? 0 : Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        onLevel && onLevel(level);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* sin medidor */ }
  }

  get duration() {
    return this.state === 'recording' ? this.elapsed + (performance.now() - this.startedAt) / 1000 : this.elapsed;
  }

  pause() {
    if (this.state !== 'recording') return;
    try { this.rec.pause(); } catch (e) { /* algunos navegadores no pausan */ }
    this.elapsed += (performance.now() - this.startedAt) / 1000;
    this.state = 'paused';
  }

  resume() {
    if (this.state !== 'paused') return;
    try { this.rec.resume(); } catch (e) { /* idem */ }
    this.startedAt = performance.now();
    this.state = 'recording';
  }

  /** Detiene y devuelve { blob, mime, duration }. */
  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.state === 'idle') { resolve(null); return; }
      const duration = this.duration;
      this.state = 'idle';
      if (this.rec.state === 'inactive') {
        // El sistema ya detuvo la grabación (por ejemplo, al bloquear el teléfono): se guarda lo que haya
        const blob = new Blob(this.chunks, { type: this.mime });
        this.cleanup();
        resolve({ blob, mime: this.mime, duration });
        return;
      }
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this.cleanup();
        resolve({ blob, mime: this.mime, duration });
      };
      try { this.rec.stop(); } catch (e) { this.cleanup(); resolve(null); }
    });
  }

  cancel() {
    this.state = 'idle';
    try { this.rec && this.rec.state !== 'inactive' && this.rec.stop(); } catch (e) { /* nada */ }
    this.cleanup();
  }

  cleanup() {
    cancelAnimationFrame(this.raf);
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* nada */ }
    try { this.ctx && this.ctx.close(); } catch (e) { /* nada */ }
    this.stream = null;
    this.ctx = null;
  }
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// ---------- Conversión a WAV (16 kHz mono) en trozos, para transcribir con IA ----------

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Devuelve una lista de Blobs WAV de máximo `chunkSec` segundos cada uno. */
export async function toWavChunks(blob, chunkSec = 240, rate = 16000) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OffCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    const ab = await blob.arrayBuffer();
    // Forma con callbacks: compatible con Safari antiguo y moderno
    decoded = await new Promise((res, rej) => {
      const r = ctx.decodeAudioData(ab, res, rej);
      if (r && typeof r.then === 'function') r.then(res, rej);
    });
  } finally {
    try { ctx.close(); } catch (e) { /* nada */ }
  }
  const length = Math.ceil(decoded.duration * rate);
  const off = new OffCtx(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const per = chunkSec * rate;
  const out = [];
  for (let i = 0; i < pcm.length; i += per) out.push(encodeWav(pcm.subarray(i, Math.min(pcm.length, i + per)), rate));
  return out;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
