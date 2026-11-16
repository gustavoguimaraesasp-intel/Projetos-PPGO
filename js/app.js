// Aplicação: carregamento do arquivo, integração com o parser DWG e painel de informações.

import { LibreDwg, Dwg_File_Type } from '../vendor/libredwg-web/dist/libredwg-web.js';
import { buildScene, TYPE_LABELS } from './scene.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);

// ---------- Unidades ----------
const INSUNITS = { 0: 'none', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 14: 'dm' };
const UNIT_INFO = {
  none: { label: 'Sem unidade', toM: null, sym: 'u' },
  mm: { label: 'Milímetros', toM: 0.001, sym: 'mm' },
  cm: { label: 'Centímetros', toM: 0.01, sym: 'cm' },
  dm: { label: 'Decímetros', toM: 0.1, sym: 'dm' },
  m: { label: 'Metros', toM: 1, sym: 'm' },
  in: { label: 'Polegadas', toM: 0.0254, sym: 'in' },
  ft: { label: 'Pés', toM: 0.3048, sym: 'ft' },
};
const VERSIONS = {
  AC1009: 'AutoCAD R11/R12', AC1012: 'AutoCAD R13', AC1014: 'AutoCAD R14', AC1015: 'AutoCAD 2000/2002',
  AC1018: 'AutoCAD 2004–2006', AC1021: 'AutoCAD 2007–2009', AC1024: 'AutoCAD 2010–2012',
  AC1027: 'AutoCAD 2013–2017', AC1032: 'AutoCAD 2018+',
};

const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF2 = nf(2), NF0 = nf(0);

// ---------- Estado ----------
const state = {
  file: null,
  db: null,
  scene: null,
  fileUnit: 'none',
  unitOverride: 'auto',
  typeFilter: new Set(),
  sort: { key: 'area', dir: -1 },
  search: '',
};

// DXF mínimo usado para "aquecer" o leitor. Contorna um defeito da libredwg-web 0.9.0:
// a primeira conversão de um DWG 2007+ numa instância nova aborta o WebAssembly,
// mas funciona depois que qualquer outro desenho já foi convertido.
const WARMUP_DXF = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join(String.fromCharCode(10));

let libPromise = null;
function getLib() {
  if (!libPromise) {
    const base = new URL('../vendor/libredwg-web/wasm', import.meta.url).href;
    libPromise = LibreDwg.create(base).then((lib) => {
      try {
        const p = lib.dwg_read_data(WARMUP_DXF, Dwg_File_Type.DXF);
        if (p != null) { lib.convert(p); lib.dwg_free(p); }
      } catch (e) { console.warn('Aquecimento do leitor falhou:', e); }
      return lib;
    });
    libPromise.catch(() => { libPromise = null; });
  }
  return libPromise;
}

/** Lê e converte o arquivo. Após um "Aborted()" a instância WASM fica inutilizada: recria e tenta de novo. */
async function parseDrawing(buf, type) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const lib = await getLib();
    let ptr;
    try {
      ptr = lib.dwg_read_data(buf, type);
      if (ptr == null) throw new Error('Não foi possível ler o arquivo. Ele pode estar corrompido ou em uma versão não suportada.');
      const db = lib.convert(ptr);
      try { lib.dwg_free(ptr); } catch { /* ignora */ }
      return db;
    } catch (err) {
      libPromise = null; // descarta a instância (pode ter abortado)
      if (attempt === 1 || !/abort/i.test(String(err?.message || err))) throw err;
      console.warn('Leitor abortou; recriando a instância e tentando novamente…', err);
    }
  }
}

// ---------- Viewer ----------
const viewer = new Viewer($('canvas'), {
  onPick: handlePick,
  onMove: (x, y) => {
    if (!state.scene) return;
    const [ox, oy] = state.scene.origin;
    $('coords').textContent = `X: ${NF2.format(x + ox)}  Y: ${NF2.format(y + oy)}`;
  },
  onView: () => {
    if (!state.scene) return;
    const b = state.scene.viewBox;
    const z = (viewer.s * Math.max(b[2] - b[0], b[3] - b[1])) / Math.max(viewer.W, viewer.H) / 0.92;
    $('zoomInfo').textContent = `Zoom: ${z >= 10 ? NF0.format(z) : NF2.format(z)}×`;
  },
});

// ---------- Carregamento ----------
function showLoading(text) {
  $('loading').hidden = false;
  $('loadingText').textContent = text;
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
}
function hideLoading() { $('loading').hidden = true; }

async function loadFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'dwg' && ext !== 'dxf') {
    alert('Formato não suportado. Selecione um arquivo .dwg ou .dxf.');
    return;
  }
  try {
    await showLoading('Carregando o leitor de DWG (WebAssembly)…');
    await getLib();
    await showLoading(`Lendo e convertendo ${file.name}…`);
    const buf = await file.arrayBuffer();
    const header = new TextDecoder('ascii').decode(new Uint8Array(buf, 0, Math.min(6, buf.byteLength)));
    const type = ext === 'dxf' ? Dwg_File_Type.DXF : Dwg_File_Type.DWG;
    const db = await parseDrawing(buf, type);
    await showLoading('Montando o desenho e calculando áreas…');
    const scene = buildScene(db);
    state.file = { name: file.name, size: file.size, version: VERSIONS[header] || (ext === 'dxf' ? 'DXF' : header) };
    state.db = db;
    state.scene = scene;
    state.fileUnit = INSUNITS[db.header?.INSUNITS] || 'none';
    state.typeFilter = new Set(Object.keys(TYPE_LABELS));
    $('unitSelect').value = 'auto';
    state.unitOverride = 'auto';
    $('dropzone').hidden = true;
    $('toolbar').hidden = false;
    $('statusbar').hidden = false;
    $('fileName').textContent = file.name;
    document.title = `${file.name} — Análise DWG`;
    viewer.setScene(scene);
    renderAll();
  } catch (err) {
    console.error(err);
    alert('Erro ao processar o arquivo:\n' + (err?.message || err));
  } finally {
    hideLoading();
  }
}

$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

// Arrastar e soltar em qualquer lugar da janela
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dragOverlay').hidden = false; });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dragOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dragOverlay').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ---------- Unidades / formatação ----------
function unit() {
  const u = state.unitOverride === 'auto' ? state.fileUnit : state.unitOverride;
  return UNIT_INFO[u] || UNIT_INFO.none;
}
function fmtArea(a) {
  const u = unit();
  if (u.toM) return `${NF2.format(a * u.toM * u.toM)} m²`;
  return `${NF2.format(a)} u²`;
}
function fmtLen(l) {
  const u = unit();
  if (u.toM) return `${NF2.format(l * u.toM)} m`;
  return `${NF2.format(l)} u`;
}
function areaValue(a) { const u = unit(); return u.toM ? a * u.toM * u.toM : a; }
function lenValue(l) { const u = unit(); return u.toM ? l * u.toM : l; }

$('unitSelect').addEventListener('change', (e) => {
  state.unitOverride = e.target.value;
  renderAll();
});

// ---------- Filtros de polígonos ----------
function layerVisible(name) {
  const l = state.scene.layerMap.get(name);
  return !l || l.visible;
}
function polygonPasses(pg, ignoreSearch = false) {
  if (!state.typeFilter.has(pg.type)) return false;
  if (!$('includeBlocks').checked && pg.source) return false;
  if ($('onlyVisible').checked && (!layerVisible(pg.layer) || (pg.ilayer && !layerVisible(pg.ilayer)))) return false;
  if (!ignoreSearch && state.search) {
    const q = state.search;
    if (!(`${pg.layer} ${pg.typeLabel} ${pg.source} ${pg.handle}`.toLowerCase().includes(q))) return false;
  }
  return true;
}
function filteredPolygons() {
  return state.scene ? state.scene.polygons.filter((pg) => polygonPasses(pg)) : [];
}

// ---------- Renderização do painel ----------
function renderAll() {
  if (!state.scene) return;
  $('emptyInfo').hidden = true;
  $('summary').hidden = false;
  renderFileInfo();
  renderTypeChips();
  renderSummary();
  renderPolyTable();
  renderLayers();
  renderSelected();
}

function renderFileInfo() {
  const s = state.scene;
  const b = s.bbox;
  const u = unit();
  const fileU = UNIT_INFO[state.fileUnit];
  const kb = state.file.size / 1024;
  const rows = [
    ['Nome', state.file.name],
    ['Tamanho', kb > 1024 ? `${NF2.format(kb / 1024)} MB` : `${NF0.format(kb)} KB`],
    ['Versão', state.file.version],
    ['Unidade no arquivo', fileU.label],
    ['Unidade usada', u.label],
    ['Entidades (modelo)', NF0.format(s.entityCount)],
    ['Elementos desenhados', NF0.format(s.prims.length)],
    ['Camadas', NF0.format(s.layers.length)],
    ['Blocos definidos', NF0.format((state.db.tables?.BLOCK_RECORD?.entries || []).filter((b) => !b.name.startsWith('*')).length)],
    ['Extensão X', fmtLen(b[2] - b[0])],
    ['Extensão Y', fmtLen(b[3] - b[1])],
  ];
  $('fileInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

function renderSummary() {
  const list = state.scene.polygons.filter((pg) => polygonPasses(pg, true));
  const total = list.reduce((s, p) => s + p.area, 0);
  const max = list.reduce((m, p) => Math.max(m, p.area), 0);
  $('kTotal').textContent = list.length ? fmtArea(total) : '—';
  $('kCount').textContent = NF0.format(list.length);
  $('kMax').textContent = list.length ? fmtArea(max) : '—';
  $('kAvg').textContent = list.length ? fmtArea(total / list.length) : '—';
  const notes = [];
  if (!unit().toM) notes.push('Unidade não definida no arquivo: escolha a unidade do desenho abaixo para ver as áreas em m².');
  notes.push('Considera os tipos e camadas selecionados na aba Polígonos. Polígonos sobrepostos (ex.: hachura sobre polilinha) são somados separadamente.');
  $('areaNote').textContent = notes.join(' ');

  // por camada
  const by = new Map();
  for (const p of list) {
    const r = by.get(p.layer) || { n: 0, a: 0 };
    r.n++; r.a += p.area;
    by.set(p.layer, r);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].a - a[1].a);
  const tbody = $('layerAreaTable').querySelector('tbody');
  tbody.innerHTML = rows.length
    ? rows.map(([name, r]) => `<tr><td title="${esc(name)}">${swatch(name)}${esc(name)}</td><td class="num">${r.n}</td><td class="num">${fmtArea(r.a)}</td></tr>`).join('')
      + `<tr><td><b>Total</b></td><td class="num"><b>${list.length}</b></td><td class="num"><b>${fmtArea(total)}</b></td></tr>`
    : '<tr><td colspan="3" class="muted">Nenhum polígono fechado encontrado.</td></tr>';

  // tipos de entidade
  const tc = Object.entries(state.scene.typeCount).sort((a, b) => b[1] - a[1]);
  $('typeTable').querySelector('tbody').innerHTML = tc.map(([t, n]) => `<tr><td>${esc(t)}</td><td class="num">${NF0.format(n)}</td></tr>`).join('');
  const sk = Object.entries(state.scene.skipped);
  $('skippedNote').textContent = sk.length ? `Não renderizados: ${sk.map(([t, n]) => `${t} (${n})`).join(', ')}.` : '';
}

function renderTypeChips() {
  const present = new Set(state.scene.polygons.map((p) => p.type));
  const box = $('typeChips');
  box.innerHTML = '';
  for (const [t, label] of Object.entries(TYPE_LABELS)) {
    if (!present.has(t)) continue;
    const n = state.scene.polygons.filter((p) => p.type === t).length;
    const b = document.createElement('button');
    b.className = 'chip' + (state.typeFilter.has(t) ? ' on' : '');
    b.textContent = `${label} (${n})`;
    b.onclick = () => {
      if (state.typeFilter.has(t)) state.typeFilter.delete(t); else state.typeFilter.add(t);
      b.classList.toggle('on');
      renderSummary();
      renderPolyTable();
    };
    box.appendChild(b);
  }
}

const MAX_ROWS = 1500;
function renderPolyTable() {
  const list = filteredPolygons();
  const { key, dir } = state.sort;
  list.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true }) * dir;
  });
  const total = list.reduce((s, p) => s + p.area, 0);
  $('polyCountInfo').textContent = `${NF0.format(list.length)} polígonos · ${fmtArea(total)}`;
  const sel = viewer.selected;
  const rows = list.slice(0, MAX_ROWS).map((p) =>
    `<tr data-id="${p.id}"${sel && sel.id === p.id ? ' class="sel"' : ''}>`
    + `<td>${p.id}</td><td title="${esc(p.typeLabel + (p.source ? ' — bloco ' + p.source : ''))}">${esc(p.typeLabel)}${p.source ? ' ▣' : ''}</td>`
    + `<td title="${esc(p.layer)}">${swatch(p.layer)}${esc(p.layer)}</td>`
    + `<td class="num">${fmtArea(p.area)}</td><td class="num">${fmtLen(p.perimeter)}</td></tr>`);
  if (list.length > MAX_ROWS) rows.push(`<tr><td colspan="5" class="muted">… mais ${NF0.format(list.length - MAX_ROWS)} polígonos (use o filtro ou exporte o CSV)</td></tr>`);
  if (!list.length) rows.push('<tr><td colspan="5" class="muted">Nenhum polígono com os filtros atuais.</td></tr>');
  $('polyTable').querySelector('tbody').innerHTML = rows.join('');
  for (const th of $('polyTable').querySelectorAll('th[data-sort]')) {
    th.classList.toggle('asc', th.dataset.sort === key && dir === 1);
    th.classList.toggle('desc', th.dataset.sort === key && dir === -1);
  }
}

$('polyTable').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const k = th.dataset.sort;
  state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'area' || k === 'perimeter' ? -1 : 1) };
  renderPolyTable();
});
$('polyTable').querySelector('tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const pg = state.scene.polygons[Number(tr.dataset.id) - 1];
  selectPolygon(pg, true);
});
$('polySearch').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); renderPolyTable(); });
$('onlyVisible').addEventListener('change', () => { renderSummary(); renderPolyTable(); });
$('includeBlocks').addEventListener('change', () => { renderSummary(); renderPolyTable(); });

function renderLayers() {
  const ul = $('layerList');
  ul.innerHTML = '';
  for (const l of state.scene.layers) {
    const li = document.createElement('li');
    li.className = l.visible ? '' : 'off';
    li.innerHTML = `<input type="checkbox" ${l.visible ? 'checked' : ''} aria-label="Visibilidade da camada">`
      + `${swatch(l.name)}<span class="name" title="${esc(l.name)}">${esc(l.name)}</span>`
      + `<span class="meta">${NF0.format(l.count)} ent.${l.polyCount ? ` · ${fmtArea(l.area)}` : ''}</span>`;
    li.querySelector('input').addEventListener('change', (e) => {
      l.visible = e.target.checked;
      li.className = l.visible ? '' : 'off';
      layersChanged();
    });
    ul.appendChild(li);
  }
}
function layersChanged() {
  if (viewer.selected && !polygonPasses(viewer.selected, true)) viewer.select(null);
  viewer.requestDraw();
  renderSummary();
  renderPolyTable();
  renderSelected();
}
$('layersAll').onclick = () => { state.scene?.layers.forEach((l) => (l.visible = true)); renderLayers(); layersChanged(); };
$('layersNone').onclick = () => { state.scene?.layers.forEach((l) => (l.visible = false)); renderLayers(); layersChanged(); };

// ---------- Seleção ----------
let lastHits = [];
function handlePick(wx, wy) {
  const hits = viewer.polygonsAt(wx, wy, (pg) => polygonPasses(pg, true));
  if (!hits.length) { selectPolygon(null); lastHits = []; return; }
  // cliques repetidos no mesmo ponto alternam entre polígonos sobrepostos
  const same = hits.length === lastHits.length && hits.every((h, i) => h === lastHits[i]);
  let pg = hits[0];
  if (same && viewer.selected) {
    const i = hits.indexOf(viewer.selected);
    pg = hits[(i + 1) % hits.length];
  }
  lastHits = hits;
  selectPolygon(pg, false);
}

function selectPolygon(pg, zoom) {
  viewer.select(pg, zoom);
  renderSelected();
  for (const tr of $('polyTable').querySelectorAll('tbody tr')) {
    tr.classList.toggle('sel', !!pg && tr.dataset.id === String(pg.id));
  }
  if (pg) {
    const tr = $('polyTable').querySelector(`tr[data-id="${pg.id}"]`);
    if (tr && !$('tab-poligonos').hidden) tr.scrollIntoView({ block: 'nearest' });
  }
}

function renderSelected() {
  const pg = viewer.selected;
  $('selectedCard').hidden = !pg;
  if (!pg) return;
  const [ox, oy] = state.scene.origin;
  const b = pg.bbox;
  const rows = [
    ['Tipo', pg.typeLabel],
    ['Camada', pg.layer],
    ...(pg.source ? [['Bloco', pg.source]] : []),
    ['Handle', pg.handle || '—'],
    ['Área', fmtArea(pg.area)],
    ['Perímetro', fmtLen(pg.perimeter)],
    ['Vértices (desenho)', NF0.format(pg.vertices)],
    ['Largura × altura', `${fmtLen(b[2] - b[0])} × ${fmtLen(b[3] - b[1])}`],
    ['Centroide', `${NF2.format(pg.cx + ox)} ; ${NF2.format(pg.cy + oy)}`],
  ];
  $('selectedInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}
$('clearSel').onclick = () => selectPolygon(null);

// ---------- CSV ----------
$('btnCsv').onclick = () => {
  if (!state.scene) return;
  const u = unit();
  const aU = u.toM ? 'm²' : 'u²', lU = u.toM ? 'm' : 'u';
  const [ox, oy] = state.scene.origin;
  const dec = (v) => String(Number(v.toFixed(4))).replace('.', ',');
  const lines = [[`id`, 'tipo', 'camada', 'bloco', 'handle', `area (${aU})`, `perimetro (${lU})`, 'centroide_x', 'centroide_y'].join(';')];
  for (const p of filteredPolygons()) {
    lines.push([p.id, p.typeLabel, p.layer, p.source, p.handle || '', dec(areaValue(p.area)), dec(lenValue(p.perimeter)), dec(p.cx + ox), dec(p.cy + oy)]
      .map((v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.file.name.replace(/\.\w+$/, '') + '_poligonos.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Abas ----------
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    for (const o of document.querySelectorAll('.tab')) o.classList.toggle('active', o === t);
    for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.id !== 'tab-' + t.dataset.tab;
  });
}

// ---------- Ferramentas ----------
$('btnZoomIn').onclick = () => viewer.zoomAt(1.5);
$('btnZoomOut').onclick = () => viewer.zoomAt(1 / 1.5);
$('btnFit').onclick = () => viewer.fit();
$('btnFill').onclick = (e) => {
  viewer.showFills = !viewer.showFills;
  e.currentTarget.setAttribute('aria-pressed', String(viewer.showFills));
  viewer.requestDraw();
};
let light = false;
$('btnTheme').onclick = () => {
  light = !light;
  $('viewport').classList.toggle('light', light);
  viewer.setTheme(light
    ? { bg: '#ffffff', fg: '#111111', accent: '#e8590c', light: true }
    : { bg: '#1b1f24', fg: '#e8e8e8', accent: '#ff9f1c', light: false });
};
window.addEventListener('keydown', (e) => {
  if (!state.scene || e.target.matches('input, select, textarea')) return;
  if (e.key === '+' || e.key === '=') viewer.zoomAt(1.5);
  else if (e.key === '-') viewer.zoomAt(1 / 1.5);
  else if (e.key === 'f' || e.key === 'F') viewer.fit();
  else if (e.key === 'Escape') selectPolygon(null);
});

// ---------- Utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function swatch(layerName) {
  const l = state.scene?.layerMap.get(layerName);
  let c = l ? l.color : '#888';
  if (c === 'FG') c = '#ffffff';
  return `<span class="swatch" style="background:${c}"></span>`;
}

// Pré-carrega o WebAssembly em segundo plano para agilizar o primeiro arquivo
setTimeout(() => getLib().catch((e) => console.warn('Falha ao pré-carregar o leitor DWG:', e)), 300);
