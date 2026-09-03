import { context, DISPLAY_NAME } from '../shared.js';

export const SCRIPT_TYPES = { GLOBAL: 0, SCOPED: 1, PRESET: 2 };

export const LIST_TARGETS = [
    { type: SCRIPT_TYPES.GLOBAL, key: 'global', selector: '#saved_regex_scripts', label: '全局正则' },
    { type: SCRIPT_TYPES.SCOPED, key: 'scoped', selector: '#saved_scoped_scripts', label: '角色正则' },
    { type: SCRIPT_TYPES.PRESET, key: 'preset', selector: '#saved_preset_scripts', label: '预设正则' },
];

const state = { engine: null, connected: false };

function engineCandidates() {
    const file = 'extensions/regex/engine.js';
    const candidates = [];
    try {
        const url = new URL(import.meta.url);
        const marker = '/scripts/';
        const index = url.pathname.indexOf(marker);
        if (index >= 0) candidates.push(`${url.origin}${url.pathname.slice(0, index + marker.length)}${file}`);
        candidates.push(new URL(`../../../${file}`, import.meta.url).href);
    } catch {
        // Fall through to the origin-relative guess below.
    }
    candidates.push(`/scripts/${file}`);
    return [...new Set(candidates)];
}

/**
 * Resolves SillyTavern's regex engine, which owns reading and writing the three
 * script scopes. Without it this feature stays completely inert.
 */
export async function connectRegexHost() {
    if (state.connected) return true;
    for (const candidate of engineCandidates()) {
        try {
            const module = await import(/* webpackIgnore: true */ candidate);
            if (typeof module?.getScriptsByType === 'function' && typeof module?.saveScriptsByType === 'function') {
                state.engine = module;
                state.connected = true;
                return true;
            }
        } catch {
            // Try the next candidate location.
        }
    }
    console.warn(`[${DISPLAY_NAME}] 无法访问 SillyTavern 的正则引擎，正则分组已停用`);
    return false;
}

export function isRegexHostConnected() {
    return state.connected;
}

/** @returns {{id: string, scriptName: string, disabled: boolean}[]} the live, mutable array */
export function getScripts(scriptType) {
    try {
        const scripts = state.engine?.getScriptsByType(scriptType);
        return Array.isArray(scripts) ? scripts : [];
    } catch {
        return [];
    }
}

export async function saveScripts(scriptType, scripts) {
    try {
        await state.engine?.saveScriptsByType(scripts, scriptType);
        return true;
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 保存正则脚本失败`, error);
        return false;
    }
}

/**
 * Builds the key that scopes group metadata. Character and preset scripts live
 * per character and per preset, so their groups must too.
 */
export function scopeKeyFor(scriptType) {
    if (scriptType === SCRIPT_TYPES.GLOBAL) return 'global';
    if (scriptType === SCRIPT_TYPES.SCOPED) {
        const characters = context?.characters;
        const avatar = characters?.[context?.characterId]?.avatar;
        return `scoped:${avatar || 'none'}`;
    }
    try {
        const api = state.engine?.getCurrentPresetAPI?.() || 'unknown';
        const name = state.engine?.getCurrentPresetName?.() || 'unknown';
        return `preset:${api}:${name}`;
    } catch {
        return 'preset:unknown';
    }
}

/**
 * SillyTavern's jQuery sortable rebuilds the script array from the container's
 * direct children. Once rows live inside group wrappers those children carry no
 * script id, which would make it save an empty list. Disabling it is mandatory,
 * not an optimisation.
 */
export function setNativeSortableEnabled(enabled) {
    const jquery = globalThis.jQuery || globalThis.$;
    if (typeof jquery !== 'function') return;
    for (const target of LIST_TARGETS) {
        try {
            const list = jquery(target.selector);
            if (list.length && list.data('ui-sortable')) list.sortable(enabled ? 'enable' : 'disable');
        } catch {
            // jQuery UI sortable is not attached to this list.
        }
    }
}

/** Character scripts can only be edited for a single selected character. */
export function isScopedEditable() {
    return context?.characterId !== undefined && context?.characterId !== null && !context?.groupId;
}
