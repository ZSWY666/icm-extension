const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const prefix = 'icm-incident-tags:';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.properties = {};
    this.style = { setProperty: (key, value) => { this.properties[key] = value; } };
    this.className = '';
    this.selectedValue = '';
  }

  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  }

  remove() {
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }

  set innerHTML(value) {
    assert.equal(value, '');
    this.children = [];
  }

  get options() {
    return this.children;
  }

  set value(value) {
    this.selectedValue = value;
  }

  get value() {
    if (this.tagName !== 'select') return this.selectedValue;
    return this.children.some(option => option.value === this.selectedValue)
      ? this.selectedValue : '';
  }

  get selectedIndex() {
    return this.children.findIndex(option => option.value === this.selectedValue);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (`.${child.className}` === selector) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }

  closest(selector) {
    if (selector.split(', ').includes(`.${this.className}`)) return this;
    return this.parent?.closest(selector) || null;
  }
}

function createHarness() {
  const data = {};
  const localData = {};
  const grids = [];
  const timers = new Map();
  const intervals = [];
  const errors = [];
  const alerts = [];
  const documentEvents = {};
  let storageListener;
  let mutationListener;
  let rejectWrites = false;
  let writeError = 'Storage write failed';
  let rejectReads = false;
  let timerId = 0;
  const context = {
    console: { error: (...args) => errors.push(args) },
    location: { href: 'https://portal.microsofticm.com/imp/v5/incidents/search', pathname: '/imp/v5/incidents/search' },
    AbortController,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { intervals.push(callback); },
    MutationObserver: class {
      constructor(callback) { mutationListener = callback; }
      observe() {}
    },
    Node: { ELEMENT_NODE: 1 },
    document: {
      readyState: 'loading',
      body: new Element('body'),
      createElement: name => new Element(name),
      addEventListener: (name, callback) => { documentEvents[name] = callback; },
      querySelectorAll: selector => selector === '.searchresults-k-grid' ? grids : []
    },
    window: { alert: message => alerts.push(message) },
    chrome: {
      storage: {
        local: {
          async get() { return { ...localData }; },
          async set(values) { Object.assign(localData, values); }
        },
        sync: {
          async get() {
            if (rejectReads) throw new Error('Storage read failed');
            return { ...data };
          },
          async set(values) {
            if (rejectWrites) throw new Error(writeError);
            Object.assign(data, values);
          },
          async remove(keys) {
            if (rejectWrites) throw new Error(writeError);
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
          }
        },
        onChanged: { addListener: listener => { storageListener = listener; } }
      }
    }
  };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.api = {
      loadData, enhanceGrid, refreshAllGrids, migrateLocalData,
      saveTag, saveTagName, saveTagColor, deleteTag, changeTag,
      getTagsSignature: () => JSON.stringify(Array.from(tagsMap.values()))
    };
  })();`), context);

  function setTag(id, name, color) {
    data[`${prefix}tag:${id}:meta`] = { id };
    data[`${prefix}tag:${id}:name`] = { value: name };
    data[`${prefix}tag:${id}:color`] = { value: color };
  }

  function addGrid(incidentId = '123') {
    const row = new Element('tr');
    row.link = { href: `https://portal.microsofticm.com/imp/v5/incidents/details/${incidentId}/summary` };
    const querySelector = row.querySelector.bind(row);
    row.querySelector = selector => selector.startsWith('a[href') ? row.link : querySelector(selector);
    const colgroup = { querySelector: () => ({}) };
    const headerFilter = {
      _tagsSignature: null,
      updates: 0,
      _updateMenuContent() {
        this._tagsSignature = context.api.getTagsSignature();
        this.updates++;
      }
    };
    const headerRow = {
      querySelector: selector => selector === '.icm-ext-state-filter' ? headerFilter : {}
    };
    const header = {
      dataset: { icmExtStateWidthReserved: 'true' },
      querySelector: selector => selector === 'colgroup' ? colgroup : headerRow
    };
    const body = {
      ...header,
      querySelectorAll: () => [row]
    };
    const grid = {
      querySelector: selector => selector === '.k-grid-header table' ? header : body,
      querySelectorAll: () => [row]
    };
    grids.push(grid);
    return {
      grid, headerFilter,
      row,
      get select() { return row.querySelector('.icm-ext-state-td')?.querySelector('.icm-ext-state-select'); }
    };
  }

  return {
    ...context.api, data, localData, grids, errors, alerts, setTag, addGrid, context, intervals,
    init: () => documentEvents.DOMContentLoaded(),
    rejectWrites: (message = 'Storage write failed') => { rejectWrites = true; writeError = message; },
    allowWrites: () => { rejectWrites = false; },
    rejectReads: () => { rejectReads = true; },
    storageChanged: (key, area = 'sync') => storageListener({ [key]: {} }, area),
    mutate: mutations => mutationListener(mutations),
    flushTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach(callback => callback());
    }
  };
}

test('returning to cached Search rows applies Case edits and new Tag options', async () => {
  const h = createHarness();
  h.setTag('old', 'Old', '#E6194B');
  h.data[`${prefix}incident:123`] = { tagId: 'old' };
  const fixture = h.addGrid();
  await h.init();
  h.enhanceGrid();
  const originalSelect = fixture.select;
  assert.equal(originalSelect.value, 'old');

  h.grids.length = 0;
  h.setTag('new', 'New', '#3CB44B');
  h.data[`${prefix}incident:123`] = { tagId: 'new' };
  await h.storageChanged(`${prefix}incident:123`);
  assert.equal(originalSelect.value, 'old');

  h.grids.push(fixture.grid);
  const previousHeaderUpdates = fixture.headerFilter.updates;
  h.enhanceGrid();
  assert.equal(fixture.select, originalSelect);
  assert.equal(fixture.select.value, 'new');
  assert.equal(fixture.select.options[2].textContent, 'New');
  assert.equal(fixture.select.properties['--tag-bg'], '#3CB44B');
  assert.equal(fixture.row.hidden, false);
  assert.equal(fixture.headerFilter.updates, previousHeaderUpdates + 1);

  const options = [...fixture.select.options];
  const headerUpdates = fixture.headerFilter.updates;
  h.enhanceGrid();
  assert.equal(fixture.headerFilter.updates, headerUpdates);
  assert.deepEqual(fixture.select.options, options);
  options.forEach((option, index) => assert.equal(fixture.select.options[index], option));
});

test('a recycled Search row reads and saves the current Incident ID', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  h.setTag('two', 'Two', '#3CB44B');
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  h.data[`${prefix}incident:456`] = { tagId: 'two' };
  const fixture = h.addGrid();
  await h.loadData();
  h.enhanceGrid();

  fixture.row.link.href = 'https://portal.microsofticm.com/imp/v5/incidents/details/456/summary';
  h.enhanceGrid();
  assert.equal(fixture.select.value, 'two');
  assert.equal(fixture.select.getAttribute('aria-label'), '事件 456 的 Tag');
  fixture.select.value = 'one';
  await fixture.select.listeners.change({ stopPropagation() {}, currentTarget: fixture.select });
  assert.equal(h.data[`${prefix}incident:456`].tagId, 'one');
  assert.equal(h.data[`${prefix}incident:123`].tagId, 'one');
});

test('cross-tab changes refresh visible Search values, names and colors', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  const fixture = h.addGrid();
  await h.init();
  h.enhanceGrid();
  h.setTag('one', 'Renamed', '#3CB44B');
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  await h.storageChanged(`${prefix}incident:123`);
  assert.equal(fixture.select.value, 'one');
  assert.equal(fixture.select.options[1].textContent, 'Renamed');
  assert.equal(fixture.select.properties['--tag-bg'], '#3CB44B');

  h.data[`${prefix}incident:123`] = { tagId: null };
  await h.storageChanged(`${prefix}incident:123`);
  assert.equal(fixture.select.value, '');
  assert.equal(fixture.select.properties['--tag-bg'], '#fff');
});

test('failed Search writes restore the previous Tag and notify the user', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  h.setTag('two', 'Two', '#3CB44B');
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  const fixture = h.addGrid();
  await h.loadData();
  h.enhanceGrid();
  h.rejectWrites();
  fixture.select.value = 'two';
  await fixture.select.listeners.change({ stopPropagation() {}, currentTarget: fixture.select });
  assert.equal(fixture.select.value, 'one');
  assert.equal(h.data[`${prefix}incident:123`].tagId, 'one');
  assert.equal(h.errors.length, 1);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /具体错误：Storage write failed/);
});

test('invalidated extension writes explain that existing ICM pages need refreshing', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  const fixture = h.addGrid();
  await h.init();
  h.rejectWrites('Extension context invalidated.');
  fixture.select.value = '';
  await fixture.select.listeners.change({ stopPropagation() {}, currentTarget: fixture.select });
  assert.equal(fixture.select.value, 'one');
  assert.match(h.alerts[0], /刷新所有已打开的 ICM 页面/);
  assert.match(h.alerts[0], /具体错误：Extension context invalidated\./);
  assert.doesNotMatch(h.alerts[0], /容量已满/);
});

test('storage quota failures show the exact cause and matching recovery advice', async () => {
  for (const [reason, advice] of [
    ['MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded', /至少一分钟/],
    ['MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded', /每小时限制/],
    ['QUOTA_BYTES_PER_ITEM quota exceeded', /缩短 Tag 名称/],
    ['QUOTA_BYTES quota exceeded', /总容量已满/],
    ['MAX_ITEMS quota exceeded', /记录数/],
    ['Storage is unavailable', /请提供下方的具体错误/]
  ]) {
    const h = createHarness();
    h.setTag('one', 'One', '#E6194B');
    await h.init();
    h.rejectWrites(reason);
    assert.equal(await h.changeTag(() => h.saveTagName('one', 'Failed')), false);
    assert.match(h.alerts[0], advice);
    assert.ok(h.alerts[0].includes(`具体错误：${reason}`));
    assert.equal(h.data[`${prefix}tag:one:name`].value, 'One');
  }
});

test('route changes and link attribute mutations reconcile existing Search rows', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  const fixture = h.addGrid();
  await h.init();
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  await h.loadData();
  h.context.location.href += '?page=2';
  h.intervals[0]();
  assert.equal(fixture.select.value, 'one');

  fixture.row.link.href = 'https://portal.microsofticm.com/imp/v5/incidents/details/456/summary';
  h.mutate([{ type: 'attributes', target: fixture.row, addedNodes: [] }]);
  h.flushTimers();
  assert.equal(fixture.select.value, '');
  assert.equal(fixture.select.getAttribute('aria-label'), '事件 456 的 Tag');
});

test('local records migrate once, retaining the local backup and unrelated settings', async () => {
  const h = createHarness();
  const meta = `${prefix}tag:one:meta`;
  const name = `${prefix}tag:one:name`;
  const color = `${prefix}tag:one:color`;
  const incident = `${prefix}incident:123`;
  Object.assign(h.localData, {
    [meta]: { id: 'one' },
    [name]: { value: 'Local' },
    [color]: { value: '#E6194B' },
    [incident]: { tagId: 'one' },
    unrelated: true
  });
  const fixture = h.addGrid();
  await h.init();
  assert.equal(fixture.select.value, 'one');
  for (const key of [meta, name, color, incident]) {
    assert.deepEqual(h.data[key], h.localData[key]);
  }
  assert.equal(h.data.unrelated, undefined);
  assert.equal(h.localData['icm-sync-migration-v1'], true);
  delete h.data[incident];
  await h.migrateLocalData();
  assert.equal(h.data[incident], undefined);
  assert.equal(h.localData[incident].tagId, 'one');
});

test('migration preserves cloud conflicts, cleared incidents and deleted Tag tombstones', async () => {
  const h = createHarness();
  h.setTag('one', 'Cloud', '#3CB44B');
  const name = `${prefix}tag:one:name`;
  const incident = `${prefix}incident:123`;
  h.data[incident] = { tagId: null, updatedAt: 20 };
  h.data[`${prefix}tag:deleted:meta`] = { id: 'deleted', deletedAt: 20 };
  Object.assign(h.localData, {
    [name]: { value: 'Local', updatedAt: 30 },
    [incident]: { tagId: 'one', updatedAt: 30 },
    [`${prefix}tag:deleted:meta`]: { id: 'deleted' },
    [`${prefix}tag:deleted:name`]: { value: 'Deleted' },
    [`${prefix}tag:deleted:color`]: { value: '#E6194B' }
  });
  await h.migrateLocalData();
  assert.equal(h.data[name].value, 'Cloud');
  assert.equal(h.data[incident].tagId, null);
  assert.equal(h.data[`${prefix}tag:deleted:name`], undefined);
  assert.equal(h.data[`${prefix}tag:deleted:color`], undefined);
  await h.loadData();
  assert.equal(JSON.parse(h.getTagsSignature()).length, 1);
});

test('quota failure during migration keeps local data and permits a later retry', async () => {
  const h = createHarness();
  const incident = `${prefix}incident:123`;
  h.localData[incident] = { tagId: null };
  h.rejectWrites('QUOTA_BYTES quota exceeded');
  await h.init();
  assert.equal(h.localData[incident].tagId, null);
  assert.equal(h.localData['icm-sync-migration-v1'], undefined);
  assert.equal(h.data[incident], undefined);
  assert.equal(h.errors.length, 1);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.intervals.length, 0);
  h.allowWrites();
  await h.init();
  assert.equal(h.localData['icm-sync-migration-v1'], true);
  assert.equal(h.data[incident].tagId, null);
});

test('only sync changes refresh displayed records after migration', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  const fixture = h.addGrid();
  await h.init();
  const incident = `${prefix}incident:123`;
  h.data[incident] = { tagId: 'one' };
  await h.storageChanged(incident, 'local');
  assert.equal(fixture.select.value, '');
  await h.storageChanged(incident, 'sync');
  assert.equal(fixture.select.value, 'one');
});

test('Tag creation, renaming, coloring and deletion persist only to sync storage', async () => {
  const h = createHarness();
  await h.init();
  const tag = { id: 'one', name: 'One', color: '#E6194B' };
  await h.saveTag(tag);
  await h.saveTagName('one', 'Renamed');
  await h.saveTagColor('one', '#3CB44B');
  assert.equal(h.data[`${prefix}tag:one:name`].value, 'Renamed');
  assert.equal(h.data[`${prefix}tag:one:color`].value, '#3CB44B');
  assert.equal(h.localData[`${prefix}tag:one:meta`], undefined);
  await h.deleteTag('one');
  assert.ok(h.data[`${prefix}tag:one:meta`].deletedAt);
  assert.equal(h.data[`${prefix}tag:one:name`], undefined);
  assert.equal(h.data[`${prefix}tag:one:color`], undefined);
  assert.equal(h.getTagsSignature(), '[]');
});

test('failed Tag edits notify, retain stored values and recover for subsequent writes', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  await h.init();
  h.rejectWrites('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
  assert.equal(await h.changeTag(() => h.saveTagName('one', 'Failed')), false);
  assert.equal(await h.changeTag(() => h.saveTagColor('one', '#3CB44B')), false);
  assert.equal(await h.changeTag(() => h.deleteTag('one')), false);
  assert.equal(await h.changeTag(() => h.saveTag({ id: 'two', name: 'Two', color: '#3CB44B' })), false);
  assert.equal(h.errors.length, 4);
  assert.equal(h.alerts.length, 4);
  assert.equal(h.data[`${prefix}tag:one:name`].value, 'One');
  assert.equal(h.data[`${prefix}tag:one:color`].value, '#E6194B');
  assert.equal(h.data[`${prefix}tag:one:meta`].deletedAt, undefined);
  assert.equal(h.data[`${prefix}tag:two:meta`], undefined);
  h.allowWrites();
  assert.equal(await h.changeTag(() => h.saveTagName('one', 'Recovered')), true);
  assert.equal(h.data[`${prefix}tag:one:name`].value, 'Recovered');
});

test('sync read errors are reported without clearing visible Tags', async () => {
  const h = createHarness();
  h.setTag('one', 'One', '#E6194B');
  h.data[`${prefix}incident:123`] = { tagId: 'one' };
  const fixture = h.addGrid();
  await h.init();
  h.rejectReads();
  await h.storageChanged(`${prefix}incident:123`);
  assert.equal(fixture.select.value, 'one');
  assert.equal(h.errors.length, 1);
  assert.equal(h.alerts.length, 1);
});
