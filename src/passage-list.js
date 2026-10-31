export function initializePassageList(document, onSelect) {
  const list = document.getElementById('passages'), search = document.getElementById('passage-search'), count = document.getElementById('passage-count'), empty = document.getElementById('passage-empty');
  let passages = [], selected = '', start = '', compiled = new Map(), signature = '';
  const query = () => search.value.trim().toLocaleLowerCase();
  const matches = (passage, text) => !text || [passage.title, passage.id, passage.source].some(value => value.toLocaleLowerCase().includes(text));
  function refresh() {
    const text = query(), filtered = passages.filter(passage => matches(passage, text));
    const rows = filtered.map(passage => {
      const result = compiled.get(passage.id);
      return { id: passage.id, title: passage.title || '(untitled)', start: passage.id === start, image: !!passage.image, errors: result?.errors ?? 0, warnings: (result?.diagnostics.length ?? 0) - (result?.errors ?? 0), selected: passage.id === selected };
    });
    const next = JSON.stringify(rows);
    if (next !== signature) {
      signature = next;
      list.replaceChildren(...rows.map(row => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'passage-item'; item.setAttribute('role', 'option'); item.dataset.id = row.id;
        item.setAttribute('aria-selected', String(row.selected));
        const title = document.createElement('span'); title.className = 'item-title'; title.textContent = `${row.start ? '★ ' : ''}${row.title}`;
        const id = document.createElement('span'); id.className = 'item-id'; id.textContent = row.id === row.title ? '' : row.id;
        item.append(title, id);
        if (row.errors) { const dot = document.createElement('span'); dot.className = 'dot error'; dot.title = `${row.errors} error(s)`; item.append(dot); }
        else if (row.warnings) { const dot = document.createElement('span'); dot.className = 'dot warning'; dot.title = `${row.warnings} warning(s)`; item.append(dot); }
        item.title = `${row.title} — ${row.id}`;
        item.addEventListener('click', () => onSelect(row.id));
        return item;
      }));
    }
    count.textContent = text ? `${filtered.length} / ${passages.length}` : String(passages.length);
    empty.hidden = filtered.length > 0;
  }
  search.addEventListener('input', refresh);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); search.value = ''; refresh(); }
    else if ((event.key === 'Enter' || event.key === 'ArrowDown') && list.children.length) {
      event.preventDefault();
      const current = list.querySelector('[aria-selected=true]');
      if (event.key === 'Enter') onSelect((current ?? list.children[0]).dataset.id);
      else (current ?? list.children[0]).focus();
    }
  });
  list.addEventListener('keydown', event => {
    const items = [...list.children], index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' && index < items.length - 1) { event.preventDefault(); items[index + 1].focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); if (index > 0) items[index - 1].focus(); else search.focus(); }
  });
  return {
    render(projectPassages, selectedId, startId, compiledMap) {
      passages = projectPassages; selected = selectedId; start = startId; compiled = compiledMap;
      if (!passages.some(p => p.id === selected && matches(p, query()))) { /* keep filter; selection may be filtered out */ }
      refresh();
      list.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
    },
    clear() { search.value = ''; signature = ''; }
  };
}
