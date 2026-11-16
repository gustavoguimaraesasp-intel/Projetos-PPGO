// Utilitários geométricos 2D: matrizes afins, OCS, arcos, bulges, splines e áreas.
// Matriz afim 2D: [a, b, c, d, e, f] -> x' = a*x + c*y + e ; y' = b*x + d*y + f

export const TAU = Math.PI * 2;
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function mul(m, n) {
  // retorna m * n (aplica n primeiro, depois m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
export function rotate(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}
export const det = (m) => m[0] * m[3] - m[1] * m[2];
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function isIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** Matriz OCS -> WCS (projetada em XY) pelo "Arbitrary Axis Algorithm" do AutoCAD. */
export function ocsMatrix(n, elevation = 0) {
  if (!n) return IDENTITY;
  let nx = n.x || 0, ny = n.y || 0, nz = n.z || 0;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return IDENTITY;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) {
    return elevation ? [1, 0, 0, 1, 0, 0] : IDENTITY;
  }
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    // Wy x N
    ax = nz; ay = 0; az = -nx;
  } else {
    // Wz x N
    ax = -ny; ay = nx; az = 0;
  }
  let l = Math.hypot(ax, ay, az);
  ax /= l; ay /= l; az /= l;
  // Ay = N x Ax
  let bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
  l = Math.hypot(bx, by, bz);
  bx /= l; by /= l;
  return [ax, ay, bx, by, elevation * nx, elevation * ny];
}

/** Nº de segmentos para um arco de abertura `sweep` (rad). */
export function arcSegments(sweep) {
  return Math.max(4, Math.ceil((Math.abs(sweep) / TAU) * 128));
}

/** Pontos de um arco (cx, cy, r) de a0 até a1 no sentido anti-horário. */
export function arcPoints(cx, cy, r, a0, a1, out = []) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = arcSegments(sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

export function circlePoints(cx, cy, r) {
  const n = 128, out = [];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Elipse: centro, eixo maior (vetor), razão, parâmetros t0..t1. */
export function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, out = []) {
  const vx = -my * ratio, vy = mx * ratio; // eixo menor
  let sweep = t1 - t0;
  while (sweep <= 1e-12) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = arcSegments(sweep);
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const c = Math.cos(t), s = Math.sin(t);
    out.push(cx + mx * c + vx * s, cy + my * c + vy * s);
  }
  return out;
}

/** Adiciona os pontos de um segmento com bulge entre (x1,y1) e (x2,y2) (sem o ponto inicial). */
export function bulgePoints(x1, y1, x2, y2, bulge, out) {
  if (!bulge || Math.abs(bulge) < 1e-12) {
    out.push(x2, y2);
    return;
  }
  const theta = 4 * Math.atan(bulge); // ângulo incluído (com sinal)
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) { out.push(x2, y2); return; }
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // centro = ponto médio + k * normal esquerda da corda, k = (1 - b²) / (4b)
  const k = (1 - bulge * bulge) / (4 * bulge);
  const cx = (x1 + x2) / 2 - dy * k;
  const cy = (y1 + y2) / 2 + dx * k;
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = arcSegments(theta);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  // garante o ponto final exato
  out[out.length - 2] = x2;
  out[out.length - 1] = y2;
}

/** Comprimento de um segmento com bulge. */
export function bulgeLength(x1, y1, x2, y2, bulge) {
  const chord = Math.hypot(x2 - x1, y2 - y1);
  if (!bulge || Math.abs(bulge) < 1e-12) return chord;
  const theta = Math.abs(4 * Math.atan(bulge));
  const r = chord / (2 * Math.sin(theta / 2));
  return r * theta;
}

/** Área com sinal do segmento circular gerado por um bulge (positivo = anti-horário). */
export function bulgeSegmentArea(x1, y1, x2, y2, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-12) return 0;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  const theta = Math.abs(4 * Math.atan(bulge));
  const r = chord / (2 * Math.sin(theta / 2));
  return Math.sign(bulge) * 0.5 * r * r * (theta - Math.sin(theta));
}

/** Polilinha com bulges: retorna { pts, area (com sinal), perimeter }. */
export function bulgePolyline(vertices, closed) {
  const pts = [];
  let area2 = 0, segArea = 0, perimeter = 0;
  const n = vertices.length;
  if (!n) return { pts, area: 0, perimeter: 0 };
  pts.push(vertices[0].x, vertices[0].y);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const bulge = a.bulge || 0;
    bulgePoints(a.x, a.y, b.x, b.y, bulge, pts);
    perimeter += bulgeLength(a.x, a.y, b.x, b.y, bulge);
    if (closed) {
      area2 += a.x * b.y - b.x * a.y;
      segArea += bulgeSegmentArea(a.x, a.y, b.x, b.y, bulge);
    }
  }
  return { pts, area: closed ? area2 / 2 + segArea : 0, perimeter };
}

/** Área com sinal (shoelace) de pontos planos [x0,y0,x1,y1,...]. */
export function polygonArea(pts) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return s / 2;
}

export function polylineLength(pts, closed) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i + 3 < n; i += 2) s += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  if (closed && n >= 4) s += Math.hypot(pts[0] - pts[n - 2], pts[1] - pts[n - 1]);
  return s;
}

export function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
    a += f;
    cx += (pts[i] + pts[j]) * f;
    cy += (pts[i + 1] + pts[j + 1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i += 2) { sx += pts[i]; sy += pts[i + 1]; }
    return [sx / (n / 2), sy / (n / 2)];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function transformPts(m, pts) {
  if (isIdentity(m)) return pts;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
    out[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
  }
  return out;
}

/** Avalia NURBS (algoritmo de De Boor) gerando pontos planos. */
export function nurbsPoints(degree, knots, ctrl, weights, samples) {
  const n = ctrl.length;
  if (n < 2) return [];
  const p = Math.min(degree || 3, n - 1);
  let U = knots;
  if (!U || U.length !== n + p + 1) {
    // vetor de nós uniforme "clamped"
    U = [];
    for (let i = 0; i <= n + p; i++) {
      if (i <= p) U.push(0);
      else if (i >= n) U.push(1);
      else U.push((i - p) / (n - p));
    }
  }
  const w = weights && weights.length === n ? weights : null;
  const t0 = U[p], t1 = U[n];
  const count = samples || Math.min(800, Math.max(32, n * 12));
  const out = [];
  for (let s = 0; s <= count; s++) {
    let t = t0 + ((t1 - t0) * s) / count;
    if (s === count) t = t1 - 1e-10 * (t1 - t0);
    let k = p;
    while (k < n - 1 && U[k + 1] <= t) k++;
    const dx = [], dy = [], dw = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j];
      const wt = w ? w[k - p + j] : 1;
      dx.push(c.x * wt); dy.push(c.y * wt); dw.push(wt);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const alpha = den === 0 ? 0 : (t - U[i]) / den;
        dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
        dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
        dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
      }
    }
    out.push(dx[p] / dw[p], dy[p] / dw[p]);
  }
  return out;
}

/** Curva Catmull-Rom passando pelos pontos de ajuste (fit points). */
export function catmullRom(points, closed, perSeg = 16) {
  const n = points.length;
  if (n < 2) return [];
  const get = (i) => {
    if (closed) return points[(i + n) % n];
    return points[Math.max(0, Math.min(n - 1, i))];
  };
  const out = [points[0].x, points[0].y];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 1; s <= perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      );
    }
  }
  return out;
}
