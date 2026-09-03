import { normalizeName } from '../grouping.js';
import { clone, confirmAction, DISPLAY_NAME, escapeHtml, promptText, scheduleSave, settings, toast, uid } from '../shared.js';
import { getPromptById, getPromptManager, getPromptOrder, saveHostServiceSettings, scheduleHostRender } from './host.js';
import { assignPrompt, findGroup, normalizeOrder, readState } from './state.js';

export const LIBRARY_VERSION = 1;
const DIALOG_ID = 'sgp-library-dialog';

/**
 * The global library is a cross-preset shelf of prompt snippets. It stores only
 * a name and the text body, and inserting one always creates a brand new prompt
 * in the current preset rather than a reference, so editing a preset entry can
 * never reach back into the library.
 * @typedef {{id: string, name: string, content: string, groupId: string|null}} LibraryItem
 * @typedef {{id: string, name: string, collapsed: boolean}} LibraryGroup
 * @typedef {{version: number, items: LibraryItem[], groups: LibraryGroup[], collapsed: boolean}} Library
 */

export function createEmptyLibrary() {
    return { version: LIBRARY_VERSION, items: [], groups: [], collapsed: true };
}

export function normalizeLibrary(input) {
    const output = createEmptyLibrary();
    // Tolerate a bare array, which is what the earliest 柏宝箱 payloads look like.
    const source = Array.isArray(input) ? { items: input } : (input && typeof input === 'object' ? input : {});

    const groupIds = new Set();
    output.groups = (Array.isArray(source.groups) ? source.groups : [])
        .filter(group => group && typeof group === 'object')
        .map(group => ({
            id: String(group.id || uid('lg')),
            name: normalizeName(group.name) || '未命名分组',
            collapsed: group.collapsed !== false,
        }))
        .filter(group => {
            if (groupIds.has(group.id)) return false;
            groupIds.add(group.id);
            return true;
        });

    const itemIds = new Set();
    output.items = (Array.isArray(source.items) ? source.items : [])
        .filter(item => item && typeof item === 'object')
        .map(item => {
            let id = String(item.id || '');
            if (!id || itemIds.has(id)) id = uid('li');
            itemIds.add(id);
            const groupId = String(item.groupId ?? '');
            return {
                id,
                name: normalizeName(item.name) || '未命名条目',
                content: typeof item.content === 'string' ? item.content : String(item.content ?? ''),
                groupId: groupIds.has(groupId) ? groupId : null,
            };
        });

    output.collapsed = source.collapsed !== false;
    return output;
}

export function readLibrary() {
    if (!settings) return createEmptyLibrary();
    settings.promptLibrary = normalizeLibrary(settings.promptLibrary);
    return settings.promptLibrary;
}

/**
 * Applies a mutation to the library and persists it.
 * @param {(library: Library) => void|boolean} mutator returns false to abort
 */
export function commitLibrary(mutator) {
    const library = readLibrary();
    try {
        if (mutator(library) === false) return library;
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 全局库更新失败`, error);
        return library;
    }
    settings.promptLibrary = normalizeLibrary(library);
    scheduleSave();
    return settings.promptLibrary;
}

/** Stores a preset entry's name and body in the library. */
export function storePromptInLibrary(identifier) {
    const prompt = getPromptById(identifier);
    if (!prompt) return null;
    let created = null;
    commitLibrary(library => {
        created = {
            id: uid('li'),
            name: normalizeName(prompt.name) || '未命名条目',
            content: typeof prompt.content === 'string' ? prompt.content : String(prompt.content ?? ''),
            groupId: null,
        };
        library.items.push(created);
    });
    if (created) toast(`已存入全局库：${created.name}`, 'success');
    return created;
}

function uniqueInsertName(name) {
    const manager = getPromptManager();
    const prompts = Array.isArray(manager?.serviceSettings?.prompts) ? manager.serviceSettings.prompts : [];
    const taken = new Set(prompts.map(prompt => normalizeName(prompt?.name)).filter(Boolean));
    const base = normalizeName(name) || '未命名条目';
    if (!taken.has(base)) return base;
    for (let index = 2; index < 200; index++) {
        const candidate = `${base} ${index}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${Date.now().toString(36)}`;
}

function uniqueIdentifier() {
    const manager = getPromptManager();
    const context = globalThis.SillyTavern?.getContext?.();
    for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = context?.uuidv4?.() || uid('lp');
        if (!manager?.getPromptById?.(candidate)) return candidate;
    }
    return uid('lp');
}

/**
 * Inserts library items into the current preset as new prompts.
 * @param {string[]} itemIds library item ids, applied in library order
 * @param {{groupId?: string}} target optional preset group to drop them into
 * @returns {number} how many entries were created
 */
export function insertLibraryItems(itemIds, { groupId = '' } = {}) {
    const manager = getPromptManager();
    const order = getPromptOrder();
    if (!manager || typeof manager.addPrompt !== 'function' || !order) return 0;
    const library = readLibrary();
    const wanted = new Set(itemIds);
    const ordered = library.items.filter(item => wanted.has(item.id));
    if (!ordered.length) return 0;

    const created = [];
    for (const item of ordered) {
        const identifier = uniqueIdentifier();
        try {
            manager.addPrompt({ name: uniqueInsertName(item.name), role: 'system', content: item.content }, identifier);
        } catch (error) {
            console.error(`[${DISPLAY_NAME}] 插入全局库条目失败`, error);
            continue;
        }
        order.push({ identifier, enabled: true });
        created.push(identifier);
    }
    if (!created.length) return 0;

    if (groupId && findGroup(readState(), groupId)) {
        for (const identifier of created) assignPrompt(identifier, groupId, '');
        normalizeOrder();
    }
    saveHostServiceSettings();
    scheduleHostRender(0);
    return created.length;
}

/** Asks where new entries should land, but only when there is a choice to make. */
export async function chooseInsertGroup() {
    const groups = readState().groups;
    if (!groups.length) return { groupId: '' };
    const answer = await promptText(
        '插入到哪里',
        `留空表示放在列表末尾的未分组区。也可以输入分组名称：\n${groups.map(group => group.name).join('、')}`,
        '',
    );
    if (answer === null) return null;
    const wanted = normalizeName(answer);
    if (!wanted) return { groupId: '' };
    const match = groups.find(group => group.name === wanted)
        || groups.find(group => group.name.toLocaleLowerCase() === wanted.toLocaleLowerCase());
    if (!match) {
        toast(`没有名为“${wanted}”的分组，已放到未分组`, 'warning');
        return { groupId: '' };
    }
    return { groupId: match.id };
}

export function deleteLibraryItem(itemId) {
    commitLibrary(library => {
        const index = library.items.findIndex(item => item.id === itemId);
        if (index < 0) return false;
        library.items.splice(index, 1);
        return true;
    });
}

export function moveLibraryItem(itemId, groupId) {
    commitLibrary(library => {
        const item = library.items.find(entry => entry.id === itemId);
        if (!item) return false;
        item.groupId = groupId || null;
        return true;
    });
}

export function createLibraryGroup(name) {
    const label = normalizeName(name);
    if (!label) return null;
    let created = null;
    commitLibrary(library => {
        created = { id: uid('lg'), name: label, collapsed: false };
        library.groups.push(created);
    });
    return created;
}

export function renameLibraryGroup(groupId, name) {
    const label = normalizeName(name);
    if (!label) return false;
    let ok = false;
    commitLibrary(library => {
        const group = library.groups.find(item => item.id === groupId);
        if (!group) return false;
        group.name = label;
        ok = true;
        return true;
    });
    return ok;
}

/** Deletes a library folder. Its snippets fall back to "未分组". */
export function deleteLibraryGroup(groupId) {
    commitLibrary(library => {
        const index = library.groups.findIndex(item => item.id === groupId);
        if (index < 0) return false;
        library.groups.splice(index, 1);
        for (const item of library.items) {
            if (item.groupId === groupId) item.groupId = null;
        }
        return true;
    });
}

export function setLibraryGroupCollapsed(groupId, collapsed) {
    commitLibrary(library => {
        const group = library.groups.find(item => item.id === groupId);
        if (!group) return false;
        group.collapsed = Boolean(collapsed);
        return true;
    });
}

export function setLibraryCollapsed(collapsed) {
    commitLibrary(library => {
        library.collapsed = Boolean(collapsed);
    });
}

export function exportLibrary() {
    const library = readLibrary();
    const blob = new Blob([JSON.stringify({
        type: 'sgplus-prompt-library',
        version: LIBRARY_VERSION,
        exportedAt: new Date().toISOString(),
        items: library.items,
        groups: library.groups,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sgplus-library-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

export async function importLibrary(file) {
    try {
        const data = JSON.parse(await file.text());
        const incoming = normalizeLibrary(data);
        if (!incoming.items.length && !incoming.groups.length) throw new Error('文件里没有可导入的条目');
        if (!await confirmAction('导入全局库', `即将追加 ${incoming.items.length} 个条目和 ${incoming.groups.length} 个分组，现有内容不会被删除。继续吗？`)) return;
        commitLibrary(library => {
            const remap = new Map();
            for (const group of incoming.groups) {
                const existing = library.groups.find(item => item.name === group.name);
                if (existing) {
                    remap.set(group.id, existing.id);
                    continue;
                }
                const next = { id: uid('lg'), name: group.name, collapsed: true };
                library.groups.push(next);
                remap.set(group.id, next.id);
            }
            for (const item of incoming.items) {
                library.items.push({
                    id: uid('li'),
                    name: item.name,
                    content: item.content,
                    groupId: item.groupId ? remap.get(item.groupId) || null : null,
                });
            }
        });
        toast(`已导入 ${incoming.items.length} 个全局库条目`, 'success');
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 全局库导入失败`, error);
        toast(`导入失败：${error.message || error}`, 'error');
    }
}

export function closeLibraryDialog() {
    document.getElementById(DIALOG_ID)?.remove();
}

/**
 * A small name plus body editor, in the same card language as the row menu.
 * SillyTavern's own input popup cannot host a multi-line body, so this is a
 * purpose-built dialog rather than a `Popup.show.input` call.
 * @returns {Promise<{name: string, content: string}|null>}
 */
export function editLibraryItemDialog({ title, name = '', content = '' }) {
    closeLibraryDialog();
    return new Promise(resolve => {
        const layer = document.createElement('div');
        layer.id = DIALOG_ID;
        layer.className = 'sgp-dialog-layer';
        layer.innerHTML = `
            <div class="sgp-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <div class="sgp-dialog-title">${escapeHtml(title)}</div>
                <label class="sgp-dialog-field">
                    <span>名称</span>
                    <input type="text" class="sgp-dialog-input" data-sgp-dialog-name value="${escapeHtml(name)}">
                </label>
                <label class="sgp-dialog-field">
                    <span>内容</span>
                    <textarea class="sgp-dialog-textarea" data-sgp-dialog-content rows="12">${escapeHtml(content)}</textarea>
                </label>
                <div class="sgp-dialog-actions">
                    <button type="button" class="pgm-btn" data-sgp-dialog-cancel>取消</button>
                    <button type="button" class="pgm-btn primary" data-sgp-dialog-save>保存</button>
                </div>
            </div>
        `;
        (document.getElementById('srg-root') || document.body).appendChild(layer);

        const nameInput = layer.querySelector('[data-sgp-dialog-name]');
        const contentInput = layer.querySelector('[data-sgp-dialog-content]');
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', handleKeydown, true);
            layer.remove();
            resolve(value);
        };
        const submit = () => {
            const nextName = normalizeName(nameInput?.value);
            if (!nextName) {
                toast('名称不能为空', 'warning');
                nameInput?.focus();
                return;
            }
            finish({ name: nextName, content: contentInput?.value ?? '' });
        };
        const handleKeydown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.stopPropagation();
                submit();
            }
        };

        layer.querySelector('[data-sgp-dialog-cancel]')?.addEventListener('click', () => finish(null));
        layer.querySelector('[data-sgp-dialog-save]')?.addEventListener('click', submit);
        layer.addEventListener('mousedown', event => {
            if (event.target === layer) finish(null);
        });
        document.addEventListener('keydown', handleKeydown, true);
        if (!window.matchMedia?.('(pointer: coarse)')?.matches) {
            requestAnimationFrame(() => nameInput?.focus());
        }
    });
}

export function librarySnapshotForExport() {
    return clone(readLibrary());
}
