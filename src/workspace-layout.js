// Column and pane sizes are authoring preferences, separate from the project.
const STORAGE_KEY = 'storyline.workspace.v2';
const DEFAULTS = Object.freeze({ map: 480, preview: 460, mapFraction: 0.6, theme: 'dark' });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function initializeWorkspaceLayout(document, window) {
  const workspace = document.getElementById('workspace'), navigation = document.getElementById('map-navigation');
  let preferences = { ...DEFAULTS }, drag = null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    if (saved?.version === 2) for (const key of Object.keys(DEFAULTS)) if (typeof saved[key] === typeof DEFAULTS[key]) preferences[key] = saved[key];
  } catch { /* storage may be blocked */ }
  const persist = () => { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ...preferences })); } catch { /* session only */ } };
  const splits = {
    map: { handle: document.getElementById('column-splitter'), axis: 'x', property: '--map-width', min: 240, max: () => workspace.clientWidth - 360 - (workspace.classList.contains('with-preview') ? preferences.preview + 12 : 6), unit: 'px', sign: 1 },
    preview: { handle: document.getElementById('preview-splitter'), axis: 'x', property: '--preview-width', min: 300, max: () => workspace.clientWidth - preferences.map - 372, unit: 'px', sign: -1 },
    mapFraction: { handle: document.getElementById('map-splitter'), axis: 'y', property: '--map-fraction', min: 0.2, max: () => 0.85, unit: '', sign: 1 }
  };
  function refresh() {
    for (const [key, split] of Object.entries(splits)) {
      const value = clamp(preferences[key], split.min, Math.max(split.min, split.max()));
      (key === 'mapFraction' ? navigation : workspace).style.setProperty(split.property, `${value}${split.unit}`);
    }
    document.documentElement.dataset.theme = preferences.theme;
  }
  for (const [key, split] of Object.entries(splits)) {
    split.handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = { key, pointerId: event.pointerId, start: split.axis === 'x' ? event.clientX : event.clientY, origin: preferences[key] };
      split.handle.setPointerCapture(event.pointerId); split.handle.classList.add('active'); document.body.classList.add('resizing');
    });
    split.handle.addEventListener('pointermove', event => {
      if (!drag || drag.key !== key || event.pointerId !== drag.pointerId) return;
      const delta = ((split.axis === 'x' ? event.clientX : event.clientY) - drag.start) * split.sign;
      preferences[key] = key === 'mapFraction' ? clamp(drag.origin + delta / navigation.clientHeight, split.min, split.max()) : clamp(drag.origin + delta, split.min, Math.max(split.min, split.max()));
      refresh();
    });
    const end = event => { if (!drag || event.pointerId !== drag.pointerId) return; drag = null; split.handle.classList.remove('active'); document.body.classList.remove('resizing'); persist(); };
    split.handle.addEventListener('pointerup', end); split.handle.addEventListener('pointercancel', end);
    split.handle.addEventListener('dblclick', () => { preferences[key] = DEFAULTS[key]; refresh(); persist(); });
    split.handle.addEventListener('keydown', event => {
      const step = key === 'mapFraction' ? (event.shiftKey ? 0.1 : 0.03) : (event.shiftKey ? 60 : 16);
      const decrease = split.axis === 'x' ? 'ArrowLeft' : 'ArrowUp', increase = split.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key === decrease) preferences[key] -= step * split.sign; else if (event.key === increase) preferences[key] += step * split.sign; else if (event.key === 'Enter') preferences[key] = DEFAULTS[key]; else return;
      event.preventDefault(); preferences[key] = clamp(preferences[key], split.min, Math.max(split.min, split.max())); refresh(); persist();
    });
  }
  window.addEventListener('resize', refresh);
  if (window.ResizeObserver) new window.ResizeObserver(refresh).observe(workspace);
  refresh();
  return {
    refresh,
    get theme() { return preferences.theme; },
    setTheme(theme) { preferences.theme = theme; refresh(); persist(); }
  };
}
