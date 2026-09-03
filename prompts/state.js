import { normalizeName } from '../grouping.js';
import { clone, context, DISPLAY_NAME, scheduleSave, settings, uid } from '../shared.js';
import { getPromptById, getPromptOrder, saveHostServiceSettings } from './host.js';

export const PORTABLE_NAMESPACE = 'sgplus';
export const PORTABLE_FIELD = 'promptEntries';
const BAIBAI_NAMESPACE = 'baibaiToolkit';
const LOOSE_ID = '__loose';

let cache = null;

function chatCompletionSettings() {
    return context?.chatCompletionSettings || context?.oai_settings || null;
}

export function getPresetName() {
    const raw = chatCompletionSettings()?.preset_settings_openai;
    return normalizeName(raw) || '';
}

function extensionsRoot({ create = false } = {}) {
    const oai = chatCompletionSettings();
    if (!oai) return null;
    if (!oai.extensions || typeof oai.extensions !== 'object' || Array.isArray(oai.extensions)) {
        if (!create) return null;
        oai.extensions = {};
    }
    return oai.extensions;
}

export function createEmptyState() {
    return {
        version: 1,
        updatedAt: 0,
        groups: [],
        assignments: {},
        favorites: [],
        favoritesCollapsed: false,
    };
}

export function normalizePromptState(input) {
    const output = createEmptyState();
    if (!input || typeof input !== 'object') return output;
    output.updatedAt = Number(input.updatedAt) || 0;

    const ids = new Set();
    output.groups = (Array.isArray(input.groups) ? input.groups : [])
        .filter(group => group && typeof group === 'object')
        .map(group => ({
            id: String(group.id || uid('pg')),
            name: normalizeName(group.name) || '未命名分组',
            collapsed: group.collapsed !== false,
            enabled: group.enabled !== false,
        }))
        .filter(group => {
            if (ids.has(group.id)) return false;
            ids.add(group.id);
            return true;
        });

    const assignments = input.assignments && typeof input.assignments === 'object' && !Array.isArray(input.assignments)
        ? input.assignments
        : {};
    for (const [promptId, groupId] of Object.entries(assignments)) {
        const id = String(promptId || '');
        if (!id || !ids.has(String(groupId))) continue;
        output.assignments[id] = String(groupId);
    }

    const favorites = Array.isArray(input.favorites) ? input.favorites : [];
    output.favorites = [...new Set(favorites.map(value => String(value || '')).filter(Boolean))];
    output.favoritesCollapsed = Boolean(input.favoritesCollapsed);
    return output;
}

/**
 * Reads grouping metadata written by 柏宝箱 (ST-BaiBai-Tools) so users keep the
 * groups they already built before switching to SGplus.
 * @returns {object|null} a normalized state, or null when nothing was found
 */
export function readCompatibleState() {
    const root = extensionsRoot();
    if (!root) return null;

    const baibaiGroups = root[BAIBAI_NAMESPACE]?.presetPromptGroups;
    const baibaiFavorites = root[BAIBAI_NAMESPACE]?.presetPromptFavorites;
    if (baibaiGroups && typeof baibaiGroups === 'object') {
        const state = createEmptyState();
        const groups = Array.isArray(baibaiGroups.groups) ? baibaiGroups.groups : [];
        const known = new Set();
        for (const group of groups) {
            if (!group || typeof group !== 'object' || !group.id) continue;
            const id = String(group.id);
            if (known.has(id)) continue;
            known.add(id);
            state.groups.push({
                id,
                name: normalizeName(group.name) || '未命名分组',
                collapsed: group.collapsed !== false,
                enabled: group.enabled !== false,
            });
        }
        const prompts = baibaiGroups.prompts && typeof baibaiGroups.prompts === 'object' ? baibaiGroups.prompts : {};
        for (const [promptId, meta] of Object.entries(prompts)) {
            const groupId = String(meta?.groupId || '');
            if (!promptId || !known.has(groupId)) continue;
            state.assignments[String(promptId)] = groupId;
        }
        if (baibaiFavorites && Array.isArray(baibaiFavorites.promptIds)) {
            state.favorites = [...new Set(baibaiFavorites.promptIds.map(value => String(value || '')).filter(Boolean))];
            state.favoritesCollapsed = Boolean(baibaiFavorites.collapsed);
        }
        if (state.groups.length || state.favorites.length) return state;
    }

    const legacy = root.entryGrouping;
    if (legacy && typeof legacy === 'object') {
        const state = createEmptyState();
        const groups = Array.isArray(legacy.groups) ? legacy.groups : [];
        const known = new Map();
        for (const group of groups) {
            if (!group) continue;
            const name = normalizeName(typeof group === 'string' ? group : group.name);
            if (!name) continue;
            const id = String(group.id || uid('pg'));
            known.set(String(group.id ?? name), id);
            state.groups.push({ id, name, collapsed: true, enabled: true });
        }
        const source = legacy.assignments && typeof legacy.assignments === 'object'
            ? legacy.assignments
            : (legacy.prompts && typeof legacy.prompts === 'object' ? legacy.prompts : {});
        for (const [promptId, value] of Object.entries(source)) {
            const raw = typeof value === 'object' ? value?.groupId ?? value?.group : value;
            const groupId = known.get(String(raw ?? ''));
            if (!promptId || !groupId) continue;
            state.assignments[String(promptId)] = groupId;
        }
        if (state.groups.length) return state;
    }
    return null;
}

function readPortableState() {
    const root = extensionsRoot();
    const stored = root?.[PORTABLE_NAMESPACE]?.[PORTABLE_FIELD];
    return stored && typeof stored === 'object' ? stored : null;
}

function readMirrorState(presetName) {
    if (!presetName) return null;
    const stored = settings?.promptGroups?.[presetName];
    return stored && typeof stored === 'object' ? stored : null;
}

/**
 * Resolves the metadata for the active preset.
 *
 * Two copies are kept on purpose: a mirror in the extension settings that is
 * always saved immediately (so nothing is lost when a preset is switched
 * without being saved), and a portable copy inside the preset's own
 * `extensions` field (so groups travel with preset export and import).
 * @returns {{version: number, updatedAt: number, groups: object[], assignments: Record<string, string>, favorites: string[], favoritesCollapsed: boolean}}
 */
export function readState() {
    const presetName = getPresetName();
    if (cache && cache.presetName === presetName) return cache.state;

    const portable = readPortableState();
    const mirror = readMirrorState(presetName);
    let chosen = null;
    if (portable && mirror) {
        chosen = Number(mirror.updatedAt) > Number(portable.updatedAt) ? mirror : portable;
    } else {
        chosen = portable || mirror || readCompatibleState();
    }

    const state = normalizePromptState(chosen);
    cache = { presetName, state };
    return state;
}

export function invalidateStateCache() {
    cache = null;
}

/** Drops metadata for a preset that no longer exists. */
export function forgetPreset(presetName) {
    const name = normalizeName(presetName);
    if (!name || !settings?.promptGroups) return;
    delete settings.promptGroups[name];
    if (cache?.presetName === name) cache = null;
    scheduleSave();
}

/** Moves metadata across a rename so groups survive it. */
export function renamePreset(oldName, newName) {
    const from = normalizeName(oldName);
    const to = normalizeName(newName);
    if (!from || !to || from === to || !settings?.promptGroups) return;
    const stored = settings.promptGroups[from];
    if (stored) {
        settings.promptGroups[to] = stored;
        delete settings.promptGroups[from];
    }
    if (cache?.presetName === from) cache.presetName = to;
    scheduleSave();
}

function writeState(presetName, state) {
    if (presetName && settings?.promptGroups) settings.promptGroups[presetName] = clone(state);
    const root = extensionsRoot({ create: true });
    if (root) {
        if (!root[PORTABLE_NAMESPACE] || typeof root[PORTABLE_NAMESPACE] !== 'object') root[PORTABLE_NAMESPACE] = {};
        root[PORTABLE_NAMESPACE][PORTABLE_FIELD] = clone(state);
    }
    scheduleSave();
}

/**
 * Applies a mutation to the active preset's metadata and persists both copies.
 * @param {(state: object) => void|boolean} mutator returns false to abort the write
 */
export function commit(mutator) {
    const presetName = getPresetName();
    const state = readState();
    try {
        if (mutator(state) === false) return state;
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 预设条目分组更新失败`, error);
        return state;
    }
    state.updatedAt = Date.now();
    pruneState(state);
    writeState(presetName, state);
    return state;
}

/** Removes references to prompts and groups that no longer exist. */
export function pruneState(state) {
    const known = new Set(getPromptOrder().map(entry => entry?.identifier).filter(Boolean));
    if (!known.size) return state;
    const groupIds = new Set(state.groups.map(group => group.id));
    for (const promptId of Object.keys(state.assignments)) {
        if (!known.has(promptId) || !groupIds.has(state.assignments[promptId])) delete state.assignments[promptId];
    }
    state.favorites = state.favorites.filter(promptId => known.has(promptId));
    return state;
}

export function findGroup(state, groupId) {
    return state.groups.find(group => group.id === groupId) || null;
}

export function isSuppressed(identifier) {
    if (!identifier) return false;
    const state = readState();
    const groupId = state.assignments[identifier];
    if (!groupId) return false;
    return findGroup(state, groupId)?.enabled === false;
}

export function isFavorite(identifier) {
    return readState().favorites.includes(identifier);
}

/**
 * Turns the flat prompt order into the block sequence the list renders.
 *
 * A group is simply a contiguous run of prompts in SillyTavern's own
 * `prompt_order`, positioned where its first member sits. That keeps the native
 * order authoritative: if this extension is ever removed, the order survives
 * and only the grouping is lost.
 * @returns {{type: 'item'|'group', id: string, group?: object, members: {identifier: string, enabled: boolean}[]}[]}
 */
export function buildBlocks(state = readState(), order = getPromptOrder()) {
    const blocks = [];
    const emitted = new Set();
    const membersByGroup = new Map();

    for (const entry of order) {
        const identifier = entry?.identifier;
        if (!identifier) continue;
        const groupId = state.assignments[identifier];
        if (!groupId || !findGroup(state, groupId)) continue;
        if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, []);
        membersByGroup.get(groupId).push(entry);
    }

    for (const entry of order) {
        const identifier = entry?.identifier;
        if (!identifier) continue;
        const groupId = state.assignments[identifier];
        const group = groupId ? findGroup(state, groupId) : null;
        if (!group) {
            blocks.push({ type: 'item', id: identifier, members: [entry] });
            continue;
        }
        if (emitted.has(group.id)) continue;
        emitted.add(group.id);
        blocks.push({ type: 'group', id: group.id, group, members: membersByGroup.get(group.id) || [] });
    }

    for (const group of state.groups) {
        if (emitted.has(group.id)) continue;
        blocks.push({ type: 'group', id: group.id, group, members: [] });
    }
    return blocks;
}

/**
 * Rewrites the native order so every group's members sit together, then hands
 * the change to SillyTavern's own save path.
 * @returns {boolean} whether the order actually changed
 */
export function normalizeOrder(state = readState()) {
    const order = getPromptOrder();
    if (!order.length) return false;
    const blocks = buildBlocks(state, order);
    const next = [];
    for (const block of blocks) next.push(...block.members);
    if (next.length !== order.length) return false;
    const changed = next.some((entry, index) => entry !== order[index]);
    if (!changed) return false;
    order.splice(0, order.length, ...next);
    saveHostServiceSettings();
    return true;
}

/** Moves a whole block (a loose prompt or an entire group) by one position. */
export function moveBlock(blockId, delta) {
    const state = readState();
    const order = getPromptOrder();
    const blocks = buildBlocks(state, order);
    const index = blocks.findIndex(block => block.id === blockId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= blocks.length) return false;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    return applyBlocks(blocks, order);
}

/** Drops a block before or after another block. */
export function placeBlock(sourceId, targetId, placeAfter = false) {
    if (!sourceId || sourceId === targetId) return false;
    const state = readState();
    const order = getPromptOrder();
    const blocks = buildBlocks(state, order);
    const sourceIndex = blocks.findIndex(block => block.id === sourceId);
    if (sourceIndex < 0) return false;
    const [block] = blocks.splice(sourceIndex, 1);
    if (!targetId) {
        blocks.push(block);
    } else {
        const targetIndex = blocks.findIndex(item => item.id === targetId);
        if (targetIndex < 0) {
            blocks.splice(sourceIndex, 0, block);
            return false;
        }
        blocks.splice(targetIndex + (placeAfter ? 1 : 0), 0, block);
    }
    return applyBlocks(blocks, order);
}

function applyBlocks(blocks, order) {
    const next = [];
    for (const block of blocks) next.push(...block.members);
    if (next.length !== order.length) return false;
    order.splice(0, order.length, ...next);
    saveHostServiceSettings();
    return true;
}

/**
 * Assigns a prompt to a group and repositions it so the group stays contiguous.
 * @param {string} identifier prompt identifier
 * @param {string} groupId target group, or an empty string for "未分组"
 * @param {string} [beforeIdentifier] insert ahead of this sibling when given
 */
export function assignPrompt(identifier, groupId, beforeIdentifier = '') {
    if (!identifier) return false;
    const order = getPromptOrder();
    const fromIndex = order.findIndex(entry => entry?.identifier === identifier);
    if (fromIndex < 0) return false;

    commit(state => {
        if (groupId && findGroup(state, groupId)) state.assignments[identifier] = groupId;
        else delete state.assignments[identifier];
    });

    const state = readState();
    const [entry] = order.splice(fromIndex, 1);
    let insertAt = order.length;

    if (beforeIdentifier && beforeIdentifier !== identifier) {
        const siblingIndex = order.findIndex(item => item?.identifier === beforeIdentifier);
        if (siblingIndex >= 0) insertAt = siblingIndex;
    } else if (groupId) {
        const lastMember = order.reduce((found, item, index) => (
            state.assignments[item?.identifier] === groupId ? index : found
        ), -1);
        insertAt = lastMember >= 0 ? lastMember + 1 : Math.min(fromIndex, order.length);
    } else {
        insertAt = Math.min(fromIndex, order.length);
    }

    order.splice(insertAt, 0, entry);
    normalizeOrder(state);
    saveHostServiceSettings();
    return true;
}

/** Reorders a prompt inside its own group (or among loose prompts). */
export function movePromptWithin(identifier, delta) {
    const state = readState();
    const order = getPromptOrder();
    const groupId = state.assignments[identifier] || '';
    const siblings = order.filter(entry => (state.assignments[entry?.identifier] || '') === groupId);
    const localIndex = siblings.findIndex(entry => entry?.identifier === identifier);
    const target = localIndex + delta;
    if (localIndex < 0 || target < 0 || target >= siblings.length) return false;
    const fromIndex = order.indexOf(siblings[localIndex]);
    const toIndex = order.indexOf(siblings[target]);
    if (fromIndex < 0 || toIndex < 0) return false;
    const [entry] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, entry);
    saveHostServiceSettings();
    return true;
}

export function createGroup(name, { promptIds = [] } = {}) {
    const label = normalizeName(name);
    if (!label) return null;
    let created = null;
    commit(state => {
        created = { id: uid('pg'), name: label, collapsed: false, enabled: true };
        state.groups.push(created);
        for (const promptId of promptIds) {
            if (promptId) state.assignments[promptId] = created.id;
        }
    });
    if (promptIds.length) normalizeOrder();
    return created;
}

export function renameGroup(groupId, name) {
    const label = normalizeName(name);
    if (!label) return false;
    let ok = false;
    commit(state => {
        const group = findGroup(state, groupId);
        if (!group) return false;
        group.name = label;
        ok = true;
        return true;
    });
    return ok;
}

/** Deletes a group. Its prompts fall back to "未分组"; nothing is removed. */
export function deleteGroup(groupId) {
    let ok = false;
    commit(state => {
        const index = state.groups.findIndex(group => group.id === groupId);
        if (index < 0) return false;
        state.groups.splice(index, 1);
        for (const [promptId, assigned] of Object.entries(state.assignments)) {
            if (assigned === groupId) delete state.assignments[promptId];
        }
        ok = true;
        return true;
    });
    return ok;
}

export function setGroupCollapsed(groupId, collapsed) {
    commit(state => {
        const group = findGroup(state, groupId);
        if (!group) return false;
        group.collapsed = Boolean(collapsed);
        return true;
    });
}

export function setGroupEnabled(groupId, enabled) {
    commit(state => {
        const group = findGroup(state, groupId);
        if (!group) return false;
        group.enabled = Boolean(enabled);
        return true;
    });
}

export function setFavoritesCollapsed(collapsed) {
    commit(state => {
        state.favoritesCollapsed = Boolean(collapsed);
    });
}

export function toggleFavorite(identifier) {
    if (!identifier) return false;
    let favorited = false;
    commit(state => {
        const index = state.favorites.indexOf(identifier);
        if (index >= 0) {
            state.favorites.splice(index, 1);
        } else {
            state.favorites.push(identifier);
            favorited = true;
        }
    });
    return favorited;
}

export function clearGroups() {
    commit(state => {
        state.groups = [];
        state.assignments = {};
    });
}

/** Names shown in the list, used by the smart-grouping engine. */
export function promptNames(order = getPromptOrder()) {
    const names = new Map();
    for (const entry of order) {
        const prompt = getPromptById(entry?.identifier);
        const name = normalizeName(prompt?.name);
        if (name && !names.has(name)) names.set(name, entry.identifier);
    }
    return names;
}

export const LOOSE_SECTION_ID = LOOSE_ID;
