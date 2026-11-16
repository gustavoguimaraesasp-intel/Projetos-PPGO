// Converte o DwgDatabase (libredwg-web) em uma lista de primitivas 2D desenháveis
// e extrai os polígonos fechados com área e perímetro.

import { aciColor, rgbToHex } from './aci.js';
import {
  IDENTITY, TAU, mul, translate, scale, rotate, det, apply, ocsMatrix,
  arcPoints, circlePoints, ellipsePoints, bulgePolyline, polygonArea, polylineLength,
  bboxOf, transformPts, nurbsPoints, catmullRom, pointInPolygon, centroid,
} from './geometry.js';

const MAX_DEPTH = 12;

export const TYPE_LABELS = {
  LWPOLYLINE: 'Polilinha', POLYLINE2D: 'Polilinha 2D', CIRCLE: 'Círculo', ELLIPSE: 'Elipse',
  SPLINE: 'Spline', HATCH: 'Hachura',
};

/** Limpa os códigos de formatação de MTEXT. */
export function cleanMText(t) {
  if (!t) return '';
  return String(t)
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S([^;^#/]*)[\^#/]([^;]*);/g, '$1/$2')
    .replace(/\\P/g, '\n')
    .replace(/\\X/g, '\n')
    .replace(/\\[ACFHQTWfhqtwacp][^;\\]*;/g, '')
    .replace(/\\[LlOoKkN]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\([{}])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%')
    .replace(/%%[uUoO]/g, '');
}

function textString(t) {
  return cleanMText(t).replace(/\n/g, ' ');
}

function isClosedLW(e) {
  if ((e.flag & 512) !== 0) return true;
  const v = e.vertices;
  if (v && v.length > 2) {
    const a = v[0], b = v[v.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) return true;
  }
  return false;
}

/**
 * Constrói a cena.
 * @param {object} db DwgDatabase
 * @returns {{prims, polygons, layers, bbox, origin, stats}}
 */
export function buildScene(db) {
  const layerMap = new Map();
  for (const l of db.tables?.LAYER?.entries || []) {
    let color;
    const idx = l.colorIndex;
    if (idx != null && Math.abs(idx) >= 1 && Math.abs(idx) <= 255) color = aciColor(idx);
    else if (l.color != null) color = rgbToHex(l.color);
    else color = 'FG';
    layerMap.set(l.name, {
      name: l.name,
      color,
      visible: !(l.off || l.frozen || (idx != null && idx < 0)),
      count: 0,
      polyCount: 0,
      area: 0,
    });
  }
  const getLayer = (name) => {
    const n = name || '0';
    if (!layerMap.has(n)) layerMap.set(n, { name: n, color: 'FG', visible: true, count: 0, polyCount: 0, area: 0 });
    return layerMap.get(n);
  };

  const blocks = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
    if (b?.name) blocks.set(b.name.toUpperCase(), b);
  }

  const prims = [];
  const polygons = [];
  const typeCount = {};
  const skipped = {};
  let infinite = [];

  function resolveColor(e, layerName, byBlock) {
    if (e.color != null && e.color !== undefined && e.colorIndex !== 256 && e.colorIndex !== 0) return rgbToHex(e.color);
    const idx = e.colorIndex;
    if (idx == null || idx === 256) return getLayer(layerName).color;
    if (idx === 0) return byBlock || 'FG';
    if (idx >= 1 && idx <= 255) return aciColor(idx);
    if (e.color != null) return rgbToHex(e.color);
    return getLayer(layerName).color;
  }

  function addPoly(ctx, pts, closed, opts = {}) {
    if (!pts || pts.length < 4) return null;
    const wpts = transformPts(ctx.m, pts);
    const prim = {
      kind: 'poly', pts: wpts, closed: !!closed, color: ctx.color, layer: ctx.layer, ilayer: ctx.ilayer,
      bbox: bboxOf(wpts), fill: opts.fill || null, stroke: opts.stroke !== false, handle: ctx.handle,
    };
    prims.push(prim);
    return prim;
  }

  function addPolygon(ctx, type, localPts, localArea, localPerim) {
    if (ctx.noPolygons) return;
    const wpts = transformPts(ctx.m, localPts);
    const d = Math.abs(det(ctx.m));
    const area = Math.abs(localArea) * d;
    if (!(area > 0) || !isFinite(area)) return;
    polygons.push({
      id: polygons.length + 1,
      type,
      typeLabel: TYPE_LABELS[type] || type,
      layer: ctx.layer,
      ilayer: ctx.ilayer,
      handle: ctx.handle,
      source: ctx.blockPath || '',
      area,
      perimeter: localPerim * Math.sqrt(d),
      vertices: localPts.length / 2,
      pts: wpts,
      bbox: bboxOf(wpts),
    });
  }

  function addText(ctx, x, y, rot, h, str, opts = {}) {
    if (!str || !(h > 0)) return;
    const [wx, wy] = apply(ctx.m, x, y);
    // ângulo e escala após a transformação
    const ux = ctx.m[0] * Math.cos(rot) + ctx.m[2] * Math.sin(rot);
    const uy = ctx.m[1] * Math.cos(rot) + ctx.m[3] * Math.sin(rot);
    const s = Math.sqrt(Math.abs(det(ctx.m)));
    const lines = str.split('\n');
    const wh = h * s;
    const wf = opts.widthFactor || 1;
    const maxLen = Math.max(...lines.map((l) => l.length));
    const w = maxLen * wh * 0.7 * wf;
    const tot = wh * (1 + (lines.length - 1) * 1.66);
    const r = Math.max(w, tot) * 1.2;
    prims.push({
      kind: 'text', x: wx, y: wy, rot: Math.atan2(uy, ux), h: wh, wf, lines,
      align: opts.align || 'left', baseline: opts.baseline || 'alphabetic',
      color: ctx.color, layer: ctx.layer, ilayer: ctx.ilayer, handle: ctx.handle,
      bbox: [wx - r, wy - r, wx + r, wy + r],
    });
  }

  function textEntity(ctx, e, t) {
    // t: estrutura com text, startPoint, endPoint, textHeight, rotation, halign, valign, xScale
    if (!t) return;
    const om = ocsMatrix(e.extrusionDirection);
    const c2 = { ...ctx, m: mul(ctx.m, om) };
    const ha = t.halign || 0, va = t.valign || 0;
    let p = t.startPoint || { x: 0, y: 0 };
    if ((ha !== 0 || va !== 0) && ha !== 3 && ha !== 5 && t.endPoint) p = t.endPoint;
    if ((ha === 3 || ha === 5) && t.endPoint) {
      // texto alinhado/ajustado: centraliza entre os dois pontos
      p = { x: (t.startPoint.x + t.endPoint.x) / 2, y: (t.startPoint.y + t.endPoint.y) / 2 };
    }
    const align = ha === 1 || ha === 4 || ha === 3 || ha === 5 ? 'center' : ha === 2 ? 'right' : 'left';
    const baseline = ha === 4 ? 'middle' : ['alphabetic', 'bottom', 'middle', 'top'][va] || 'alphabetic';
    addText(c2, p.x, p.y, t.rotation || 0, t.textHeight, textString(t.text), {
      align, baseline, widthFactor: t.xScale || 1,
    });
  }

  function mtextEntity(ctx, e) {
    const p = e.insertionPoint;
    if (!p) return;
    let rot = e.rotation || 0;
    if (e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
    const ap = e.attachmentPoint || 1;
    const col = (ap - 1) % 3, row = Math.floor((ap - 1) / 3);
    addText(ctx, p.x, p.y, rot, e.textHeight || 1, cleanMText(e.text), {
      align: ['left', 'center', 'right'][col],
      baseline: ['top', 'middle', 'bottom'][row],
      mtext: true,
    });
  }

  function hatchLoops(e) {
    const loops = [];
    for (const path of e.boundaryPaths || []) {
      let pts = [];
      if (path.vertices) {
        const r = bulgePolyline(path.vertices, true);
        pts = r.pts;
      } else if (path.edges) {
        for (const ed of path.edges) {
          const seg = [];
          switch (ed.type) {
            case 1:
              seg.push(ed.start.x, ed.start.y, ed.end.x, ed.end.y);
              break;
            case 2: {
              if (ed.isCCW === false) {
                const tmp = arcPoints(ed.center.x, ed.center.y, ed.radius, -ed.endAngle, -ed.startAngle);
                for (let i = tmp.length - 2; i >= 0; i -= 2) seg.push(tmp[i], tmp[i + 1]);
              } else arcPoints(ed.center.x, ed.center.y, ed.radius, ed.startAngle, ed.endAngle, seg);
              break;
            }
            case 3: {
              const ratio = ed.lengthOfMinorAxis || 1;
              if (ed.isCCW === false) {
                const tmp = ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, -ed.endAngle, -ed.startAngle);
                for (let i = tmp.length - 2; i >= 0; i -= 2) seg.push(tmp[i], tmp[i + 1]);
              } else ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio, ed.startAngle, ed.endAngle, seg);
              break;
            }
            case 4: {
              const cp = ed.controlPoints || [];
              const w = cp.map((c) => (c.weight == null ? 1 : c.weight));
              const sp = cp.length >= 2
                ? nurbsPoints(ed.degree, ed.knots, cp, w)
                : catmullRom(ed.fitDatum || [], false);
              seg.push(...sp);
              break;
            }
          }
          // evita duplicar o ponto de junção
          let start = 0;
          if (pts.length >= 2 && seg.length >= 2 &&
            Math.abs(pts[pts.length - 2] - seg[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - seg[1]) < 1e-9) start = 2;
          for (let i = start; i < seg.length; i++) pts.push(seg[i]);
        }
      }
      if (pts.length >= 6) loops.push(pts);
    }
    return loops;
  }

  /** Área líquida de uma hachura: loops aninhados alternam entre soma e subtração (regra par-ímpar). */
  function hatchArea(loops) {
    let total = 0;
    for (let i = 0; i < loops.length; i++) {
      const a = Math.abs(polygonArea(loops[i]));
      let depth = 0;
      for (let j = 0; j < loops.length; j++) {
        if (i === j) continue;
        if (Math.abs(polygonArea(loops[j])) > a && pointInPolygon(loops[i][0], loops[i][1], loops[j])) depth++;
      }
      total += depth % 2 === 0 ? a : -a;
    }
    return Math.abs(total);
  }

  function entity(e, ctx0, depth) {
    if (!e || e.isVisible === false || e.isInPaperSpace) return;
    const type = e.type;
    const layerName = e.layer === '0' && ctx0.blockLayer ? ctx0.blockLayer : (e.layer || '0');
    const ctx = {
      ...ctx0,
      layer: layerName,
      ilayer: ctx0.ilayer || null,
      color: resolveColor(e, e.layer === '0' && ctx0.blockLayer ? ctx0.blockLayer : e.layer, ctx0.byBlock),
      handle: ctx0.topHandle || e.handle,
    };
    if (depth === 0) {
      typeCount[type] = (typeCount[type] || 0) + 1;
      getLayer(layerName).count++;
    }
    switch (type) {
      case 'LINE':
        addPoly(ctx, [e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y], false);
        break;
      case 'CIRCLE': {
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection)) };
        const pts = circlePoints(e.center.x, e.center.y, e.radius);
        addPoly(c2, pts, true);
        addPolygon(c2, 'CIRCLE', pts, Math.PI * e.radius * e.radius, TAU * e.radius);
        break;
      }
      case 'ARC': {
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection)) };
        addPoly(c2, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false);
        break;
      }
      case 'ELLIPSE': {
        const t0 = e.startAngle || 0;
        let t1 = e.endAngle == null ? TAU : e.endAngle;
        let mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
        let ratio = e.axisRatio || 1;
        if (e.extrusionDirection && e.extrusionDirection.z < 0) ratio = -ratio;
        const pts = ellipsePoints(e.center.x, e.center.y, mx, my, ratio, t0, t1);
        let sweep = t1 - t0;
        while (sweep <= 1e-12) sweep += TAU;
        const full = Math.abs(sweep - TAU) < 1e-6;
        addPoly(ctx, pts, full);
        if (full) {
          const a = Math.hypot(mx, my), b = a * Math.abs(ratio);
          const h = ((a - b) / (a + b)) ** 2;
          const perim = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
          addPolygon(ctx, 'ELLIPSE', pts, Math.PI * a * b, perim);
        }
        break;
      }
      case 'LWPOLYLINE': {
        const v = e.vertices || [];
        if (v.length < 2) break;
        const closed = isClosedLW(e);
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection, e.elevation || 0)) };
        const r = bulgePolyline(v, closed);
        addPoly(c2, r.pts, closed);
        if (closed && v.length >= 3) addPolygon(c2, 'LWPOLYLINE', r.pts, r.area, r.perimeter);
        break;
      }
      case 'POLYLINE2D': {
        const v = (e.vertices || []).filter((p) => !(p.flag & 16));
        if (v.length < 2) break;
        const closed = (e.flag & 1) !== 0;
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection, e.elevation || 0)) };
        const r = bulgePolyline(v, closed);
        addPoly(c2, r.pts, closed);
        if (closed && v.length >= 3) addPolygon(c2, 'POLYLINE2D', r.pts, r.area, r.perimeter);
        break;
      }
      case 'POLYLINE3D': {
        const v = e.vertices || [];
        const pts = [];
        for (const p of v) pts.push(p.x, p.y);
        addPoly(ctx, pts, (e.flag & 1) !== 0);
        break;
      }
      case 'SPLINE': {
        const cp = e.controlPoints || [];
        const closed = (e.flag & 1) !== 0;
        const pts = cp.length >= 2
          ? nurbsPoints(e.degree, e.knots, cp, e.weights)
          : catmullRom(e.fitPoints || [], closed);
        addPoly(ctx, pts, false);
        if (closed && pts.length >= 6) addPolygon(ctx, 'SPLINE', pts, polygonArea(pts), polylineLength(pts, true));
        break;
      }
      case 'POINT':
        if (e.position) {
          const [x, y] = apply(ctx.m, e.position.x, e.position.y);
          prims.push({ kind: 'point', x, y, color: ctx.color, layer: ctx.layer, ilayer: ctx.ilayer, bbox: [x, y, x, y] });
        }
        break;
      case 'TEXT':
        textEntity(ctx, e, e);
        break;
      case 'ATTRIB':
        if (!(e.flags & 1)) textEntity(ctx, e, typeof e.text === 'object' ? e.text : e);
        break;
      case 'ATTDEF':
        if (depth === 0 && !(e.flags & 1)) {
          const t = typeof e.text === 'object' ? { ...e.text, text: e.tag || e.text.text } : { ...e, text: e.tag || e.text };
          textEntity(ctx, e, t);
        }
        break;
      case 'MTEXT':
        mtextEntity(ctx, e);
        break;
      case 'SOLID':
      case 'TRACE': {
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection)) };
        const c = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].filter(Boolean);
        const pts = [];
        for (const p of c) pts.push(p.x, p.y);
        addPoly(c2, pts, true, { fill: ctx.color });
        break;
      }
      case '3DFACE': {
        const c = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
        const pts = [];
        for (const p of c) pts.push(p.x, p.y);
        addPoly(ctx, pts, true);
        break;
      }
      case 'HATCH': {
        const c2 = { ...ctx, m: mul(ctx.m, ocsMatrix(e.extrusionDirection, e.elevation || 0)) };
        const loops = hatchLoops(e);
        if (!loops.length) break;
        const solid = e.solidFill === 1;
        const wloops = loops.map((l) => transformPts(c2.m, l));
        const all = [].concat(...wloops);
        prims.push({
          kind: 'hatch', loops: wloops, solid, color: ctx.color, layer: ctx.layer, ilayer: ctx.ilayer,
          bbox: bboxOf(all), handle: ctx.handle,
        });
        const area = hatchArea(loops);
        // contorno externo (maior loop) usado para destaque/seleção
        let outer = loops[0];
        for (const l of loops) if (Math.abs(polygonArea(l)) > Math.abs(polygonArea(outer))) outer = l;
        const perim = loops.reduce((s, l) => s + polylineLength(l, true), 0);
        addPolygon(c2, 'HATCH', outer, area, perim);
        break;
      }
      case 'XLINE':
      case 'RAY':
        if (e.firstPoint && e.unitDirection) {
          const [x, y] = apply(ctx.m, e.firstPoint.x, e.firstPoint.y);
          const [x2, y2] = apply(ctx.m, e.firstPoint.x + e.unitDirection.x, e.firstPoint.y + e.unitDirection.y);
          infinite.push({ x, y, dx: x2 - x, dy: y2 - y, ray: type === 'RAY', ctx });
        }
        break;
      case 'LEADER': {
        const pts = [];
        for (const p of e.vertices || []) pts.push(p.x, p.y);
        addPoly(ctx, pts, false);
        break;
      }
      case 'INSERT':
        insert(e, ctx, depth);
        break;
      case 'DIMENSION': {
        const b = e.name && blocks.get(e.name.toUpperCase());
        if (b && depth < MAX_DEPTH) {
          const c2 = { ...ctx, byBlock: ctx.color, blockLayer: layerName, noPolygons: true };
          for (const be of b.entities || []) entity(be, c2, depth + 1);
        }
        break;
      }
      case 'VIEWPORT':
        break;
      default:
        if (depth === 0) skipped[type] = (skipped[type] || 0) + 1;
    }
  }

  function insert(e, ctx, depth) {
    if (depth >= MAX_DEPTH) return;
    const b = e.name && blocks.get(e.name.toUpperCase());
    if (!b) return;
    const bp = b.basePoint || { x: 0, y: 0 };
    const ip = e.insertionPoint || { x: 0, y: 0 };
    const sx = e.xScale || 1, sy = e.yScale || 1;
    const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
    const ocs = ocsMatrix(e.extrusionDirection);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let m = translate(-bp.x, -bp.y);
        m = mul(scale(sx, sy), m);
        m = mul(translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0)), m);
        m = mul(rotate(e.rotation || 0), m);
        m = mul(translate(ip.x, ip.y), m);
        m = mul(ocs, m);
        m = mul(ctx.m, m);
        const c2 = {
          ...ctx, m, byBlock: ctx.color, blockLayer: ctx.layer,
          ilayer: ctx.ilayer || ctx.layer,
          blockPath: (ctx.blockPath ? ctx.blockPath + ' › ' : '') + b.name,
          topHandle: ctx.topHandle || e.handle,
        };
        for (const be of b.entities || []) {
          if (be.type === 'ATTDEF') continue;
          entity(be, c2, depth + 1);
        }
      }
    }
  }

  const root = { m: IDENTITY, byBlock: null, blockLayer: null, ilayer: null, blockPath: '', topHandle: null };
  for (const e of db.entities || []) {
    try {
      entity(e, root, 0);
    } catch (err) {
      skipped[e?.type || '?'] = (skipped[e?.type || '?'] || 0) + 1;
    }
  }

  // Extensão do desenho (ignora linhas infinitas)
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const b = p.bbox;
    if (!b.every(isFinite)) continue;
    if (b[0] < bbox[0]) bbox[0] = b[0];
    if (b[1] < bbox[1]) bbox[1] = b[1];
    if (b[2] > bbox[2]) bbox[2] = b[2];
    if (b[3] > bbox[3]) bbox[3] = b[3];
  }
  if (!isFinite(bbox[0])) bbox = [0, 0, 100, 100];
  // usa uma extensão robusta caso existam poucos elementos muito distantes
  const robust = robustBBox(prims, bbox);

  const diag = Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]) || 100;
  for (const inf of infinite) {
    const L = diag * 20;
    const len = Math.hypot(inf.dx, inf.dy) || 1;
    const ux = inf.dx / len, uy = inf.dy / len;
    const x0 = inf.ray ? inf.x : inf.x - ux * L, y0 = inf.ray ? inf.y : inf.y - uy * L;
    const pts = [x0, y0, inf.x + ux * L, inf.y + uy * L];
    prims.push({ kind: 'poly', pts, closed: false, color: inf.ctx.color, layer: inf.ctx.layer, ilayer: inf.ctx.ilayer, bbox: bboxOf(pts), stroke: true, infinite: true });
  }

  // Origem local: evita perda de precisão em coordenadas grandes (ex.: UTM)
  const origin = [(robust[0] + robust[2]) / 2, (robust[1] + robust[3]) / 2];
  const shift = (pts) => { for (let i = 0; i < pts.length; i += 2) { pts[i] -= origin[0]; pts[i + 1] -= origin[1]; } };
  const shiftBox = (b) => { b[0] -= origin[0]; b[1] -= origin[1]; b[2] -= origin[0]; b[3] -= origin[1]; };
  for (const p of prims) {
    if (p.kind === 'poly') { if (p.pts === undefined) continue; p.pts = Float64Array.from(p.pts); shift(p.pts); }
    else if (p.kind === 'hatch') p.loops = p.loops.map((l) => { const a = Float64Array.from(l); shift(a); return a; });
    else { p.x -= origin[0]; p.y -= origin[1]; }
    shiftBox(p.bbox);
  }
  for (const pg of polygons) {
    pg.pts = Float64Array.from(pg.pts);
    shift(pg.pts);
    shiftBox(pg.bbox);
    const c = centroid(pg.pts);
    pg.cx = c[0]; pg.cy = c[1];
  }
  for (const pg of polygons) {
    const L = getLayer(pg.layer);
    L.polyCount++;
    L.area += pg.area;
  }
  shiftBox(bbox);
  shiftBox(robust);

  return {
    prims,
    polygons,
    layers: [...layerMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true })),
    layerMap,
    bbox,
    viewBox: robust,
    origin,
    typeCount,
    skipped,
    entityCount: (db.entities || []).length,
  };
}

/**
 * Extensão "útil" do desenho: ignora elementos isolados muito distantes do núcleo
 * (ex.: cotas ou linhas perdidas a quilômetros do projeto), como um "zoom extents" robusto.
 */
function robustBBox(prims, full) {
  const xs = [], ys = [];
  for (const p of prims) {
    const b = p.bbox;
    if (!b.every(isFinite)) continue;
    xs.push((b[0] + b[2]) / 2);
    ys.push((b[1] + b[3]) / 2);
  }
  if (xs.length < 10) return full.slice();
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.floor(f * (arr.length - 1))];
  const cx0 = q(xs, 0.1), cx1 = q(xs, 0.9), cy0 = q(ys, 0.1), cy1 = q(ys, 0.9);
  const span = Math.max(cx1 - cx0, cy1 - cy0, 1e-9);
  const win = [cx0 - span * 3, cy0 - span * 3, cx1 + span * 3, cy1 + span * 3];
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const b = p.bbox;
    if (!b.every(isFinite)) continue;
    if (b[0] < win[0] || b[1] < win[1] || b[2] > win[2] || b[3] > win[3]) continue;
    if (b[0] < out[0]) out[0] = b[0];
    if (b[1] < out[1]) out[1] = b[1];
    if (b[2] > out[2]) out[2] = b[2];
    if (b[3] > out[3]) out[3] = b[3];
  }
  return isFinite(out[0]) ? out : full.slice();
}
