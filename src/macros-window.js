// Macros window: list of custom JavaScript macros with a code editor.
import { createCodeEditor } from './code-editor.js';
import { identifier, newId, clone } from './model.js';

export function createMacrosWindow(document, { getProject, apply }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('macros-dialog'), list = byId('macro-list'), error = byId('macros-error'), fields = byId('macro-fields');
  let macros = [], index = -1;
  const editor = createCodeEditor(byId('macro-code'), { mode: 'js', onChange: value => { if (index >= 0) macros[index].code = value; } });
  function store() {
    if (index < 0) return;
    macros[index].id = byId('macro-id').value.trim();
    macros[index].targets = [...byId('macro-targets').selectedOptions].map(option => option.value);
  }
  function renderList() {
    list.replaceChildren(...macros.map((macro, i) => {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = macro.id || '(unnamed)'; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(i === index));
      item.addEventListener('click', () => { store(); select(i); });
      return item;
    }));
    byId('macro-delete').disabled = index < 0; fields.hidden = index < 0;
  }
  function select(i) {
    index = i;
    if (i >= 0) {
      const macro = macros[i];
      byId('macro-id').value = macro.id; editor.value = macro.code;
      const targets = byId('macro-targets'); targets.replaceChildren(...getProject().passages.map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = `${p.title} (${p.id})`; o.selected = macro.targets.includes(p.id); return o; }));
    }
    renderList();
  }
  byId('macro-add').addEventListener('click', () => { store(); macros.push({ id: `macro_${macros.length + 1}`, code: "ctx.text('Hello from a macro.');", targets: [] }); select(macros.length - 1); byId('macro-id').focus(); byId('macro-id').select(); });
  byId('macro-delete').addEventListener('click', () => { if (index < 0) return; macros.splice(index, 1); select(macros.length ? Math.min(index, macros.length - 1) : -1); });
  byId('macro-id').addEventListener('input', () => { if (index >= 0) { macros[index].id = byId('macro-id').value.trim(); list.children[index].textContent = macros[index].id || '(unnamed)'; } });
  const close = () => dialog.close();
  byId('macros-cancel').addEventListener('click', close); byId('macros-close').addEventListener('click', close);
  byId('macros-form').addEventListener('submit', event => {
    event.preventDefault(); store();
    try {
      const ids = new Set();
      for (const macro of macros) {
        if (!identifier(macro.id)) throw new Error(`“${macro.id}” is not a valid macro ID (letters, digits, _ and -)`);
        if (ids.has(macro.id)) throw new Error(`Duplicate macro ID ${macro.id}`);
        ids.add(macro.id);
      }
      if (apply(clone(macros))) dialog.close();
    } catch (e) { error.textContent = e.message; }
  });
  return {
    open(selectId = null) {
      macros = clone(getProject().customMacros); error.textContent = '';
      const start = selectId ? macros.findIndex(m => m.id === selectId) : -1;
      select(macros.length ? Math.max(0, start) : -1);
      dialog.showModal(); requestAnimationFrame(() => editor.refresh());
    }
  };
}
export { newId };
