import { familyKey, inferGroups, normalizeName } from '../grouping.js';
import {
    bindSearchInput,
    confirmAction,
    DISPLAY_NAME,
    escapeHtml,
    focusSearchAt,
    isCoarsePointer,
    promptText,
    settings,
    toast,
} from '../shared.js';
import { getScripts, isScopedEditable, LIST_TARGETS, setNativeSortableEnabled, SCRIPT_TYPES } from './host.js';
import {
    assignScript,
    buildBlocks,
    createGroup,
    deleteGroup,
    findGroup,
    moveBlock,
    normalizeOrder,
    placeBlock,
    readScope,
    renameGroup,
    setGroupCollapsed,
    setGroupDisabled,
} from './state.js';

const SHELL_CLASS = 'sgr-shell';
const BOUND = new WeakSet();
const views = new Map();

export function isRegexTakeoverEnabled() {
    return Boolean(settings?.enabled && settings?.enhanceRegex);
}

function viewFor(key) {
    if (!views.has(key)) views.set(key, { search: '', caret: null });
    return views.get(key);
}

export function resetViews() {
    for (const view of views.values()) {
        view.search = '';
        view.caret = null;
    }
}

function scriptName(script) {
    return normalizeName(script?.scriptName) || script?.id || '';
}

function matchesSearch(view, script) {
    const query = normalizeName(view.search).toLocaleLowerCase();
    if (!query) return true;
    return scriptName(script).toLocaleLowerCase().includes(query);
}

/** Collects the native rows, wherever a previous pass may have parked them. */
function collectRows(container) {
    const rows = new Map();
    for (const row of container.querySelectorAll('.regex-script-label')) {
        const id = row.id || row.dataset.regexScriptId || '';
        if (id) rows.set(id, row);
    }
    return rows;
}

function renderToolbar(target, scope, blocks, view) {
    const scripts = getScripts(target.type);
    const enabled = scripts.filter(script => !script?.disabled).length;
    return `
        <div class="sgr-tools">
            <input type="search" class="pgm-search sgr-search" data-sgr-search placeholder="搜索${escapeHtml(target.label)}..." value="${escapeHtml(view.search)}">
            <button type="button" class="pgm-btn primary" data-sgr-smart title="按脚本名称推断分组，已手动分组的不会被打乱">智能整理</button>
            <button type="button" class="pgm-btn" data-sgr-add-group>＋ 新建分组</button>
        </div>
        <div class="pgm-hint sgr-hint">共 ${scripts.length} 条，已启用 ${enabled} 条，${scope.groups.length} 个分组，${blocks.filter(block => block.type === 'item').length} 条未分组。分组只改变列表呈现，不会改写正则本体。</div>
    `;
}

function renderGroupHead(group, members, index, total, dragEnabled) {
    const enabled = members.filter(script => !script?.disabled).length;
    const allDisabled = members.length > 0 && enabled === 0;
    return `
        <div class="pgm-group-head sgr-group-head">
            <span class="pgm-drag sgr-block-drag" draggable="${dragEnabled ? 'true' : 'false'}" data-sgr-drag-block="${escapeHtml(group.id)}" title="拖动分组排序">⠿</span>
            <button type="button" class="pgm-group-toggle sgr-group-toggle" data-sgr-collapse="${escapeHtml(group.id)}" aria-expanded="${group.collapsed !== false ? 'false' : 'true'}">
                <span class="pgm-chevron">▾</span><strong class="pgm-group-name">${escapeHtml(group.name)}</strong><span class="pgm-count">${enabled}/${members.length}</span>
            </button>
            <div class="pgm-group-actions sgr-group-actions">
                <button type="button" class="pgm-row-btn sgr-power" data-sgr-toggle-group="${escapeHtml(group.id)}" title="${allDisabled ? '启用整组' : '停用整组'}"><i class="fa-solid ${allDisabled ? 'fa-toggle-off' : 'fa-toggle-on'}"></i></button>
                <button type="button" class="pgm-row-btn reorder" data-sgr-block-up="${escapeHtml(group.id)}" ${index === 0 ? 'disabled' : ''} title="上移分组">↑</button>
                <button type="button" class="pgm-row-btn reorder" data-sgr-block-down="${escapeHtml(group.id)}" ${index === total - 1 ? 'disabled' : ''} title="下移分组">↓</button>
                <button type="button" class="pgm-row-btn" data-sgr-rename="${escapeHtml(group.id)}" title="重命名分组">✎</button>
                <button type="button" class="pgm-row-btn danger" data-sgr-delete="${escapeHtml(group.id)}" title="删除分组（正则回到未分组）">×</button>
            </div>
        </div>
    `;
}

/**
 * Adds a "move to group" control inside the row's own ellipsis disclosure, so
 * it sits with SillyTavern's other secondary actions instead of crowding the
 * row. The disclosure is pure CSS on the host side, so nothing else is needed.
 */
function decorateRow(row, target, scope) {
    const buttons = row.querySelector('.regex_script_buttons');
    if (!buttons) return;
    let select = buttons.querySelector('.sgr-move');
    if (!select) {
        select = document.createElement('select');
        select.className = 'pgm-move sgr-move';
        select.title = '移动到分组';
        buttons.appendChild(select);
    }
    const scriptId = row.id || row.dataset.regexScriptId || '';
    const assigned = scope.assignments[scriptId] || '';
    const wanted = ['', ...scope.groups.map(group => group.id)].join('\u0001');
    if (select.dataset.sgrOptions !== wanted) {
        select.dataset.sgrOptions = wanted;
        select.innerHTML = ['<option value="">未分组</option>']
            .concat(scope.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`))
            .join('');
    }
    select.value = assigned;
    select.dataset.sgrScript = scriptId;
    select.dataset.sgrType = String(target.type);
}

/**
 * Rearranges one native list into grouped sections.
 *
 * The rows themselves are moved, never recreated, so every handler SillyTavern
 * bound to them keeps working and other extensions that query
 * `.regex-script-label` still find what they expect.
 */
export function renderList(target) {
    const container = document.querySelector(target.selector);
    if (!container) return;
    if (!isRegexTakeoverEnabled()) {
        releaseList(container);
        return;
    }
    if (target.type === SCRIPT_TYPES.SCOPED && !isScopedEditable()) {
        releaseList(container);
        return;
    }

    const view = viewFor(target.key);
    const scope = readScope(target.type);
    const scripts = getScripts(target.type);
    if (!scripts.length && !scope.groups.length) {
        releaseList(container);
        return;
    }

    const rows = collectRows(container);
    // SillyTavern draws the rows itself. If it has not done so yet, leave the
    // list alone rather than building group chrome around nothing.
    if (scripts.length && !rows.size) {
        releaseList(container);
        return;
    }

    const blocks = buildBlocks(target.type, scope, scripts);
    const searching = Boolean(normalizeName(view.search));
    const dragEnabled = !searching && !settings.regexDragLocked && !isCoarsePointer();

    let shell = container.querySelector(`:scope > .${SHELL_CLASS}`);
    if (!shell) {
        shell = document.createElement('div');
        shell.className = SHELL_CLASS;
        container.insertBefore(shell, container.firstChild);
    }

    const sections = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.type === 'group') {
            const visible = block.members.filter(script => matchesSearch(view, script));
            if (searching && !visible.length && !block.group.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase())) continue;
            const collapsed = searching ? false : block.group.collapsed !== false;
            sections.push(`
                <div class="sgr-group ${collapsed ? 'collapsed' : ''}" data-sgr-group="${escapeHtml(block.group.id)}" data-sgr-block="${escapeHtml(block.group.id)}">
                    ${renderGroupHead(block.group, block.members, index, blocks.length, dragEnabled)}
                    <div class="sgr-group-body" data-sgr-drop="${escapeHtml(block.group.id)}"></div>
                </div>
            `);
            continue;
        }
        const script = block.members[0];
        if (!script || !matchesSearch(view, script)) continue;
        sections.push(`<div class="sgr-loose" data-sgr-block="${escapeHtml(block.id)}" data-sgr-drop=""></div>`);
    }

    shell.innerHTML = `
        ${renderToolbar(target, scope, blocks, view)}
        <div class="sgr-body">${sections.join('') || '<div class="sgr-empty">没有匹配的正则</div>'}</div>
    `;

    // Park every native row into its section, in block order.
    let sectionIndex = 0;
    const bodies = [...shell.querySelectorAll('[data-sgr-drop]')];
    for (const block of blocks) {
        if (block.type === 'group') {
            const visible = block.members.filter(script => matchesSearch(view, script));
            if (searching && !visible.length && !block.group.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase())) continue;
            const body = bodies[sectionIndex++];
            const collapsed = searching ? false : block.group.collapsed !== false;
            if (!body || collapsed) continue;
            for (const script of visible) {
                const row = rows.get(script.id);
                if (row) body.appendChild(row);
            }
            if (!visible.length) body.innerHTML = '<div class="sgr-empty">把正则拖到这里，或用条目菜单里的“移动到分组”</div>';
            continue;
        }
        const script = block.members[0];
        if (!script || !matchesSearch(view, script)) continue;
        const body = bodies[sectionIndex++];
        const row = rows.get(script.id);
        if (body && row) body.appendChild(row);
    }

    // Anything filtered out by the search must leave the flow without being
    // detached, so the next pass can still find it.
    const parked = shell.querySelector('.sgr-parked') || (() => {
        const node = document.createElement('div');
        node.className = 'sgr-parked';
        shell.appendChild(node);
        return node;
    })();
    for (const [id, row] of rows) {
        if (!shell.contains(row) || row.parentElement === parked) {
            const script = scripts.find(item => item?.id === id);
            if (script && !matchesSearch(view, script)) parked.appendChild(row);
            else if (!shell.contains(row)) parked.appendChild(row);
        }
    }

    for (const row of rows.values()) decorateRow(row, target, scope);
    bindShell(shell, target, { searching });

    if (view.caret) {
        focusSearchAt(shell.querySelector('[data-sgr-search]'), view.caret.selectionStart, view.caret.selectionEnd);
        view.caret = null;
    }
}

/** Puts the rows back as plain children and removes our chrome. */
function releaseList(container) {
    const shell = container.querySelector(`:scope > .${SHELL_CLASS}`);
    if (!shell) return;
    for (const row of shell.querySelectorAll('.regex-script-label')) {
        row.querySelector('.sgr-move')?.remove();
        row.removeAttribute('draggable');
        container.appendChild(row);
    }
    shell.remove();
}

export function releaseAll() {
    for (const target of LIST_TARGETS) {
        const container = document.querySelector(target.selector);
        if (container) releaseList(container);
    }
}

export function renderAll() {
    if (!isRegexTakeoverEnabled()) {
        releaseAll();
        setNativeSortableEnabled(true);
        return;
    }
    setNativeSortableEnabled(false);
    for (const target of LIST_TARGETS) renderList(target);
}

let scheduled = false;
export function rerender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        renderAll();
    });
}

async function applySmartGrouping(target) {
    const scope = readScope(target.type);
    const scripts = getScripts(target.type);
    const assigned = new Set(Object.keys(scope.assignments));
    const candidates = scripts.filter(script => script?.id && !assigned.has(script.id));

    const byName = new Map();
    for (const script of candidates) {
        const name = scriptName(script);
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(script.id);
    }

    const clusters = inferGroups([...byName.keys()], { minGroupSize: settings.minGroupSize });
    if (!clusters.length) {
        toast('没有找到可自动成组的正则名称模式', 'info');
        return;
    }

    let groups = 0;
    let moved = 0;
    for (const cluster of clusters) {
        const scriptIds = cluster.names.flatMap(name => byName.get(name) || []);
        if (!scriptIds.length) continue;
        const existing = scope.groups.find(group => familyKey(group.name) === familyKey(cluster.label));
        if (existing) {
            for (const scriptId of scriptIds) await assignScript(target.type, scriptId, existing.id, '');
        } else {
            createGroup(target.type, cluster.label, { scriptIds });
            groups++;
        }
        moved += scriptIds.length;
    }
    await normalizeOrder(target.type);
    toast(`智能整理完成：新建 ${groups} 个分组，归入 ${moved} 条正则`, 'success');
    rerender();
}

function bindShell(shell, target, { searching }) {
    const view = viewFor(target.key);

    bindSearchInput(shell.querySelector('[data-sgr-search]'), ({ value, selectionStart, selectionEnd }) => {
        view.search = value;
        view.caret = { selectionStart, selectionEnd };
        renderList(target);
    });

    shell.querySelector('[data-sgr-smart]')?.addEventListener('click', () => void applySmartGrouping(target));
    shell.querySelector('[data-sgr-add-group]')?.addEventListener('click', async () => {
        const name = normalizeName(await promptText('新建正则分组', '请输入分组名称：', ''));
        if (!name) return;
        if (readScope(target.type).groups.some(group => familyKey(group.name) === familyKey(name))) {
            toast('已有同名分组', 'warning');
            return;
        }
        createGroup(target.type, name);
        rerender();
    });
    shell.querySelectorAll('[data-sgr-collapse]').forEach(button => {
        button.addEventListener('click', () => {
            if (searching) return;
            const groupId = button.dataset.sgrCollapse;
            const group = findGroup(readScope(target.type), groupId);
            setGroupCollapsed(target.type, groupId, group?.collapsed === false);
            rerender();
        });
    });
    shell.querySelectorAll('[data-sgr-toggle-group]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgrToggleGroup;
            const scope = readScope(target.type);
            const group = findGroup(scope, groupId);
            if (!group) return;
            const members = getScripts(target.type).filter(script => scope.assignments[script?.id] === groupId);
            if (!members.length) {
                toast('这个分组还没有正则', 'info');
                return;
            }
            const shouldDisable = members.some(script => !script?.disabled);
            const changed = await setGroupDisabled(target.type, groupId, shouldDisable);
            toast(`“${group.name}”已${shouldDisable ? '停用' : '启用'} ${changed} 条正则`, 'success');
            rerender();
        });
    });
    shell.querySelectorAll('[data-sgr-rename]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgrRename;
            const group = findGroup(readScope(target.type), groupId);
            if (!group) return;
            const name = normalizeName(await promptText('重命名正则分组', '请输入新的分组名称：', group.name));
            if (!name || name === group.name) return;
            if (readScope(target.type).groups.some(item => item.id !== groupId && familyKey(item.name) === familyKey(name))) {
                toast('已有同名分组', 'warning');
                return;
            }
            renameGroup(target.type, groupId, name);
            toast('分组名称已更新', 'success');
            rerender();
        });
    });
    shell.querySelectorAll('[data-sgr-delete]').forEach(button => {
        button.addEventListener('click', async () => {
            const groupId = button.dataset.sgrDelete;
            const group = findGroup(readScope(target.type), groupId);
            if (!group) return;
            if (!await confirmAction('删除正则分组', `删除“${group.name}”？其中的正则会回到未分组，正则本体不会被删除。`)) return;
            deleteGroup(target.type, groupId);
            rerender();
        });
    });
    shell.querySelectorAll('[data-sgr-block-up]').forEach(button => {
        button.addEventListener('click', async () => {
            if (await moveBlock(target.type, button.dataset.sgrBlockUp, -1)) rerender();
        });
    });
    shell.querySelectorAll('[data-sgr-block-down]').forEach(button => {
        button.addEventListener('click', async () => {
            if (await moveBlock(target.type, button.dataset.sgrBlockDown, 1)) rerender();
        });
    });

    bindDragAndDrop(shell, target);
}

/** Bound once per row element, since rows are moved rather than recreated. */
export function bindRowControls() {
    for (const target of LIST_TARGETS) {
        const container = document.querySelector(target.selector);
        if (!container) continue;
        for (const select of container.querySelectorAll('.sgr-move')) {
            if (BOUND.has(select)) continue;
            BOUND.add(select);
            select.addEventListener('change', async event => {
                event.stopPropagation();
                const scriptType = Number(select.dataset.sgrType);
                await assignScript(scriptType, select.dataset.sgrScript || '', select.value, '');
                rerender();
            });
            select.addEventListener('click', event => event.stopPropagation());
        }
    }
}

function bindDragAndDrop(shell, target) {
    const searching = Boolean(normalizeName(viewFor(target.key).search));
    const dragEnabled = !searching && !settings.regexDragLocked && !isCoarsePointer();
    if (!dragEnabled) return;
    let draggingRow = '';
    let draggingBlock = '';

    const clearDragState = () => {
        draggingRow = '';
        draggingBlock = '';
        shell.querySelectorAll('.sgp-dragging, .sgp-drag-over').forEach(element => element.classList.remove('sgp-dragging', 'sgp-drag-over'));
    };

    shell.querySelectorAll('.regex-script-label').forEach(row => {
        row.draggable = true;
        if (!BOUND.has(row)) {
            BOUND.add(row);
            row.addEventListener('dragstart', event => {
                if (!row.draggable) return;
                event.stopPropagation();
                draggingRow = row.id || row.dataset.regexScriptId || '';
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
        }
    });

    shell.querySelectorAll('[data-sgr-drag-block]').forEach(handle => {
        handle.addEventListener('dragstart', event => {
            event.stopPropagation();
            draggingBlock = handle.dataset.sgrDragBlock || '';
            draggingRow = '';
            handle.closest('[data-sgr-block]')?.classList.add('sgp-dragging');
            try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-sgr-block', draggingBlock);
            } catch {
                // Same-panel drags only need the state above.
            }
        });
        handle.addEventListener('dragend', clearDragState);
    });

    shell.querySelectorAll('[data-sgr-drop], .regex-script-label').forEach(dropTarget => {
        dropTarget.addEventListener('dragover', event => {
            if (!draggingRow && !draggingBlock) return;
            event.preventDefault();
            event.stopPropagation();
            shell.querySelectorAll('.sgp-drag-over').forEach(element => element.classList.remove('sgp-drag-over'));
            dropTarget.classList.add('sgp-drag-over');
        });
        dropTarget.addEventListener('dragleave', event => {
            if (!dropTarget.contains(event.relatedTarget)) dropTarget.classList.remove('sgp-drag-over');
        });
        dropTarget.addEventListener('drop', async event => {
            if (!draggingRow && !draggingBlock) return;
            event.preventDefault();
            event.stopPropagation();

            if (draggingBlock) {
                const blockId = dropTarget.closest('[data-sgr-block]')?.dataset.sgrBlock || '';
                const bounds = dropTarget.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const source = draggingBlock;
                clearDragState();
                if (await placeBlock(target.type, source, blockId, placeAfter)) rerender();
                return;
            }

            const scope = readScope(target.type);
            const targetRow = dropTarget.closest('.regex-script-label');
            const source = draggingRow;
            clearDragState();

            if (targetRow && targetRow.id !== source) {
                const sibling = targetRow.id;
                const bounds = targetRow.getBoundingClientRect();
                const placeAfter = event.clientY > bounds.top + bounds.height / 2;
                const scripts = getScripts(target.type);
                const siblingIndex = scripts.findIndex(script => script?.id === sibling);
                const nextSibling = placeAfter ? scripts[siblingIndex + 1]?.id || '' : sibling;
                await assignScript(target.type, source, scope.assignments[sibling] || '', nextSibling);
                rerender();
                return;
            }

            const groupId = dropTarget.closest('[data-sgr-group]')?.dataset.sgrGroup || '';
            await assignScript(target.type, source, groupId, '');
            rerender();
        });
    });
}

export function logTakeover() {
    console.log(`[${DISPLAY_NAME}] 正则分组已接管正则列表`);
}
