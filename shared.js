export const MODULE_NAME = 'smart_resource_groups';
export const DISPLAY_NAME = 'SGplus';
export const VERSION = '3.1.0';

export const ROOT_ID = 'srg-root';
export const POPOVER_ID = 'srg-popover';
export const MANAGER_ID = 'srg-manager-mask';
export const MENU_ID = 'srg-menu-entry';
export const SETTINGS_ID = 'srg-settings';
export const RUNTIME_STYLE_ID = 'srg-runtime-mobile-fixes';

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: 3,
    enabled: true,
    enhancePresets: true,
    enhanceThemes: true,
    enhanceWorldInfo: true,
    autoGroupOnDiscovery: true,
    minGroupSize: 2,
    compactRows: false,
    legacyMigrated: false,
    resources: {},
    enhancePromptEntries: true,
    promptDragLocked: false,
    promptAutoSaveOnEntryEdit: false,
    promptGroups: {},
    promptLibrary: { version: 1, items: [], groups: [], collapsed: true },
    enhanceRegex: true,
    regexDragLocked: false,
    regexGroups: {},
});

/** Live bindings: importers observe these reassignments. */
export let context = null;
export let settings = null;

let saveTimer = 0;
let hostModalDepth = 0;

export function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function uid(prefix = 'g') {
    try {
        if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    } catch {
        // Ignore and use the deterministic fallback shape below.
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function toast(message, type = 'info') {
    try {
        const toaster = globalThis.toastr;
        if (toaster?.[type]) {
            toaster[type](message, DISPLAY_NAME, { timeOut: 2600, positionClass: 'toast-top-center' });
            return;
        }
    } catch {
        // Console fallback below.
    }
    console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

export function readHostContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
        return null;
    }
}

export function setContext(value) {
    context = value;
}

export function isTauriRuntime() {
    try {
        const host = String(location.hostname || '').toLocaleLowerCase();
        return Boolean(globalThis.__TAURI_INTERNALS__ || globalThis.__TAURI__ || globalThis.__TAURI_METADATA__ || location.protocol === 'tauri:' || /(?:^|\.)tauri\.localhost$/.test(host));
    } catch {
        return false;
    }
}

export function getTauriTopInset(viewportWidth) {
    // Tauri can expose a mobile WebView whose physical screenshot is wide
    // while its CSS viewport is narrow (for example, a landscape tablet at a
    // high device-pixel ratio). Do not gate this by viewport width: the
    // native status/title bar can overlap either desktop or mobile layouts.
    if (!isTauriRuntime() || viewportWidth < 1) return 0;
    const configured = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--srg-tauri-titlebar-height'));
    return Number.isFinite(configured) ? Math.max(0, Math.min(96, configured)) : 36;
}

function mergeDefaults(defaults, current) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return clone(defaults);
    const output = clone(defaults);
    for (const [key, value] of Object.entries(current)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
            output[key] = { ...output[key], ...value };
        } else {
            output[key] = value;
        }
    }
    return output;
}

export function loadSettings() {
    const extensionSettings = context.extensionSettings || context.extension_settings;
    if (!extensionSettings || typeof extensionSettings !== 'object') {
        throw new Error('当前 SillyTavern 未提供 extensionSettings');
    }
    extensionSettings[MODULE_NAME] = mergeDefaults(DEFAULT_SETTINGS, extensionSettings[MODULE_NAME]);
    settings = extensionSettings[MODULE_NAME];
    if (!settings.resources || typeof settings.resources !== 'object' || Array.isArray(settings.resources)) settings.resources = {};
    if (!settings.promptGroups || typeof settings.promptGroups !== 'object' || Array.isArray(settings.promptGroups)) settings.promptGroups = {};
    if (!settings.promptLibrary || typeof settings.promptLibrary !== 'object' || Array.isArray(settings.promptLibrary)) {
        settings.promptLibrary = { version: 1, items: [], groups: [], collapsed: true };
    }
    if (!settings.regexGroups || typeof settings.regexGroups !== 'object' || Array.isArray(settings.regexGroups)) settings.regexGroups = {};
    settings.schemaVersion = 3;
    settings.minGroupSize = Math.max(2, Math.min(12, Number(settings.minGroupSize) || 2));
    return settings;
}

export function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = 0;
        try {
            context?.saveSettingsDebounced?.();
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 保存扩展设置失败`, error);
        }
    }, 80);
}

export function cancelScheduledSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = 0;
}

export function getHostModalDepth() {
    return hostModalDepth;
}

export async function promptText(title, message, initial = '') {
    hostModalDepth++;
    try {
        try {
            if (context?.Popup?.show?.input) return await context.Popup.show.input(title, message, initial);
        } catch {
            // Native fallback below.
        }
        return window.prompt(`${title}\n${message}`, initial);
    } finally {
        hostModalDepth = Math.max(0, hostModalDepth - 1);
    }
}

export async function confirmAction(title, message) {
    hostModalDepth++;
    try {
        try {
            if (context?.Popup?.show?.confirm) return Boolean(await context.Popup.show.confirm(title, message));
        } catch {
            // Native fallback below.
        }
        return window.confirm(`${title}\n${message}`);
    } finally {
        hostModalDepth = Math.max(0, hostModalDepth - 1);
    }
}

export function centerItemInScroller(scroller, item) {
    if (!scroller || !item) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const delta = (itemRect.top + itemRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2);
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop + delta, max));
}

export function focusSearchAt(input, selectionStart, selectionEnd) {
    if (!input) return;
    try {
        input.focus({ preventScroll: true });
    } catch {
        input.focus();
    }
    const length = input.value.length;
    const start = Math.max(0, Math.min(Number.isInteger(selectionStart) ? selectionStart : length, length));
    const end = Math.max(start, Math.min(Number.isInteger(selectionEnd) ? selectionEnd : start, length));
    try {
        input.setSelectionRange(start, end);
    } catch {
        // Some embedded browsers do not expose selection APIs for search inputs.
    }
}

export function bindSearchInput(input, onCommit) {
    if (!input) return;
    let composing = false;
    let compositionCommitTimer = 0;
    const snapshot = target => ({
        value: target.value || '',
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
    });
    const commit = target => onCommit(snapshot(target));

    input.addEventListener('compositionstart', () => {
        composing = true;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        compositionCommitTimer = 0;
    });
    input.addEventListener('compositionend', event => {
        composing = false;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        const committed = snapshot(event.currentTarget);
        compositionCommitTimer = window.setTimeout(() => {
            compositionCommitTimer = 0;
            onCommit(committed);
        }, 0);
    });
    input.addEventListener('input', event => {
        if (composing || event.isComposing) return;
        if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
        compositionCommitTimer = 0;
        commit(event.currentTarget);
    });
}

export function isCoarsePointer() {
    return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
}
