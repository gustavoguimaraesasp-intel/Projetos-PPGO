// Paleta AutoCAD Color Index (ACI) 0-255.
// Cores 1-9 são fixas; 10-249 seguem o padrão matiz/brilho/saturação do AutoCAD;
// 250-255 são tons de cinza. A cor 7 depende do fundo (preto/branco) e é tratada como 'FG'.

const FIXED = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
  6: '#ff00ff', 7: 'FG', 8: '#808080', 9: '#c0c0c0',
};
const GRAYS = [51, 91, 132, 173, 214, 255];
const LEVELS = [255, 165, 127, 76, 38];

function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n) => Math.round((n + m)).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

const TABLE = new Array(256).fill('FG');
for (let i = 1; i <= 255; i++) {
  if (FIXED[i]) TABLE[i] = FIXED[i];
  else if (i >= 250) TABLE[i] = '#' + GRAYS[i - 250].toString(16).padStart(2, '0').repeat(3);
  else {
    const hue = (Math.floor(i / 10) - 1) * 15;
    const sub = i % 10;
    const v = LEVELS[Math.floor(sub / 2)];
    const s = sub % 2 === 0 ? 1 : 0.5;
    TABLE[i] = hsvToHex(hue, s, v);
  }
}

export function aciColor(index) {
  const i = Math.abs(index | 0);
  if (i < 1 || i > 255) return 'FG';
  return TABLE[i];
}

export function rgbToHex(rgb) {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}
