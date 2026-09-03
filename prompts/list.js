import { familyKey, inferGroups, normalizeName } from '../grouping.js';
import {
    confirmAction,
    DISPLAY_NAME,
    escapeHtml,
    isCoarsePointer,
    promptText,
    scheduleSave,
    settings,
    toast,
} from '../shared.js';
import {
    destroyNativeSortable,
    getOrderEntry,
    getPrefix,
    getPromptById,
    getPromptManager,
    getPromptOrder,
    getScrollContainer,
    getTokenCounts,
    invokeNativeHandler,
    isToggleAllowed,
    renderNativeList,
    saveHostServiceSettings,
    scheduleHostRender,
} from './host.js';
import {
    chooseInsertGroup,
    createLibraryGroup,
    deleteLibraryGroup,
    deleteLibraryItem,
    editLibraryItemDialog,
    exportLibrary,
    importLibrary,
    insertLibraryItems,
    moveLibraryItem,
    readLibrary,
    renameLibraryGroup,
    setLibraryCollapsed,
    setLibraryGroupCollapsed,
    storePromptInLibrary,
    commitLibrary,
} from './library.js';
import {
    assignPrompt,
    buildBlocks,
    createGroup,
    deleteGroup,
    findGroup,
    moveBlock,
    movePromptWithin,
    normalizeOrder,
    placeBlock,
    readState,
    renameGroup,
    setGroupCollapsed,
    setGroupEnabled,
} from './state.js';

const MENU_ID = 'sgp-row-menu';
const LIBRARY_HOST_ID = 'sgp-global-library-host';

const view = {
    search: '',
    selecting: false,
    selection: new Set(),
};

let renderScheduled = false;

export function isTakeoverEnabled() {
    return Boolean(settings?.enabled && settings?.enhancePromptEntries);
}

export function resetView() {
    view.search = '';
    view.selecting = false;
    view.selection.clear();
}

function promptLabel(identifier) {
    return normalizeName(getPromptById(identifier)?.name) || identifier;
}

function matchesSearch(identifier) {
    const query = normalizeName(view.search).toLocaleLowerCase();
    if (!query) return true;
    return promptLabel(identifier).toLocaleLowerCase().includes(query);
}

/** Builds one flat group-header row; member prompts remain native sibling rows. */
function renderGroupHeader(block, { index, total, dragEnabled, searching }) {
    const group = block.group;
    const collapsed = searching ? false : group.collapsed !== false;
    const enabledCount = block.members.filter(entry => entry.enabled !== false).length;
    const muted = group.enabled === false;

    return `
        <li class="sgp-block pgm-group sgp-group sgp-group-head ${collapsed ? 'collapsed' : ''} ${muted ? 'sgp-group-muted' : ''}" data-sgp-group="${escapeHtml(group.id)}" data-sgp-block="${escapeHtml(group.id)}">
            <span class="pgm-drag sgp-block-drag" draggable="${dragEnabled ? 'true' : 'false'}" data-sgp-drag-block="${escapeHtml(group.id)}" title="拖动分组排序">⠿</span>
            <button type="button" class="pgm-group-toggle sgp-group-toggle" data-sgp-collapse="${escapeHtml(group.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                <span class="pgm-chevron">▾</span><strong class="pgm-group-name">${escapeHtml(group.name)}</strong><span class="pgm-count">${enabledCount}/${block.members.length}</span>
            </button>
            <span class="pgm-group-actions sgp-group-actions">
                <span class="sgp-group-inline-actions" aria-hidden="true">
                    <button type="button" class="pgm-row-btn sgp-power ${muted ? 'muted' : ''}" data-sgp-group-action="power" title="${muted ? '恢复整组参与生成' : '整组静音'}"><i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></button>
                    <button type="button" class="pgm-row-btn" data-sgp-group-action="up" ${index <= 0 ? 'disabled' : ''} title="上移分组"><i class="fa-solid fa-arrow-up"></i></button>
                    <button type="button" class="pgm-row-btn" data-sgp-group-action="down" ${index >= total - 1 ? 'disabled' : ''} title="下移分组"><i class="fa-solid fa-arrow-down"></i></button>
                    <button type="button" class="pgm-row-btn" data-sgp-group-action="rename" title="重命名分组"><i class="fa-solid fa-pencil"></i></button>
                    <button type="button" class="pgm-row-btn danger" data-sgp-group-action="delete" title="删除分组"><i class="fa-solid fa-xmark"></i></button>
                </span>
                <button type="button" class="pgm-row-btn sgp-group-more" data-sgp-group-menu="${escapeHtml(group.id)}" title="更多分组操作" aria-label="更多分组操作" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
            </span>
        </li>
    `;
}

function createNodes(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return [...template.content.childNodes];
}

/**
 * Adds SGplus controls to the exact `<li>` created by SillyTavern. Native
 * edit/toggle/detach nodes are retained, so their event handlers and any
 * custom CSS that targets the host row continue to work.
 */
function decorateNativeRow(row, entry, { dragEnabled, state, collapsed = false, blockId = '' }) {
    const identifier = entry.identifier;
    const prompt = getPromptById(identifier);
    if (!prompt) return null;
    const groupId = state.assignments[identifier] || '';
    const group = groupId ? findGroup(state, groupId) : null;
    const muted = group?.enabled === false;

    row.classList.add('sgp-row');
    row.classList.toggle('sgp-row-muted', muted);
    row.classList.toggle('sgp-row-selected', view.selection.has(identifier));
    row.classList.toggle('sgp-loose-row', !groupId);
    row.classList.toggle('sgp-group-member-collapsed', collapsed);
    row.dataset.sgpGroupMember = groupId;
    row.dataset.sgpBlock = blockId || groupId || identifier;
    row.draggable = Boolean(dragEnabled && !view.selecting);

    const nameCell = row.querySelector(`.${getPrefix()}prompt_manager_prompt_name`);
    if (muted && nameCell) {
        const badge = document.createElement('small');
        badge.className = 'sgp-muted-badge';
        badge.title = '所属分组已静音，本条目不会参与生成';
        badge.textContent = '静音';
        nameCell.appendChild(badge);
    }

    const handle = row.querySelector('.drag-handle');
    if (handle) {
        handle.hidden = view.selecting;
        handle.classList.toggle('ui-sortable-handle', Boolean(dragEnabled && !view.selecting));
        handle.toggleAttribute('data-sgp-row-handle', Boolean(dragEnabled && !view.selecting));
    }
    if (view.selecting && nameCell) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'sgp-check';
        check.dataset.sgpSelectRow = identifier;
        check.checked = view.selection.has(identifier);
        check.setAttribute('aria-label', `选择 ${prompt.name ?? identifier}`);
        nameCell.before(check);
    }

    const controls = row.querySelector('.prompt_manager_prompt_controls');
    if (!controls) return row;
    controls.parentElement?.classList.add('sgp-controls-cell');
    for (const child of [...controls.children]) {
        if (child.classList.length === 1 && child.classList.contains('fa-solid')) child.remove();
    }

    const nativeDetach = controls.querySelector('.prompt-manager-detach-action');
    const actionButton = (action, icon, title) => `<span class="menu_button sgp-prompt-action" data-sgp-row-action="${action}" data-sgp-row-id="${escapeHtml(identifier)}" title="${title}"><i class="fa-solid ${icon}"></i></span>`;
    const actions = document.createElement('span');
    actions.className = 'sgp-prompt-actions';
    actions.setAttribute('aria-hidden', 'true');
    actions.innerHTML = [
        actionButton('move', 'fa-folder-tree', '移动到分组'),
        actionButton('library', 'fa-database', '添加到全局库'),
        actionButton('up', 'fa-arrow-up', '上移条目'),
        actionButton('down', 'fa-arrow-down', '下移条目'),
        actionButton('copy', 'fa-copy', '复制条目'),
    ].join('');
    if (nativeDetach) {
        nativeDetach.classList.add('sgp-prompt-action', 'danger');
        nativeDetach.title = '从预设移除';
        actions.appendChild(nativeDetach);
    }

    const more = document.createElement('span');
    more.className = 'menu_button sgp-prompt-icon-button sgp-more';
    more.dataset.sgpMenu = identifier;
    more.title = '更多操作';
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    controls.prepend(actions, more);
    return row;
}

/**
 * The cross-preset snippet shelf, rendered above and outside the preset list
 * so it keeps the same stable hierarchy as Prompt Manager's own controls.
 */
function renderLibrary() {
    const library = readLibrary();
    const query = normalizeName(view.search).toLocaleLowerCase();
    const matches = item => !query || item.name.toLocaleLowerCase().includes(query);
    const visible = library.items.filter(matches);
    const collapsed = query ? !visible.length : library.collapsed !== false;

    const renderItems = items => items.map(item => `
        <li class="sgp-library-row" data-sgp-library-item="${escapeHtml(item.id)}">
            <span class="sgp-library-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="sgp-library-actions">
                <span class="sgp-library-inline-actions" aria-hidden="true">
                    <button type="button" class="pgm-row-btn" data-sgp-library-insert="${escapeHtml(item.id)}" title="插入到当前预设"><i class="fa-solid fa-file-circle-plus"></i></button>
                    <button type="button" class="pgm-row-btn" data-sgp-library-edit="${escapeHtml(item.id)}" title="编辑内容"><i class="fa-solid fa-pencil"></i></button>
                    <button type="button" class="pgm-row-btn danger" data-sgp-library-delete="${escapeHtml(item.id)}" title="从库中删除"><i class="fa-solid fa-trash"></i></button>
                </span>
                <button type="button" class="pgm-row-btn sgp-library-more" data-sgp-library-menu="${escapeHtml(item.id)}" title="更多操作" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
            </span>
        </li>
    `).join('');

    const sections = [];
    const loose = visible.filter(item => !item.groupId);
    if (loose.length) sections.push(`<ul class="sgp-library-list" data-sgp-library-drop="">${renderItems(loose)}</ul>`);

    for (const group of library.groups) {
        const items = visible.filter(item => item.groupId === group.id);
        if (query && !items.length && !group.name.toLocaleLowerCase().includes(query)) continue;
        const groupCollapsed = query ? false : group.collapsed !== false;
        sections.push(`
            <div class="sgp-library-group ${groupCollapsed ? 'collapsed' : ''}" data-sgp-library-group="${escapeHtml(group.id)}">
                <div class="sgp-library-group-head">
                    <button type="button" class="pgm-group-toggle sgp-group-toggle" data-sgp-library-collapse="${escapeHtml(group.id)}" aria-expanded="${groupCollapsed ? 'false' : 'true'}">
                        <span class="pgm-chevron">▾</span><strong class="pgm-group-name">${escapeHtml(group.name)}</strong><span class="pgm-count">${items.length}</span>
                    </button>
                    <div class="pgm-group-actions">
                        <button type="button" class="pgm-row-btn" data-sgp-library-group-rename="${escapeHtml(group.id)}" title="重命名分组">✎</button>
                        <button type="button" class="pgm-row-btn danger" data-sgp-library-group-delete="${escapeHtml(group.id)}" title="删除分组（条目回到未分组）">×</button>
                    </div>
                </div>
                <ul class="sgp-library-list" data-sgp-library-drop="${escapeHtml(group.id)}">${groupCollapsed ? '' : (renderItems(items) || '<li class="sgp-library-empty">这个分组还是空的</li>')}</ul>
            </div>
        `);
    }

    const body = collapsed
        ? ''
        : `${sections.join('') || '<div class="sgp-library-empty-large">全局库还是空的。在任意条目的“⋯”菜单里选“添加到全局库”，即可跨预设复用。</div>'}`;

    return `
        <div class="sgp-library ${collapsed ? 'collapsed' : ''}">
            <div class="pgm-group-head sgp-group-head sgp-library-head">
                <button type="button" class="pgm-group-toggle sgp-group-toggle" data-sgp-library-toggle aria-expanded="${collapsed ? 'false' : 'true'}">
                    <span class="pgm-chevron">▾</span><strong class="pgm-group-name"><i class="fa-solid fa-box-archive sgp-library-icon"></i> 全局库</strong><span class="pgm-count">${library.items.length}</span>
                </button>
                <div class="sgp-library-head-actions">
                    <button type="button" class="pgm-row-btn" data-sgp-library-add-group title="新建库分组"><i class="fa-solid fa-folder-plus"></i></button>
                    <button type="button" class="pgm-row-btn sgp-library-tools-more" data-sgp-library-tools-menu title="库工具" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
                    <span class="sgp-library-tools-actions" aria-hidden="true">
                        <button type="button" class="pgm-row-btn" data-sgp-library-export title="导出库"><i class="fa-solid fa-file-export"></i></button>
                        <button type="button" class="pgm-row-btn" data-sgp-library-import title="导入库"><i class="fa-solid fa-file-import"></i></button>
                    </span>
                </div>
            </div>
            <div class="sgp-library-body">${body}</div>
            <input type="file" accept="application/json,.json" data-sgp-library-import-file hidden>
        </div>
    `;
}

function renderListHeader(state, counts) {
    const order = getPromptOrder();
    const locked = Boolean(settings.promptDragLocked);
    const selectedCount = view.selection.size;
    const tokenTotal = order.reduce((sum, entry) => sum + (entry.enabled === false ? 0 : Number(counts[entry.identifier]) || 0), 0);

    const batchBar = view.selecting
        ? `
            <div class="sgp-batch-bar">
                <span class="sgp-batch-count">已选 ${selectedCount} 条</span>
                <button type="button" class="pgm-btn" data-sgp-batch="enable" ${selectedCount ? '' : 'disabled'}>启用</button>
                <button type="button" class="pgm-btn" data-sgp-batch="disable" ${selectedCount ? '' : 'disabled'}>停用</button>
                <select class="pgm-move sgp-batch-move" data-sgp-batch-move ${selectedCount ? '' : 'disabled'}>
                    <option value="">移动到…</option>
                    <option value="__none">未分组</option>
                    ${state.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}
                    <option value="__new">＋ 新建分组…</option>
                </select>
                <button type="button" class="pgm-btn" data-sgp-batch="all">全选</button>
                <button type="button" class="pgm-btn" data-sgp-select-mode="off">完成</button>
            </div>
        `
        : '';

    return `
        <li class="${getPrefix()}prompt_manager_list_head sgp-list-head">
            <span class="sgp-token-total">预设总 Token: ${tokenTotal || '计算中'}</span>
            <span class="sgp-list-head-actions">
                <button type="button" class="menu_button fa-solid ${view.selecting ? 'fa-xmark' : 'fa-folder-plus'}" data-sgp-select-mode="${view.selecting ? 'off' : 'on'}" title="${view.selecting ? '取消分组选择' : '创建预设分组'}"></button>
                <button type="button" class="menu_button fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'} sgp-lock ${locked ? 'active' : ''}" data-sgp-lock title="${locked ? '解锁预设拖拽' : '锁定预设拖拽'}"></button>
            </span>
        </li>
        ${batchBar ? `<li class="sgp-block sgp-batch-block">${batchBar}</li>` : ''}
    `;
}

function syncLibraryHost(list) {
    let host = document.getElementById(LIBRARY_HOST_ID);
    if (!host) {
        host = document.createElement('div');
        host.id = LIBRARY_HOST_ID;
        list.before(host);
    }
    host.innerHTML = renderLibrary();
    bindLibraryEvents(host, { searching: false });
    return host;
}

export function removeLibraryHost() {
    document.getElementById(LIBRARY_HOST_ID)?.remove();
}

/** Draws the grouped prompt list into SillyTavern's own list element. */
export async function renderGroupedList() {
    closeRowMenu();
    closeGroupMenu();
    const manager = getPromptManager();
    const list = manager?.listElement;
    if (!list) return;
    const state = readState();
    const counts = getTokenCounts();
    const searching = Boolean(normalizeName(view.search));
    const dragEnabled = !searching && !view.selecting && !settings.promptDragLocked && !isCoarsePointer();
    const blocks = buildBlocks(state, getPromptOrder());

    const scroller = getScrollContainer();
    const previousScrollTop = scroller?.scrollTop ?? 0;
    await renderNativeList();

    const nativeRows = new Map(
        [...list.querySelectorAll('li[data-pm-identifier]')]
            .map(row => [row.dataset.pmIdentifier, row]),
    );
    const fragment = document.createDocumentFragment();
    for (const node of createNodes(renderListHeader(state, counts))) fragment.appendChild(node);

    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.type === 'group') {
            const visible = block.members.filter(entry => matchesSearch(entry.identifier));
            if (searching && !visible.length && !block.group.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase())) continue;
            for (const node of createNodes(renderGroupHeader(block, { index, total: blocks.length, dragEnabled, searching }))) {
                fragment.appendChild(node);
            }
            const collapsed = !searching && block.group.collapsed !== false;
            for (const entry of visible) {
                const row = nativeRows.get(entry.identifier);
                const decorated = row && decorateNativeRow(row, entry, {
                    dragEnabled,
                    state,
                    collapsed,
                    blockId: block.group.id,
                });
                if (decorated) fragment.appendChild(decorated);
            }
            continue;
        }
        const entry = block.members[0];
        if (!entry || !matchesSearch(entry.identifier)) continue;
        const row = nativeRows.get(entry.identifier);
        const decorated = row && decorateNativeRow(row, entry, { dragEnabled, state, blockId: block.id });
        if (decorated) fragment.appendChild(decorated);
    }

    if (!fragment.querySelector?.('li[data-pm-identifier], li.sgp-group')) {
        for (const node of createNodes('<li class="pgm-empty sgp-empty sgp-empty-large">没有匹配的条目</li>')) fragment.appendChild(node);
    }
    list.replaceChildren(fragment);

    syncLibraryHost(list);
    destroyNativeSortable();
    bindListEvents(list, { dragEnabled, searching });
    if (scroller && previousScrollTop) {
        scroller.scrollTop = Math.min(previousScrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    }
}

/** Re-renders our own list without asking SillyTavern for a token recount. */
export function rerender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        if (!isTakeoverEnabled()) return;
        void renderGroupedList();
    });
}

function rowFor(list, identifier) {
    return list.querySelector(`[data-pm-identifier="${CSS.escape(identifier)}"]`);
}

/** Flips a prompt on or off in place, then defers the expensive token recount. */
function toggleEntry(list, identifier) {
    const entry = getOrderEntry(identifier);
    if (!entry) return;
    const prompt = getPromptById(identifier);
    if (prompt && !isToggleAllowed(prompt)) return;
    entry.enabled = entry.enabled === false;
    const counts = getTokenCounts();
    if (counts && identifier in counts) counts[identifier] = null;
    saveHostServiceSettings();

    const prefix = getPrefix();
    for (const row of list.querySelectorAll(`[data-pm-identifier="${CSS.escape(identifier)}"]`)) {
        row.classList.toggle(`${prefix}prompt_manager_prompt_disabled`, entry.enabled === false);
        const toggle = row.querySelector('.prompt-manager-toggle-action');
        if (toggle) {
            toggle.classList.toggle('fa-toggle-on', entry.enabled !== false);
            toggle.classList.toggle('fa-toggle-off', entry.enabled === false);
            toggle.title = entry.enabled !== false ? '停用此条目' : '启用此条目';
        }
    }
    updateGroupCounters(list);
    scheduleHostRender();
}

function updateGroupCounters(list) {
    const state = readState();
    for (const block of buildBlocks(state, getPromptOrder())) {
        if (block.type !== 'group') continue;
        const counter = list.querySelector(`[data-sgp-group="${CSS.escape(block.id)}"] .pgm-count`);
        if (!counter) continue;
        const enabled = block.members.filter(entry => entry.enabled !== false).length;
        counter.textContent = `${enabled}/${block.members.length}`;
    }
    const hint = list.querySelector('.sgp-hint');
    if (hint) {
        const order = getPromptOrder();
        const enabled = order.filter(entry => entry.enabled !== false).length;
        hint.textContent = hint.textContent.replace(/已启用 \d+ 条/, `已启用 ${enabled} 条`);
    }
}

/** Duplicates a prompt definition and its order entry, keeping the group. */
function copyEntry(identifier) {
    const manager = getPromptManager();
    const source = getPromptById(identifier);
    if (!manager || !source) return;
    const prompts = manager.serviceSettings?.prompts;
    const order = getPromptOrder();
    if (!Array.isArray(prompts) || !order.length) return;

    const hostContext = globalThis.SillyTavern?.getContext?.();
    const newId = hostContext?.uuidv4?.() || `sgp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const copy = structuredClone(source);
    copy.identifier = newId;
    copy.name = `${source.name ?? identifier} 副本`;
    copy.system_prompt = false;
    prompts.push(copy);

    const sourceIndex = order.findIndex(entry => entry?.identifier === identifier);
    const sourceEntry = order[sourceIndex];
    order.splice(sourceIndex + 1, 0, { identifier: newId, enabled: sourceEntry?.enabled !== false });

    const groupId = readState().assignments[identifier] || '';
    if (groupId) assignPrompt(newId, groupId, '');
    saveHostServiceSettings();
    toast(`已复制“${source.name ?? identifier}”`, 'success');
    scheduleHostRender(0);
}

function closeRowMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.querySelectorAll('.sgp-row-actions-open').forEach(row => {
        row.classList.remove('sgp-row-actions-open');
        row.querySelector('[data-sgp-menu]')?.setAttribute('aria-expanded', 'false');
        row.querySelector('.sgp-prompt-actions')?.setAttribute('aria-hidden', 'true');
    });
}

function closeGroupMenu() {
    document.querySelectorAll('.sgp-group-actions-open').forEach(group => {
        group.classList.remove('sgp-group-actions-open');
        group.querySelector('[data-sgp-group-menu]')?.setAttribute('aria-expanded', 'false');
        group.querySelector('.sgp-group-inline-actions')?.setAttribute('aria-hidden', 'true');
    });
}

function toggleRowActions(anchor) {
    const row = anchor.closest('.sgp-row');
    const opening = !row?.classList.contains('sgp-row-actions-open');
    closeRowMenu();
    closeGroupMenu();
    if (!opening || !row) return;
    row.classList.add('sgp-row-actions-open');
    anchor.setAttribute('aria-expanded', 'true');
    row.querySelector('.sgp-prompt-actions')?.setAttribute('aria-hidden', 'false');
}

function toggleGroupActions(anchor) {
    const group = anchor.closest('.sgp-group');
    const opening = !group?.classList.contains('sgp-group-actions-open');
    closeRowMenu();
    closeGroupMenu();
    if (!opening || !group) return;
    group.classList.add('sgp-group-actions-open');
    anchor.setAttribute('aria-expanded', 'true');
    group.querySelector('.sgp-group-inline-actions')?.setAttribute('aria-hidden', 'false');
}

/** Group choice is the only row action that needs a compact secondary picker. */
function openRowMoveMenu(anchor, identifier) {
    document.getElementById(MENU_ID)?.remove();
    const state = readState();
    const prompt = getPromptById(identifier);
    if (!prompt) return;
    const groupId = state.assignments[identifier] || '';

    const options = ['<option value="__none"' + (groupId ? '' : ' selected') + '>未分组</option>']
        .concat(state.groups.map(group => `<option value="${escapeHtml(group.id)}" ${group.id === groupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`))
        .concat(['<option value="__new">＋ 新建分组…</option>'])
        .join('');

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'sgp-menu';
    menu.innerHTML = `
        <div class="sgp-menu-title">${escapeHtml(prompt.name ?? identifier)}</div>
        <label class="sgp-menu-field"><span>移动到分组</span>
            <select class="pgm-move" data-sgp-menu-move>${options}</select>
        </label>
    `;
    document.getElementById('srg-root')?.appendChild(menu) ?? document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 240;
    let left = Math.min(rect.right - width, window.innerWidth - width - gap);
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - gap) top = Math.max(gap, rect.top - height - gap);
    menu.style.left = `${Math.max(gap, left)}px`;
    menu.style.top = `${top}px`;

    const list = getPromptManager()?.listElement;
    menu.querySelector('[data-sgp-menu-move]')?.addEventListener('change', async event => {
        const value = event.currentTarget.value;
        closeRowMenu();
        if (value === '__new') {
            const name = normalizeName(await promptText('新建分组', '请输入分组名称：', ''));
            if (!name) return;
            if (state.groups.some(group => familyKey(group.name) === familyKey(name))) {
                toast('已有同名分组', 'warning');
                return;
            }
            const created = createGroup(name, { promptIds: [identifier] });
            if (created) toast(`已把条目移入“${created.name}”`, 'success');
        } else {
            assignPrompt(identifier, value === '__none' ? '' : value, '');
        }
        rerender();
    });
}

async function runRowAction(list, identifier, action, anchor) {
    const prompt = getPromptById(identifier);
    const row = rowFor(list, identifier);
    if (!prompt || !row) return;
    if (action === 'move') {
        openRowMoveMenu(anchor, identifier);
        return;
    }
    closeRowMenu();
    if ((action === 'up' || action === 'down') && movePromptWithin(identifier, action === 'up' ? -1 : 1)) rerender();
    if (action === 'copy') copyEntry(identifier);
    if (action === 'library' && storePromptInLibrary(identifier)) rerender();
    if (action === 'edit') invokeNativeHandler('handleEdit', row.querySelector('.prompt-manager-inspect-action') || row);
    if (action === 'inspect') invokeNativeHandler('handleInspect', row.querySelector('.prompt-manager-inspect-action') || row);
    if (action === 'detach') {
        if (!await confirmAction('从预设移除', `把“${prompt.name ?? identifier}”从当前预设的条目列表移除？条目定义仍然保留，可以再次添加。`)) return;
        invokeNativeHandler('handleDetach', row);
        scheduleHostRender(0);
    }
}

async function runGroupAction(groupId, action) {
    closeGroupMenu();
    const liveGroup = findGroup(readState(), groupId);
    if (!liveGroup) return;
    if (action === 'power') {
        const name = liveGroup.name;
        const shouldEnable = liveGroup.enabled === false;
        setGroupEnabled(groupId, shouldEnable);
        toast(shouldEnable ? `“${name}”已恢复参与生成` : `“${name}”已整组静音`, 'success');
        scheduleHostRender(0);
        rerender();
        return;
    }
    if (action === 'up' || action === 'down') {
        if (moveBlock(groupId, action === 'up' ? -1 : 1)) rerender();
        return;
    }
    if (action === 'rename') {
        const name = normalizeName(await promptText('重命名分组', '请输入新的分组名称：', liveGroup.name));
        if (!name || name === liveGroup.name) return;
        if (readState().groups.some(item => item.id !== groupId && familyKey(item.name) === familyKey(name))) {
            toast('已有同名分组', 'warning');
            return;
        }
        renameGroup(groupId, name);
        toast('分组名称已更新', 'success');
        rerender();
        return;
    }
    if (action === 'delete') {
        if (!await confirmAction('删除分组', `删除“${liveGroup.name}”？其中的条目会回到未分组，条目本体不会被删除。`)) return;
        deleteGroup(groupId);
        rerender();
    }
}

async function applySmartGrouping() {
    const state = readState();
    const order = getPromptOrder();
    const assigned = new Set(Object.keys(state.assignments));
    const candidates = order
        .map(entry => entry?.identifier)
        .filter(identifier => identifier && !assigned.has(identifier));

    const byName = new Map();
    for (const identifier of candidates) {
        const name = promptLabel(identifier);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(identifier);
    }

    const clusters = inferGroups([...byName.keys()], { minGroupSize: settings.minGroupSize });
    if (!clusters.length) {
        toast('没有找到可自动成组的条目名称模式', 'info');
        return;
    }

    let groups = 0;
    let moved = 0;
    for (const cluster of clusters) {
        const promptIds = cluster.names.flatMap(name => byName.get(name) || []);
        if (!promptIds.length) continue;
        const existing = state.groups.find(group => familyKey(group.name) === familyKey(cluster.label));
        if (existing) {
            for (const identifier of promptIds) assignPrompt(identifier, existing.id, '');
        } else {
            createGroup(cluster.label, { promptIds });
            groups++;
        }
        moved += promptIds.length;
    }
    normalizeOrder();
    toast(`智能整理完成：新建 ${groups} 个分组，归入 ${moved} 个条目`, 'success');
    rerender();
}

function batchTargets() {
    return [...view.selection].filter(identifier => getOrderEntry(identifier));
}

/** Keeps the batch controls in step with the checkboxes without a full redraw. */
function syncBatchBar(list) {
    const counter = list.querySelector('.sgp-batch-count');
    if (counter) counter.textContent = `已选 ${view.selection.size} 条`;
    const hasSelection = view.selection.size > 0;
    for (const control of list.querySelectorAll('[data-sgp-batch]:not([data-sgp-batch="all"]), [data-sgp-batch-move]')) {
        control.disabled = !hasSelection;
    }
}

async function runBatchAction(action, list) {
    const targets = batchTargets();
    if (!targets.length) return;
    if (action === 'enable' || action === 'disable') {
        const wanted = action === 'enable';
        let applied = 0;
        for (const identifier of targets) {
            const entry = getOrderEntry(identifier);
            const prompt = getPromptById(identifier);
            if (!entry || (prompt && !isToggleAllowed(prompt))) continue;
            entry.enabled = wanted;
            applied++;
        }
        saveHostServiceSettings();
        const skipped = targets.length - applied;
        toast(`已${wanted ? '启用' : '停用'} ${applied} 个条目${skipped ? `，${skipped} 个不支持开关已跳过` : ''}`, 'success');
        scheduleHostRender(0);
        rerender();
        return;
    }
    if (action === 'all') {
        const order = getPromptOrder();
        const all = order.map(entry => entry?.identifier).filter(identifier => identifier && matchesSearch(identifier));
        const shouldSelectAll = view.selection.size < all.length;
        view.selection.clear();
        if (shouldSelectAll) for (const identifier of all) view.selection.add(identifier);
        rerender();
        return;
    }
    if (action === 'move') {
        rerender();
    }
    void list;
}

function bindListEvents(list, { dragEnabled, searching }) {
    list.querySelectorAll('[data-sgp-select-mode]').forEach(button => {
        button.addEventListener('click', () => {
            view.selecting = button.dataset.sgpSelectMode === 'on';
            view.selection.clear();
            rerender();
        });
    });
    list.querySelector('[data-sgp-lock]')?.addEventListener('click', () => {
        settings.promptDragLocked = !settings.promptDragLocked;
        scheduleSave();
        rerender();
    });
    list.querySelectorAll('[data-sgp-batch]').forEach(button => {
        button.addEventListener('click', () => void runBatchAction(button.dataset.sgpBatch, list));
    });
    list.querySelector('[data-sgp-batch-move]')?.addEventListener('change', async event => {
        const value = event.currentTarget.value;
        const targets = batchTargets();
        if (!value || !targets.length) return;
        if (value === '__new') {
            const name = normalizeName(await promptText('新建分组', '请输入分组名称：', ''));
            if (!name) {
                rerender();
                return;
            }
            createGroup(name, { promptIds: targets });
        } else {
            for (const identifier of targets) assignPrompt(identifier, value === '__none' ? '' : value, '');
        }
        normalizeOrder();
        toast(`已移动 ${targets.length} 个条目`, 'success');
        rerender();
    });
    list.querySelectorAll('[data-sgp-select-row]').forEach(input => {
        input.addEventListener('change', () => {
            const identifier = input.dataset.sgpSelectRow;
            if (input.checked) view.selection.add(identifier);
            else view.selection.delete(identifier);
            input.closest('.sgp-row')?.classList.toggle('sgp-row-selected', input.checked);
            syncBatchBar(list);
        });
    });

    list.querySelectorAll('[data-sgp-collapse]').forEach(button => {
        button.addEventListener('click', () => {
            if (searching) return;
            const groupId = button.dataset.sgpCollapse;
            const group = findGroup(readState(), groupId);
            setGroupCollapsed(groupId, group?.collapsed === false);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-group-menu]').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            toggleGroupActions(button);
        });
    });
    list.querySelectorAll('[data-sgp-group-action]').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            const groupId = button.closest('[data-sgp-group]')?.dataset.sgpGroup || '';
            void runGroupAction(groupId, button.dataset.sgpGroupAction);
        });
    });

    list.querySelectorAll('[data-sgp-toggle]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            toggleEntry(list, element.dataset.sgpToggle);
        });
    });
    list.querySelectorAll('[data-sgp-menu]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            toggleRowActions(element);
        });
    });
    list.querySelectorAll('[data-sgp-row-action]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            void runRowAction(list, element.dataset.sgpRowId, element.dataset.sgpRowAction, element);
        });
    });
    bindDragAndDrop(list, { dragEnabled });
}

function bindLibraryEvents(list, { searching }) {
    list.querySelector('[data-sgp-library-tools-menu]')?.addEventListener('click', event => {
        event.stopPropagation();
        const library = event.currentTarget.closest('.sgp-library');
        const opening = !library?.classList.contains('sgp-library-tools-open');
        library?.classList.toggle('sgp-library-tools-open', opening);
        event.currentTarget.setAttribute('aria-expanded', String(opening));
        library?.querySelector('.sgp-library-tools-actions')?.setAttribute('aria-hidden', String(!opening));
    });
    list.querySelectorAll('[data-sgp-library-menu]').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            const row = button.closest('.sgp-library-row');
            const opening = !row?.classList.contains('sgp-library-actions-open');
            list.querySelectorAll('.sgp-library-actions-open').forEach(item => item.classList.remove('sgp-library-actions-open'));
            row?.classList.toggle('sgp-library-actions-open', opening);
            button.setAttribute('aria-expanded', String(opening));
            row?.querySelector('.sgp-library-inline-actions')?.setAttribute('aria-hidden', String(!opening));
        });
    });
    list.querySelector('[data-sgp-library-toggle]')?.addEventListener('click', () => {
        if (searching) return;
        setLibraryCollapsed(readLibrary().collapsed === false);
        rerender();
    });
    list.querySelectorAll('[data-sgp-library-collapse]').forEach(button => {
        button.addEventListener('click', () => {
            if (searching) return;
            const groupId = button.dataset.sgpLibraryCollapse;
            const group = readLibrary().groups.find(item => item.id === groupId);
            setLibraryGroupCollapsed(groupId, group?.collapsed === false);
            rerender();
        });
    });
    list.querySelector('[data-sgp-library-add-group]')?.addEventListener('click', async () => {
        const name = normalizeName(await promptText('新建库分组', '请输入分组名称：', ''));
        if (!name) return;
        if (readLibrary().groups.some(group => familyKey(group.name) === familyKey(name))) {
            toast('全局库里已有同名分组', 'warning');
            return;
        }
        createLibraryGroup(name);
        rerender();
    });
    list.querySelector('[data-sgp-library-export]')?.addEventListener('click', exportLibrary);
    const fileInput = list.querySelector('[data-sgp-library-import-file]');
    list.querySelector('[data-sgp-library-import]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        await importLibrary(file);
        rerender();
    });

    list.querySelectorAll('[data-sgp-library-insert]').forEach(button => {
        button.addEventListener('click', async () => {
            const itemId = button.dataset.sgpLibraryInsert;
            const target = await chooseInsertGroup();
            if (!target) return;
            const inserted = insertLibraryItems([itemId], target);
            if (inserted) toast(`已插入 ${inserted} 个条目到当前预设`, 'success');
            else toast('插入失败，请稍后再试', 'error');
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-library-edit]').forEach(button => {
        button.addEventListener('click', async () => {
            const itemId = button.dataset.sgpLibraryEdit;
            const item = readLibrary().items.find(entry => entry.id === itemId);
            if (!item) return;
            const result = await editLibraryItemDialog({ title: '编辑全局库条目', name: item.name, content: item.content });
            if (!result) return;
            commitLibrary(library => {
                const target = library.items.find(entry => entry.id === itemId);
                if (!target) return false;
                target.name = result.name;
                target.content = result.content;
                return true;
            });
            toast('全局库条目已更新', 'success');
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-library-delete]').forEach(button => {
        button.addEventListener('click', async () => {
            const itemId = button.dataset.sgpLibraryDelete;
            const item = readLibrary().items.find(entry => entry.id === itemId);
            if (!item || !await confirmAction('删除全局库条目', `从全局库删除“${item.name}”？已经插入到预设里的条目不会受影响。`)) return;
            deleteLibraryItem(itemId);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-library-group-rename]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgpLibraryGroupRename;
            const group = readLibrary().groups.find(item => item.id === groupId);
            if (!group) return;
            const name = normalizeName(await promptText('重命名库分组', '请输入新的分组名称：', group.name));
            if (!name || name === group.name) return;
            renameLibraryGroup(groupId, name);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-library-group-delete]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgpLibraryGroupDelete;
            const group = readLibrary().groups.find(item => item.id === groupId);
            if (!group || !await confirmAction('删除库分组', `删除“${group.name}”？组内条目会回到未分组，不会被删除。`)) return;
            deleteLibraryGroup(groupId);
            rerender();
        });
    });

    // Dragging a library row onto a folder header or list moves it there.
    let draggingLibraryItem = '';
    list.querySelectorAll('[data-sgp-library-item]').forEach(row => {
        row.draggable = true;
        row.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingLibraryItem = row.dataset.sgpLibraryItem || '';
            row.classList.add('sgp-dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', draggingLibraryItem);
            } catch {
                // Same-panel drags only need the state above.
            }
        });
        row.addEventListener('dragend', () => {
            draggingLibraryItem = '';
            list.querySelectorAll('.sgp-dragging, .sgp-drag-over').forEach(element => element.classList.remove('sgp-dragging', 'sgp-drag-over'));
        });
    });
    list.querySelectorAll('[data-sgp-library-drop]').forEach(target => {
        target.addEventListener('dragover', event => {
            if (!draggingLibraryItem) return;
            event.preventDefault();
            event.stopPropagation();
            target.classList.add('sgp-drag-over');
        });
        target.addEventListener('dragleave', event => {
            if (!target.contains(event.relatedTarget)) target.classList.remove('sgp-drag-over');
        });
        target.addEventListener('drop', event => {
            if (!draggingLibraryItem) return;
            event.preventDefault();
            event.stopPropagation();
            moveLibraryItem(draggingLibraryItem, target.dataset.sgpLibraryDrop || '');
            draggingLibraryItem = '';
            rerender();
        });
    });
}

function bindDragAndDrop(list, { dragEnabled }) {
    if (!dragEnabled) return;
    let draggingRow = '';
    let draggingBlock = '';

    const clearDragState = () => {
        draggingRow = '';
        draggingBlock = '';
        list.querySelectorAll('.sgp-dragging, .sgp-drag-over').forEach(element => element.classList.remove('sgp-dragging', 'sgp-drag-over'));
    };

    list.querySelectorAll('.sgp-row[draggable="true"]').forEach(row => {
        row.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingRow = row.dataset.pmIdentifier || '';
            draggingBlock = '';
            row.classList.add('sgp-dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', draggingRow);
            } catch {
                // Same-panel drags only need the state above.
            }
        });
        row.addEventListener('dragend', clearDragState);
    });

    list.querySelectorAll('[data-sgp-drag-block][draggable="true"]').forEach(handle => {
        handle.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingBlock = handle.dataset.sgpDragBlock || '';
            draggingRow = '';
            handle.closest('.sgp-block')?.classList.add('sgp-dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-sgp-block', draggingBlock);
            } catch {
                // Same-panel drags only need the state above.
            }
        });
        handle.addEventListener('dragend', clearDragState);
    });

    // Dropping a row onto a group moves it into that group; dropping onto
    // another row reorders within the target's group.
    list.querySelectorAll('.sgp-group, .sgp-row').forEach(target => {
        target.addEventListener('dragover', event => {
            if (!draggingRow && !draggingBlock) return;
            event.preventDefault();
            event.stopPropagation();
            list.querySelectorAll('.sgp-drag-over').forEach(element => element.classList.remove('sgp-drag-over'));
            target.classList.add('sgp-drag-over');
            try { event.dataTransfer.dropEffect = 'move'; } catch { /* Browser fallback. */ }
        });
        target.addEventListener('dragleave', event => {
            if (!target.contains(event.relatedTarget)) target.classList.remove('sgp-drag-over');
        });
        target.addEventListener('drop', event => {
            if (!draggingRow && !draggingBlock) return;
            event.preventDefault();
            event.stopPropagation();
            const state = readState();

            if (draggingBlock) {
                const targetBlock = target.closest('[data-sgp-block]')?.dataset.sgpBlock || '';
                const bounds = target.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const changed = placeBlock(draggingBlock, targetBlock, placeAfter);
                clearDragState();
                if (changed) rerender();
                return;
            }

            const targetRow = target.closest('.sgp-row');
            if (targetRow && targetRow.dataset.pmIdentifier !== draggingRow) {
                const sibling = targetRow.dataset.pmIdentifier;
                const bounds = targetRow.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const targetGroup = state.assignments[sibling] || '';
                const order = getPromptOrder();
                const siblingIndex = order.findIndex(entry => entry?.identifier === sibling);
                const nextSibling = placeAfter ? order[siblingIndex + 1]?.identifier || '' : sibling;
                assignPrompt(draggingRow, targetGroup, nextSibling);
                clearDragState();
                rerender();
                return;
            }

            const groupId = target.closest('.sgp-group')?.dataset.sgpGroup || '';
            assignPrompt(draggingRow, groupId, '');
            clearDragState();
            rerender();
        });
    });
}

export function bindGlobalRowMenuDismissal() {
    const dismiss = event => {
        const rowMenu = document.getElementById(MENU_ID);
        if (rowMenu && !rowMenu.contains(event.target) && !event.target?.closest?.('[data-sgp-menu]')) closeRowMenu();
        if (!event.target?.closest?.('.sgp-row-actions-open')) closeRowMenu();
        if (!event.target?.closest?.('.sgp-group-actions-open')) closeGroupMenu();
        const library = document.getElementById(LIBRARY_HOST_ID);
        if (library && !event.target?.closest?.('[data-sgp-library-menu], .sgp-library-inline-actions')) {
            library.querySelectorAll('.sgp-library-actions-open').forEach(row => row.classList.remove('sgp-library-actions-open'));
        }
        if (library && !event.target?.closest?.('[data-sgp-library-tools-menu], .sgp-library-tools-actions')) {
            library.querySelector('.sgp-library')?.classList.remove('sgp-library-tools-open');
        }
    };
    // Escape must close this menu only. Without stopping propagation the host
    // would also collapse the whole settings drawer behind it.
    const dismissOnEscape = event => {
        const hasOpenMenu = document.getElementById(MENU_ID)
            || document.querySelector('.sgp-row-actions-open, .sgp-group-actions-open, .sgp-library-actions-open, .sgp-library-tools-open');
        if (event.key !== 'Escape' || !hasOpenMenu) return;
        event.preventDefault();
        event.stopPropagation();
        closeRowMenu();
        closeGroupMenu();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
        document.removeEventListener('pointerdown', dismiss, true);
        document.removeEventListener('keydown', dismissOnEscape, true);
        closeRowMenu();
        closeGroupMenu();
    };
}

export { closeRowMenu };
