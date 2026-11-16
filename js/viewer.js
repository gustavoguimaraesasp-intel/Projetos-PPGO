// Visualizador 2D em Canvas: desenho, zoom, pan, seleção e destaque.

import { pointInPolygon } from './geometry.js';

export class Viewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.cx = 0; this.cy = 0; this.s = 1; // centro (mundo) e escala (px/unidade)
    this.dpr = window.devicePixelRatio || 1;
    this.theme = { bg: '#1b1f24', fg: '#e8e8e8', accent: '#ff9f1c' };
    this.selected = null;
    this.hoverPolygon = null;
    this.showFills = true;
    this.onPick = opts.onPick || (() => {});
    this.onMove = opts.onMove || (() => {});
    this.onView = opts.onView || (() => {});
    this._pending = false;
    this._bindEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setTheme(theme) { this.theme = { ...this.theme, ...theme }; this.requestDraw(); }

  setScene(scene) {
    this.scene = scene;
    this.selected = null;
    this._groups = null;
    this.fit();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.requestDraw();
  }

  fit(box) {
    const b = box || this.scene?.viewBox;
    if (!b) return;
    const w = Math.max(b[2] - b[0], 1e-9), h = Math.max(b[3] - b[1], 1e-9);
    this.cx = (b[0] + b[2]) / 2;
    this.cy = (b[1] + b[3]) / 2;
    this.s = Math.min(this.W / w, this.H / h) * 0.92;
    this.requestDraw();
  }

  zoomAt(factor, sx, sy) {
    if (sx == null) { sx = this.W / 2; sy = this.H / 2; }
    const [wx, wy] = this.toWorld(sx, sy);
    this.s = Math.min(Math.max(this.s * factor, 1e-12), 1e12);
    this.cx = wx - (sx - this.W / 2) / this.s;
    this.cy = wy + (sy - this.H / 2) / this.s;
    this.requestDraw();
  }

  toWorld(sx, sy) {
    return [this.cx + (sx - this.W / 2) / this.s, this.cy - (sy - this.H / 2) / this.s];
  }

  requestDraw() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this.draw(); });
  }

  _buildGroups() {
    // agrupa primitivas por cor para desenhar com poucas chamadas de stroke()
    const strokes = new Map();
    const fills = [];
    const texts = [];
    const points = [];
    for (const p of this.scene.prims) {
      if (p.kind === 'poly') {
        if (p.fill) fills.push(p);
        if (p.stroke !== false) {
          if (!strokes.has(p.color)) strokes.set(p.color, []);
          strokes.get(p.color).push(p);
        }
      } else if (p.kind === 'hatch') fills.push(p);
      else if (p.kind === 'text') texts.push(p);
      else if (p.kind === 'point') points.push(p);
    }
    this._groups = { strokes, fills, texts, points };
  }

  _visible(p) {
    const lm = this.scene.layerMap;
    const l = lm.get(p.layer);
    if (l && !l.visible) return false;
    if (p.ilayer) { const il = lm.get(p.ilayer); if (il && !il.visible) return false; }
    return true;
  }

  _col(c) {
    if (c === 'FG') return this.theme.fg;
    if (!this.theme.light) return c;
    // fundo claro: escurece cores muito claras (amarelo, ciano…) para manter a legibilidade
    this._lightCache ||= new Map();
    let v = this._lightCache.get(c);
    if (!v) {
      const n = parseInt(c.slice(1), 16);
      let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (lum > 0.6) { const k = 0.6 / lum * 0.85; r *= k; g *= k; b *= k; }
      v = `rgb(${r | 0},${g | 0},${b | 0})`;
      this._lightCache.set(c, v);
    }
    return v;
  }

  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.scene) return;
    if (!this._groups) this._buildGroups();
    const s = this.s;
    const [vx0, vy1] = this.toWorld(0, 0);
    const [vx1, vy0] = this.toWorld(this.W, this.H);
    const inView = (b) => !(b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1);
    const tiny = 0.6 / s; // tamanho mínimo em unidades de mundo para desenhar detalhes
    const world = () => ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (this.W / 2 - this.cx * s), dpr * (this.H / 2 + this.cy * s));
    world();
    ctx.lineWidth = 1 / s;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // preenchimentos (hachuras e sólidos)
    if (this.showFills) {
      for (const p of this._groups.fills) {
        if (!inView(p.bbox) || !this._visible(p)) continue;
        ctx.beginPath();
        if (p.kind === 'hatch') { for (const l of p.loops) this._path(l, true); }
        else this._path(p.pts, true);
        ctx.fillStyle = this._col(p.color);
        ctx.globalAlpha = p.kind === 'hatch' && !p.solid ? 0.18 : 1;
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
        if (p.kind === 'hatch' && !p.solid) {
          ctx.strokeStyle = this._col(p.color);
          ctx.globalAlpha = 0.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // linhas agrupadas por cor
    for (const [color, list] of this._groups.strokes) {
      ctx.beginPath();
      let any = false;
      for (const p of list) {
        const b = p.bbox;
        if (!inView(b) || !this._visible(p)) continue;
        if (b[2] - b[0] < tiny && b[3] - b[1] < tiny) {
          // elemento menor que um pixel: desenha apenas um ponto
          ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] + tiny, b[1]);
        } else this._path(p.pts, p.closed);
        any = true;
      }
      if (any) { ctx.strokeStyle = this._col(color); ctx.stroke(); }
    }

    // pontos (em pixels de tela)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1;
    for (const p of this._groups.points) {
      if (!inView(p.bbox) || !this._visible(p)) continue;
      const [x, y] = this.toScreen(p.x, p.y);
      ctx.strokeStyle = this._col(p.color);
      ctx.beginPath();
      ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
      ctx.stroke();
    }

    // textos
    for (const t of this._groups.texts) {
      const px = t.h * s;
      if (px < 2.5 || !inView(t.bbox) || !this._visible(t)) continue;
      const [x, y] = this.toScreen(t.x, t.y);
      ctx.setTransform(dpr, 0, 0, dpr, dpr * x, dpr * y);
      ctx.rotate(-t.rot);
      if (t.wf !== 1) ctx.scale(t.wf, 1);
      ctx.fillStyle = this._col(t.color);
      ctx.font = `${px * 1.35}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = t.align;
      const lh = px * 1.66;
      const n = t.lines.length;
      let y0 = 0;
      if (t.baseline === 'top') { ctx.textBaseline = 'top'; y0 = 0; }
      else if (t.baseline === 'middle') { ctx.textBaseline = 'middle'; y0 = -((n - 1) * lh) / 2; }
      else if (t.baseline === 'bottom') { ctx.textBaseline = 'bottom'; y0 = -(n - 1) * lh; }
      else { ctx.textBaseline = 'alphabetic'; y0 = 0; }
      for (let i = 0; i < n; i++) ctx.fillText(t.lines[i], 0, y0 + i * lh);
    }

    // destaque do polígono selecionado / sob o cursor
    for (const [pg, strong] of [[this.hoverPolygon, false], [this.selected, true]]) {
      if (!pg) continue;
      world();
      ctx.beginPath();
      this._path(pg.pts, true);
      ctx.fillStyle = this.theme.accent;
      ctx.globalAlpha = strong ? 0.28 : 0.12;
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.theme.accent;
      ctx.lineWidth = (strong ? 2.5 : 1.5) / s;
      ctx.stroke();
    }
    this.onView();
  }

  toScreen(x, y) {
    return [(x - this.cx) * this.s + this.W / 2, this.H / 2 - (y - this.cy) * this.s];
  }

  _path(pts, closed) {
    const ctx = this.ctx;
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    if (closed) ctx.closePath();
  }

  /** Polígonos que contêm o ponto (menor área primeiro). */
  polygonsAt(wx, wy, filter) {
    if (!this.scene) return [];
    const hits = [];
    for (const pg of this.scene.polygons) {
      const b = pg.bbox;
      if (wx < b[0] || wx > b[2] || wy < b[1] || wy > b[3]) continue;
      if (filter && !filter(pg)) continue;
      if (pointInPolygon(wx, wy, pg.pts)) hits.push(pg);
    }
    return hits.sort((a, b) => a.area - b.area);
  }

  select(pg, zoom) {
    this.selected = pg;
    if (pg && zoom) {
      const b = pg.bbox;
      const w = b[2] - b[0], h = b[3] - b[1];
      this.fit([b[0] - w * 0.4, b[1] - h * 0.4, b[2] + w * 0.4, b[3] + h * 0.4]);
    }
    this.requestDraw();
  }

  _bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(Math.pow(1.0015, -d), x, y);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      if (pointers.size === 1) {
        const [x, y] = pos(e);
        drag = { x, y, cx: this.cx, cy: this.cy, moved: false, button: e.button };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: this.s };
        drag = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        this.zoomAt((pinch.s * d) / pinch.d / this.s, mx, my);
        return;
      }
      if (drag) {
        const dx = p[0] - drag.x, dy = p[1] - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.cx = drag.cx - dx / this.s;
          this.cy = drag.cy + dy / this.s;
          c.style.cursor = 'grabbing';
          this.requestDraw();
        }
      }
      const [wx, wy] = this.toWorld(p[0], p[1]);
      this.onMove(wx, wy, p);
    });

    const end = (e) => {
      const wasDrag = drag;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) drag = null;
      c.style.cursor = '';
      if (wasDrag && !wasDrag.moved && e.type === 'pointerup' && wasDrag.button === 0) {
        const [x, y] = pos(e);
        const [wx, wy] = this.toWorld(x, y);
        this.onPick(wx, wy, e);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => this.fit());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
