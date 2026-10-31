// Layered left-to-right layout for passage maps.
export const CARD_WIDTH = 240;
export function autoLayout(passages, edges, { startId = null, cardHeight = () => 120, gapX = 90, gapY = 36, origin = { x: 60, y: 60 } } = {}) {
  const ids = passages.map(p => p.id), index = new Map(ids.map((id, i) => [id, i]));
  const out = new Map(ids.map(id => [id, []])), inc = new Map(ids.map(id => [id, []]));
  for (const edge of edges) {
    if (!index.has(edge.from) || !index.has(edge.to) || edge.from === edge.to || out.get(edge.from).includes(edge.to)) continue;
    out.get(edge.from).push(edge.to); inc.get(edge.to).push(edge.from);
  }
  // Layers: longest path from roots, ignoring back edges found by DFS.
  const layer = new Map(), onStack = new Set(), visited = new Set();
  const roots = []; let steps = 0;
  if (startId && index.has(startId)) roots.push(startId);
  for (const id of ids) if (!inc.get(id).length && !roots.includes(id)) roots.push(id);
  for (const id of ids) if (!roots.includes(id)) roots.push(id);
  function visit(id, depth) {
    if (onStack.has(id) || ++steps > 50000) return; // back edge or budget
    if ((layer.get(id) ?? -1) >= depth && visited.has(id)) return;
    layer.set(id, Math.max(layer.get(id) ?? 0, depth)); visited.add(id); onStack.add(id);
    for (const next of out.get(id)) visit(next, depth + 1);
    onStack.delete(id);
  }
  for (const root of roots) if (!visited.has(root)) visit(root, 0);
  const columns = [];
  for (const id of ids) { const l = layer.get(id) ?? 0; (columns[l] ??= []).push(id); }
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];
  // Barycenter ordering sweeps to reduce crossings.
  const position = new Map();
  const reposition = () => columns.forEach(column => column.forEach((id, i) => position.set(id, i)));
  reposition();
  for (let sweep = 0; sweep < 6; sweep++) {
    for (let c = 1; c < columns.length; c++) {
      columns[c].sort((a, b) => bary(a, inc, position) - bary(b, inc, position) || index.get(a) - index.get(b)); reposition();
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      columns[c].sort((a, b) => bary(a, out, position) - bary(b, out, position) || index.get(a) - index.get(b)); reposition();
    }
  }
  // Coordinates: columns centred on a shared axis.
  const heights = columns.map(column => column.reduce((sum, id) => sum + cardHeight(id), 0) + Math.max(0, column.length - 1) * gapY);
  const tallest = Math.max(...heights, 0);
  const positions = new Map();
  columns.forEach((column, c) => {
    let y = origin.y + (tallest - heights[c]) / 2;
    for (const id of column) { positions.set(id, { x: Math.round(origin.x + c * (CARD_WIDTH + gapX)), y: Math.round(y) }); y += cardHeight(id) + gapY; }
  });
  return positions;
}
function bary(id, neighbours, position) {
  const list = neighbours.get(id);
  if (!list.length) return position.get(id);
  return list.reduce((sum, n) => sum + position.get(n), 0) / list.length;
}
