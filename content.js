(() => {
  const STORAGE_PREFIX = 'icm-incident-tags:';

  const PALETTE = [
    '#E6194B', '#3CB44B', '#FFE119', '#4363D8', '#F58231',
    '#911EB4', '#46F0F0', '#F032E6', '#BCF60C', '#FABEBE',
    '#008080', '#E6BEFF', '#9A6324', '#FFFAC8', '#800000',
    '#AAFFC3', '#808000', '#FFD8B1', '#000075', '#808080'
  ];

  const STORAGE = chrome.storage.sync;
  const MIGRATION_KEY = 'icm-sync-migration-v1';
  const DETAIL_POSITION_KEY = 'icm-detail-tag-position';
  let detailPosition = null;
  
  let tagsMap = new Map();
  let incidentTagsMap = new Map();
  let activeFilters = new Set();
  
  const writeQueues = new Map();
  let enhanceTimer;
  let detailControl;
  let currentPageUrl = location.href;
  let initialized = false;

  function getContrastYIQ(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return '#111827';
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#111827' : '#ffffff';
  }

  function queueOperation(key, operation) {
    let q = writeQueues.get(key) || Promise.resolve();
    q = q.catch(() => undefined).then(operation);
    writeQueues.set(key, q);
    return q;
  }

  function queueWrite(key, value) {
    return queueOperation(key, () => STORAGE.set({ [key]: value }));
  }

  function storageErrorDetails(error) {
    const reason = typeof error?.message === 'string' ? error.message : String(error);
    let advice = '请刷新 ICM 页面后重试；若仍失败，请提供下方的具体错误。';
    if (/extension context invalidated/i.test(reason)) {
      advice = '扩展已重新加载、更新或停用。请确认扩展已启用，再刷新所有已打开的 ICM 页面；仅重新加载扩展不够。';
    } else if (/MAX_WRITE_OPERATIONS_PER_MINUTE/i.test(reason)) {
      advice = '同步写入次数达到每分钟限制，请停止操作至少一分钟后重试。';
    } else if (/MAX_WRITE_OPERATIONS_PER_HOUR|MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE/i.test(reason)) {
      advice = '同步写入次数达到持续或每小时限制，请稍后重试。';
    } else if (/QUOTA_BYTES_PER_ITEM/i.test(reason)) {
      advice = '单条同步记录超过容量限制，请缩短 Tag 名称后重试。';
    } else if (/MAX_ITEMS|QUOTA_BYTES/i.test(reason)) {
      advice = '同步存储的记录数或总容量已满。刷新页面不会释放容量，请勿卸载扩展或清空数据，以免丢失记录。';
    }
    return `${advice}\n具体错误：${reason}`;
  }

  async function migrateLocalData() {
    const localData = await chrome.storage.local.get(null);
    if (localData[MIGRATION_KEY]) return;
    const syncedData = await STORAGE.get(null);
    const migrated = {};
    for (const [key, value] of Object.entries(localData)) {
      if (!/^icm-incident-tags:(tag:[a-z0-9-]{1,64}:(meta|name|color)|incident:\d+)$/i.test(key)) continue;
      if (Object.prototype.hasOwnProperty.call(syncedData, key)) continue;
      const tagMatch = key.match(/^icm-incident-tags:tag:([^:]+):(name|color)$/);
      if (tagMatch) {
        const metaKey = STORAGE_PREFIX + 'tag:' + tagMatch[1] + ':meta';
        const meta = syncedData[metaKey] || localData[metaKey];
        if (meta?.deletedAt) continue;
      }
      migrated[key] = value;
    }
    if (Object.keys(migrated).length) await STORAGE.set(migrated);
    await chrome.storage.local.set({ [MIGRATION_KEY]: true });
  }

  async function changeTag(operation) {
    try {
      await operation();
      return true;
    } catch (error) {
      console.error('Failed to sync Tag change', error);
      window.alert(`保存 Tag 失败。\n${storageErrorDetails(error)}`);
      try {
        await loadData();
        document.querySelectorAll('.icm-ext-state-filter').forEach(filter => {
          if (filter._updateMenuContent) filter._updateMenuContent();
        });
        refreshAllGrids();
      } catch (reloadError) {
        console.error('Failed to reload synced Tags', reloadError);
        window.alert(`重新读取 Tag 失败。\n${storageErrorDetails(reloadError)}`);
      }
      return false;
    }
  }

  function isValidTagId(value) {
    return typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value);
  }

  function isValidColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  }

  async function loadData() {
    const allData = await STORAGE.get(null);
    const previousTagIds = new Set(tagsMap.keys());
    tagsMap.clear();
    incidentTagsMap.clear();
    
    const storedTags = new Map();
    for (const [key, value] of Object.entries(allData)) {
      const tagMatch = key.match(/^icm-incident-tags:tag:([^:]+):(meta|name|color)$/);
      if (tagMatch && isValidTagId(tagMatch[1])) {
        const record = storedTags.get(tagMatch[1]) || { id: tagMatch[1] };
        record[tagMatch[2]] = value;
        storedTags.set(tagMatch[1], record);
      } else if (key.startsWith(STORAGE_PREFIX + 'incident:')) {
        const incidentId = key.split(':')[2];
        if (!/^\d+$/.test(incidentId)) continue;
        const tagId = value && typeof value === 'object' ? value.tagId : value;
        incidentTagsMap.set(incidentId, isValidTagId(tagId) ? tagId : null);
      }
    }

    for (const record of storedTags.values()) {
      if (record.meta && record.meta.deletedAt) {
        tagsMap.delete(record.id);
        continue;
      }
      
      const name = typeof record.name?.value === 'string' ? record.name.value.trim() : '';
      const color = record.color?.value;
      if (record.meta && name && isValidColor(color)) {
        tagsMap.set(record.id, { id: record.id, name, color });
      }
    }

    if (activeFilters.size === 0) {
      activeFilters.add(''); // 未标记
      for (const tagId of tagsMap.keys()) {
        activeFilters.add(tagId);
      }
    } else {
      for (const tagId of tagsMap.keys()) {
        if (!previousTagIds.has(tagId)) activeFilters.add(tagId);
      }
    }
  }

  function getIncidentTagId(incidentId) {
    if (incidentTagsMap.has(incidentId)) {
      const tagId = incidentTagsMap.get(incidentId);
      return (tagId && tagsMap.has(tagId)) ? tagId : '';
    }
    return '';
  }

  function saveIncidentTag(incidentId, tagId) {
    incidentTagsMap.set(incidentId, tagId || null);
    return queueWrite(STORAGE_PREFIX + 'incident:' + incidentId, {
      tagId: tagId || null,
      updatedAt: Date.now()
    });
  }

  async function saveTag(tag) {
    const baseKey = STORAGE_PREFIX + 'tag:' + tag.id;
    const now = Date.now();
    await queueOperation(baseKey, () => STORAGE.set({
      [baseKey + ':meta']: { id: tag.id, createdAt: tag.createdAt || now },
      [baseKey + ':name']: { value: tag.name, updatedAt: now },
      [baseKey + ':color']: { value: tag.color, updatedAt: now }
    }));
    tagsMap.set(tag.id, tag);
  }

  async function saveTagName(id, name) {
    const tag = tagsMap.get(id);
    if (tag) {
      const baseKey = STORAGE_PREFIX + 'tag:' + id;
      await queueOperation(baseKey, () => STORAGE.set({
        [baseKey + ':name']: { value: name, updatedAt: Date.now() }
      }));
      tag.name = name;
    }
  }

  async function saveTagColor(id, color) {
    const tag = tagsMap.get(id);
    if (tag) {
      const baseKey = STORAGE_PREFIX + 'tag:' + id;
      await queueOperation(baseKey, () => STORAGE.set({
        [baseKey + ':color']: { value: color, updatedAt: Date.now() }
      }));
      tag.color = color;
    }
  }

  async function deleteTag(id) {
    const baseKey = STORAGE_PREFIX + 'tag:' + id;
    const now = Date.now();
    await queueOperation(baseKey, async () => {
      await STORAGE.set({ [baseKey + ':meta']: { id: id, deletedAt: now, updatedAt: now } });
      await STORAGE.remove([baseKey + ':name', baseKey + ':color']);
    });
    tagsMap.delete(id);
  }

  function getIncidentId(row) {
    const incidentLink = row.querySelector('a[href*="/incidents/details/"]');
    const linkMatch = incidentLink?.href.match(/\/incidents\/details\/(\d+)/i);
    if (linkMatch) return linkMatch[1];

    const checkbox = row.querySelector('input[type="checkbox"].gridCheckbox');
    const labelMatch = checkbox?.getAttribute('aria-label')?.match(/IncidentId\s+(\d+)/i);
    if (labelMatch) return labelMatch[1];

    return /^\d+$/.test(checkbox?.id || '') ? checkbox.id : null;
  }

  function applyTagStyles(element, tagId) {
    if (!tagId || !tagsMap.has(tagId)) {
      element.style.setProperty('--tag-bg', '#fff');
      element.style.setProperty('--tag-fg', '#111827');
      element.style.setProperty('--tag-border', '#6b7280');
      return;
    }
    const tag = tagsMap.get(tagId);
    element.style.setProperty('--tag-bg', tag.color);
    element.style.setProperty('--tag-fg', getContrastYIQ(tag.color));
    element.style.setProperty('--tag-border', tag.color);
  }

  function applyFilter(grid) {
    for (const row of grid.querySelectorAll('.k-grid-content tbody tr[role="row"]')) {
      const incidentId = getIncidentId(row);
      if (!incidentId) continue;
      const tagId = getIncidentTagId(incidentId);
      row.hidden = !activeFilters.has(tagId);
    }
  }

  function refreshAllGrids() {
    if (detailControl) detailControl._updateMenuContent();
    for (const grid of document.querySelectorAll('.searchresults-k-grid')) {
      for (const row of grid.querySelectorAll('.k-grid-content tbody tr[role="row"]')) {
        const incidentId = getIncidentId(row);
        if (!incidentId) continue;
        const select = row.querySelector('.icm-ext-state-select');
        if (select) {
          updateSelectOptions(select);
          const currentVal = getIncidentTagId(incidentId);
          select.value = currentVal;
          applyTagStyles(select, currentVal);
        }
      }
      applyFilter(grid);
    }
  }

  function parseDetailPosition(value) {
    if (value == null) return null;
    if (typeof value !== 'object' ||
        !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
        value.x < 0 || value.y < 0) {
      throw new Error('Invalid saved detail Tag position');
    }
    return { x: value.x, y: value.y };
  }

  function reportPositionError(error, action) {
    console.error(`Failed to ${action} detail Tag position`, error);
    window.alert(`${action === 'save' ? '保存' : '读取'} Tag 位置失败，Tag 数据不受影响。\n${storageErrorDetails(error)}`);
  }

  function enableDetailDragging(filter, summary, controller, positionMenu) {
    const options = { signal: controller.signal };
    let drag = null;
    let suppressClick = false;

    function moveTo(position) {
      const rect = summary.getBoundingClientRect();
      const x = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
      const y = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
      filter.style.left = `${x}px`;
      filter.style.top = `${y}px`;
      filter.style.right = 'auto';
      filter.style.bottom = 'auto';
      if (filter.open) positionMenu();
      return { x, y };
    }

    filter._applyPosition = () => {
      if (drag) return;
      if (detailPosition) {
        moveTo(detailPosition);
      } else {
        filter.style.left = '';
        filter.style.top = '';
        filter.style.right = '';
        filter.style.bottom = '';
        const rect = summary.getBoundingClientRect();
        if (rect.left < 8 || rect.top < 8 ||
            rect.left + rect.width > window.innerWidth - 8 ||
            rect.bottom > window.innerHeight - 8) {
          moveTo({ x: rect.left, y: rect.top });
        }
      }
    };

    summary.title += '；拖拽可移动，位置仅保存在当前浏览器';
    summary.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || drag) return;
      suppressClick = false;
      const rect = summary.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        origin: { x: rect.left, y: rect.top },
        moved: false
      };
      summary.setPointerCapture(event.pointerId);
    }, options);

    summary.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      suppressClick = true;
      filter.classList.add('icm-ext-dragging');
      event.preventDefault();
      moveTo({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    }, options);

    function finishDrag(event, cancelled) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const finished = drag;
      drag = null;
      filter.classList.remove('icm-ext-dragging');
      if (summary.hasPointerCapture(event.pointerId)) summary.releasePointerCapture(event.pointerId);
      if (!finished.moved) {
        filter._applyPosition();
        return;
      }
      if (cancelled) {
        filter._applyPosition();
        return;
      }
      detailPosition = moveTo({
        x: finished.origin.x + event.clientX - finished.startX,
        y: finished.origin.y + event.clientY - finished.startY
      });
      const position = { ...detailPosition };
      return queueOperation(DETAIL_POSITION_KEY, () =>
        chrome.storage.local.set({ [DETAIL_POSITION_KEY]: position })
      ).catch(error => reportPositionError(error, 'save'));
    }

    summary.addEventListener('pointerup', event => finishDrag(event, false), options);
    summary.addEventListener('pointercancel', event => finishDrag(event, true), options);
    summary.addEventListener('lostpointercapture', event => finishDrag(event, true), options);
    summary.addEventListener('click', event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, options);
    window.addEventListener('resize', () => {
      filter._applyPosition();
      if (filter.open) positionMenu();
    }, options);
  }

  function createFilter(incidentId = null) {
    const controller = new AbortController();
    const filter = document.createElement('details');
    filter.className = 'icm-ext-state-filter';
    if (incidentId) filter.classList.add('icm-ext-detail-state');
    const summary = document.createElement('summary');
    summary.className = 'icm-ext-state-filter-summary';
    summary.textContent = 'Tag';
    summary.setAttribute('aria-label', incidentId ? `事件 ${incidentId} 的个人处理状态` : 'Filter by Tag');
    summary.setAttribute('title', incidentId ? '个人 Tag，通过浏览器账号同步，不会修改 ICM 官方状态' : 'Filter by Tag');
    filter.appendChild(summary);

    const menu = document.createElement('div');
    menu.className = 'icm-ext-state-filter-menu';

    const menuHeader = document.createElement('div');
    menuHeader.className = 'icm-ext-filter-menu-header';
    const menuTitle = document.createElement('strong');
    menuTitle.textContent = incidentId ? `事件 ${incidentId} 的 Tag` : '筛选与管理 Tag';
    const menuHint = document.createElement('span');
    menuHint.textContent = incidentId ? '单选 · 浏览器账号同步' : '可多选 · 浏览器账号同步';
    menuHeader.append(menuTitle, menuHint);
    menu.appendChild(menuHeader);
    
    const listContainer = document.createElement('div');
    listContainer.className = 'icm-ext-state-filter-list';
    menu.appendChild(listContainer);

    function updateMenuContent() {
      listContainer.innerHTML = '';
      
      const updateSummary = () => {
        if (incidentId) {
          const tagId = getIncidentTagId(incidentId);
          summary.textContent = `Tag: ${tagsMap.get(tagId)?.name || '未标记'}`;
          summary.setAttribute('aria-label', `事件 ${incidentId} 的个人处理状态：${tagsMap.get(tagId)?.name || '未标记'}`);
          applyTagStyles(summary, tagId);
          return;
        }
        const total = tagsMap.size + 1;
        summary.textContent = activeFilters.size === total ? 'Tag' : `Tag(${activeFilters.size})`;
        for (const grid of document.querySelectorAll('.searchresults-k-grid')) applyFilter(grid);
      };

      const addOption = (id, name, color) => {
        const item = document.createElement('div');
        item.className = 'icm-ext-state-filter-item';
        const optionRow = document.createElement('div');
        optionRow.className = 'icm-ext-state-filter-option-row';
        const label = document.createElement('label');
        label.className = 'icm-ext-state-filter-option';
        applyTagStyles(label, id);
        
        const checkbox = document.createElement('input');
        checkbox.type = incidentId ? 'radio' : 'checkbox';
        if (incidentId) checkbox.name = `icm-ext-detail-tag-${incidentId}`;
        checkbox.value = id;
        checkbox.checked = incidentId ? getIncidentTagId(incidentId) === id : activeFilters.has(id);
        checkbox.addEventListener('change', async event => {
          event.stopPropagation();
          if (incidentId) {
            const previousTagId = getIncidentTagId(incidentId);
            try {
              await saveIncidentTag(incidentId, id);
            } catch (error) {
              incidentTagsMap.set(incidentId, previousTagId || null);
              console.error('Failed to save incident Tag', error);
              window.alert(`保存 Tag 失败。\n${storageErrorDetails(error)}`);
            }
            refreshAllGrids();
            return;
          }
          if (event.currentTarget.checked) activeFilters.add(id);
          else activeFilters.delete(id);
          updateSummary();
        });
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tag-name';
        nameSpan.textContent = name;
        nameSpan.title = name;
        
        label.append(checkbox, nameSpan);
        
        if (id) {
          const colorInput = document.createElement('input');
          colorInput.type = 'color';
          colorInput.value = color;
           colorInput.title = '修改颜色';
          colorInput.addEventListener('click', e => e.stopPropagation());
          colorInput.addEventListener('input', e => {
            const newColor = e.target.value;
            applyTagStyles(label, id);
            label.style.setProperty('--tag-bg', newColor);
            label.style.setProperty('--tag-fg', getContrastYIQ(newColor));
            label.style.setProperty('--tag-border', newColor);
          });
          colorInput.addEventListener('change', async e => {
            const newColor = e.target.value;
            await changeTag(() => saveTagColor(id, newColor));
            refreshAllGrids();
          });
          label.appendChild(colorInput);

          const renameButton = document.createElement('button');
          renameButton.type = 'button';
          renameButton.className = 'icm-ext-tag-icon-btn';
          renameButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.6 2.6a2 2 0 0 1 2.8 2.8L7.2 14.6 3 15.5l.9-4.2 9.7-8.7Zm-8.5 9.5-.4 1.7 1.7-.4 7.1-7.1-1.3-1.3-7.1 7.1Z" fill="currentColor"/></svg>';
          renameButton.title = `重命名 ${name}`;
          renameButton.setAttribute('aria-label', `重命名 Tag ${name}`);

          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.className = 'icm-ext-tag-icon-btn icm-ext-tag-delete-btn';
          deleteButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l.7 1.5H17V6H3V4.5h3.3L7 3Zm-2 4h10l-.7 10H5.7L5 7Zm3 2v6h1.5V9H8Zm2.5 0v6H12V9h-1.5Z" fill="currentColor"/></svg>';
          deleteButton.title = `删除 ${name}`;
          deleteButton.setAttribute('aria-label', `删除 Tag ${name}`);

          renameButton.addEventListener('click', event => {
            event.stopPropagation();
            if (item.querySelector('.icm-ext-state-filter-edit-row')) return;

            const editRow = document.createElement('div');
            editRow.className = 'icm-ext-state-filter-edit-row';
            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'icm-ext-tag-rename-input';
            editInput.value = name;
            editInput.setAttribute('aria-label', `Tag ${name} 的新名称`);
            const saveButton = document.createElement('button');
            saveButton.type = 'button';
            saveButton.textContent = '保存';
            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.textContent = '取消';
            const renameError = document.createElement('div');
            renameError.className = 'icm-ext-tag-rename-error';

            const saveRename = async () => {
              const newName = editInput.value.trim();
              if (!newName) {
                renameError.textContent = '请输入 Tag 名称';
                return;
              }
              const duplicate = Array.from(tagsMap.values()).some(tag =>
                tag.id !== id && tag.name.toLowerCase() === newName.toLowerCase()
              );
              if (duplicate) {
                renameError.textContent = 'Tag 名称已存在';
                return;
              }
              if (!await changeTag(() => saveTagName(id, newName))) return;
              updateMenuContent();
              document.querySelectorAll('.icm-ext-state-select').forEach(updateSelectOptions);
              refreshAllGrids();
            };
            saveButton.addEventListener('click', event => {
              event.stopPropagation();
              saveRename();
            });
            cancelButton.addEventListener('click', event => {
              event.stopPropagation();
              editRow.remove();
              renameError.remove();
            });
            editInput.addEventListener('keydown', event => {
              event.stopPropagation();
              if (event.key === 'Enter') saveRename();
              if (event.key === 'Escape') cancelButton.click();
            });
            editRow.append(editInput, saveButton, cancelButton);
            item.append(editRow, renameError);
            editInput.focus();
            editInput.select();
          });

          deleteButton.addEventListener('click', async event => {
            event.stopPropagation();
            if (!window.confirm(`确定删除 Tag“${name}”吗？关联事件将变为“未标记”。`)) return;
            if (!await changeTag(() => deleteTag(id))) return;
            activeFilters.delete(id);
            activeFilters.add('');
            updateMenuContent();
            document.querySelectorAll('.icm-ext-state-select').forEach(updateSelectOptions);
            refreshAllGrids();
          });

          optionRow.append(label, renameButton, deleteButton);
        } else {
          optionRow.appendChild(label);
        }

        item.appendChild(optionRow);
        listContainer.appendChild(item);
      };

      addOption('', '未标记', null);
      for (const tag of tagsMap.values()) {
        addOption(tag.id, tag.name, tag.color);
      }
      
      filter._tagsSignature = JSON.stringify(Array.from(tagsMap.values()));
      updateSummary();
      filter._applyPosition?.();
      if (filter.open) positionMenu();
    }

    const actions = document.createElement('div');
    actions.className = 'icm-ext-state-filter-actions';
    for (const [text, selected] of [['全选', true], ['清空', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', event => {
        event.stopPropagation();
        activeFilters.clear();
        if (selected) {
          activeFilters.add('');
          tagsMap.forEach(t => activeFilters.add(t.id));
        }
        for (const checkbox of listContainer.querySelectorAll('input[type="checkbox"]')) {
          checkbox.checked = selected;
        }
        const total = tagsMap.size + 1;
        summary.textContent = selected ? 'Tag' : 'Tag(0)';
        for (const grid of document.querySelectorAll('.searchresults-k-grid')) applyFilter(grid);
      });
      actions.appendChild(button);
    }
    if (!incidentId) menu.appendChild(actions);

    const createSection = document.createElement('div');
    createSection.className = 'icm-ext-tag-create';
    
    const createRow = document.createElement('div');
    createRow.className = 'icm-ext-tag-create-row';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'icm-ext-tag-create-input';
     input.placeholder = '新 Tag 名称';
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icm-ext-tag-create-btn';
    btn.textContent = '新建';
    
    const errorMsg = document.createElement('div');
    errorMsg.className = 'icm-ext-tag-create-error';
    
    createRow.append(input, btn);
    createSection.append(createRow, errorMsg);
    menu.appendChild(createSection);

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = input.value.trim();
      if (!name) {
         errorMsg.textContent = '请输入 Tag 名称';
        errorMsg.style.display = 'block';
        return;
      }
      const exists = Array.from(tagsMap.values()).some(t => t.name.toLowerCase() === name.toLowerCase());
      if (exists) {
         errorMsg.textContent = 'Tag 名称已存在';
        errorMsg.style.display = 'block';
        return;
      }
      
      const newId = crypto.randomUUID();
      const numTags = tagsMap.size;
      const color = PALETTE[numTags % PALETTE.length];
      
       const newTag = { id: newId, name, color, createdAt: Date.now() };
      if (!await changeTag(() => saveTag(newTag))) return;
      activeFilters.add(newId);
      input.value = '';
      errorMsg.style.display = 'none';
      
      updateMenuContent();
      refreshAllGrids();
    });

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') btn.click();
    });

    document.body.appendChild(menu);
    menu.hidden = true;
    updateMenuContent();

    function positionMenu() {
      const rect = summary.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - bounds.width - 4))}px`;
      menu.style.top = `${Math.max(4, rect.bottom + bounds.height + 4 <= window.innerHeight
        ? rect.bottom + 2 : rect.top - bounds.height - 2)}px`;
    }

    if (incidentId) enableDetailDragging(filter, summary, controller, positionMenu);

    filter.addEventListener('toggle', () => {
      menu.hidden = !filter.open;
      if (filter.open) positionMenu();
    });
    window.addEventListener('resize', () => { if (filter.open) positionMenu(); }, { signal: controller.signal });
    window.addEventListener('scroll', () => { if (filter.open) positionMenu(); }, { capture: true, signal: controller.signal });
    
    document.addEventListener('pointerdown', event => {
      if (!filter.open || filter.contains(event.target) || menu.contains(event.target)) return;
      filter.open = false;
    }, { signal: controller.signal });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && filter.open) {
        filter.open = false;
        summary.focus();
      }
    }, { signal: controller.signal });

    for (const eventName of ['pointerdown', 'mousedown', 'click']) {
      filter.addEventListener(eventName, event => event.stopPropagation());
    }
    
    filter._updateMenuContent = updateMenuContent;
    filter._dispose = () => {
      controller.abort();
      menu.remove();
      filter.remove();
    };
    return filter;
  }

  function enhanceDetailPage() {
    const incidentId = location.pathname.match(/\/incidents\/details\/(\d+)(?:\/|$)/i)?.[1];
    if (detailControl &&
        (detailControl.dataset.incidentId !== incidentId || !detailControl.isConnected)) {
      detailControl._dispose();
      detailControl = null;
    }
    if (!incidentId || detailControl) return;

    detailControl = createFilter(incidentId);
    detailControl.dataset.incidentId = incidentId;
    document.body.appendChild(detailControl);
    detailControl._applyPosition();
  }

  function updateSelectOptions(select) {
    const tags = Array.from(tagsMap.values());
    if (select.options.length === tags.length + 1 &&
        select.options[0].value === '' &&
        tags.every((tag, index) => {
          const option = select.options[index + 1];
          return option.value === tag.id && option.textContent === tag.name &&
            option.dataset.tagColor === tag.color;
        })) return;

    const currentVal = select.value;
    select.innerHTML = '';
    
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '未标记';
    select.appendChild(defaultOption);
    
     for (const tag of tagsMap.values()) {
       const option = document.createElement('option');
       option.value = tag.id;
       option.textContent = tag.name;
       option.dataset.tagColor = tag.color;
       option.style.backgroundColor = tag.color;
       option.style.color = getContrastYIQ(tag.color);
       select.appendChild(option);
    }
    
    select.value = currentVal;
    if (select.selectedIndex === -1) select.value = '';
    applyTagStyles(select, select.value);
  }

  function insertColumn(colgroup) {
    if (!colgroup || colgroup.querySelector('.icm-ext-state-col')) return;
    const col = document.createElement('col');
    col.className = 'icm-ext-state-col';
    col.style.width = '148px';
    colgroup.insertBefore(col, colgroup.children[1] || null);
  }

  function reserveColumnWidth(table) {
    if (table.dataset.icmExtStateWidthReserved === 'true') return;
    const currentWidth = Number.parseFloat(table.style.width) || table.getBoundingClientRect().width;
    table.style.width = `${currentWidth + 148}px`;
    table.dataset.icmExtStateWidthReserved = 'true';
  }

  function enhanceGrid() {
    for (const grid of document.querySelectorAll('.searchresults-k-grid')) {
      const headerTable = grid.querySelector('.k-grid-header table');
      const bodyTable = grid.querySelector('.k-grid-content table') ||
        grid.querySelector('.k-grid-header + .k-grid-content table');
      if (!headerTable || !bodyTable) continue;

      reserveColumnWidth(headerTable);
      reserveColumnWidth(bodyTable);
      insertColumn(headerTable.querySelector('colgroup'));
      insertColumn(bodyTable.querySelector('colgroup'));

      const headerRow = headerTable.querySelector('thead tr');
      if (headerRow && !headerRow.querySelector('.icm-ext-state-th')) {
        const heading = document.createElement('th');
        heading.className = 'k-header icm-ext-state-th';
        heading.setAttribute('role', 'columnheader');
        heading.appendChild(createFilter());
        headerRow.insertBefore(heading, headerRow.children[1] || null);
      }
      const headerFilter = headerRow?.querySelector('.icm-ext-state-filter');
      if (headerFilter &&
          headerFilter._tagsSignature !== JSON.stringify(Array.from(tagsMap.values()))) {
        headerFilter._updateMenuContent();
      }

      for (const row of bodyTable.querySelectorAll('tbody tr[role="row"]')) {
        const incidentId = getIncidentId(row);
        const existingCell = row.querySelector('.icm-ext-state-td');
        const existingSelect = existingCell?.querySelector('.icm-ext-state-select');
        if (existingSelect && incidentId) {
          const label = `事件 ${incidentId} 的 Tag`;
          if (existingSelect.getAttribute('aria-label') !== label) {
            existingSelect.setAttribute('aria-label', label);
          }
          updateSelectOptions(existingSelect);
          existingSelect.value = getIncidentTagId(incidentId);
          applyTagStyles(existingSelect, existingSelect.value);
          continue;
        }
        if (existingCell && !incidentId && !existingSelect) continue;
        if (existingCell) existingCell.remove();

        const cell = document.createElement('td');
        cell.className = 'icm-ext-state-td';
        cell.setAttribute('role', 'gridcell');

        if (!incidentId) {
          cell.setAttribute('aria-label', '无法识别事件 ID');
          row.insertBefore(cell, row.children[1] || null);
          continue;
        }

        const select = document.createElement('select');
        select.className = 'icm-ext-state-select';
        select.setAttribute('aria-label', `事件 ${incidentId} 的 Tag`);
        select.setAttribute('title', 'Tag');

        updateSelectOptions(select);
        select.value = getIncidentTagId(incidentId);
        applyTagStyles(select, select.value);

        for (const eventName of ['pointerdown', 'mousedown', 'click']) {
          select.addEventListener(eventName, event => event.stopPropagation());
        }
        
        select.addEventListener('change', async event => {
          event.stopPropagation();
          const currentIncidentId = getIncidentId(row);
          if (!currentIncidentId) {
            console.error('Failed to identify incident for Tag change');
            window.alert('无法识别事件 ID，请刷新页面后重试。');
            return;
          }
          const previousTagId = getIncidentTagId(currentIncidentId);
          const tagId = event.currentTarget.value;
          applyTagStyles(event.currentTarget, tagId);
          try {
            await saveIncidentTag(currentIncidentId, tagId);
          } catch (error) {
            incidentTagsMap.set(currentIncidentId, previousTagId || null);
            console.error('Failed to save incident Tag', error);
            window.alert(`保存 Tag 失败。\n${storageErrorDetails(error)}`);
          }
          refreshAllGrids();
        });

        cell.appendChild(select);
        row.insertBefore(cell, row.children[1] || null);
      }
      applyFilter(grid);
    }
  }

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (initialized && areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, DETAIL_POSITION_KEY)) {
      try {
        detailPosition = parseDetailPosition(changes[DETAIL_POSITION_KEY].newValue);
        detailControl?._applyPosition();
      } catch (error) {
        reportPositionError(error, 'load');
      }
      return;
    }
    if (!initialized || areaName !== 'sync' || !Object.keys(changes).some(key => key.startsWith(STORAGE_PREFIX))) return;
    const shouldUpdateFilters = Object.keys(changes).some(key => key.startsWith(STORAGE_PREFIX + 'tag:'));
    try {
      await loadData();
    } catch (error) {
      console.error('Failed to reload synced Tags', error);
      window.alert(`读取同步 Tag 失败。\n${storageErrorDetails(error)}`);
      return;
    }
    if (shouldUpdateFilters) {
      document.querySelectorAll('.icm-ext-state-filter').forEach(f => {
        if (f._updateMenuContent) f._updateMenuContent();
      });
      document.querySelectorAll('.icm-ext-state-select').forEach(s => {
        updateSelectOptions(s);
      });
    }

    refreshAllGrids();
  });

  const observer = new MutationObserver(mutations => {
    const hasRelevantChange = mutations.some(mutation =>
      (mutation.type === 'attributes' &&
        !mutation.target.closest('.icm-ext-state-td, .icm-ext-state-filter, .icm-ext-state-filter-menu')) ||
      Array.from(mutation.addedNodes).some(node =>
        node.nodeType === Node.ELEMENT_NODE &&
        !node.matches?.('.icm-ext-state-col, .icm-ext-state-th, .icm-ext-state-td')
      )
    );
    if (!hasRelevantChange) return;

    clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(() => {
      enhanceGrid();
      enhanceDetailPage();
    }, 50);
  });

  async function init() {
    try {
      await migrateLocalData();
      await loadData();
    } catch (error) {
      console.error('Failed to initialize synced Tags', error);
      window.alert(`初始化 Tag 同步失败，原有本地数据仍保留。\n${storageErrorDetails(error)}`);
      return;
    }
    try {
      const localData = await chrome.storage.local.get(DETAIL_POSITION_KEY);
      detailPosition = parseDetailPosition(localData[DETAIL_POSITION_KEY]);
    } catch (error) {
      reportPositionError(error, 'load');
    }
    initialized = true;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'aria-label', 'id']
    });
    enhanceGrid();
    enhanceDetailPage();
    // pushState does not emit popstate; check routes even when the page reuses its DOM.
    setInterval(() => {
      if (location.href === currentPageUrl) return;
      currentPageUrl = location.href;
      enhanceGrid();
      enhanceDetailPage();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
