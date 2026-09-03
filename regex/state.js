import { applyBlocks, buildBlocks as buildBlockModel, moveBlockBy, placeBlockAt } from '../blocks.js';
import { normalizeName } from '../grouping.js';
import { DISPLAY_NAME, scheduleSave, settings, uid } from '../shared.js';
import { getScripts, saveScripts, scopeKeyFor } from './host.js';

function createEmptyScope() {
    return { groups: [], assignments: {} };
}

export function normalizeScope(input) {
    const output = createEmptyScope();
    if (!input || typeof input !== 'object') return output;

    const ids = new Set();
    output.groups = (Array.isArray(input.groups) ? input.groups : [])
        .filter(group => group && typeof group === 'object')
        .map(group => ({
            id: String(group.id || uid('rg')),
            name: normalizeName(group.name) || '未命名分组',
            collapsed: group.collapsed !== false,
        }))
        .filter(group => {
            if (ids.has(group.id)) return false;
            ids.add(group.id);
            return true;
        });

    const assignments = input.assignments && typeof input.assignments === 'object' && !Array.isArray(input.assignments)
        ? input.assignments
        : {};
    for (const [scriptId, groupId] of Object.entries(assignments)) {
        const id = String(scriptId || '');
        if (!id || !ids.has(String(groupId))) continue;
        output.assignments[id] = String(groupId);
    }
    return output;
}

/**
 * Reads the group metadata for a scope.
 *
 * Like the resource groups, this only ever lives in the extension settings:
 * SGplus never writes regex group data into a preset or character card.
 */
export function readScope(scriptType) {
    const key = scopeKeyFor(scriptType);
    if (!settings) return createEmptyScope();
    if (!settings.regexGroups || typeof settings.regexGroups !== 'object' || Array.isArray(settings.regexGroups)) {
        settings.regexGroups = {};
    }
    settings.regexGroups[key] = normalizeScope(settings.regexGroups[key]);
    return settings.regexGroups[key];
}

/**
 * Applies a mutation to a scope's metadata and persists it.
 * @param {(scope: object) => void|boolean} mutator returns false to abort
 */
export function commitScope(scriptType, mutator) {
    const scope = readScope(scriptType);
    try {
        if (mutator(scope) === false) return scope;
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 正则分组更新失败`, error);
        return scope;
    }
    prune(scriptType, scope);
    scheduleSave();
    return scope;
}

function prune(scriptType, scope) {
    const known = new Set(getScripts(scriptType).map(script => script?.id).filter(Boolean));
    if (!known.size) return;
    const groupIds = new Set(scope.groups.map(group => group.id));
    for (const scriptId of Object.keys(scope.assignments)) {
        if (!known.has(scriptId) || !groupIds.has(scope.assignments[scriptId])) delete scope.assignments[scriptId];
    }
}

export function findGroup(scope, groupId) {
    return scope.groups.find(group => group.id === groupId) || null;
}

export function buildBlocks(scriptType, scope = readScope(scriptType), scripts = getScripts(scriptType)) {
    return buildBlockModel({
        items: scripts,
        idOf: script => script?.id || '',
        assignments: scope.assignments,
        groups: scope.groups,
    });
}

async function commitBlocks(scriptType, blocks, scripts) {
    if (!applyBlocks(blocks, scripts)) return false;
    await saveScripts(scriptType, scripts);
    return true;
}

/** Rewrites the native array so every group's scripts sit together. */
export async function normalizeOrder(scriptType) {
    const scripts = getScripts(scriptType);
    if (!scripts.length) return false;
    return commitBlocks(scriptType, buildBlocks(scriptType, readScope(scriptType), scripts), scripts);
}

export async function moveBlock(scriptType, blockId, delta) {
    const scripts = getScripts(scriptType);
    const next = moveBlockBy(buildBlocks(scriptType, readScope(scriptType), scripts), blockId, delta);
    return next ? commitBlocks(scriptType, next, scripts) : false;
}

export async function placeBlock(scriptType, sourceId, targetId, placeAfter = false) {
    const scripts = getScripts(scriptType);
    const next = placeBlockAt(buildBlocks(scriptType, readScope(scriptType), scripts), sourceId, targetId, placeAfter);
    return next ? commitBlocks(scriptType, next, scripts) : false;
}

/**
 * Assigns a script to a group and repositions it so the group stays contiguous.
 * @param {string} beforeScriptId insert ahead of this sibling when given
 */
export async function assignScript(scriptType, scriptId, groupId, beforeScriptId = '') {
    if (!scriptId) return false;
    const scripts = getScripts(scriptType);
    const fromIndex = scripts.findIndex(script => script?.id === scriptId);
    if (fromIndex < 0) return false;

    commitScope(scriptType, scope => {
        if (groupId && findGroup(scope, groupId)) scope.assignments[scriptId] = groupId;
        else delete scope.assignments[scriptId];
    });

    const scope = readScope(scriptType);
    const [script] = scripts.splice(fromIndex, 1);
    let insertAt = scripts.length;

    if (beforeScriptId && beforeScriptId !== scriptId) {
        const siblingIndex = scripts.findIndex(item => item?.id === beforeScriptId);
        if (siblingIndex >= 0) insertAt = siblingIndex;
    } else if (groupId) {
        const lastMember = scripts.reduce((found, item, index) => (
            scope.assignments[item?.id] === groupId ? index : found
        ), -1);
        insertAt = lastMember >= 0 ? lastMember + 1 : Math.min(fromIndex, scripts.length);
    } else {
        insertAt = Math.min(fromIndex, scripts.length);
    }

    scripts.splice(insertAt, 0, script);
    await commitBlocks(scriptType, buildBlocks(scriptType, scope, scripts), scripts);
    await saveScripts(scriptType, scripts);
    return true;
}

export function createGroup(scriptType, name, { scriptIds = [] } = {}) {
    const label = normalizeName(name);
    if (!label) return null;
    let created = null;
    commitScope(scriptType, scope => {
        created = { id: uid('rg'), name: label, collapsed: false };
        scope.groups.push(created);
        for (const scriptId of scriptIds) {
            if (scriptId) scope.assignments[scriptId] = created.id;
        }
    });
    return created;
}

export function renameGroup(scriptType, groupId, name) {
    const label = normalizeName(name);
    if (!label) return false;
    let ok = false;
    commitScope(scriptType, scope => {
        const group = findGroup(scope, groupId);
        if (!group) return false;
        group.name = label;
        ok = true;
        return true;
    });
    return ok;
}

/** Deletes a group. Its scripts fall back to "未分组"; nothing is removed. */
export function deleteGroup(scriptType, groupId) {
    let ok = false;
    commitScope(scriptType, scope => {
        const index = scope.groups.findIndex(group => group.id === groupId);
        if (index < 0) return false;
        scope.groups.splice(index, 1);
        for (const [scriptId, assigned] of Object.entries(scope.assignments)) {
            if (assigned === groupId) delete scope.assignments[scriptId];
        }
        ok = true;
        return true;
    });
    return ok;
}

export function setGroupCollapsed(scriptType, groupId, collapsed) {
    commitScope(scriptType, scope => {
        const group = findGroup(scope, groupId);
        if (!group) return false;
        group.collapsed = Boolean(collapsed);
        return true;
    });
}

/**
 * Flips every script in a group.
 *
 * SillyTavern reads `disabled` straight off each script at generation time, so
 * unlike the preset entry groups there is no way to mute a regex group without
 * touching its members. The per-script switches therefore move with the group.
 * @returns {Promise<number>} how many scripts changed
 */
export async function setGroupDisabled(scriptType, groupId, disabled) {
    const scripts = getScripts(scriptType);
    const scope = readScope(scriptType);
    const members = scripts.filter(script => scope.assignments[script?.id] === groupId);
    const changed = members.filter(script => Boolean(script.disabled) !== disabled);
    for (const script of changed) script.disabled = disabled;
    if (changed.length) await saveScripts(scriptType, scripts);
    return changed.length;
}
