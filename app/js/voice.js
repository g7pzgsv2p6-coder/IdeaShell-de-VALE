// Reconocimiento de voz con la Web Speech API (webkitSpeechRecognition en Safari)

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const voiceSupported = typeof SR === 'function';

export const VOICE_LANGS = [
  { id: 'es-CL', label: 'Español (Chile)' },
  { id: 'es-ES', label: 'Español (España)' },
  { id: 'es-MX', label: 'Español (México)' },
  { id: 'es-AR', label: 'Español (Argentina)' },
  { id: 'es-US', label: 'Español (Estados Unidos)' }
];

export function voiceErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'IdeaShel Vale no tiene permiso para usar el micrófono o el reconocimiento de voz. En el iPhone revise Ajustes → Apps → Safari → Micrófono, y que Siri y Dictado estén activados. Mientras tanto, puede dictar con el micrófono del teclado.';
    case 'no-speech':
      return 'No se escuchó nada. Intente de nuevo hablando un poco más cerca del teléfono.';
    case 'audio-capture':
      return 'No se encontró un micrófono disponible. Revise que ninguna otra app lo esté usando.';
    case 'network':
      return 'El reconocimiento de voz necesita internet en este momento. Sin conexión, use el micrófono del teclado del iPhone para dictar.';
    case 'language-not-supported':
      return 'El idioma elegido no está disponible para reconocimiento de voz. Cambie el idioma en Ajustes → Voz.';
    default:
      return 'No se pudo usar el reconocimiento de voz. Puede dictar con el micrófono del teclado del iPhone.';
  }
}

/**
 * Sesión de dictado. onText(finalText, interimText) se llama con todo lo reconocido
 * hasta el momento en esta sesión.
 */
export class Dictation {
  constructor() {
    this.rec = null;
    this.active = false;
  }

  start({ lang = 'es-CL', onText, onStart, onEnd, onError }) {
    if (!voiceSupported) {
      onError?.('unsupported');
      return;
    }
    if (this.active) return;
    let rec;
    try {
      rec = new SR();
    } catch (e) {
      onError?.('unsupported');
      return;
    }
    this.rec = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { this.active = true; onStart?.(); };
    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        const piece = r[0] ? r[0].transcript : '';
        if (r.isFinal) finalText += piece + ' ';
        else interim += piece + ' ';
      }
      onText?.(finalText.replace(/\s+/g, ' ').trim(), interim.replace(/\s+/g, ' ').trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'aborted') return;
      onError?.(event.error);
    };
    rec.onend = () => {
      this.active = false;
      this.rec = null;
      onEnd?.();
    };
    try {
      rec.start();
      this.active = true;
    } catch (e) {
      this.active = false;
      onError?.('start-failed');
    }
  }

  stop() {
    if (this.rec) {
      try { this.rec.stop(); } catch (e) { /* ya detenido */ }
    }
  }
}
