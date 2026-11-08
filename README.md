# IdeaShel Vale · ideas por voz

App web instalable (PWA) para iPhone para capturar ideas por voz y organizarlas. Funciona sola: no depende de ningún servidor propio, todo queda guardado en el teléfono (IndexedDB) y abre sin internet.

**Enlace (una vez activado GitHub Pages):** https://g7pzgsv2p6-coder.github.io/IdeaShell-de-VALE/

## Funciones

- Botón grande para grabar la idea por voz (español de Chile, `es-CL`). Si el navegador no lo permite, el botón se oculta y aparece un aviso para usar el micrófono del teclado.
- Campo de texto siempre disponible (para escribir o dictar con el teclado del iPhone). Las `#etiquetas` escritas en el texto se agregan solas.
- Cada idea guarda: texto, título automático (editable), fecha y hora, categoría, etiquetas y favorita.
- Categorías editables (Trabajo, Personal, Proyectos, Estudios) y se pueden crear, renombrar, recolorear, ordenar y borrar.
- Lista con búsqueda (sin importar tildes), filtros (categoría, etiqueta, favoritas, estado, archivadas) y orden por fecha.
- Editar, borrar con confirmación y marcar favorita.
- Respaldo: exportar e importar en JSON (combinar o reemplazar), con recordatorio periódico.

### Mejoras propias

- Estado de cada idea: Nueva / En desarrollo / Hecha.
- Lista de pasos con casillas y barra de avance; al completar todos, la idea pasa a "Hecha".
- Fijar ideas arriba y archivar ideas.
- Papelera de 30 días con restaurar y "Deshacer".
- Compartir o copiar una idea.
- Pestaña **Explorar**: idea al azar para redescubrir, estadísticas, racha de días, etiquetas más usadas.
- Exportar todas las ideas como documento de texto (Markdown).
- Tema automático, claro u oscuro, e idioma de voz elegible.
- Aviso de nueva versión disponible.

### IA opcional

En **Ajustes → Inteligencia artificial** se elige el proveedor:

- **Gemini** (Google AI Studio, nivel gratuito). Modelo por defecto `gemini-flash-latest`, que siempre apunta al Gemini Flash vigente.
- **Claude** (Anthropic, pago por uso). Modelo por defecto `claude-haiku-5-5` (el más económico), con opción de `claude-sonnet-5-5`.

Funciones por idea: Resumir, Sugerir título/categoría/etiquetas, Convertir en lista de pasos, Expandir idea. Función general (pestaña Explorar): Organizar mis ideas (agrupa ideas parecidas y propone etiquetas).

Las claves quedan guardadas **solo en el teléfono**, nunca se incluyen en los respaldos y se pueden borrar con un botón. Sin clave, la app funciona completa y se ocultan las funciones de IA.

## Publicación en GitHub Pages

1. En GitHub, abra el repositorio → **Settings** → **Pages**.
2. En **Build and deployment → Source**, elija **GitHub Actions**.
3. Cada vez que se haga push a la rama `main`, el workflow `.github/workflows/pages.yml` publica la carpeta `app/`.
4. El enlace queda en: https://g7pzgsv2p6-coder.github.io/IdeaShell-de-VALE/

El repositorio debe ser público para usar GitHub Pages gratis.

## Estructura

```
app/                  ← la app que se publica (rutas relativas)
  index.html
  styles.css
  manifest.webmanifest
  sw.js               ← service worker (abre sin internet)
  js/app.js           ← interfaz y lógica
  js/db.js            ← IndexedDB
  js/ai.js            ← Gemini y Claude
  js/voice.js         ← reconocimiento de voz
  js/util.js
  icons/              ← íconos generados (192, 512, maskable, apple-touch 180)
tools/                ← generador de íconos (logo original en tools/logo.mjs)
tests/e2e.mjs         ← prueba completa con Playwright en tamaño iPhone
capturas/             ← capturas de la última prueba
```

## Desarrollo

```bash
# Probar localmente
cd app && python3 -m http.server 8080      # abrir http://localhost:8080

# Prueba completa (Playwright, tamaño iPhone, genera capturas en capturas/)
node tests/e2e.mjs

# Regenerar íconos después de cambiar tools/logo.mjs
node tools/generate-icons.mjs
```

Para cambiar el nombre o los colores: el nombre está en `app/index.html` y `app/manifest.webmanifest`; los colores en las variables del inicio de `app/styles.css` y el logo en `tools/logo.mjs`.

Si agrega archivos nuevos a `app/`, súmelos a la lista `ASSETS` de `app/sw.js` para que funcionen sin internet.
