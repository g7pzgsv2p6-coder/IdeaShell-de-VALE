// Logo original de Chispa: burbuja de voz con una chispa, en violeta y coral.
export function logoSVG({ size = 512, rounded = false, maskable = false } = {}) {
  const inner = `
    <rect x="104" y="112" width="304" height="236" rx="76" fill="#FFFFFF"/>
    <path d="M176 318 L148 412 Q146 420 154 416 L268 340 Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="10" stroke-linejoin="round"/>
    <path d="M256 150 Q266 220 334 230 Q266 240 256 310 Q246 240 178 230 Q246 220 256 150 Z" fill="url(#spark)"/>
    <path d="M338 146 Q341 166 360 169 Q341 172 338 192 Q335 172 316 169 Q335 166 338 146 Z" fill="#8061FF"/>
    <circle cx="186" cy="168" r="9" fill="#FFB199"/>`;
  const g = maskable ? `<g transform="translate(256 262) scale(0.78) translate(-256 -262)">${inner}</g>` : inner;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7A5CFF"/>
      <stop offset="1" stop-color="#4A2DC4"/>
    </linearGradient>
    <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF9A6B"/>
      <stop offset="1" stop-color="#FF5E62"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" ${rounded ? 'rx="116"' : ''} fill="url(#bg)"/>
  ${g}
</svg>`;
}
