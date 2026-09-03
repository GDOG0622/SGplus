import { familyKey, inferGroups, normalizeName } from '../grouping.js';
import {
    bindSearchInput,
    confirmAction,
    DISPLAY_NAME,
    escapeHtml,
    focusSearchAt,
    isCoarsePointer,
    promptText,
    scheduleSave,
    settings,
    toast,
} from '../shared.js';
import {
    destroyNativeSortable,
    getOrderEntry,
    getOverriddenPrompts,
    getPrefix,
    getPromptById,
    getPromptManager,
    getPromptOrder,
    getScrollContainer,
    getTokenBudget,
    getTokenCounts,
    getTokenUsage,
    INJECTION_POSITION,
    invokeNativeHandler,
    isDeletionAllowed,
    isEditAllowed,
    isInspectionAllowed,
    isToggleAllowed,
    saveHostServiceSettings,
    scheduleHostRender,
} from './host.js';
import {
    assignPrompt,
    buildBlocks,
    createGroup,
    deleteGroup,
    findGroup,
    isFavorite,
    moveBlock,
    movePromptWithin,
    normalizeOrder,
    placeBlock,
    readState,
    renameGroup,
    setFavoritesCollapsed,
    setGroupCollapsed,
    setGroupEnabled,
    toggleFavorite,
} from './state.js';

const MENU_ID = 'sgp-row-menu';

const view = {
    search: '',
    selecting: false,
    selection: new Set(),
    caret: null,
};

let renderScheduled = false;

export function isTakeoverEnabled() {
    return Boolean(settings?.enabled && settings?.enhancePromptEntries);
}

export function resetView() {
    view.search = '';
    view.selecting = false;
    view.selection.clear();
    view.caret = null;
}

function promptLabel(identifier) {
    return normalizeName(getPromptById(identifier)?.name) || identifier;
}

function matchesSearch(identifier) {
    const query = normalizeName(view.search).toLocaleLowerCase();
    if (!query) return true;
    return promptLabel(identifier).toLocaleLowerCase().includes(query);
}

function tokenLabel(counts, identifier) {
    const value = counts[identifier];
    return value ? String(value) : '-';
}

function roleIconFor(prompt) {
    const lookup = prompt.role === 'system' && (prompt.marker || prompt.system_prompt) ? '' : prompt.role;
    if (lookup === 'assistant') return { icon: 'fa-robot', title: 'Prompt will be sent as Assistant' };
    if (lookup === 'user') return { icon: 'fa-user', title: 'Prompt will be sent as User' };
    return null;
}

/**
 * Rebuilds SillyTavern's own row markup so host styling and other extensions
 * keep working.
 *
 * The row is always a direct `<li>`: the HTML parser auto-closes an open `<li>`
 * when it meets another one, so a loose row carries its own block id rather
 * than living inside a wrapper element.
 */
function renderRow(entry, { mirror = false, dragEnabled = true, counts, prefix, state, blockId = '' } = {}) {
    const identifier = entry.identifier;
    const prompt = getPromptById(identifier);
    if (!prompt) return '';
    const enabled = entry.enabled !== false;
    const groupId = state.assignments[identifier] || '';
    const group = groupId ? findGroup(state, groupId) : null;
    const muted = group?.enabled === false;
    const favorited = state.favorites.includes(identifier);
    const selected = view.selection.has(identifier);
    const name = escapeHtml(prompt.name ?? identifier);

    const isMarker = prompt.marker && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE;
    const isSystem = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE && !prompt.forbid_overrides;
    const isImportant = !prompt.marker && prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE && prompt.forbid_overrides;
    const isUser = !prompt.marker && !prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE;
    const isInjection = prompt.injection_position === INJECTION_POSITION.ABSOLUTE;
    const isOverridden = getOverriddenPrompts().includes(identifier);
    const role = roleIconFor(prompt);

    const classes = [
        `${prefix}prompt_manager_prompt`,
        `${prefix}prompt_manager_prompt_draggable`,
        'sgp-row',
        enabled ? '' : `${prefix}prompt_manager_prompt_disabled`,
        prompt.marker ? `${prefix}prompt_manager_marker` : '',
        isImportant ? `${prefix}prompt_manager_important` : '',
        muted ? 'sgp-row-muted' : '',
        mirror ? 'sgp-row-mirror' : '',
        selected ? 'sgp-row-selected' : '',
        blockId ? 'sgp-loose-row' : '',
    ].filter(Boolean).join(' ');

    const tokens = tokenLabel(counts, identifier);
    const budget = getTokenBudget();
    let warningClass = '';
    let warningTitle = '';
    if (identifier === 'chatHistory' && budget > 0 && getTokenUsage() > budget * 0.8) {
        const numeric = Number(counts[identifier]) || 0;
        const configuration = getPromptManager()?.configuration || {};
        if (numeric <= Number(configuration.dangerTokenThreshold)) {
            warningClass = 'fa-solid tooltip fa-triangle-exclamation text_danger';
            warningTitle = '发送的聊天记录非常少，考虑关闭一些其他条目。';
        } else if (numeric <= Number(configuration.warningTokenThreshold)) {
            warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
            warningTitle = '只有少量聊天记录被发送。';
        }
    }

    const nameBody = !mirror && isInspectionAllowed(prompt)
        ? `<a title="${name}" class="prompt-manager-inspect-action">${name}</a>`
        : `<span title="${name}">${name}</span>`;

    const leading = view.selecting && !mirror
        ? `<input type="checkbox" class="sgp-check" data-sgp-select-row="${escapeHtml(identifier)}" ${selected ? 'checked' : ''} aria-label="选择 ${name}">`
        : (!mirror && dragEnabled ? '<span class="drag-handle ui-sortable-handle" data-sgp-row-handle>☰</span>' : '');

    const favoriteButton = settings.promptFavoritesEnabled
        ? `<span class="sgp-star ${favorited ? 'active' : ''}" data-sgp-favorite="${escapeHtml(identifier)}" title="${favorited ? '取消收藏' : '收藏此条目'}"><i class="fa-solid fa-star"></i></span>`
        : '';
    const menuButton = mirror
        ? ''
        : `<span class="sgp-more" data-sgp-menu="${escapeHtml(identifier)}" title="更多操作"><i class="fa-solid fa-ellipsis"></i></span>`;
    const toggleButton = isToggleAllowed(prompt)
        ? `<span class="prompt-manager-toggle-action ${enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}" data-sgp-toggle="${escapeHtml(identifier)}" title="${enabled ? '停用此条目' : '启用此条目'}"></span>`
        : '<span class="fa-solid"></span>';

    return `
        <li class="${classes}" data-pm-identifier="${escapeHtml(identifier)}" ${blockId ? `data-sgp-block="${escapeHtml(blockId)}"` : ''} ${mirror ? 'data-sgp-mirror="true"' : ''} draggable="${!mirror && dragEnabled && !view.selecting ? 'true' : 'false'}">
            ${leading}
            <span class="${prefix}prompt_manager_prompt_name" data-pm-name="${name}">
                ${isMarker ? '<span class="fa-fw fa-solid fa-thumb-tack" title="Marker"></span>' : ''}
                ${isSystem ? '<span class="fa-fw fa-solid fa-square-poll-horizontal" title="Global Prompt"></span>' : ''}
                ${isImportant ? '<span class="fa-fw fa-solid fa-star" title="Important Prompt"></span>' : ''}
                ${isUser ? '<span class="fa-fw fa-solid fa-asterisk" title="Preset Prompt"></span>' : ''}
                ${isInjection ? '<span class="fa-fw fa-solid fa-syringe" title="In-Chat Injection"></span>' : ''}
                ${nameBody}
                ${role ? `<span data-role="${escapeHtml(prompt.role)}" class="fa-xs fa-solid ${role.icon}" title="${role.title}"></span>` : ''}
                ${isInjection ? `<small class="prompt-manager-injection-depth">@ ${escapeHtml(String(prompt.injection_depth ?? 0))}</small>` : ''}
                ${isOverridden ? '<small class="fa-solid fa-address-card prompt-manager-overridden" title="Pulled from a character card"></small>' : ''}
                ${muted ? '<small class="sgp-muted-badge" title="所属分组已静音，本条目不会参与生成">静音</small>' : ''}
            </span>
            <span class="sgp-controls-cell">
                <span class="prompt_manager_prompt_controls">${favoriteButton}${menuButton}${toggleButton}</span>
            </span>
            <span class="prompt_manager_prompt_tokens" data-pm-tokens="${escapeHtml(tokens)}"><span class="${warningClass}" title="${escapeHtml(warningTitle)}"> </span>${escapeHtml(tokens)}</span>
        </li>
    `;
}

function renderRows(entries, options) {
    return entries.map(entry => renderRow(entry, options)).join('');
}

function renderGroupBlock(block, { index, total, counts, prefix, state, dragEnabled, searching }) {
    const group = block.group;
    const visible = block.members.filter(entry => matchesSearch(entry.identifier));
    if (searching && !visible.length && !group.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase())) return '';
    const collapsed = searching ? false : group.collapsed !== false;
    const enabledCount = block.members.filter(entry => entry.enabled !== false).length;
    const muted = group.enabled === false;
    const body = collapsed
        ? ''
        : (renderRows(visible, { counts, prefix, state, dragEnabled })
            || '<li class="pgm-empty sgp-empty">把条目拖到这里，或用条目菜单里的“移动到分组”</li>');

    return `
        <li class="sgp-block pgm-group sgp-group ${collapsed ? 'collapsed' : ''} ${muted ? 'sgp-group-muted' : ''}" data-sgp-group="${escapeHtml(group.id)}" data-sgp-block="${escapeHtml(group.id)}">
            <div class="pgm-group-head sgp-group-head">
                <span class="pgm-drag sgp-block-drag" draggable="${dragEnabled ? 'true' : 'false'}" data-sgp-drag-block="${escapeHtml(group.id)}" title="拖动分组排序">⠿</span>
                <button type="button" class="pgm-group-toggle sgp-group-toggle" data-sgp-collapse="${escapeHtml(group.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">
                    <span class="pgm-chevron">▾</span><strong class="pgm-group-name">${escapeHtml(group.name)}</strong><span class="pgm-count">${enabledCount}/${block.members.length}</span>
                </button>
                <div class="pgm-group-actions sgp-group-actions">
                    <button type="button" class="pgm-row-btn sgp-power ${muted ? 'muted' : ''}" data-sgp-power="${escapeHtml(group.id)}" title="${muted ? '恢复整组参与生成' : '整组静音：不参与生成，但保留每条开关'}"><i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i></button>
                    <button type="button" class="pgm-row-btn reorder" data-sgp-block-up="${escapeHtml(group.id)}" ${index === 0 ? 'disabled' : ''} title="上移分组">↑</button>
                    <button type="button" class="pgm-row-btn reorder" data-sgp-block-down="${escapeHtml(group.id)}" ${index === total - 1 ? 'disabled' : ''} title="下移分组">↓</button>
                    <button type="button" class="pgm-row-btn" data-sgp-rename="${escapeHtml(group.id)}" title="重命名分组">✎</button>
                    <button type="button" class="pgm-row-btn danger" data-sgp-delete="${escapeHtml(group.id)}" title="删除分组（条目回到未分组）">×</button>
                </div>
            </div>
            <ul class="pgm-group-body sgp-group-body">${body}</ul>
        </li>
    `;
}

function renderFavorites({ counts, prefix, state }) {
    if (!settings.promptFavoritesEnabled) return '';
    const order = getPromptOrder();
    const entries = state.favorites
        .map(identifier => order.find(entry => entry?.identifier === identifier))
        .filter(entry => entry && matchesSearch(entry.identifier));
    if (!entries.length) return '';
    const collapsed = normalizeName(view.search) ? false : Boolean(state.favoritesCollapsed);
    const body = collapsed ? '' : renderRows(entries, { counts, prefix, state, mirror: true, dragEnabled: false });
    return `
        <li class="sgp-block pgm-group sgp-favorites ${collapsed ? 'collapsed' : ''}">
            <div class="pgm-group-head sgp-group-head">
                <button type="button" class="pgm-group-toggle sgp-group-toggle" data-sgp-collapse-favorites aria-expanded="${collapsed ? 'false' : 'true'}">
                    <span class="pgm-chevron">▾</span><strong class="pgm-group-name"><i class="fa-solid fa-star sgp-fav-icon"></i> 收藏</strong><span class="pgm-count">${entries.length}</span>
                </button>
            </div>
            <ul class="pgm-group-body sgp-group-body">${body}</ul>
        </li>
    `;
}

function renderToolbar(state, blocks) {
    const order = getPromptOrder();
    const enabled = order.filter(entry => entry.enabled !== false).length;
    const groupCount = state.groups.length;
    const locked = Boolean(settings.promptDragLocked);
    const selectedCount = view.selection.size;

    const batchBar = view.selecting
        ? `
            <div class="sgp-batch-bar">
                <span class="sgp-batch-count">已选 ${selectedCount} 条</span>
                <button type="button" class="pgm-btn" data-sgp-batch="enable" ${selectedCount ? '' : 'disabled'}>启用</button>
                <button type="button" class="pgm-btn" data-sgp-batch="disable" ${selectedCount ? '' : 'disabled'}>停用</button>
                <button type="button" class="pgm-btn" data-sgp-batch="favorite" ${selectedCount ? '' : 'disabled'}>收藏</button>
                <select class="pgm-move sgp-batch-move" data-sgp-batch-move ${selectedCount ? '' : 'disabled'}>
                    <option value="">移动到…</option>
                    <option value="__none">未分组</option>
                    ${state.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}
                    <option value="__new">＋ 新建分组…</option>
                </select>
                <button type="button" class="pgm-btn" data-sgp-batch="all">全选</button>
                <button type="button" class="pgm-btn" data-sgp-select-mode="off">退出多选</button>
            </div>
        `
        : '';

    return `
        <li class="sgp-block sgp-toolbar-block">
            <div class="pgm-tools sgp-tools">
                <input type="search" class="pgm-search sgp-search" data-sgp-search placeholder="搜索预设条目..." value="${escapeHtml(view.search)}">
                <button type="button" class="pgm-btn primary" data-sgp-smart title="按条目名称推断分组，已手动分组的条目不会被打乱">智能整理</button>
                <button type="button" class="pgm-btn" data-sgp-add-group>＋ 新建分组</button>
                <button type="button" class="pgm-btn" data-sgp-select-mode="${view.selecting ? 'off' : 'on'}">${view.selecting ? '退出多选' : '多选'}</button>
                <button type="button" class="pgm-icon-btn sgp-lock ${locked ? 'active' : ''}" data-sgp-lock title="${locked ? '拖拽已锁定，点击解锁' : '锁定拖拽，避免误拖'}"><i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
            </div>
            ${batchBar}
            <div class="pgm-hint sgp-hint">共 ${order.length} 条，已启用 ${enabled} 条，${groupCount} 个分组，${blocks.filter(block => block.type === 'item').length} 条未分组。分组只改变列表呈现与生成过滤，不会改写条目内容。</div>
        </li>
    `;
}

/** Draws the grouped prompt list into SillyTavern's own list element. */
export async function renderGroupedList() {
    const manager = getPromptManager();
    const list = manager?.listElement;
    if (!list) return;
    const prefix = getPrefix();
    const state = readState();
    const counts = getTokenCounts();
    const searching = Boolean(normalizeName(view.search));
    const dragEnabled = !searching && !view.selecting && !settings.promptDragLocked && !isCoarsePointer();
    const blocks = buildBlocks(state, getPromptOrder());

    const scroller = getScrollContainer();
    const previousScrollTop = scroller?.scrollTop ?? 0;
    const sections = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.type === 'group') {
            sections.push(renderGroupBlock(block, { index, total: blocks.length, counts, prefix, state, dragEnabled, searching }));
            continue;
        }
        const entry = block.members[0];
        if (!entry || !matchesSearch(entry.identifier)) continue;
        sections.push(renderRow(entry, { counts, prefix, state, dragEnabled, blockId: block.id }));
    }

    list.innerHTML = `
        ${renderToolbar(state, blocks)}
        <li class="${prefix}prompt_manager_list_head">
            <span>名称</span>
            <span></span>
            <span class="prompt_manager_prompt_tokens">Tokens</span>
        </li>
        <li class="${prefix}prompt_manager_list_separator"><hr></li>
        ${renderFavorites({ counts, prefix, state })}
        ${sections.join('') || '<li class="pgm-empty sgp-empty sgp-empty-large">没有匹配的条目</li>'}
    `;

    destroyNativeSortable();
    bindListEvents(list, { dragEnabled, searching });

    const searchInput = list.querySelector('[data-sgp-search]');
    if (view.caret && searchInput) {
        focusSearchAt(searchInput, view.caret.selectionStart, view.caret.selectionEnd);
        view.caret = null;
    }
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
    return list.querySelector(`[data-pm-identifier="${CSS.escape(identifier)}"]:not([data-sgp-mirror])`);
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
}

/** A compact popover menu in the same visual language as the resource picker. */
function openRowMenu(anchor, identifier) {
    closeRowMenu();
    const state = readState();
    const prompt = getPromptById(identifier);
    if (!prompt) return;
    const groupId = state.assignments[identifier] || '';
    const favorited = state.favorites.includes(identifier);

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
        <div class="sgp-menu-row">
            <button type="button" class="pgm-btn" data-sgp-menu-action="up">↑ 上移</button>
            <button type="button" class="pgm-btn" data-sgp-menu-action="down">↓ 下移</button>
        </div>
        <button type="button" class="sgp-menu-item" data-sgp-menu-action="favorite">${favorited ? '取消收藏' : '收藏此条目'}</button>
        ${isEditAllowed(prompt) ? '<button type="button" class="sgp-menu-item" data-sgp-menu-action="edit">编辑条目</button>' : ''}
        ${isInspectionAllowed(prompt) ? '<button type="button" class="sgp-menu-item" data-sgp-menu-action="inspect">查看内容</button>' : ''}
        <button type="button" class="sgp-menu-item" data-sgp-menu-action="copy">复制条目</button>
        ${isDeletionAllowed(prompt) ? '<button type="button" class="sgp-menu-item danger" data-sgp-menu-action="detach">从预设移除</button>' : ''}
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

    menu.querySelectorAll('[data-sgp-menu-action]').forEach(button => {
        button.addEventListener('click', async () => {
            const action = button.dataset.sgpMenuAction;
            closeRowMenu();
            const row = list ? rowFor(list, identifier) : null;
            if (action === 'up' || action === 'down') {
                if (movePromptWithin(identifier, action === 'up' ? -1 : 1)) rerender();
                return;
            }
            if (action === 'favorite') {
                toggleFavorite(identifier);
                rerender();
                return;
            }
            if (action === 'copy') {
                copyEntry(identifier);
                return;
            }
            if (action === 'edit') {
                invokeNativeHandler('handleEdit', row?.querySelector('.prompt-manager-inspect-action') || row);
                return;
            }
            if (action === 'inspect') {
                invokeNativeHandler('handleInspect', row?.querySelector('.prompt-manager-inspect-action') || row);
                return;
            }
            if (action === 'detach') {
                if (!await confirmAction('从预设移除', `把“${prompt.name ?? identifier}”从当前预设的条目列表移除？条目定义仍然保留，可以再次添加。`)) return;
                invokeNativeHandler('handleDetach', row);
                scheduleHostRender(0);
            }
        });
    });
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
    if (action === 'favorite') {
        const state = readState();
        const shouldAdd = targets.some(identifier => !state.favorites.includes(identifier));
        for (const identifier of targets) {
            const favorited = readState().favorites.includes(identifier);
            if (favorited !== shouldAdd) toggleFavorite(identifier);
        }
        toast(`已${shouldAdd ? '收藏' : '取消收藏'} ${targets.length} 个条目`, 'success');
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
    const searchInput = list.querySelector('[data-sgp-search]');
    bindSearchInput(searchInput, ({ value, selectionStart, selectionEnd }) => {
        view.search = value;
        view.caret = { selectionStart, selectionEnd };
        void renderGroupedList();
    });

    list.querySelector('[data-sgp-smart]')?.addEventListener('click', () => void applySmartGrouping());
    list.querySelector('[data-sgp-add-group]')?.addEventListener('click', async () => {
        const name = normalizeName(await promptText('新建分组', '请输入分组名称：', ''));
        if (!name) return;
        if (readState().groups.some(group => familyKey(group.name) === familyKey(name))) {
            toast('已有同名分组', 'warning');
            return;
        }
        createGroup(name);
        rerender();
    });
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
    list.querySelector('[data-sgp-collapse-favorites]')?.addEventListener('click', () => {
        if (searching) return;
        setFavoritesCollapsed(!readState().favoritesCollapsed);
        rerender();
    });
    list.querySelectorAll('[data-sgp-power]').forEach(button => {
        button.addEventListener('click', () => {
            const groupId = button.dataset.sgpPower;
            const group = findGroup(readState(), groupId);
            if (!group) return;
            setGroupEnabled(groupId, group.enabled === false);
            toast(group.enabled === false ? `“${group.name}”已恢复参与生成` : `“${group.name}”已整组静音`, 'success');
            scheduleHostRender(0);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-rename]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgpRename;
            const group = findGroup(readState(), groupId);
            if (!group) return;
            const name = normalizeName(await promptText('重命名分组', '请输入新的分组名称：', group.name));
            if (!name || name === group.name) return;
            if (readState().groups.some(item => item.id !== groupId && familyKey(item.name) === familyKey(name))) {
                toast('已有同名分组', 'warning');
                return;
            }
            renameGroup(groupId, name);
            toast('分组名称已更新', 'success');
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-delete]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgpDelete;
            const group = findGroup(readState(), groupId);
            if (!group) return;
            if (!await confirmAction('删除分组', `删除“${group.name}”？其中的条目会回到未分组，条目本体不会被删除。`)) return;
            deleteGroup(groupId);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-block-up]').forEach(button => {
        button.addEventListener('click', () => {
            if (moveBlock(button.dataset.sgpBlockUp, -1)) rerender();
        });
    });
    list.querySelectorAll('[data-sgp-block-down]').forEach(button => {
        button.addEventListener('click', () => {
            if (moveBlock(button.dataset.sgpBlockDown, 1)) rerender();
        });
    });

    list.querySelectorAll('[data-sgp-toggle]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            toggleEntry(list, element.dataset.sgpToggle);
        });
    });
    list.querySelectorAll('[data-sgp-favorite]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            toggleFavorite(element.dataset.sgpFavorite);
            rerender();
        });
    });
    list.querySelectorAll('[data-sgp-menu]').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            openRowMenu(element, element.dataset.sgpMenu);
        });
    });
    list.querySelectorAll('.prompt-manager-inspect-action').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            invokeNativeHandler('handleInspect', element);
        });
    });

    bindDragAndDrop(list, { dragEnabled });
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
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        if (!menu.contains(event.target) && !event.target?.closest?.('[data-sgp-menu]')) closeRowMenu();
    };
    const dismissOnEscape = event => {
        if (event.key === 'Escape') closeRowMenu();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
        document.removeEventListener('pointerdown', dismiss, true);
        document.removeEventListener('keydown', dismissOnEscape);
        closeRowMenu();
    };
}

export { closeRowMenu };
