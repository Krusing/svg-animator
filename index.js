'use strict';

const GRID           = 24;
const STORAGE_KEY    = 'svg-editor-v4';
const THEME_KEY      = 'svg-editor-theme';
const PAN_KEY        = 'svg-editor-pan';
const PANEL_KEY      = 'svg-editor-panels';
const DRAG_THRESHOLD = 4; // px before click becomes drag
const HALF_GRID      = GRID / 2;

// ── State ──────────────────────────────────────────────────────────────────
let shapes     = [];   // [{id, points:[{x,y}], closed, stroke, fill}]
let undoStack  = [];
let redoStack  = [];
let clipboard  = [];
let pasteMode  = false;
let pasteModeAnchor = null; // centroid of clipboard shapes
let tool       = 'select'; // 'line' | 'arc' | 'rect' | 'circle' | 'select'
let drawPoints = [];
let nextId     = 1;

let arcPhase = 0;   // 0=idle, 1=p1-placed
let arcP1 = null;
let rectPhase = 0;  // 0=idle, 1=corner1-placed
let rectCorner1 = null;
let circlePhase = 0; // 0=idle, 1=center-placed
let circleOrigin = null;

// Pan
let panX = 0, panY = 0;
let isPanning      = false;
let pannedThisDrag = false;
let panAnchor      = null;
let panSnapAnim    = null;
let spaceDown      = false;
let ctrlDown       = false;

// Drawing style
let strokeColor  = '#000000';
let fillColor    = 'none';
let strokeWidth  = 2;

// Selection & drag
let selectedIds    = new Set();
let hoveredShapeId = null;
let dragState      = null;
// dragState: { type:'shapes'|'vertex'|'rubber',
//   shapeId?, shapeIds?, wasSelected?, shiftKey?,
//   anchorClientX, anchorClientY, anchorWorld,
//   origPositions? (Map), origPt?, pointIdx?,
//   moved }

// Context menu
let ctxTargetId = null;
let nextGroupId = 1;
let lastLayerAnchorIdx = -1;
const collapsedGroups  = new Set();
const hiddenGroupIds   = new Set(); // groups hidden on canvas
const emptyGroupIds    = new Set(); // explicitly created groups with no shapes
const groupLabels      = new Map(); // groupId → custom string label

const groupSvgIds = new Map(); // groupId → explicit SVG id string

// Context menu secondary target (group)
let ctxTargetGroupId = null;

// Object properties modal state
let modalTargetKey = null;


// Layer panel drag state
let layerDragIds = null;
let layerDragInsertAfter = false;
let layerDragIntoGroup = false;
let layerDragIsGroup = false;

// ── DOM ────────────────────────────────────────────────────────────────────
const svg        = document.getElementById('canvas');
const container  = document.getElementById('canvas-container');
const statusTool = document.getElementById('status-tool');
const statusPos  = document.getElementById('status-pos');
const codeContent = document.getElementById('code-content');
const codeView    = document.getElementById('code-view');
const codeEditor  = document.getElementById('code-editor');
const btnTheme    = document.getElementById('btn-theme');
const ctxMenu    = document.getElementById('ctx-menu');

// ── SVG helpers ─────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
function mkEl(tag, attrs, cls) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (cls) e.setAttribute('class', cls);
  return e;
}
function ptsAttr(arr) { return arr.map(p => `${p.x},${p.y}`).join(' '); }

// ── SVG structure ───────────────────────────────────────────────────────────
// Grid dot pattern (world / userSpaceOnUse coords → always grid-aligned)
const defs = mkEl('defs');
const gridPat = mkEl('pattern', {
  id: 'grid-pattern', width: GRID, height: GRID,
  patternUnits: 'userSpaceOnUse'
});
gridPat.append(mkEl('circle', { cx: 0, cy: 0, r: 2.5 }, 'grid-dot'));
defs.append(gridPat);
svg.append(defs);

// World group — moves with pan
const world = mkEl('g', { id: 'world' });
svg.append(world);

// Grid layer
const layerGrid = mkEl('g');
layerGrid.append(
  mkEl('rect', { x: -500000, y: -500000, width: 1000000, height: 1000000 }, 'grid-bg'),
  mkEl('rect', { x: -500000, y: -500000, width: 1000000, height: 1000000,
    fill: 'url(#grid-pattern)', 'pointer-events': 'none' })
);

const layerShapes    = mkEl('g');
const layerSelection = mkEl('g'); // selection rings, vertex handles, rubber-band
const layerOverlay   = mkEl('g'); // draw preview (snap ring, preview line, etc.)
const layerPaste = mkEl('g', {'pointer-events': 'none', opacity: '0.55'});
world.append(layerGrid, layerShapes, layerPaste, layerSelection, layerOverlay);

// Permanent overlay elements (draw mode)
const committedPoly = mkEl('polyline', {
  fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const previewLine = mkEl('line', {
  'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const startDot = mkEl('circle', {
  r: 4, fill: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const snapRing = mkEl('circle', {
  r: 5, fill: 'none', 'stroke-width': 1.5,
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const rubberbandEl = mkEl('rect', {
  display: 'none', 'pointer-events': 'none', rx: 1
});
rubberbandEl.setAttribute('style',
  'fill: rgba(26,110,245,0.08); stroke: var(--accent); stroke-width: 1; stroke-dasharray: 4 3;');

const arcPreviewPath = mkEl('path', {
  fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const arcCenterDot = mkEl('circle', {
  r: 4, fill: 'var(--accent)', display: 'none', 'pointer-events': 'none', opacity: 0.5
});
const rectPreviewEl = mkEl('polyline', {
  fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
const circlePreviewEl = mkEl('circle', {
  fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
  stroke: 'var(--accent)', display: 'none', 'pointer-events': 'none'
});
layerOverlay.append(committedPoly, previewLine, startDot, snapRing,
  arcPreviewPath, arcCenterDot, rectPreviewEl, circlePreviewEl);
layerSelection.append(rubberbandEl);

// ── Coordinates ─────────────────────────────────────────────────────────────
function snapVal(v) { return Math.round(v / GRID) * GRID; }

function worldCoords(clientX, clientY) {     // snapped to grid
  const r = svg.getBoundingClientRect();
  return { x: snapVal(clientX - r.left - panX), y: snapVal(clientY - r.top - panY) };
}
function screenToWorld(clientX, clientY) {   // exact (for rubber-band)
  const r = svg.getBoundingClientRect();
  return { x: clientX - r.left - panX, y: clientY - r.top - panY };
}
function snapHalf(v) { return Math.round(v / HALF_GRID) * HALF_GRID; }
function halfWorldCoords(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return { x: snapHalf(clientX - r.left - panX), y: snapHalf(clientY - r.top - panY) };
}
// Center-based arc path — used only by circleGroupPaths
function arcPath(p1, p2, cx, cy) {
  const r = (Math.hypot(p1.x - cx, p1.y - cy) + Math.hypot(p2.x - cx, p2.y - cy)) / 2;
  if (r < 1) return null;
  const cross = (p1.x - cx) * (p2.y - cy) - (p1.y - cy) * (p2.x - cx);
  if (Math.abs(cross) < 0.01) return null;
  return `M ${p1.x},${p1.y} A ${r},${r} 0 0,${cross > 0 ? 1 : 0} ${p2.x},${p2.y}`;
}
// 3-point arc: returns SVG path that passes through p1, pm, p2
function threePointArcPath(p1, pm, p2) {
  const ax = p1.x, ay = p1.y, bx = pm.x, by = pm.y, cx = p2.x, cy = p2.y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 0.001) return null; // collinear
  const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D;
  const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D;
  const r = Math.hypot(ax - ux, ay - uy);
  if (r < 1) return null;
  // Sweep: cross of P1→P2 and P1→PM (screen coords, Y down)
  const cross = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
  const sweep = cross < 0 ? 1 : 0;
  // Large-arc flag
  const a1 = Math.atan2(ay - uy, ax - ux), a2 = Math.atan2(cy - uy, cx - ux);
  let arcAngle = sweep === 0 ? (a1 - a2) : (a2 - a1);
  if (arcAngle < 0) arcAngle += 2 * Math.PI;
  const largeArc = arcAngle > Math.PI ? 1 : 0;
  return `M ${ax},${ay} A ${r},${r} 0 ${largeArc},${sweep} ${cx},${cy}`;
}
// Auto midpoint for a 2-click arc: perpendicular offset = half chord length
// For P1=(0,0) P2=(6,0) → PM=(3,3)
function defaultArcMidpoint(p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  return { x: (p1.x + p2.x) / 2 - dy / 2, y: (p1.y + p2.y) / 2 + dx / 2 };
}
// 4-arc paths for circle-group
function circleGroupPaths(cx, cy, r) {
  const t = {x:cx,y:cy-r}, ri = {x:cx+r,y:cy}, b = {x:cx,y:cy+r}, l = {x:cx-r,y:cy};
  return [arcPath(t,ri,cx,cy), arcPath(ri,b,cx,cy), arcPath(b,l,cx,cy), arcPath(l,t,cx,cy)];
}
function rectPoints(c1, c2) {
  return [{x:c1.x,y:c1.y},{x:c2.x,y:c1.y},{x:c2.x,y:c2.y},{x:c1.x,y:c2.y}];
}
function shapeInRect(s, x1, y1, x2, y2) {
  const inR = p => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  const t = s.type || 'line';
  if (t === 'arc')          return inR(s.p1) || inR(s.pm) || inR(s.p2);
  if (t === 'circle') return inR({x:s.cx,y:s.cy}) || inR({x:s.cx+s.r,y:s.cy});
  return s.points.some(inR);
}

// ── Pan ──────────────────────────────────────────────────────────────────────
function applyPan() { world.setAttribute('transform', `translate(${panX},${panY})`); }

function startPan(clientX, clientY) {
  if (panSnapAnim) { cancelAnimationFrame(panSnapAnim); panSnapAnim = null; }
  isPanning = true;
  pannedThisDrag = false;
  panAnchor = { x: clientX - panX, y: clientY - panY };
  setCursor();
}
function movePan(clientX, clientY) {
  panX = clientX - panAnchor.x;
  panY = clientY - panAnchor.y;
  pannedThisDrag = true;
  applyPan();
  try { localStorage.setItem(PAN_KEY, JSON.stringify({ panX, panY })); } catch {}
}
function endPan() { isPanning = false; setCursor(); snapPanToGrid(); }

function snapPanToGrid() {
  const tx = Math.round(panX / GRID) * GRID;
  const ty = Math.round(panY / GRID) * GRID;
  if (tx === panX && ty === panY) return;
  if (panSnapAnim) cancelAnimationFrame(panSnapAnim);
  function step() {
    const dx = tx - panX, dy = ty - panY;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      panX = tx; panY = ty; applyPan();
      try { localStorage.setItem(PAN_KEY, JSON.stringify({ panX, panY })); } catch {}
      panSnapAnim = null; return;
    }
    panX += dx * 0.15; panY += dy * 0.15; applyPan();
    panSnapAnim = requestAnimationFrame(step);
  }
  panSnapAnim = requestAnimationFrame(step);
}

function makePanelResizer(panelId, side) {
  const panel = document.getElementById(panelId);
  const handle = panel.querySelector('.panel-resizer');
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = panel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.max(GRID * 4, Math.round((startW + delta) / GRID) * GRID);
      panel.style.width = w + 'px';
    }
    function onUp(ev) {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.max(GRID * 4, Math.round((startW + delta) / GRID) * GRID);
      panel.style.width = w + 'px';
      document.body.style.cursor = '';
      try {
        const d = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
        d[panelId] = w; localStorage.setItem(PANEL_KEY, JSON.stringify(d));
      } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function effectiveTool() { return ctrlDown ? 'select' : tool; }

function setCursor() {
  if (spaceDown)                    { container.style.cursor = isPanning ? 'grabbing' : 'grab'; return; }
  if (isPanning)                    { container.style.cursor = 'grabbing'; return; }
  if (dragState?.moved)             { container.style.cursor = 'grabbing'; return; }
  if (pasteMode)                    { container.style.cursor = 'copy'; return; }
  if (effectiveTool() === 'select') { container.style.cursor = hoveredShapeId !== null ? 'move' : 'default'; return; }
  container.style.cursor = 'crosshair';
}

// ── Group selection expansion ────────────────────────────────────────────────
function expandGroupSelection() {
  const groupIds = new Set();
  for (const id of selectedIds) {
    const s = shapes.find(s => s.id === id);
    if (s?.groupId) groupIds.add(s.groupId);
  }
  for (const gid of groupIds) {
    shapes.forEach(s => { if (s.groupId === gid) selectedIds.add(s.id); });
  }
}

// ── Selection render ─────────────────────────────────────────────────────────
function renderSelection() {
  Array.from(layerSelection.children).forEach(c => { if (c !== rubberbandEl) c.remove(); });
  const ringStyle = 'stroke: var(--accent); stroke-width: 2; stroke-dasharray: 6 3; opacity: 0.75;';
  const handleStyle = 'fill: var(--surface); stroke: var(--accent); stroke-width: 1.5;';

  function addHandle(p, pointKey, shapeId) {
    const vh = mkEl('rect', {x:p.x-5, y:p.y-5, width:10, height:10, rx:2});
    vh.setAttribute('style', handleStyle);
    vh.style.cursor = 'crosshair';
    vh.addEventListener('mouseenter', () => { hoveredShapeId = shapeId; setCursor(); });
    vh.addEventListener('mouseleave', () => { if (hoveredShapeId === shapeId) { hoveredShapeId = null; setCursor(); } });
    vh.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      startHandleDrag(shapeId, pointKey, p, e);
    });
    layerSelection.insertBefore(vh, rubberbandEl);
  }

  for (const id of selectedIds) {
    const s = shapes.find(s => s.id === id);
    if (!s) continue;
    const t = s.type || 'line';

    if (t === 'arc') {
      const d = threePointArcPath(s.p1, s.pm, s.p2);
      if (d) {
        const ring = mkEl('path', {d, fill:'none', 'pointer-events':'none'});
        ring.setAttribute('style', ringStyle);
        layerSelection.insertBefore(ring, rubberbandEl);
      }
      [['p1',s.p1],['pm',s.pm],['p2',s.p2]].forEach(([key,p]) => {
        addHandle(p, key, id);
      });
    } else if (t === 'circle') {
      const ring = mkEl('circle', {cx:s.cx, cy:s.cy, r:s.r, fill:'none', 'pointer-events':'none'});
      ring.setAttribute('style', ringStyle);
      layerSelection.insertBefore(ring, rubberbandEl);
      const {cx,cy,r} = s;
      [['c',{x:cx,y:cy}],['t',{x:cx,y:cy-r}],['ri',{x:cx+r,y:cy}],['b',{x:cx,y:cy+r}],['l',{x:cx-r,y:cy}]].forEach(([key,p]) => {
        addHandle(p, key, id);
      });
    } else {
      const tag = s.closed ? 'polygon' : 'polyline';
      const ring = mkEl(tag, {points:ptsAttr(s.points),fill:'none','pointer-events':'none'});
      ring.setAttribute('style', ringStyle);
      layerSelection.insertBefore(ring, rubberbandEl);
      s.points.forEach((p, i) => {
        const vh = mkEl('rect', {x:p.x-5,y:p.y-5,width:10,height:10,rx:2});
        vh.setAttribute('style', handleStyle);
        vh.style.cursor = 'crosshair';
        vh.addEventListener('mouseenter', () => { hoveredShapeId = id; setCursor(); });
        vh.addEventListener('mouseleave', () => { if (hoveredShapeId === id) { hoveredShapeId = null; setCursor(); } });
        vh.addEventListener('mousedown', e => { if (e.button !== 0) return; e.stopPropagation(); startVertexDrag(id, i, e); });
        layerSelection.insertBefore(vh, rubberbandEl);
      });
    }
  }
  syncUIToSelection();
  updatePropsVisibility();
  updateGroupBtn();
  updateLayers();
}

// ── Props visibility / group button / layers panel ────────────────────────────
function updatePropsVisibility() {
  const show = tool !== 'select' || selectedIds.size > 0;
  document.getElementById('style-props-group').classList.toggle('props-hidden', !show);
  document.getElementById('group-tool-group').classList.toggle('props-hidden', !show);
}

function updateGroupBtn() {
  const btn = document.getElementById('btn-group');
  if (!btn) return;
  const selShapes = shapes.filter(s => selectedIds.has(s.id));
  if (selShapes.length === 0) { btn.disabled = true; btn.textContent = 'Gruppera'; return; }
  const gids = selShapes.map(s => s.groupId).filter(Boolean);
  const allSameGroup = gids.length === selShapes.length && new Set(gids).size === 1;
  if (allSameGroup) { btn.disabled = false; btn.textContent = 'Dela upp'; return; }
  btn.disabled = selShapes.length < 2;
  btn.textContent = 'Gruppera';
}

function layerIcon(type) {
  if (type === 'arc')    return '◠';
  if (type === 'rect')   return '▭';
  if (type === 'circle') return '○';
  return '╱';
}

function layerName(s) {
  if (!s) return '?';
  if (s.label) return s.label;
  const t = s.type || 'line';
  const n = { line: 'Linje', arc: 'Båge', rect: 'Fyrkant', circle: 'Cirkel' };
  return (n[t] || t) + ' ' + s.id;
}
function getBuiltInAttrs(s) {
  const t = s.type || 'line';
  const res = {};
  if (t === 'circle') {
    res.cx = String(s.cx); res.cy = String(s.cy); res.r = String(s.r);
  } else if (t === 'arc') {
    const d = threePointArcPath(s.p1, s.pm, s.p2);
    if (d) res.d = d;
    res['stroke-linecap'] = 'round';
  } else {
    res.points = (s.points || []).map(p => `${p.x},${p.y}`).join(' ');
    res['stroke-linecap'] = 'round'; res['stroke-linejoin'] = 'round';
  }
  res.stroke = s.stroke || '#000000';
  res.fill = s.fill || 'none';
  res['stroke-width'] = String(s.strokeWidth || 2);
  return res;
}
function addAttrRow(list, name, val, disabled) {
  const row = document.createElement('div');
  row.className = 'obj-attr-row' + (disabled ? ' disabled' : '');
  const ni = document.createElement('input');
  ni.type = 'text'; ni.className = 'obj-attr-name'; ni.value = name;
  ni.disabled = !!disabled;
  if (!disabled) ni.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeObjectModal(); });
  const vi = document.createElement('input');
  vi.type = 'text'; vi.className = 'obj-attr-val'; vi.value = val;
  vi.disabled = !!disabled;
  if (!disabled) {
    vi.placeholder = 'värde';
    vi.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeObjectModal(); if (e.key === 'Enter') { e.preventDefault(); saveObjectModal(); } });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'obj-attr-del'; del.textContent = '×';
    del.addEventListener('click', () => row.remove());
    row.append(ni, vi, del);
  } else {
    row.append(ni, vi);
  }
  list.append(row);
  if (!disabled && !name) ni.focus();
}
function openObjectModal(key) {
  modalTargetKey = key;
  const modal    = document.getElementById('obj-modal');
  const nameInp  = document.getElementById('obj-modal-name');
  const idInp    = document.getElementById('obj-modal-svgid');
  const visInp   = document.getElementById('obj-modal-vis');
  const titleEl  = document.getElementById('obj-modal-title');
  const attrsList = document.getElementById('obj-modal-attrs-list');
  attrsList.innerHTML = '';
  if (key[0] === 'g') {
    const gid = parseInt(key.slice(1));
    titleEl.textContent = 'Grupp ' + gid;
    nameInp.value = groupLabels.get(gid) || '';
    nameInp.placeholder = 'Grupp ' + gid;
    idInp.value = groupSvgIds.get(gid) || '';
    visInp.checked = !hiddenGroupIds.has(gid);
  } else {
    const sid = parseInt(key.slice(1));
    const s = shapes.find(sh => sh.id === sid);
    if (!s) return;
    const typeNames = { line: 'Linje', arc: 'Båge', rect: 'Fyrkant', circle: 'Cirkel' };
    titleEl.textContent = (typeNames[s.type || 'line'] || s.type) + ' ' + s.id;
    nameInp.value = s.label || '';
    nameInp.placeholder = layerName(s);
    idInp.value = s.svgId || '';
    visInp.checked = !s.hidden;
    Object.entries(getBuiltInAttrs(s)).forEach(([n, v]) => addAttrRow(attrsList, n, v, true));
    if (s.attrs) Object.entries(s.attrs).forEach(([n, v]) => addAttrRow(attrsList, n, v, false));
  }
  modal.style.display = 'flex';
  nameInp.focus();
  nameInp.select();
}
function closeObjectModal() {
  document.getElementById('obj-modal').style.display = 'none';
  modalTargetKey = null;
}
function saveObjectModal() {
  if (!modalTargetKey) return;
  const key     = modalTargetKey;
  const nameVal = document.getElementById('obj-modal-name').value.trim();
  const idVal   = document.getElementById('obj-modal-svgid').value.trim();
  const visVal  = document.getElementById('obj-modal-vis').checked;
  if (key[0] === 'g') {
    const gid = parseInt(key.slice(1));
    if (nameVal) groupLabels.set(gid, nameVal); else groupLabels.delete(gid);
    if (idVal)   groupSvgIds.set(gid, idVal);   else groupSvgIds.delete(gid);
    if (visVal)  hiddenGroupIds.delete(gid);    else hiddenGroupIds.add(gid);
  } else {
    const sid = parseInt(key.slice(1));
    const s = shapes.find(sh => sh.id === sid);
    if (s) {
      const oldSvgId = s.svgId || null;
      if (nameVal) s.label = nameVal; else delete s.label;
      if (idVal)   s.svgId = idVal;   else delete s.svgId;
      s.hidden = !visVal;
      const newSvgId = s.svgId || null;
      if (oldSvgId && newSvgId && oldSvgId !== newSvgId) renameInAnimCode(oldSvgId, newSvgId);
      const customAttrs = {};
      document.getElementById('obj-modal-attrs-list').querySelectorAll('.obj-attr-row:not(.disabled)').forEach(row => {
        const n = row.querySelector('.obj-attr-name').value.trim();
        const v = row.querySelector('.obj-attr-val').value;
        if (n) customAttrs[n] = v;
      });
      if (Object.keys(customAttrs).length) s.attrs = customAttrs; else delete s.attrs;
    }
  }
  closeObjectModal();
  save(); render();
}

function updateLayers() {
  const list = document.getElementById('layers-list');
  if (!list) return;
  list.innerHTML = '';
  const reversed = [...shapes].reverse();
  const doneGroups = new Set();

  // Build flat ordered item list
  const items = [];
  for (const s of reversed) {
    if (s.groupId) {
      if (doneGroups.has(s.groupId)) continue;
      doneGroups.add(s.groupId);
      const members = shapes.filter(sh => sh.groupId === s.groupId);
      items.push({ ids: members.map(m => m.id), isGroup: true, groupId: s.groupId });
      if (!collapsedGroups.has(s.groupId)) {
        [...members].reverse().forEach(m => items.push({ ids: [m.id], isGroup: false, indent: true }));
      }
    } else {
      items.push({ ids: [s.id], isGroup: false, indent: false });
    }
  }
  for (const gid of emptyGroupIds) {
    if (!doneGroups.has(gid)) items.push({ ids: [], isGroup: true, groupId: gid });
  }

  function rangeToggle(anchorIdx, idx) {
    const lo = Math.min(anchorIdx, idx), hi = Math.max(anchorIdx, idx);
    const rangeIds = items.slice(lo, hi + 1).flatMap(it => it.ids);
    const allRangeSel = rangeIds.every(id => selectedIds.has(id));
    if (allRangeSel) rangeIds.forEach(id => selectedIds.delete(id));
    else             rangeIds.forEach(id => selectedIds.add(id));
  }

  function makeVisToggle(isHidden) {
    const span = document.createElement('span');
    span.className = 'layer-vis' + (isHidden ? ' vis-hidden' : '');
    span.title = isHidden ? 'Visa' : 'Dölj';
    span.textContent = '●';
    span.addEventListener('mousedown', e => e.stopPropagation());
    return span;
  }

  items.forEach((item, idx) => {
    const allSel = item.ids.length > 0 && item.ids.every(id => selectedIds.has(id));
    const el = document.createElement('div');

    if (item.isGroup) {
      const collapsed  = collapsedGroups.has(item.groupId);
      const isHidden   = hiddenGroupIds.has(item.groupId);
      const label      = groupLabels.get(item.groupId) || '';
      const dispName   = label || ('Grupp ' + item.groupId);
      el.className = 'layer-item layer-group' + (allSel ? ' selected' : '') + (isHidden ? ' item-hidden' : '');

      const arrowSpan = document.createElement('span');
      arrowSpan.className = 'layer-icon layer-arrow';
      arrowSpan.textContent = collapsed ? '▶' : '▼';
      el.appendChild(arrowSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'layer-name';
      nameSpan.textContent = dispName;
      el.appendChild(nameSpan);

      const visSpan = makeVisToggle(isHidden);
      visSpan.addEventListener('click', e => {
        e.stopPropagation();
        if (hiddenGroupIds.has(item.groupId)) hiddenGroupIds.delete(item.groupId);
        else hiddenGroupIds.add(item.groupId);
        save(); render();
      });
      el.appendChild(visSpan);

      if (item.ids.length === 0) {
        const delEl = document.createElement('span');
        delEl.className = 'layer-del'; delEl.title = 'Ta bort grupp'; delEl.textContent = '✕';
        delEl.addEventListener('mousedown', e => e.stopPropagation());
        delEl.addEventListener('click', e => { e.stopPropagation(); emptyGroupIds.delete(item.groupId); groupLabels.delete(item.groupId); hiddenGroupIds.delete(item.groupId); save(); updateLayers(); });
        el.appendChild(delEl);
      }

      el.addEventListener('click', e => {
        if (e.ctrlKey) {
          if (item.ids.length === 0) return;
          const cur = item.ids.every(id => selectedIds.has(id));
          if (cur) item.ids.forEach(id => selectedIds.delete(id));
          else     item.ids.forEach(id => selectedIds.add(id));
          lastLayerAnchorIdx = idx; renderSelection();
        } else if (e.shiftKey) {
          if (item.ids.length === 0) return;
          rangeToggle(lastLayerAnchorIdx >= 0 ? lastLayerAnchorIdx : idx, idx); renderSelection();
        } else {
          if (collapsedGroups.has(item.groupId)) collapsedGroups.delete(item.groupId);
          else collapsedGroups.add(item.groupId);
          updateLayers();
        }
      });
      el.addEventListener('dblclick', e => {
        e.stopPropagation();
        openObjectModal('g' + item.groupId);
      });

    } else {
      const s = shapes.find(sh => sh.id === item.ids[0]);
      const isHidden  = s?.hidden || (s?.groupId && hiddenGroupIds.has(s.groupId));
      el.className = 'layer-item' + (item.indent ? ' layer-indent' : '') + (allSel ? ' selected' : '') + (isHidden ? ' item-hidden' : '');

      const iconSpan = document.createElement('span');
      iconSpan.className = 'layer-icon';
      iconSpan.textContent = layerIcon(s?.type||'line');
      el.appendChild(iconSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'layer-name';
      nameSpan.textContent = layerName(s);
      el.appendChild(nameSpan);

      const visSpan = makeVisToggle(isHidden);
      visSpan.addEventListener('click', e => {
        e.stopPropagation();
        if (s) { s.hidden = !s.hidden; save(); render(); }
      });
      el.appendChild(visSpan);

      el.addEventListener('click', e => {
        const cur = item.ids.every(id => selectedIds.has(id));
        if (e.ctrlKey) {
          if (cur) item.ids.forEach(id => selectedIds.delete(id));
          else     item.ids.forEach(id => selectedIds.add(id));
          lastLayerAnchorIdx = idx;
        } else if (e.shiftKey) {
          rangeToggle(lastLayerAnchorIdx >= 0 ? lastLayerAnchorIdx : idx, idx);
        } else {
          selectedIds.clear();
          item.ids.forEach(id => selectedIds.add(id));
          lastLayerAnchorIdx = idx;
        }
        renderSelection();
      });
      el.addEventListener('dblclick', e => {
        e.stopPropagation();
        openObjectModal('s' + item.ids[0]);
      });
    }

    // Right-click: context menu
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (item.ids.length === 0) return;
      ctxTargetId = item.ids[0];
      ctxTargetGroupId = item.isGroup ? item.groupId : null;
      if (!item.ids.every(id => selectedIds.has(id))) {
        selectedIds.clear();
        item.ids.forEach(id => selectedIds.add(id));
        renderSelection();
      }
      showCtxMenu(e.clientX, e.clientY);
    });

    // Draggable (non-empty items only)
    if (item.ids.length > 0) {
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        layerDragIds = item.ids;
        layerDragIsGroup = item.isGroup;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '1');
        setTimeout(() => el.classList.add('layer-dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        layerDragIds = null; layerDragIsGroup = false; layerDragIntoGroup = false;
        document.querySelectorAll('.layer-drag-top,.layer-drag-bottom,.layer-drag-into,.layer-dragging')
          .forEach(x => x.classList.remove('layer-drag-top', 'layer-drag-bottom', 'layer-drag-into', 'layer-dragging'));
      });
    }
    // Drop target: group rows accept elements (including when empty)
    if (item.isGroup) {
      el.addEventListener('dragover', e => {
        if (!layerDragIds || layerDragIsGroup) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.layer-drag-top,.layer-drag-bottom,.layer-drag-into')
          .forEach(x => x.classList.remove('layer-drag-top', 'layer-drag-bottom', 'layer-drag-into'));
        layerDragIntoGroup = true;
        el.classList.add('layer-drag-into');
      });
      el.addEventListener('dragleave', () => { el.classList.remove('layer-drag-into'); });
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('layer-drag-into');
        if (!layerDragIds || !layerDragIntoGroup) return;
        const dragIds = layerDragIds; layerDragIds = null;
        if (item.ids.some(id => dragIds.includes(id))) return;
        pushUndo();
        dragIds.forEach(id => { const s = shapes.find(sh => sh.id === id); if (s) s.groupId = item.groupId; });
        emptyGroupIds.delete(item.groupId);
        save(); render();
      });
    } else {
      // Drop target: non-group rows handle reordering
      el.addEventListener('dragover', e => {
        if (!layerDragIds) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        document.querySelectorAll('.layer-drag-top,.layer-drag-bottom,.layer-drag-into')
          .forEach(x => x.classList.remove('layer-drag-top', 'layer-drag-bottom', 'layer-drag-into'));
        layerDragIntoGroup = false;
        const rect = el.getBoundingClientRect();
        layerDragInsertAfter = e.clientY > rect.top + rect.height / 2;
        el.classList.add(layerDragInsertAfter ? 'layer-drag-bottom' : 'layer-drag-top');
      });
      el.addEventListener('dragleave', () => { el.classList.remove('layer-drag-top', 'layer-drag-bottom'); });
      el.addEventListener('drop', e => {
        e.preventDefault();
        document.querySelectorAll('.layer-drag-top,.layer-drag-bottom')
          .forEach(x => x.classList.remove('layer-drag-top', 'layer-drag-bottom'));
        if (!layerDragIds) return;
        const dragIds = layerDragIds; layerDragIds = null;
        if (item.ids.some(id => dragIds.includes(id))) return;
        pushUndo();
        const allIds = [...shapes].reverse().map(s => s.id);
        const remaining = allIds.filter(id => !dragIds.includes(id));
        let insertPos;
        if (layerDragInsertAfter) {
          const lastTgtId = [...item.ids].reverse().find(id => remaining.includes(id));
          const pos = lastTgtId !== undefined ? remaining.indexOf(lastTgtId) : -1;
          insertPos = pos >= 0 ? pos + 1 : remaining.length;
        } else {
          const firstTgtId = item.ids.find(id => remaining.includes(id));
          const pos = firstTgtId !== undefined ? remaining.indexOf(firstTgtId) : -1;
          insertPos = pos >= 0 ? pos : 0;
        }
        remaining.splice(insertPos, 0, ...dragIds);
        const newOrder = [...remaining].reverse();
        shapes = newOrder.map(id => shapes.find(s => s.id === id)).filter(Boolean);
        save(); render();
      });
    }

    list.append(el);
  });
}

document.getElementById('layers-list').addEventListener('click', e => {
  if (e.target !== document.getElementById('layers-list')) return; // only bare background
  if (e.ctrlKey) return; // ctrl+click on empty = nothing
  if (selectedIds.size === 0) return;
  selectedIds.clear();
  renderSelection();
});

function groupOrUngroup() {
  if (selectedIds.size === 0) return;
  const selShapes = shapes.filter(s => selectedIds.has(s.id));
  const gids = selShapes.map(s => s.groupId).filter(Boolean);
  const allSameGroup = gids.length === selShapes.length && new Set(gids).size === 1;
  pushUndo();
  if (allSameGroup) {
    const gid = gids[0];
    shapes.forEach(s => { if (s.groupId === gid) delete s.groupId; });
  } else {
    if (selShapes.length < 2) { undoStack.pop(); return; }
    const gid = nextGroupId++;
    if (!groupSvgIds.has(gid)) groupSvgIds.set(gid, 'group' + gid);
    selShapes.forEach(s => { s.groupId = gid; });
  }
  save(); render();
}

// ── Shape element factory (used by render + paste preview) ───────────────────
function applyDash(el, dashType, sw) {
  if (dashType === 'dashed') {
    el.setAttribute('stroke-dasharray', `${+(sw*3).toFixed(2)} ${+(sw*2).toFixed(2)}`);
  } else if (dashType === 'dotted') {
    el.setAttribute('stroke-dasharray', `0.01 ${+(sw*2.5).toFixed(2)}`);
    el.setAttribute('stroke-linecap', 'round');
  }
}
function makeShapeEl(s) {
  const t = s.type || 'line';
  const rawStroke = s.stroke||'#000000', fill = s.fill||'none', sw = s.strokeWidth||2;
  const ghost = rawStroke === 'none' && fill === 'none';
  const stroke = ghost ? 'rgba(128,128,128,0.35)' : rawStroke;
  let el;
  if (t === 'arc') {
    const d = threePointArcPath(s.p1, s.pm, s.p2);
    if (!d) return null;
    el = mkEl('path', {d, stroke, fill, 'stroke-width':sw, 'stroke-linecap':'round'}, 'drawn-line');
  } else if (t === 'circle') {
    el = mkEl('circle', {cx:s.cx, cy:s.cy, r:s.r, stroke, fill, 'stroke-width':sw}, 'drawn-line');
  } else {
    const tag = s.closed ? 'polygon' : 'polyline';
    el = mkEl(tag, {points:ptsAttr(s.points), stroke, fill, 'stroke-width':sw,
      'stroke-linecap':'round', 'stroke-linejoin':'round'}, 'drawn-line');
  }
  if (ghost) {
    el.setAttribute('stroke-dasharray', '4 4');
  } else {
    applyDash(el, s.dashType, sw);
  }
  return el;
}

// ── Paste mode ────────────────────────────────────────────────────────────────
function clipboardAnchor() {
  // Use the first key point of the first shape — always on the grid.
  // This ensures offset = cursor(grid) - anchor(grid) stays grid-aligned.
  const s = clipboard[0];
  const t = s.type || 'line';
  if (t === 'arc')    return { x: s.p1.x, y: s.p1.y };
  if (t === 'circle') return { x: s.cx,   y: s.cy   };
  return { x: s.points[0].x, y: s.points[0].y };
}

function offsetShape(s, dx, dy) {
  const ns = JSON.parse(JSON.stringify(s));
  const t = ns.type || 'line';
  if (t === 'arc') {
    ns.p1={x:ns.p1.x+dx,y:ns.p1.y+dy}; ns.pm={x:ns.pm.x+dx,y:ns.pm.y+dy}; ns.p2={x:ns.p2.x+dx,y:ns.p2.y+dy};
  } else if (t === 'circle') { ns.cx+=dx; ns.cy+=dy; }
  else ns.points = ns.points.map(p=>({x:p.x+dx,y:p.y+dy}));
  return ns;
}

function enterPasteMode() {
  if (!clipboard.length) return;
  pasteMode = true;
  pasteModeAnchor = clipboardAnchor();
  cancelDraw(); selectedIds.clear(); renderSelection();
  setCursor();
}

function updatePastePreview(cursor) {
  layerPaste.innerHTML = '';
  if (!pasteMode) return;
  const dx = cursor.x - pasteModeAnchor.x, dy = cursor.y - pasteModeAnchor.y;
  for (const src of clipboard) {
    const el = makeShapeEl(offsetShape(src, dx, dy));
    if (el) layerPaste.append(el);
  }
}

function commitPaste(cursor) {
  const dx = cursor.x - pasteModeAnchor.x, dy = cursor.y - pasteModeAnchor.y;
  pushUndo();
  const newIds = new Set();
  for (const src of clipboard) {
    const s = offsetShape(src, dx, dy);
    s.id = nextId++;
    const _pt = s.type === 'circle' ? 'circle' : s.type === 'arc' ? 'arc' : s.closed ? 'rect' : 'line';
    s.svgId = _pt + s.id;
    shapes.push(s);
    newIds.add(s.id);
  }
  selectedIds.clear();
  newIds.forEach(id => selectedIds.add(id));
  save(); render();
}

function cancelPasteMode() {
  pasteMode = false;
  pasteModeAnchor = null;
  layerPaste.innerHTML = '';
  setCursor();
}

// ── Shape render ──────────────────────────────────────────────────────────────
function render() {
  layerShapes.innerHTML = '';

  for (const s of shapes) {
    if (s.hidden || (s.groupId && hiddenGroupIds.has(s.groupId))) continue;
    const t = s.type || 'line';
    const shapeEl = makeShapeEl(s);
    if (!shapeEl) continue;
    layerShapes.append(shapeEl);

    if (effectiveTool() === 'select' && !pasteMode) {
      let hit;
      if (t === 'arc') {
        const d = threePointArcPath(s.p1, s.pm, s.p2);
        if (!d) continue;
        hit = mkEl('path', {d, fill:'none', stroke:'transparent', 'stroke-width':14, 'data-shape-id':s.id});
      } else if (t === 'circle') {
        hit = mkEl('circle', {cx:s.cx,cy:s.cy,r:s.r, fill:s.fill!=='none'?'transparent':'none', stroke:'transparent','stroke-width':14,'data-shape-id':s.id});
      } else {
        hit = mkEl(s.closed?'polygon':'polyline', {points:ptsAttr(s.points), fill:s.closed?'transparent':'none', stroke:'transparent','stroke-width':14,'data-shape-id':s.id});
      }
      hit.addEventListener('mouseenter', () => { hoveredShapeId = s.id; shapeEl.classList.add('hovered'); setCursor(); });
      hit.addEventListener('mouseleave', () => { if (hoveredShapeId===s.id) hoveredShapeId=null; shapeEl.classList.remove('hovered'); setCursor(); });
      hit.addEventListener('mousedown', e => { if (e.button!==0||isPanning||spaceDown) return; e.stopPropagation(); startShapeDrag(s.id, e); });
      hit.addEventListener('dblclick', e => { e.stopPropagation(); openObjectModal('s' + s.id); });
      layerShapes.append(hit);
    }
  }

  renderSelection();
  updateCode();
}

// ── Draw-mode helpers ────────────────────────────────────────────────────────
function atStart(x, y) {
  if (drawPoints.length < 2) return false;
  return x === drawPoints[0].x && y === drawPoints[0].y;
}

function commitShape(closed) {
  if (drawPoints.length >= 2) {
    pushUndo();
    const _id = nextId++;
    shapes.push({
      id: _id, svgId: 'line' + _id, points: [...drawPoints], closed,
      stroke: strokeColor, fill: fillColor,
      strokeWidth: strokeWidth
    });
    selectedIds.clear(); selectedIds.add(_id);
    save();
    render();
  }
  cancelDraw();
}

function cancelDraw() {
  drawPoints = [];
  arcPhase = 0; arcP1 = null;
  rectPhase = 0; rectCorner1 = null;
  circlePhase = 0; circleOrigin = null;
  committedPoly.setAttribute('display', 'none');
  previewLine.setAttribute('display', 'none');
  startDot.setAttribute('display', 'none');
  snapRing.setAttribute('display', 'none');
  arcPreviewPath.setAttribute('display', 'none');
  arcCenterDot.setAttribute('display', 'none');
  rectPreviewEl.setAttribute('display', 'none');
  circlePreviewEl.setAttribute('display', 'none');
}

// ── Drag helpers ─────────────────────────────────────────────────────────────
function startShapeDrag(shapeId, e) {
  hideCtxMenu();
  const wasSelected = selectedIds.has(shapeId);

  if (!e.shiftKey) {
    if (!wasSelected) { selectedIds.clear(); selectedIds.add(shapeId); }
  } else {
    selectedIds.add(shapeId); // may be toggled off on mouseup if click
  }

  dragState = {
    type: 'shapes',
    shapeId,
    shapeIds: new Set(selectedIds),
    anchorClientX: e.clientX,
    anchorClientY: e.clientY,
    anchorWorld: worldCoords(e.clientX, e.clientY),
    origPositions: null,
    moved: false,
    shiftKey: e.shiftKey,
    wasSelected
  };
  renderSelection();
}

function startVertexDrag(shapeId, pointIdx, e) {
  hideCtxMenu();
  const s = shapes.find(s => s.id === shapeId);
  if (!s) return;
  dragState = {
    type: 'vertex', shapeId, pointKey: pointIdx,
    anchorClientX: e.clientX, anchorClientY: e.clientY,
    anchorWorld: worldCoords(e.clientX, e.clientY),
    origPt: { ...s.points[pointIdx] }, moved: false
  };
}

function startHandleDrag(shapeId, pointKey, origPt, e) {
  hideCtxMenu();
  dragState = {
    type: 'vertex', shapeId, pointKey,
    anchorClientX: e.clientX, anchorClientY: e.clientY,
    anchorWorld: worldCoords(e.clientX, e.clientY),
    origPt: { x: origPt.x, y: origPt.y }, moved: false
  };
}

function startRubberband(e) {
  hideCtxMenu();
  if (!e.shiftKey) selectedIds.clear();
  const anchorWorld = screenToWorld(e.clientX, e.clientY);

  dragState = {
    type: 'rubber',
    anchorClientX: e.clientX,
    anchorClientY: e.clientY,
    anchorWorld,
    moved: false,
    shiftKey: e.shiftKey
  };
  renderSelection();
}

// ── Mouse events ──────────────────────────────────────────────────────────────

// Middle mouse or Space+drag → pan
svg.addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    startPan(e.clientX, e.clientY);
    return;
  }
  if (e.button === 0) {
    pannedThisDrag = false;
    // Only fires when NOT over a hit-target (they stopPropagation)
    if (effectiveTool() === 'select' && !isPanning) {
      startRubberband(e);
    }
  }
});

// Pan + drag (window-level so it works outside SVG bounds)
window.addEventListener('mousemove', e => {
  if (isPanning) { movePan(e.clientX, e.clientY); return; }
  if (!dragState) return;

  // Check drag threshold
  if (!dragState.moved) {
    const dx = e.clientX - dragState.anchorClientX;
    const dy = e.clientY - dragState.anchorClientY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    // Threshold crossed — initiate drag
    dragState.moved = true;

    if (dragState.type === 'shapes') {
      // Push undo BEFORE any movement
      undoStack.push(JSON.stringify({ shapes, nextId }));
      if (undoStack.length > 100) undoStack.shift();
      dragState.origPositions = new Map();
      for (const id of dragState.shapeIds) {
        const s = shapes.find(s => s.id === id);
        if (!s) continue;
        const t = s.type || 'line';
        if (t === 'arc')          dragState.origPositions.set(id, {p1:{...s.p1},pm:{...s.pm},p2:{...s.p2}});
        else if (t === 'circle') dragState.origPositions.set(id, {cx:s.cx,cy:s.cy});
        else                     dragState.origPositions.set(id, s.points.map(p=>({...p})));
      }
    } else if (dragState.type === 'vertex') {
      undoStack.push(JSON.stringify({ shapes, nextId }));
      if (undoStack.length > 100) undoStack.shift();
    }
  }

  const cur = worldCoords(e.clientX, e.clientY);

  if (dragState.type === 'shapes') {
    const dx = cur.x - dragState.anchorWorld.x;
    const dy = cur.y - dragState.anchorWorld.y;
    for (const [id, orig] of dragState.origPositions) {
      const s = shapes.find(s => s.id === id);
      if (!s) continue;
      const t = s.type || 'line';
      if (t === 'arc') {
        s.p1 = {x:orig.p1.x+dx,y:orig.p1.y+dy};
        s.pm = {x:orig.pm.x+dx,y:orig.pm.y+dy};
        s.p2 = {x:orig.p2.x+dx,y:orig.p2.y+dy};
      } else if (t === 'circle') {
        s.cx = orig.cx+dx; s.cy = orig.cy+dy;
      } else {
        s.points = orig.map(p=>({x:p.x+dx,y:p.y+dy}));
      }
    }
    render();

  } else if (dragState.type === 'vertex') {
    const dx = cur.x - dragState.anchorWorld.x;
    const dy = cur.y - dragState.anchorWorld.y;
    const s = shapes.find(s => s.id === dragState.shapeId);
    if (s) {
      const pk = dragState.pointKey;
      const nx = dragState.origPt.x + dx, ny = dragState.origPt.y + dy;
      const t = s.type || 'line';
      if (typeof pk === 'number') {
        s.points[pk] = {x: nx, y: ny};
      } else if (t === 'arc') {
        if (pk === 'p1')       s.p1 = {x: nx, y: ny};
        else if (pk === 'p2')  s.p2 = {x: nx, y: ny};
        else if (pk === 'pm') { const hc = halfWorldCoords(e.clientX, e.clientY); s.pm = {x: hc.x, y: hc.y}; }
      } else if (t === 'circle') {
        if (pk === 'c') {
          s.cx = nx; s.cy = ny;
        } else {
          const newR = Math.hypot(nx - s.cx, ny - s.cy);
          if (newR > 0) s.r = Math.max(HALF_GRID, Math.round(newR / HALF_GRID) * HALF_GRID);
        }
      }
      render();
    }

  } else if (dragState.type === 'rubber') {
    const w = screenToWorld(e.clientX, e.clientY);
    const x1 = Math.min(dragState.anchorWorld.x, w.x);
    const y1 = Math.min(dragState.anchorWorld.y, w.y);
    const x2 = Math.max(dragState.anchorWorld.x, w.x);
    const y2 = Math.max(dragState.anchorWorld.y, w.y);
    rubberbandEl.setAttribute('x', x1);
    rubberbandEl.setAttribute('y', y1);
    rubberbandEl.setAttribute('width', Math.max(0, x2 - x1));
    rubberbandEl.setAttribute('height', Math.max(0, y2 - y1));
    rubberbandEl.setAttribute('display', 'block');
  }
});

window.addEventListener('mouseup', e => {
  if (isPanning) { endPan(); return; }
  if (!dragState) return;

  if (!dragState.moved) {
    // Was a click
    if (dragState.type === 'shapes') {
      if (dragState.shiftKey) {
        // Toggle: we added in mousedown, remove if it was already selected
        if (dragState.wasSelected) selectedIds.delete(dragState.shapeId);
      } else {
        selectedIds.clear();
        selectedIds.add(dragState.shapeId);
      }
      renderSelection();
    }
    // rubber click (empty canvas, !shift): selection already cleared in startRubberband
  } else {
    if (dragState.type === 'shapes' || dragState.type === 'vertex') {
      save();
      render();
    } else if (dragState.type === 'rubber') {
      // Finalize rubber-band: select shapes with any point inside rect
      const w = screenToWorld(e.clientX, e.clientY);
      const x1 = Math.min(dragState.anchorWorld.x, w.x);
      const y1 = Math.min(dragState.anchorWorld.y, w.y);
      const x2 = Math.max(dragState.anchorWorld.x, w.x);
      const y2 = Math.max(dragState.anchorWorld.y, w.y);
      for (const s of shapes) {
        if (shapeInRect(s, x1, y1, x2, y2)) selectedIds.add(s.id);
      }
      expandGroupSelection();
      rubberbandEl.setAttribute('display', 'none');
      renderSelection();
    }
  }

  dragState = null;
  setCursor();
});

// Draw-tool snap ring & preview
svg.addEventListener('mousemove', e => {
  if (isPanning || dragState) return;
  const { x, y } = worldCoords(e.clientX, e.clientY);
  statusPos.textContent = `${x / GRID}, ${y / GRID}`;
  if (pasteMode) {
    updatePastePreview({x, y});
    snapRing.setAttribute('cx', x); snapRing.setAttribute('cy', y);
    snapRing.setAttribute('display', 'block');
    return;
  }
  if (effectiveTool() === 'select') return;

  let snapX = x, snapY = y;

  if (tool === 'line') {
    const closing = atStart(x, y);
    snapRing.setAttribute('stroke', closing ? '#22c55e' : 'var(--accent)');
    if (drawPoints.length > 0) {
      const last = drawPoints[drawPoints.length - 1];
      previewLine.setAttribute('x1', last.x); previewLine.setAttribute('y1', last.y);
      previewLine.setAttribute('x2', x);      previewLine.setAttribute('y2', y);
      previewLine.setAttribute('display', 'block');
    }
  } else if (tool === 'arc' && arcPhase === 1) {
    if (x !== arcP1.x || y !== arcP1.y) {
      const pm = defaultArcMidpoint(arcP1, {x, y});
      const d = threePointArcPath(arcP1, pm, {x, y});
      if (d) { arcPreviewPath.setAttribute('d', d); arcPreviewPath.setAttribute('display', 'block'); }
      else arcPreviewPath.setAttribute('display', 'none');
    }
  } else if (tool === 'rect' && rectPhase === 1) {
    const pts = rectPoints(rectCorner1, {x, y});
    rectPreviewEl.setAttribute('points', ptsAttr([...pts, pts[0]]));
    rectPreviewEl.setAttribute('display', 'block');
  } else if (tool === 'circle' && circlePhase === 1) {
    const r = Math.hypot(x - circleOrigin.x, y - circleOrigin.y);
    circlePreviewEl.setAttribute('cx', circleOrigin.x);
    circlePreviewEl.setAttribute('cy', circleOrigin.y);
    circlePreviewEl.setAttribute('r', Math.max(1, r));
    circlePreviewEl.setAttribute('display', 'block');
  }

  snapRing.setAttribute('cx', snapX); snapRing.setAttribute('cy', snapY);
  snapRing.setAttribute('display', 'block');
});

svg.addEventListener('mouseleave', () => {
  if (isPanning || dragState) return;
  if (pasteMode) { layerPaste.innerHTML = ''; }
  snapRing.setAttribute('display', 'none');
  previewLine.setAttribute('display', 'none');
  if (tool === 'arc') {
    arcPreviewPath.setAttribute('display', 'none');
  }
  if (tool === 'rect') rectPreviewEl.setAttribute('display', 'none');
  if (tool === 'circle') circlePreviewEl.setAttribute('display', 'none');
  statusPos.textContent = '';
});

// Draw-tool click
svg.addEventListener('click', e => {
  if (isPanning || pannedThisDrag || spaceDown) return;
  if (pasteMode) {
    const {x, y} = worldCoords(e.clientX, e.clientY);
    commitPaste({x, y});
    if (e.ctrlKey) {
      // Stay in paste mode for another placement
      pasteMode = false; // brief reset so enterPasteMode works clean
      enterPasteMode();
    } else {
      cancelPasteMode();
    }
    return;
  }
  if (effectiveTool() === 'select') return;
  const { x, y } = worldCoords(e.clientX, e.clientY);

  if (tool === 'line') {
    if (atStart(x, y)) { commitShape(true); return; }
    drawPoints.push({x, y});
    if (drawPoints.length === 1) {
      startDot.setAttribute('cx', x); startDot.setAttribute('cy', y);
      startDot.setAttribute('display', 'block');
    } else {
      committedPoly.setAttribute('points', ptsAttr(drawPoints));
      committedPoly.setAttribute('display', 'block');
    }
  } else if (tool === 'arc') {
    if (arcPhase === 0) {
      arcP1 = {x, y}; arcPhase = 1;
      startDot.setAttribute('cx', x); startDot.setAttribute('cy', y);
      startDot.setAttribute('display', 'block');
    } else if (arcPhase === 1) {
      if (x === arcP1.x && y === arcP1.y) return;
      const pm = defaultArcMidpoint(arcP1, {x, y});
      const d = threePointArcPath(arcP1, pm, {x, y});
      if (!d) return;
      pushUndo();
      const _arcId = nextId++;
      shapes.push({
        id: _arcId, svgId: 'arc' + _arcId, type: 'arc', p1: arcP1, pm, p2: {x, y},
        stroke: strokeColor, fill: fillColor, strokeWidth
      });
      selectedIds.clear(); selectedIds.add(_arcId);
      save(); render(); cancelDraw();
    }
  } else if (tool === 'rect') {
    if (rectPhase === 0) {
      rectCorner1 = {x, y}; rectPhase = 1;
      startDot.setAttribute('cx', x); startDot.setAttribute('cy', y);
      startDot.setAttribute('display', 'block');
    } else if (rectPhase === 1) {
      if (x === rectCorner1.x || y === rectCorner1.y) return;
      pushUndo();
      const _rectId = nextId++;
      shapes.push({
        id: _rectId, svgId: 'rect' + _rectId, points: rectPoints(rectCorner1, {x, y}), closed: true,
        stroke: strokeColor, fill: fillColor, strokeWidth
      });
      selectedIds.clear(); selectedIds.add(_rectId);
      save(); render(); cancelDraw();
    }
  } else if (tool === 'circle') {
    if (circlePhase === 0) {
      circleOrigin = {x, y}; circlePhase = 1;
      startDot.setAttribute('cx', x); startDot.setAttribute('cy', y);
      startDot.setAttribute('display', 'block');
    } else if (circlePhase === 1) {
      const r = Math.hypot(x - circleOrigin.x, y - circleOrigin.y);
      if (r < 1) return;
      pushUndo();
      const _cirId = nextId++;
      shapes.push({
        id: _cirId, svgId: 'circle' + _cirId, type: 'circle', cx: circleOrigin.x, cy: circleOrigin.y, r,
        stroke: strokeColor, fill: fillColor, strokeWidth
      });
      selectedIds.clear(); selectedIds.add(_cirId);
      save(); render(); cancelDraw();
    }
  }
});

// Right-click: finish draw OR show context menu
svg.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (pasteMode) { cancelPasteMode(); return; }
  if (effectiveTool() === 'line') { commitShape(false); return; }
  if (effectiveTool() === 'arc' || effectiveTool() === 'rect' || effectiveTool() === 'circle') { cancelDraw(); return; }

  if (hoveredShapeId !== null) {
    ctxTargetId = hoveredShapeId; ctxTargetGroupId = null;
    if (!selectedIds.has(hoveredShapeId)) {
      selectedIds.clear();
      selectedIds.add(hoveredShapeId);
      renderSelection();
    }
    showCtxMenu(e.clientX, e.clientY);
  } else {
    hideCtxMenu();
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────
function showCtxMenu(x, y) {
  ctxMenu.style.display = 'block';
  // Position: keep on screen
  const mw = ctxMenu.offsetWidth  || 172;
  const mh = ctxMenu.offsetHeight || 200;
  ctxMenu.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
}
function hideCtxMenu() { ctxMenu.style.display = 'none'; ctxTargetId = null; ctxTargetGroupId = null; }

ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'copy')   { copySelected(); hideCtxMenu(); return; }
  if (action === 'cut')    { cutSelected();  hideCtxMenu(); return; }
  if (action === 'paste')  { hideCtxMenu(); paste(); return; }
  if (action === 'rename') {
    const key = ctxTargetGroupId !== null ? 'g' + ctxTargetGroupId : ctxTargetId !== null ? 's' + ctxTargetId : null;
    hideCtxMenu();
    if (key) openObjectModal(key);
    return;
  }

  if (ctxTargetId === null) return;
  pushUndo();
  if (action === 'delete') {
    shapes = shapes.filter(s => !selectedIds.has(s.id));
    selectedIds.clear();
  } else {
    const idx = shapes.findIndex(s => s.id === ctxTargetId);
    if (idx !== -1) {
      switch (action) {
        case 'to-front':  shapes.push(shapes.splice(idx, 1)[0]); break;
        case 'forward':   if (idx < shapes.length - 1) [shapes[idx], shapes[idx+1]] = [shapes[idx+1], shapes[idx]]; break;
        case 'backward':  if (idx > 0)                 [shapes[idx], shapes[idx-1]] = [shapes[idx-1], shapes[idx]]; break;
        case 'to-back':   shapes.unshift(shapes.splice(idx, 1)[0]); break;
      }
    }
  }
  save(); render(); hideCtxMenu();
});

// Close context menu when clicking outside
document.addEventListener('mousedown', e => {
  if (!ctxMenu.contains(e.target)) hideCtxMenu();
});

// ── Tool switching ────────────────────────────────────────────────────────────
function setTool(t) {
  tool = t;
  cancelDraw();
  cancelPasteMode();
  if (t !== 'select') {
    selectedIds.clear();
    renderSelection();
  }
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tool-${t}`)?.classList.add('active');
  statusTool.textContent = {line:'Linje', arc:'Båge', rect:'Fyrkant', circle:'Cirkel', select:'Välj'}[t] || t;
  setCursor();
  render();
}

document.getElementById('tool-line').addEventListener('click',   () => setTool('line'));
document.getElementById('tool-arc').addEventListener('click',    () => setTool('arc'));
document.getElementById('tool-rect').addEventListener('click',   () => setTool('rect'));
document.getElementById('tool-circle').addEventListener('click', () => setTool('circle'));
document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
document.getElementById('btn-group').addEventListener('click', groupOrUngroup);

// ── Undo / Redo ───────────────────────────────────────────────────────────────
function pushUndo() {
  undoStack.push(JSON.stringify({ shapes, nextId }));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify({ shapes, nextId }));
  if (redoStack.length > 100) redoStack.shift();
  const s = JSON.parse(undoStack.pop());
  shapes = s.shapes; nextId = s.nextId;
  selectedIds.clear();
  save(); render();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify({ shapes, nextId }));
  if (undoStack.length > 100) undoStack.shift();
  const s = JSON.parse(redoStack.pop());
  shapes = s.shapes; nextId = s.nextId;
  selectedIds.clear();
  save(); render();
}

// ── Copy / Paste ──────────────────────────────────────────────────────────────
function copySelected() {
  if (!selectedIds.size) return;
  clipboard = shapes
    .filter(s => selectedIds.has(s.id))
    .map(s => JSON.parse(JSON.stringify(s)));
  pasteOffset = 0;
}

function paste() { enterPasteMode(); }

function cutSelected() {
  if (!selectedIds.size) return;
  copySelected();
  pushUndo();
  shapes = shapes.filter(s => !selectedIds.has(s.id));
  selectedIds.clear();
  save(); render();
}

// ── Download ──────────────────────────────────────────────────────────────────
function exportSVGWithAnim() {
  const svg = exportSVG();
  const hasAnim = animDeclEditor.value.trim() || animLoopEditor.value.trim();
  if (!hasAnim) return svg;
  const js = buildAnimJS();
  return svg.replace('</svg>', `  <script type="text/javascript"><![CDATA[\n${js}\n  ]]></script>\n</svg>`);
}

document.getElementById('btn-download').addEventListener('click', () => {
  const blob = new Blob([exportSVGWithAnim()], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'drawing.svg' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});

// ── Toggle panels ─────────────────────────────────────────────────────────────
document.getElementById('btn-toggle-layers').addEventListener('click', () => {
  const panel = document.getElementById('layers-panel');
  panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-layers').classList.toggle('active', !panel.classList.contains('hidden'));
});

document.getElementById('btn-toggle-code').addEventListener('click', () => {
  const panel = document.getElementById('code-panel');
  panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-code').classList.toggle('active', !panel.classList.contains('hidden'));
});

let _savedPreviewHeight = 0;
document.getElementById('btn-toggle-preview').addEventListener('click', () => {
  const btn = document.getElementById('btn-toggle-preview');
  if (previewPanel.offsetHeight > 0) {
    _savedPreviewHeight = previewPanel.offsetHeight;
    previewPanel.style.height = '0px';
    btn.classList.remove('active');
  } else {
    previewPanel.style.height = (_savedPreviewHeight || GRID * 10) + 'px';
    btn.classList.add('active');
    schedulePreviewUpdate();
  }
});

// ── Öppna modal ───────────────────────────────────────────────────────────────
const openModal = document.getElementById('open-modal');
document.getElementById('btn-open').addEventListener('click', () => { openModal.style.display = 'flex'; });
document.getElementById('open-modal-close').addEventListener('click', () => { openModal.style.display = 'none'; });
openModal.addEventListener('mousedown', e => { if (e.target === openModal) openModal.style.display = 'none'; });
document.getElementById('btn-example-1').addEventListener('click', () => { openModal.style.display = 'none'; loadExample1(); });

// ── Börja om ──────────────────────────────────────────────────────────────────
const confirmModal = document.getElementById('confirm-modal');
document.getElementById('btn-clear').addEventListener('click', () => { confirmModal.style.display = 'flex'; });
document.getElementById('confirm-modal-cancel').addEventListener('click', () => { confirmModal.style.display = 'none'; });
confirmModal.addEventListener('mousedown', e => { if (e.target === confirmModal) confirmModal.style.display = 'none'; });
document.getElementById('confirm-modal-ok').addEventListener('click', () => {
  confirmModal.style.display = 'none';
  pushUndo();
  shapes = []; selectedIds.clear();
  animDeclEditor.value = '';
  animLoopEditor.value = '';
  saveAnimCode();
  cancelDraw(); save(); render();
});

// ── SVG export ────────────────────────────────────────────────────────────────
function exportSVG() {
  if (!shapes.length) return `<svg xmlns="http://www.w3.org/2000/svg"/>`;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function ex(x, y) {
    minX = Math.min(minX,x); minY = Math.min(minY,y);
    maxX = Math.max(maxX,x); maxY = Math.max(maxY,y);
  }
  const visibleShapes = shapes.filter(s => !s.hidden && !(s.groupId && hiddenGroupIds.has(s.groupId)));
  for (const s of visibleShapes) {
    const t = s.type || 'line';
    if (t === 'arc') {
      ex(s.p1.x,s.p1.y); ex(s.pm.x,s.pm.y); ex(s.p2.x,s.p2.y);
    } else if (t === 'circle') {
      ex(s.cx-s.r,s.cy-s.r); ex(s.cx+s.r,s.cy+s.r);
    } else {
      for (const {x,y} of s.points) ex(x,y);
    }
  }
  if (!visibleShapes.length) return `<svg xmlns="http://www.w3.org/2000/svg"/>`;
  minX -= GRID; minY -= GRID; maxX += GRID; maxY += GRID;
  const w = maxX - minX, h = maxY - minY;

  function shapeToSVG(s, indent) {
    const t = s.type || 'line';
    const stroke = s.stroke||'#000000', fill = s.fill||'none', sw = s.strokeWidth||2;
    const common = `stroke="${stroke}" fill="${fill}" stroke-width="${sw}"`;
    const sid = s.svgId ? s.svgId.trim() : null;
    const idAttr = sid ? ` id="${sid}"` : '';
    const extra = s.attrs ? ' ' + Object.entries(s.attrs).map(([k,v]) => `${k}="${v}"`).join(' ') : '';
    let dashStr = '';
    if (s.dashType === 'dashed') dashStr = ` stroke-dasharray="${+(sw*3).toFixed(2)} ${+(sw*2).toFixed(2)}"`;
    else if (s.dashType === 'dotted') dashStr = ` stroke-dasharray="0.01 ${+(sw*2.5).toFixed(2)}" stroke-linecap="round"`;
    if (t === 'arc') {
      const d = threePointArcPath({x:s.p1.x-minX,y:s.p1.y-minY},{x:s.pm.x-minX,y:s.pm.y-minY},{x:s.p2.x-minX,y:s.p2.y-minY});
      return d ? `${indent}<path${idAttr} d="${d}" ${common} stroke-linecap="round" data-arc-pm="${+(s.pm.x-minX).toFixed(2)},${+(s.pm.y-minY).toFixed(2)}"${dashStr}${extra}/>` : null;
    } else if (t === 'circle') {
      return `${indent}<circle${idAttr} cx="${s.cx-minX}" cy="${s.cy-minY}" r="${s.r}" ${common}${dashStr}${extra}/>`;
    } else {
      const tag = s.closed ? 'polygon' : 'polyline';
      const pts = s.points.map(p=>`${p.x-minX},${p.y-minY}`).join(' ');
      return `${indent}<${tag}${idAttr} points="${pts}" ${common} stroke-linecap="round" stroke-linejoin="round"${dashStr}${extra}/>`;
    }
  }

  const lines = [];
  const seenGroups = new Set();
  for (const s of visibleShapes) {
    if (s.groupId) {
      if (seenGroups.has(s.groupId)) continue;
      seenGroups.add(s.groupId);
      const members = visibleShapes.filter(vs => vs.groupId === s.groupId);
      const gId = groupSvgIds.get(s.groupId);
      lines.push(`  <g${gId ? ` id="${gId}"` : ''}>`);
      members.forEach(m => { const l = shapeToSVG(m, '    '); if (l) lines.push(l); });
      lines.push('  </g>');
    } else {
      const l = shapeToSVG(s, '  ');
      if (l) lines.push(l);
    }
  }
  for (const gid of emptyGroupIds) {
    if (!seenGroups.has(gid)) {
      const gId = groupSvgIds.get(gid);
      lines.push(`  <g${gId ? ` id="${gId}"` : ''}></g>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg"\n` +
         `     width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
         lines.join('\n') + '\n</svg>';
}

// ── Code panel ────────────────────────────────────────────────────────────────
function highlightXML(code) {
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  let out = '', i = 0, n = code.length;
  while (i < n) {
    if (code[i] !== '<') {
      let j = i; while (j < n && code[j] !== '<') j++;
      out += esc(code.slice(i, j)); i = j; continue;
    }
    i++; // skip <
    const sl = (i < n && code[i] === '/') ? (i++, '/') : '';
    let j = i; while (j < n && !/[\s\/>]/.test(code[j])) j++;
    out += `<span class="xp">&lt;${sl}</span>`;
    if (j > i) out += `<span class="xt">${esc(code.slice(i, j))}</span>`;
    i = j;
    let done = false;
    while (i < n && !done) {
      if (/\s/.test(code[i])) { out += code[i++]; continue; }
      if (code[i] === '/' && i + 1 < n && code[i+1] === '>') {
        out += `<span class="xp">/&gt;</span>`; i += 2; done = true;
      } else if (code[i] === '>') {
        out += `<span class="xp">&gt;</span>`; i++; done = true;
      } else if (/[\w:.-]/.test(code[i])) {
        let k = i; while (k < n && /[\w:.-]/.test(code[k])) k++;
        const name = code.slice(i, k); i = k;
        if (i < n && code[i] === '=') {
          i++;
          if (i < n && code[i] === '"') {
            i++;
            let m = i; while (m < n && code[m] !== '"') m++;
            out += `<span class="xa">${esc(name)}</span><span class="xp">="</span><span class="xv">${esc(code.slice(i, m))}</span><span class="xp">"</span>`;
            i = m + 1;
          } else { out += `<span class="xa">${esc(name)}</span>=`; }
        } else { out += `<span class="xa">${esc(name)}</span>`; }
      } else { out += esc(code[i++]); }
    }
  }
  return out;
}
let _codeEditTimer = null;
let _codeEditing = false;

function updateCode() {
  if (_codeEditing) return;
  codeContent.innerHTML = highlightXML(exportSVG());
  updateAnimVars();
  schedulePreviewUpdate();
}

// ── SVG text → shapes parser ──────────────────────────────────────────────────
function parseSVGText(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl || doc.querySelector('parsererror')) return false;

  const newShapes = []; let nid = 1; let ngid = 1;
  const newGroupLabels = new Map();
  const newGroupSvgIds = new Map();

  function common(el) {
    const r = { stroke: el.getAttribute('stroke') || '#000000',
                fill:   el.getAttribute('fill')   || 'none',
                strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 2 };
    const svgId = el.getAttribute('id');
    if (svgId) r.svgId = svgId;
    return r;
  }

  function walk(els, gid) {
    for (const el of els) {
      const tag = el.tagName?.toLowerCase();
      if (!tag) continue;
      if (tag === 'g') {
        const myGid = ngid++;
        const svgId = el.getAttribute('id');
        if (svgId) newGroupSvgIds.set(myGid, svgId);
        walk(el.children, myGid);
      } else if (tag === 'polyline' || tag === 'polygon') {
        const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i+1] });
        if (pts.length >= 2) newShapes.push({ id: nid++, type: 'line', points: pts,
          closed: tag === 'polygon', ...common(el), ...(gid ? { groupId: gid } : {}) });
      } else if (tag === 'circle') {
        const cx = parseFloat(el.getAttribute('cx')) || 0;
        const cy = parseFloat(el.getAttribute('cy')) || 0;
        const r  = parseFloat(el.getAttribute('r'))  || 0;
        if (r > 0) newShapes.push({ id: nid++, type: 'circle', cx, cy, r,
          ...common(el), ...(gid ? { groupId: gid } : {}) });
      } else if (tag === 'path') {
        const d = el.getAttribute('d') || '';
        const m = d.match(/^M\s*([\d.+-]+)[,\s]+([\d.+-]+)\s+A\s+([\d.+-]+)[,\s]+[\d.+-]+\s+\d\s+\d,\d\s+([\d.+-]+)[,\s]+([\d.+-]+)/);
        if (!m) continue;
        const p1 = { x: +m[1], y: +m[2] }, p2 = { x: +m[4], y: +m[5] };
        const pmStr = el.getAttribute('data-arc-pm');
        const pm = pmStr ? { x: +pmStr.split(',')[0], y: +pmStr.split(',')[1] } : defaultArcMidpoint(p1, p2);
        newShapes.push({ id: nid++, type: 'arc', p1, pm, p2,
          ...common(el), ...(gid ? { groupId: gid } : {}) });
      }
    }
  }

  walk(svgEl.children, null);

  pushUndo();
  shapes = newShapes; nextId = nid; nextGroupId = ngid;
  groupLabels.clear(); newGroupLabels.forEach((v, k) => groupLabels.set(k, v));
  groupSvgIds.clear(); newGroupSvgIds.forEach((v, k) => groupSvgIds.set(k, v));
  emptyGroupIds.clear(); hiddenGroupIds.clear(); collapsedGroups.clear(); selectedIds.clear();
  save(); render();
  return true;
}

// ── Code editor: click pre → textarea, blur → back to highlighted pre ────────
codeView.addEventListener('click', () => {
  _codeEditing = true;
  codeEditor.value = exportSVG();
  codeEditor.classList.remove('parse-error');
  codeView.style.display = 'none';
  codeEditor.style.display = 'block';
  codeEditor.focus();
});
codeEditor.addEventListener('blur', () => {
  _codeEditing = false;
  clearTimeout(_codeEditTimer);
  codeEditor.style.display = 'none';
  codeView.style.display   = 'block';
  const ok = parseSVGText(codeEditor.value);
  if (!ok) { /* keep canvas as-is; just show current SVG */ }
  codeContent.innerHTML = highlightXML(exportSVG());
});
codeEditor.addEventListener('input', () => {
  clearTimeout(_codeEditTimer);
  _codeEditTimer = setTimeout(() => {
    const ok = parseSVGText(codeEditor.value);
    codeEditor.classList.toggle('parse-error', !ok);
  }, 800);
});
codeEditor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeEditor.selectionStart, en = codeEditor.selectionEnd;
    codeEditor.value = codeEditor.value.slice(0, s) + '  ' + codeEditor.value.slice(en);
    codeEditor.selectionStart = codeEditor.selectionEnd = s + 2;
  }
  if (e.key === 'Escape') { codeEditor.blur(); }
});

// ── Object properties modal ───────────────────────────────────────────────────
document.getElementById('obj-modal-save').addEventListener('click', saveObjectModal);
document.getElementById('obj-modal-add-attr').addEventListener('click', () => {
  addAttrRow(document.getElementById('obj-modal-attrs-list'), '', '');
});
document.getElementById('obj-modal-cancel').addEventListener('click', closeObjectModal);
document.getElementById('obj-modal').addEventListener('mousedown', e => {
  if (e.target === document.getElementById('obj-modal')) closeObjectModal();
});
document.getElementById('obj-modal-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('obj-modal-svgid').focus(); }
  if (e.key === 'Escape') closeObjectModal();
  e.stopPropagation();
});
document.getElementById('obj-modal-svgid').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); saveObjectModal(); }
  if (e.key === 'Escape') closeObjectModal();
  e.stopPropagation();
});

document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(exportSVG()).then(() => {
    const btn = document.getElementById('btn-copy');
    const orig = btn.textContent;
    btn.textContent = 'Kopierat!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
});

// ── JS Animation panel ────────────────────────────────────────────────────────
const animDeclEditor = document.getElementById('anim-decl-editor');
const animLoopEditor = document.getElementById('anim-loop-editor');
const ANIM_DECL_KEY  = 'svg-editor-anim-decl';
const ANIM_LOOP_KEY  = 'svg-editor-anim-loop';
const LOOP_FPS_KEY        = 'svg-editor-loop-fps';
const LOOP_FPS_DISABLE_KEY = 'svg-editor-loop-fps-disable';
const VARS_GROUPS_KEY      = 'svg-editor-vars-groups';
let _loopFps           = parseInt(localStorage.getItem(LOOP_FPS_KEY) || '60', 10);
let _loopUncapped      = localStorage.getItem(LOOP_FPS_DISABLE_KEY) !== 'false';
let _animIncludeGroups = localStorage.getItem(VARS_GROUPS_KEY) === 'true';

function saveAnimCode() {
  try { localStorage.setItem(ANIM_DECL_KEY, animDeclEditor.value); } catch {}
  try { localStorage.setItem(ANIM_LOOP_KEY, animLoopEditor.value); } catch {}
}

// Rename variable references in decl/loop editors when a svgId changes.
function renameInAnimCode(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  [animDeclEditor, animLoopEditor].forEach(ed => {
    const n = ed.value.replace(re, newName);
    if (n !== ed.value) ed.value = n;
  });
  saveAnimCode();
}

function updateAnimVars() {
  const list = document.getElementById('anim-vars-list');
  if (!list) return;
  const allVis = shapes.filter(s => !s.hidden && !(s.groupId && hiddenGroupIds.has(s.groupId)));
  const ordered = [];
  const seenGrp = new Set();
  for (const s of allVis) {
    if (s.groupId) {
      if (!seenGrp.has(s.groupId)) {
        seenGrp.add(s.groupId);
        if (_animIncludeGroups) {
          const gsvgId = groupSvgIds.get(s.groupId);
          if (gsvgId) ordered.push({ _groupId: s.groupId, svgId: gsvgId });
        }
        allVis.filter(v => v.groupId === s.groupId).forEach(m => ordered.push(m));
      }
    } else { ordered.push(s); }
  }
  if (_animIncludeGroups) {
    for (const gid of emptyGroupIds) {
      if (!seenGrp.has(gid) && !hiddenGroupIds.has(gid)) {
        const gsvgId = groupSvgIds.get(gid);
        if (gsvgId) ordered.push({ _groupId: gid, svgId: gsvgId });
      }
    }
  }
  list.innerHTML = '';
  for (const s of ordered) {
    if (!s.svgId) continue;
    const row = document.createElement('div');
    row.className = 'av-row';
    const kw   = document.createElement('span');  kw.className  = 'av-kw';   kw.textContent  = 'const';
    const inp  = document.createElement('input');  inp.className = 'av-name'; inp.type = 'text'; inp.value = s.svgId; inp.spellcheck = false; inp.autocomplete = 'off';
    inp.style.width = Math.max(20, s.svgId.length) + 'ch';
    const eq   = document.createElement('span');  eq.className  = 'av-rest'; eq.textContent  = ' = svg.querySelector(\'#';
    const idSp = document.createElement('span');  idSp.className = 'av-id';  idSp.textContent = s.svgId;
    const cl   = document.createElement('span');  cl.className  = 'av-rest'; cl.textContent  = '\');';
    inp.addEventListener('input', () => {
      idSp.textContent = inp.value;
      inp.style.width = Math.max(20, inp.value.length) + 'ch';
    });
    inp.addEventListener('change', () => {
      const newId = inp.value.trim();
      if (!newId || newId === s.svgId) { inp.value = s.svgId; idSp.textContent = s.svgId; return; }
      const oldId = s.svgId;
      if (s._groupId != null) { groupSvgIds.set(s._groupId, newId); s.svgId = newId; }
      else s.svgId = newId;
      inp.style.width = Math.max(20, newId.length) + 'ch';
      renameInAnimCode(oldId, newId);
      save(); render();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = s.svgId; idSp.textContent = s.svgId; inp.blur(); }
      e.stopPropagation();
    });
    row.append(kw, inp, eq, idSp, cl);
    list.appendChild(row);
  }
}

function buildAnimJS() {
  const allVis = shapes.filter(s => !s.hidden && !(s.groupId && hiddenGroupIds.has(s.groupId)));
  const ordered = [];
  const seenGrp = new Set();
  for (const s of allVis) {
    if (s.groupId) {
      if (!seenGrp.has(s.groupId)) {
        seenGrp.add(s.groupId);
        if (_animIncludeGroups) {
          const gsvgId = groupSvgIds.get(s.groupId);
          if (gsvgId) ordered.push({ svgId: gsvgId });
        }
        allVis.filter(v => v.groupId === s.groupId).forEach(m => ordered.push(m));
      }
    } else { ordered.push(s); }
  }
  if (_animIncludeGroups) {
    for (const gid of emptyGroupIds) {
      if (!seenGrp.has(gid) && !hiddenGroupIds.has(gid)) {
        const gsvgId = groupSvgIds.get(gid);
        if (gsvgId) ordered.push({ svgId: gsvgId });
      }
    }
  }
  const varLines = ordered.filter(s => s.svgId)
    .map(s => `const ${s.svgId} = svg.querySelector('#${s.svgId}');`)
    .join('\n');
  const decl = animDeclEditor.value;
  const loop = animLoopEditor.value;
  const parts = ["const svg = document.querySelector('svg');"];
  if (varLines) parts.push(varLines);
  if (decl.trim()) parts.push(decl);
  parts.push('(function loop() {');
  if (loop.trim()) parts.push(loop);
  parts.push('  requestAnimationFrame(loop);');
  parts.push('})();');
  return parts.join('\n');
}

const EXAMPLE_1_DECL =
`const cx = parseFloat(orbit.getAttribute('cx'));
const cy = parseFloat(orbit.getAttribute('cy'));
const r  = parseFloat(orbit.getAttribute('r'));
let angle = 0;`;

const EXAMPLE_1_LOOP =
`  angle += 0.025;
  planet.setAttribute('cx', (cx + Math.cos(angle) * r).toFixed(1));
  planet.setAttribute('cy', (cy + Math.sin(angle) * r).toFixed(1));`;

function loadExample1() {
  pushUndo();
  shapes = [
    { id: 1, type: 'circle', cx: 0, cy: 0, r: GRID * 3,
      stroke: '#888888', fill: 'none', strokeWidth: 1.5, svgId: 'orbit', label: 'Orbit', groupId: 1 },
    { id: 2, type: 'circle', cx: GRID * 3, cy: 0, r: GRID / 2,
      stroke: '#1a6ef5', fill: '#c8dff5', strokeWidth: 2, svgId: 'planet', label: 'Planet', groupId: 1 },
  ];
  nextId = 3; nextGroupId = 2;
  groupLabels.clear(); groupSvgIds.clear(); emptyGroupIds.clear();
  groupSvgIds.set(1, 'group1');
  hiddenGroupIds.clear(); collapsedGroups.clear(); selectedIds.clear();
  const rect = container.getBoundingClientRect();
  panX = Math.round(rect.width  / 2 / GRID) * GRID;
  panY = Math.round(rect.height / 2 / GRID) * GRID;
  applyPan();
  try { localStorage.setItem(PAN_KEY, JSON.stringify({ panX, panY })); } catch {}
  save(); render();
  animDeclEditor.value = EXAMPLE_1_DECL;
  animLoopEditor.value = EXAMPLE_1_LOOP;
  saveAnimCode();
  schedulePreviewUpdate();
}

// Horizontal resizer between SVG code and JS animation
(function() {
  const handle = document.getElementById('anim-resizer');
  const wrap   = document.getElementById('svg-code-wrap');
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY, startH = wrap.offsetHeight;
    function onMove(ev) {
      const h = Math.max(GRID * 2, Math.round((startH + ev.clientY - startY) / GRID) * GRID);
      wrap.style.height = h + 'px';
    }
    function onUp(ev) {
      onMove(ev);
      try {
        const d = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
        d['anim-split'] = wrap.offsetHeight;
        localStorage.setItem(PANEL_KEY, JSON.stringify(d));
      } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
})();

// ── Preview panel ─────────────────────────────────────────────────────────────
const previewPanel  = document.getElementById('preview-panel');
const previewIframe = document.getElementById('preview-iframe');

function buildPreviewHTML() {
  const pauseScript = `var _rh=null,_lf=null,_fps=${_loopUncapped ? 9999 : _loopFps},_lt=-Infinity;var _raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){_lf=cb;_rh=_raf(function tick(t){if(t-_lt>=1000/_fps){_lt=t;cb(t);}else _rh=_raf(tick);});return _rh;};window.addEventListener('message',function(e){if(e.data==='preview-pause'){cancelAnimationFrame(_rh);_rh=null;}else if(e.data==='preview-resume'&&_lf)_lf(performance.now());else if(e.data&&e.data.fps)_fps=e.data.fps;});`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body{margin:0;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh}
  svg{max-width:90vw;max-height:90vh}
</style></head>
<body>
${exportSVG()}
<script>
${pauseScript}
${buildAnimJS()}
<\/script>
</body></html>`;
}

let _previewTimer = null;
let _previewPaused = false;
function schedulePreviewUpdate() {
  if (previewPanel.offsetHeight === 0) return;
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(() => {
    if (previewPanel.offsetHeight > 0) {
      previewIframe.srcdoc = buildPreviewHTML();
      _previewPaused = false;
      btnPreviewPause.textContent = '⏸ Pausa';
    }
  }, 300);
}

const btnPreviewPause = document.getElementById('btn-preview-pause');
btnPreviewPause.addEventListener('click', () => {
  if (!_previewPaused) {
    previewIframe.contentWindow.postMessage('preview-pause', '*');
    _previewPaused = true;
    btnPreviewPause.textContent = '▶ Fortsätt';
  } else {
    previewIframe.contentWindow.postMessage('preview-resume', '*');
    _previewPaused = false;
    btnPreviewPause.textContent = '⏸ Pausa';
  }
});

// Loop FPS settings
const loopSettings      = document.getElementById('loop-settings');
const loopFpsInput      = document.getElementById('loop-fps');
const loopFpsDisable    = document.getElementById('loop-fps-disable');
loopFpsInput.value      = _loopFps;
loopFpsDisable.checked  = _loopUncapped;
loopFpsInput.disabled   = _loopUncapped;
const btnLoopSettings = document.getElementById('btn-loop-settings');
btnLoopSettings.addEventListener('click', e => {
  e.stopPropagation();
  const open = loopSettings.style.display !== 'block';
  loopSettings.style.display = open ? 'block' : 'none';
  btnLoopSettings.textContent = open ? 'Dölj inställningar' : 'Visa inställningar';
  btnLoopSettings.classList.toggle('active', open);
});
btnLoopSettings.addEventListener('mousedown', e => e.stopPropagation());
loopFpsInput.addEventListener('change', () => {
  const fps = Math.max(1, Math.min(120, parseInt(loopFpsInput.value, 10) || 60));
  loopFpsInput.value = fps;
  _loopFps = fps;
  try { localStorage.setItem(LOOP_FPS_KEY, fps); } catch {}
  if (!_loopUncapped) try { previewIframe.contentWindow.postMessage({ fps }, '*'); } catch {}
});
loopFpsDisable.addEventListener('change', () => {
  _loopUncapped = loopFpsDisable.checked;
  loopFpsInput.disabled = _loopUncapped;
  try { localStorage.setItem(LOOP_FPS_DISABLE_KEY, _loopUncapped); } catch {}
  const fps = _loopUncapped ? 9999 : _loopFps;
  try { previewIframe.contentWindow.postMessage({ fps }, '*'); } catch {}
});

// Vars settings (include groups toggle)
const varsSettings = document.getElementById('vars-settings');
const varsIncludeGroups = document.getElementById('vars-include-groups');
varsIncludeGroups.checked = _animIncludeGroups;
const btnVarsSettings = document.getElementById('btn-vars-settings');
btnVarsSettings.addEventListener('click', e => {
  e.stopPropagation();
  const open = varsSettings.style.display !== 'block';
  varsSettings.style.display = open ? 'block' : 'none';
  btnVarsSettings.textContent = open ? 'Dölj inställningar' : 'Visa inställningar';
  btnVarsSettings.classList.toggle('active', open);
});
btnVarsSettings.addEventListener('mousedown', e => e.stopPropagation());
varsIncludeGroups.addEventListener('change', () => {
  _animIncludeGroups = varsIncludeGroups.checked;
  try { localStorage.setItem(VARS_GROUPS_KEY, _animIncludeGroups); } catch {}
  updateAnimVars();
  schedulePreviewUpdate();
});

// Preview panel h-resizer
(function() {
  const handle = document.getElementById('preview-resizer');
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY, startH = previewPanel.offsetHeight;
    function onMove(ev) {
      const h = Math.max(0, Math.round((startH - (ev.clientY - startY)) / GRID) * GRID);
      previewPanel.style.height = h + 'px';
    }
    function onUp(ev) {
      onMove(ev);
      try { const d = JSON.parse(localStorage.getItem(PANEL_KEY)||'{}'); d['preview-panel'] = previewPanel.offsetHeight; localStorage.setItem(PANEL_KEY, JSON.stringify(d)); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
})();

[animDeclEditor, animLoopEditor].forEach(ed => {
  ed.addEventListener('input', () => { saveAnimCode(); schedulePreviewUpdate(); });
  ed.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      const s = ed.selectionStart;
      ed.value = ed.value.slice(0, s) + '  ' + ed.value.slice(ed.selectionEnd);
      ed.selectionStart = ed.selectionEnd = s + 2;
    }
  });
});

const _animPreviewModal = document.getElementById('anim-preview-modal');
document.getElementById('btn-anim-preview').addEventListener('click', () => {
  document.getElementById('anim-preview-code').textContent = buildAnimJS();
  _animPreviewModal.style.display = 'flex';
});
document.getElementById('btn-anim-preview-close').addEventListener('click', () => {
  _animPreviewModal.style.display = 'none';
});
_animPreviewModal.addEventListener('mousedown', e => {
  if (e.target === _animPreviewModal) _animPreviewModal.style.display = 'none';
});
// Collapsible / drag-to-resize anim sections
// Each draggable header acts as a splitter: dragging it resizes the section ABOVE it.
(function() {
  const ANIM_SEC_KEY = 'svg-editor-anim-sec';
  function loadSec() { try { return JSON.parse(localStorage.getItem(ANIM_SEC_KEY) || '{}'); } catch { return {}; } }
  function saveSec(s) { try { localStorage.setItem(ANIM_SEC_KEY, JSON.stringify(s)); } catch {} }

  // resizeBodyId: the body whose height is adjusted when this header is dragged
  const defs = [
    { id: 'anim-sec-vars', bodyId: 'anim-vars-body', defaultH: 96,  draggable: false, resizeBodyId: null              },
    { id: 'anim-sec-decl', bodyId: 'anim-decl-body', defaultH: 80,  draggable: true,  resizeBodyId: 'anim-vars-body'  },
    { id: 'anim-sec-loop', bodyId: 'anim-loop-body', defaultH: null, draggable: true,  resizeBodyId: 'anim-decl-body'  },
  ];

  const saved = loadSec();
  for (const { bodyId, defaultH } of defs) {
    if (!defaultH) continue;
    const h = saved[bodyId + '-h'] || defaultH;
    document.getElementById(bodyId).style.height = h + 'px';
  }

  for (const { id, draggable, resizeBodyId } of defs) {
    const sec   = document.getElementById(id);
    const label = sec.querySelector('.anim-section-label');
    if (saved[id + '-c']) sec.classList.add('collapsed');
    if (draggable) label.style.cursor = 'row-resize';

    label.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const resizeBody = resizeBodyId ? document.getElementById(resizeBodyId) : null;
      const startY = e.clientY, startH = resizeBody ? resizeBody.offsetHeight : 0;
      let dragged = false;

      function onMove(ev) {
        if (!dragged && Math.abs(ev.clientY - startY) > 4) dragged = true;
        if (dragged && draggable && resizeBody) {
          const h = Math.max(GRID, Math.round((startH + ev.clientY - startY) / GRID) * GRID);
          resizeBody.style.height = h + 'px';
        }
      }
      function onUp(ev) {
        onMove(ev);
        const st = loadSec();
        if (dragged && draggable && resizeBody) {
          st[resizeBodyId + '-h'] = resizeBody.offsetHeight;
        } else if (!dragged) {
          sec.classList.toggle('collapsed');
          st[id + '-c'] = sec.classList.contains('collapsed') ? 1 : 0;
          if (sec.classList.contains('collapsed')) {
            const sp = sec.querySelector('#vars-settings, #loop-settings');
            if (sp && sp.style.display === 'block') {
              sp.style.display = 'none';
              const btn = sp.previousElementSibling?.querySelector('.anim-sec-settings-btn');
              if (btn) { btn.textContent = 'Visa inställningar'; btn.classList.remove('active'); }
            }
          }
        }
        saveSec(st);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }
})();

// ── Color / fill controls ─────────────────────────────────────────────────────
const swatchStroke     = document.getElementById('swatch-stroke');
const swatchFill       = document.getElementById('swatch-fill');
const strokeWidthInput = document.getElementById('stroke-width');

function setSwatchColor(el, color) {
  const none = !color || color === 'none';
  el.classList.toggle('swatch-none', none);
  el.style.background = none ? '' : color;
}
setSwatchColor(swatchFill, fillColor);

// Sync UI to show the first selected shape's properties
function syncUIToSelection() {
  if (selectedIds.size === 0) return;
  const first = shapes.find(s => selectedIds.has(s.id));
  if (!first) return;
  strokeColor = first.stroke || '#000000';
  setSwatchColor(swatchStroke, strokeColor);
  strokeWidth = first.strokeWidth || 2;
  strokeWidthInput.value = strokeWidth;
  fillColor = first.fill || 'none';
  setSwatchColor(swatchFill, fillColor);
  const dt = first.dashType || 'solid';
  document.querySelectorAll('.dash-btn').forEach(b => b.classList.toggle('active', b.dataset.dash === dt));
}

document.querySelectorAll('.dash-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const dash = btn.dataset.dash;
    document.querySelectorAll('.dash-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (selectedIds.size > 0) {
      pushUndo();
      shapes.forEach(s => { if (selectedIds.has(s.id)) { if (dash === 'solid') delete s.dashType; else s.dashType = dash; } });
      save(); render();
    } else {
      // Sets default for next drawn shape (stored in a variable picked up at commit time)
    }
  });
});

let strokeWidthUndone = false;
strokeWidthInput.addEventListener('focus', () => { strokeWidthUndone = false; });
strokeWidthInput.addEventListener('input', e => {
  strokeWidth = parseFloat(e.target.value) || 2;
  if (selectedIds.size > 0) {
    if (!strokeWidthUndone) { pushUndo(); strokeWidthUndone = true; }
    shapes.filter(s => selectedIds.has(s.id)).forEach(s => { s.strokeWidth = strokeWidth; });
    save(); render();
  }
});

// ── Color palette ─────────────────────────────────────────────────────────────
const GRAYS = ['#000000','#1c1c1c','#383838','#555555','#717171','#8e8e8e','#aaaaaa','#c6c6c6','#e2e2e2','#ffffff'];
const PASTELS = [
  '#ffe8e8','#ffbfbf','#ff9999','#ff6b6b','#e03131',  '#ffe8f5','#ffbfd9','#ff80c0','#f06595','#c2255c',
  '#fff3e0','#ffe4b3','#ffcc80','#ffa94d','#e8590c',  '#fffde0','#fff9b3','#ffec99','#ffd43b','#f08c00',
  '#ebfbee','#c3fae8','#96f2d7','#63e6be','#099268',  '#f4fce3','#d8f5a2','#b2f2bb','#69db7c','#2f9e44',
  '#e7f5ff','#c5f6fa','#a5d8ff','#74c0fc','#1c7ed6',  '#e3fafc','#99e9f2','#66d9e8','#22b8cf','#0c8599',
  '#f3f0ff','#e5dbff','#d0bfff','#b197fc','#7048e8',  '#fff0f6','#fcc2d7','#faa2c1','#f783ac','#a61e4d',
];
const RECENT_KEY = 'svg-editor-recent-colors';
const MAX_RECENT = 10;

let recentColors = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
let cpTarget = 'stroke';

const palettePop    = document.getElementById('color-palette');
const cpGraysEl     = document.getElementById('cp-grays');
const cpPastelsEl   = document.getElementById('cp-pastels');
const cpRecentEl    = document.getElementById('cp-recent');
const cpRecentLabel = document.getElementById('cp-recent-label');
const cpNative      = document.getElementById('cp-native');
const cpHex         = document.getElementById('cp-hex');
const cpHexOk       = document.getElementById('cp-hex-ok');

function buildSwatchEl(color, currentColor) {
  const el = document.createElement('div');
  el.className = 'cp-swatch' + (color === currentColor ? ' selected' : '');
  el.style.background = color;
  el.title = color;
  el.addEventListener('click', () => applyPaletteColor(color));
  return el;
}

function buildRecentUI(currentColor) {
  cpRecentEl.innerHTML = '';
  cpRecentLabel.style.display = recentColors.length ? '' : 'none';
  recentColors.forEach(c => cpRecentEl.append(buildSwatchEl(c, currentColor)));
}

function buildNoneSwatch(currentColor) {
  const el = document.createElement('div');
  el.className = 'cp-swatch cp-swatch-none' + (currentColor === 'none' ? ' selected' : '');
  el.title = 'Ingen färg';
  el.addEventListener('click', () => applyPaletteColor('none'));
  return el;
}

function buildPaletteUI(currentColor) {
  document.getElementById('cp-none').innerHTML = '';
  document.getElementById('cp-none').append(buildNoneSwatch(currentColor));
  cpGraysEl.innerHTML = '';
  GRAYS.forEach(c => cpGraysEl.append(buildSwatchEl(c, currentColor)));
  cpPastelsEl.innerHTML = '';
  PASTELS.forEach(c => cpPastelsEl.append(buildSwatchEl(c, currentColor)));
  buildRecentUI(currentColor);
  cpHex.value = currentColor === 'none' ? '' : currentColor;
  cpNative.value = /^#[0-9a-fA-F]{6}$/.test(currentColor) ? currentColor : '#000000';
}

function showPalette(triggerEl, type) {
  cpTarget = type;
  const current = type === 'stroke' ? strokeColor : fillColor;
  buildPaletteUI(current);
  const rect = triggerEl.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 4;
  if (left + 234 > window.innerWidth - 8) left = window.innerWidth - 242;
  if (left < 8) left = 8;
  palettePop.style.left = left + 'px';
  palettePop.style.top  = top  + 'px';
  palettePop.style.display = 'block';
}

function hidePalette() { palettePop.style.display = 'none'; }

function addRecent(color) {
  recentColors = recentColors.filter(c => c !== color);
  recentColors.unshift(color);
  if (recentColors.length > MAX_RECENT) recentColors.pop();
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors));
}

function applyPaletteColor(color) {
  if (color !== 'none') addRecent(color);
  if (cpTarget === 'stroke') {
    strokeColor = color;
    setSwatchColor(swatchStroke, color);
    if (selectedIds.size > 0) {
      pushUndo();
      shapes.filter(s => selectedIds.has(s.id)).forEach(s => { s.stroke = color; });
      save(); render();
    }
  } else {
    fillColor = color;
    setSwatchColor(swatchFill, color);
    if (selectedIds.size > 0) {
      pushUndo();
      shapes.filter(s => selectedIds.has(s.id)).forEach(s => { s.fill = color; });
      save(); render();
    }
  }
  hidePalette();
}

swatchStroke.closest('.color-prop').addEventListener('click', e => { e.stopPropagation(); showPalette(swatchStroke, 'stroke'); });
swatchFill.closest('.color-prop').addEventListener('click',   e => { e.stopPropagation(); showPalette(swatchFill,   'fill');   });

cpNative.addEventListener('change', e => { applyPaletteColor(e.target.value); });

function applyHex() {
  const v = cpHex.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) applyPaletteColor(v);
}
cpHexOk.addEventListener('click', applyHex);
cpHex.addEventListener('keydown', e => { if (e.key === 'Enter') { applyHex(); e.preventDefault(); } });
cpHex.addEventListener('input',   e => {
  if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) cpNative.value = e.target.value;
});

document.addEventListener('click', e => {
  if (palettePop.style.display === 'block' &&
      !palettePop.contains(e.target) &&
      e.target !== swatchStroke && e.target !== swatchFill) {
    hidePalette();
  }
});

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  btnTheme.textContent = dark ? '☀ Tema: ljus' : '☾ Tema: mörk';
  btnTheme.title = dark ? 'Byt till ljust tema' : 'Byt till mörkt tema';
  codeView.style.cursor = 'default';
  setCursor();
}
btnTheme.addEventListener('click', () => {
  const dark = !document.documentElement.classList.contains('dark');
  applyTheme(dark);
  localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
});

// ── LocalStorage ──────────────────────────────────────────────────────────────
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({
    shapes, nextId, nextGroupId,
    hiddenGroupIds: [...hiddenGroupIds],
    emptyGroupIds:  [...emptyGroupIds],
    groupLabels:    Object.fromEntries(groupLabels),
    groupSvgIds:    Object.fromEntries(groupSvgIds),
  })); } catch {}
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (d) {
      shapes = d.shapes || []; nextId = d.nextId || 1;
      nextGroupId = d.nextGroupId || 1;
      shapes.forEach(s => { if (s.groupId && s.groupId >= nextGroupId) nextGroupId = s.groupId + 1; });
      hiddenGroupIds.clear(); (d.hiddenGroupIds || []).forEach(id => hiddenGroupIds.add(id));
      emptyGroupIds.clear();  (d.emptyGroupIds  || []).forEach(id => emptyGroupIds.add(id));
      groupLabels.clear();
      Object.entries(d.groupLabels || {}).forEach(([k, v]) => groupLabels.set(Number(k), v));
      groupSvgIds.clear();
      Object.entries(d.groupSvgIds || {}).forEach(([k, v]) => groupSvgIds.set(Number(k), v));
    }
  } catch {}
  try {
    const p = JSON.parse(localStorage.getItem(PAN_KEY) || 'null');
    if (p) { panX = p.panX || 0; panY = p.panY || 0; }
  } catch {}
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Control' && !ctrlDown) {
    ctrlDown = true;
    if (!pasteMode) { cancelDraw(); render(); }
    setCursor();
    return;
  }
  if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; if (!isPanning) setCursor(); }
    return;
  }
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && e.key === 'c') { e.preventDefault(); copySelected(); return; }
  if (e.ctrlKey && e.key === 'x') { e.preventDefault(); cutSelected();  return; }
  if (e.ctrlKey && e.key === 'v') { e.preventDefault(); paste(); return; }
  if (e.ctrlKey && e.key === 'g') { e.preventDefault(); groupOrUngroup(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (e.key) {
    case 'l': case 'L': setTool('line');   break;
    case 'b': case 'B': setTool('arc');    break;
    case 'r': case 'R': setTool('rect');   break;
    case 'c': case 'C': setTool('circle'); break;
    case 's': case 'S': setTool('select'); break;
    case 'Delete': case 'Backspace':
      if (selectedIds.size > 0) {
        e.preventDefault();
        pushUndo();
        shapes = shapes.filter(s => !selectedIds.has(s.id));
        selectedIds.clear();
        save(); render();
      }
      break;
    case 'Escape':
      if (_animPreviewModal?.style.display !== 'none') { _animPreviewModal.style.display = 'none'; break; }
      if (openModal?.style.display !== 'none') { openModal.style.display = 'none'; break; }
      if (confirmModal?.style.display !== 'none') { confirmModal.style.display = 'none'; break; }
      if (modalTargetKey) { closeObjectModal(); break; }
      hideCtxMenu();
      if (pasteMode) {
        cancelPasteMode();
        setTool('select');
      } else if (drawPoints.length > 0 || arcPhase > 0 || rectPhase > 0 || circlePhase > 0) {
        cancelDraw(); // stay on current drawing tool
        render();
      } else if (selectedIds.size > 0) {
        selectedIds.clear();
        renderSelection(); updateLayers(); syncUIToSelection(); updatePropsVisibility(); updateGroupBtn();
      } else {
        setTool('select');
      }
      break;
  }
});

document.addEventListener('keyup', e => {
  if (e.key === ' ')       { spaceDown = false; if (!isPanning) setCursor(); }
  if (e.key === 'Control') { ctrlDown = false; setCursor(); render(); }
});

window.addEventListener('blur', () => {
  if (ctrlDown) { ctrlDown = false; setCursor(); render(); }
});

// ── Init ──────────────────────────────────────────────────────────────────────
applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
load();
applyPan();
try {
  const ps = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
  if (ps['layers-panel']) document.getElementById('layers-panel').style.width = ps['layers-panel'] + 'px';
  if (ps['code-panel'])   document.getElementById('code-panel').style.width   = ps['code-panel']   + 'px';
  if (ps['anim-split'])   document.getElementById('svg-code-wrap').style.height = ps['anim-split'] + 'px';
  previewPanel.style.height = (ps['preview-panel'] != null ? ps['preview-panel'] : GRID * 10) + 'px';
  document.getElementById('btn-toggle-preview').classList.toggle('active', previewPanel.offsetHeight > 0);
} catch {}
makePanelResizer('layers-panel', 'right');
makePanelResizer('code-panel',   'left');
// Init animation editors
animDeclEditor.value = localStorage.getItem(ANIM_DECL_KEY) || '';
animLoopEditor.value = localStorage.getItem(ANIM_LOOP_KEY) || '';
setTool('select');
document.getElementById('btn-new-group').addEventListener('click', () => {
  const gid = nextGroupId++;
  if (!groupSvgIds.has(gid)) groupSvgIds.set(gid, 'group' + gid);
  emptyGroupIds.add(gid);
  save(); render();
});
