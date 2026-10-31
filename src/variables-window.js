// Variables window: rows (path, type, default) over the project's global state, trait defaults and locals.
import { flattenJson, unflattenRows } from './paths.js';
import { validateGameState, validateVariables, jsonObject, clone } from './model.js';

const TABS = {
  global: { title: 'Global state', help: 'Values every passage can read and change: $player.name, $gold, $pete.state.trust… Actors with a traits object inherit the trait defaults.', validate: value => validateGameState(value, false) },
  traits: { title: 'Trait defaults', help: 'Starting traits for every actor that has a traits object (for example $player.traits.empathy). Explicit actor values win.', validate: value => jsonObject(value, 'traitDefaults') },
  local: { title: 'Passage locals', help: 'Defaults for $local.* — they reset every time a passage is entered and are handy for in-passage choices.', validate: value => validateVariables(value, 'local') }
};
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'json' : typeof value === 'object' ? 'json' : typeof value;
export function createVariablesWindow(document, { getProject, apply }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('variables-dialog'), rows = byId('variables-rows'), raw = byId('variables-raw'), rawToggle = byId('variables-raw-toggle'), error = byId('variables-error');
  let data = null, tab = 'global';
  const current = () => data[tab];
  function renderTabs() {
    for (const button of dialog.querySelectorAll('[role=tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    byId('variables-help').textContent = TABS[tab].help;
  }
  function renderRows() {
    renderTabs();
    const list = current();
    rows.replaceChildren(...list.map((row, index) => {
      const tr = document.createElement('tr');
      const path = document.createElement('input'); path.className = 'path'; path.value = row.path; path.placeholder = 'player.name'; path.spellcheck = false; path.setAttribute('aria-label', 'Variable path');
      const type = document.createElement('select'); type.setAttribute('aria-label', 'Type');
      for (const option of ['string', 'number', 'boolean', 'null', 'json']) { const o = document.createElement('option'); o.value = option; o.textContent = option === 'json' ? 'object / list' : option; type.append(o); }
      type.value = typeOf(row.value);
      const value = document.createElement('input'); value.setAttribute('aria-label', 'Default value'); value.spellcheck = false;
      const show = () => { const t = type.value; value.disabled = t === 'null'; value.value = t === 'null' ? 'null' : t === 'string' ? String(row.value ?? '') : JSON.stringify(row.value ?? (t === 'number' ? 0 : t === 'boolean' ? false : {})); };
      show();
      path.addEventListener('change', () => { row.path = path.value.trim(); });
      type.addEventListener('change', () => { const t = type.value; row.value = t === 'string' ? String(row.value ?? '') : t === 'number' ? (Number(row.value) || 0) : t === 'boolean' ? Boolean(row.value) : t === 'null' ? null : (typeof row.value === 'object' && row.value !== null ? row.value : {}); show(); });
      value.addEventListener('change', () => {
        try {
          const t = type.value;
          if (t === 'string') row.value = value.value;
          else if (t === 'number') { const n = Number(value.value); if (!Number.isFinite(n)) throw new Error('Enter a number'); row.value = n; }
          else if (t === 'boolean') { if (!/^(true|false)$/i.test(value.value.trim())) throw new Error('Enter true or false'); row.value = value.value.trim().toLowerCase() === 'true'; }
          else if (t === 'json') { const parsed = JSON.parse(value.value); if (parsed === null || typeof parsed !== 'object') throw new Error('Enter a JSON object or list'); row.value = parsed; }
          error.textContent = ''; value.removeAttribute('aria-invalid');
        } catch (e) { error.textContent = `${row.path || 'value'}: ${e.message}`; value.setAttribute('aria-invalid', 'true'); }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${row.path}`);
      remove.addEventListener('click', () => { list.splice(index, 1); renderRows(); });
      for (const cell of [path, type, value, remove]) { const td = document.createElement('td'); td.append(cell); tr.append(td); }
      return tr;
    }));
  }
  function toObject(list) {
    for (const row of list) if (!row.path.trim()) throw new Error('Every variable needs a path');
    return unflattenRows(list);
  }
  function syncRaw(toRaw) {
    if (toRaw) raw.value = JSON.stringify(toObject(current()), null, 2);
    else { const parsed = JSON.parse(raw.value); TABS[tab].validate(parsed); data[tab] = flattenJson(parsed).filter(r => r.path); }
  }
  function switchTab(next) {
    try { if (rawToggle.checked) syncRaw(false); } catch (e) { error.textContent = e.message; return; }
    tab = next; error.textContent = '';
    if (rawToggle.checked) { syncRaw(true); renderTabs(); } else renderRows();
  }
  dialog.querySelectorAll('[role=tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  rawToggle.addEventListener('change', () => {
    try { syncRaw(rawToggle.checked); error.textContent = ''; } catch (e) { error.textContent = e.message; rawToggle.checked = !rawToggle.checked; return; }
    raw.hidden = !rawToggle.checked; byId('variables-table-wrap').hidden = rawToggle.checked; byId('variable-add').hidden = rawToggle.checked;
    if (!rawToggle.checked) renderRows();
  });
  byId('variable-add').addEventListener('click', () => { current().push({ path: '', value: '' }); renderRows(); rows.lastElementChild?.querySelector('input')?.focus(); });
  const close = () => dialog.close();
  byId('variables-cancel').addEventListener('click', close); byId('variables-close').addEventListener('click', close);
  byId('variables-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      if (rawToggle.checked) syncRaw(false);
      const result = { initialGameState: TABS.global.validate(toObject(data.global)), traitDefaults: TABS.traits.validate(toObject(data.traits)), initialVariables: TABS.local.validate(toObject(data.local)) };
      if (apply(result)) dialog.close();
    } catch (e) { error.textContent = e.message; }
  });
  return {
    open(initialTab = 'global') {
      const project = getProject();
      data = { global: flattenJson(clone(project.initialGameState)).filter(r => r.path), traits: flattenJson(clone(project.traitDefaults)).filter(r => r.path), local: flattenJson(clone(project.initialVariables)).filter(r => r.path) };
      tab = initialTab; error.textContent = ''; rawToggle.checked = false; raw.hidden = true; byId('variables-table-wrap').hidden = false; byId('variable-add').hidden = false;
      renderRows(); dialog.showModal();
    }
  };
}
