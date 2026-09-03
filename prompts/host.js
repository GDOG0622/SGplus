import { DISPLAY_NAME } from '../shared.js';

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 };

const state = {
    promptManager: null,
    connected: false,
    patched: false,
    originals: null,
    hooks: null,
    renderTimer: 0,
    renderDepth: 0,
};

/**
 * Builds a URL inside SillyTavern's own `/scripts/` folder from this module's
 * location, so the bridge keeps working no matter how deeply the extension is
 * nested or whether it was installed per-user or globally.
 * @param {string} file file name relative to `/scripts/`
 * @returns {string[]} candidate URLs, most reliable first
 */
function scriptModuleCandidates(file) {
    const candidates = [];
    try {
        const url = new URL(import.meta.url);
        const marker = '/scripts/';
        const index = url.pathname.indexOf(marker);
        if (index >= 0) candidates.push(`${url.origin}${url.pathname.slice(0, index + marker.length)}${file}`);
        candidates.push(new URL(`../../../${file}`, import.meta.url).href);
        candidates.push(new URL(`../../../../${file}`, import.meta.url).href);
    } catch {
        // Fall through to the origin-relative guess below.
    }
    candidates.push(`/scripts/${file}`);
    return [...new Set(candidates)];
}

async function importScriptModule(file) {
    for (const candidate of scriptModuleCandidates(file)) {
        try {
            return await import(/* webpackIgnore: true */ candidate);
        } catch {
            // Try the next candidate location.
        }
    }
    return null;
}

/**
 * Resolves SillyTavern's live prompt manager instance. It is created during app
 * startup, so this retries for a while before giving up.
 * @returns {Promise<boolean>} whether the bridge is usable
 */
export async function connectHost({ attempts = 40, interval = 250 } = {}) {
    if (state.connected) return true;
    const module = await importScriptModule('openai.js');
    if (!module) {
        console.warn(`[${DISPLAY_NAME}] 无法访问 SillyTavern 的 openai 模块，预设条目分组已停用`);
        return false;
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
        const manager = module.promptManager;
        if (manager && typeof manager.renderPromptManagerListItems === 'function') {
            state.promptManager = manager;
            state.connected = true;
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    console.warn(`[${DISPLAY_NAME}] SillyTavern 的 Prompt Manager 尚未就绪，预设条目分组已停用`);
    return false;
}

export function isHostConnected() {
    return state.connected && Boolean(state.promptManager);
}

export function getPromptManager() {
    return state.promptManager;
}

export function getPrefix() {
    return state.promptManager?.configuration?.prefix ?? '';
}

export function getActiveCharacter() {
    return state.promptManager?.activeCharacter ?? null;
}

/** @returns {{identifier: string, enabled: boolean}[]} the live, mutable order array */
export function getPromptOrder() {
    const manager = state.promptManager;
    if (!manager) return [];
    try {
        const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
        return Array.isArray(order) ? order : [];
    } catch {
        return [];
    }
}

export function getPromptById(identifier) {
    try {
        return state.promptManager?.getPromptById(identifier) ?? null;
    } catch {
        return null;
    }
}

export function getOrderEntry(identifier) {
    return getPromptOrder().find(entry => entry?.identifier === identifier) || null;
}

export function getTokenCounts() {
    try {
        return state.promptManager?.tokenHandler?.getCounts?.() ?? {};
    } catch {
        return {};
    }
}

export function getTokenBudget() {
    const settings = state.promptManager?.serviceSettings;
    const context = Number(settings?.openai_max_context) || 0;
    const response = Number(settings?.openai_max_tokens) || 0;
    return Math.max(0, context - response);
}

export function getTokenUsage() {
    return Number(state.promptManager?.tokenUsage) || 0;
}

/** SillyTavern scrolls the prompt manager through this ancestor. */
export function getScrollContainer() {
    return document.getElementById(`${getPrefix()}prompt_manager`)?.closest('.scrollableInner') || null;
}

export function getOverriddenPrompts() {
    const overridden = state.promptManager?.overriddenPrompts;
    return Array.isArray(overridden) ? overridden : [];
}

export function isInspectionAllowed(prompt) {
    try {
        return Boolean(state.promptManager?.isPromptInspectionAllowed(prompt));
    } catch {
        return false;
    }
}

export function isEditAllowed(prompt) {
    try {
        return Boolean(state.promptManager?.isPromptEditAllowed(prompt));
    } catch {
        return false;
    }
}

export function isToggleAllowed(prompt) {
    try {
        return Boolean(state.promptManager?.isPromptToggleAllowed(prompt));
    } catch {
        return false;
    }
}

export function isDeletionAllowed(prompt) {
    try {
        return Boolean(state.promptManager?.isPromptDeletionAllowed(prompt));
    } catch {
        return false;
    }
}

export function saveHostServiceSettings() {
    try {
        return state.promptManager?.saveServiceSettings?.();
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 保存 Prompt Manager 设置失败`, error);
        return undefined;
    }
}

/**
 * Asks SillyTavern for a full re-render, which is what recomputes token counts.
 * Debounced because every call runs a dry-run generation.
 */
export function scheduleHostRender(delay = 500) {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(() => {
        state.renderTimer = 0;
        try {
            state.promptManager?.render(true);
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 刷新 Prompt Manager 失败`, error);
        }
    }, delay);
}

export function cancelHostRender() {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = 0;
}

/** Renders the native list by calling through to the unpatched implementation. */
export async function renderNativeList() {
    const manager = state.promptManager;
    const original = state.originals?.renderPromptManagerListItems;
    if (!manager || !original) return;
    state.renderDepth++;
    try {
        await original.call(manager);
    } finally {
        state.renderDepth = Math.max(0, state.renderDepth - 1);
    }
}

export function makeNativeDraggable() {
    const manager = state.promptManager;
    const original = state.originals?.makeDraggable;
    if (!manager || !original) return;
    try {
        original.call(manager);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 恢复原生拖拽失败`, error);
    }
}

/** Removes the jQuery UI sortable that SillyTavern attaches to the list. */
export function destroyNativeSortable() {
    const manager = state.promptManager;
    const jquery = globalThis.jQuery || globalThis.$;
    if (!manager || typeof jquery !== 'function') return;
    try {
        const list = jquery(`#${getPrefix()}prompt_manager_list`);
        if (list.length && list.data('ui-sortable')) list.sortable('destroy');
    } catch {
        // Nothing to destroy, or jQuery UI is unavailable.
    }
}

/**
 * Takes over list rendering, drag setup and generation-time filtering.
 * @param {object} hooks
 * @param {() => boolean} hooks.isEnabled whether the takeover should apply right now
 * @param {() => Promise<void>|void} hooks.renderList draws the grouped list
 * @param {(identifier: string) => boolean} hooks.isSuppressed whether a prompt is muted by its group
 */
export function installPatches(hooks) {
    const manager = state.promptManager;
    if (!manager || state.patched) return false;
    state.hooks = hooks;
    state.originals = {
        renderPromptManagerListItems: manager.renderPromptManagerListItems.bind(manager),
        makeDraggable: manager.makeDraggable.bind(manager),
        getPromptCollection: manager.getPromptCollection.bind(manager),
        isPromptDisabledForActiveCharacter: manager.isPromptDisabledForActiveCharacter.bind(manager),
    };

    manager.renderPromptManagerListItems = async function patchedRenderPromptManagerListItems(...args) {
        if (state.renderDepth > 0 || !state.hooks?.isEnabled()) {
            return state.originals.renderPromptManagerListItems(...args);
        }
        try {
            return await state.hooks.renderList();
        } catch (error) {
            // Never leave the user with a broken prompt list.
            console.error(`[${DISPLAY_NAME}] 预设条目列表渲染失败，已回退到原生列表`, error);
            return state.originals.renderPromptManagerListItems(...args);
        }
    };

    manager.makeDraggable = function patchedMakeDraggable(...args) {
        if (!state.hooks?.isEnabled()) return state.originals.makeDraggable(...args);
        destroyNativeSortable();
        return undefined;
    };

    manager.getPromptCollection = function patchedGetPromptCollection(...args) {
        const collection = state.originals.getPromptCollection(...args);
        if (!state.hooks?.isEnabled()) return collection;
        try {
            const entries = Array.isArray(collection?.collection) ? collection.collection : null;
            if (!entries) return collection;
            for (let index = entries.length - 1; index >= 0; index--) {
                const identifier = entries[index]?.identifier;
                // `main` must survive so relative inserts from other extensions keep working.
                if (identifier && identifier !== 'main' && state.hooks.isSuppressed(identifier)) {
                    entries.splice(index, 1);
                }
            }
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 分组静音过滤失败，本次生成使用原始条目`, error);
        }
        return collection;
    };

    manager.isPromptDisabledForActiveCharacter = function patchedIsPromptDisabled(identifier) {
        if (state.hooks?.isEnabled() && state.hooks.isSuppressed(identifier)) return true;
        return state.originals.isPromptDisabledForActiveCharacter(identifier);
    };

    state.patched = true;
    return true;
}

export function removePatches() {
    const manager = state.promptManager;
    cancelHostRender();
    if (!manager || !state.patched) return;
    manager.renderPromptManagerListItems = state.originals.renderPromptManagerListItems;
    manager.makeDraggable = state.originals.makeDraggable;
    manager.getPromptCollection = state.originals.getPromptCollection;
    manager.isPromptDisabledForActiveCharacter = state.originals.isPromptDisabledForActiveCharacter;
    state.patched = false;
    state.originals = null;
    state.hooks = null;
}

export function isPatched() {
    return state.patched;
}

/**
 * Asks SillyTavern to write the current Chat Completion preset to disk by
 * driving its own "update preset" button, so the save path stays identical to
 * what the user would get by clicking it.
 * @returns {boolean} whether the button was found
 */
export function requestPresetSave() {
    const button = document.getElementById('update_oai_preset');
    if (!button) return false;
    button.click();
    return true;
}

/** Invokes a native row handler with a synthetic event carrying the row element. */
export function invokeNativeHandler(name, rowElement) {
    const manager = state.promptManager;
    const handler = manager?.[name];
    if (typeof handler !== 'function' || !rowElement) return false;
    try {
        handler.call(manager, { target: rowElement, preventDefault() {}, stopPropagation() {} });
        return true;
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 调用原生操作 ${name} 失败`, error);
        return false;
    }
}
