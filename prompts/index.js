import { context, DISPLAY_NAME, settings } from '../shared.js';
import {
    connectHost,
    getPromptManager,
    installPatches,
    isHostConnected,
    isPatched,
    removePatches,
    requestPresetSave,
    scheduleHostRender,
} from './host.js';
import { closeLibraryDialog } from './library.js';
import {
    bindGlobalRowMenuDismissal,
    closeRowMenu,
    isTakeoverEnabled,
    renderGroupedList,
    rerender,
    resetView,
} from './list.js';
import {
    commit,
    forgetPreset,
    invalidateStateCache,
    isSuppressed,
    normalizeOrder,
    readState,
    renamePreset,
} from './state.js';

const cleanupFns = [];
let ready = false;

export function isPromptTakeoverReady() {
    return ready && isHostConnected();
}

function refreshFromHost({ collapseAll = false } = {}) {
    invalidateStateCache();
    if (!isTakeoverEnabled()) return;
    const state = readState();
    if (collapseAll && state.groups.length) {
        commit(next => {
            for (const group of next.groups) group.collapsed = true;
        });
    }
    normalizeOrder();
    rerender();
}

function bindLifecycleEvents() {
    const eventSource = context?.eventSource || globalThis.eventSource;
    const eventTypes = context?.eventTypes || context?.event_types || globalThis.event_types || {};
    if (!eventSource?.on) return;

    const bind = (name, handler) => {
        const type = eventTypes[name];
        if (!type) return;
        eventSource.on(type, handler);
        cleanupFns.push(() => {
            try {
                eventSource.removeListener?.(type, handler);
                eventSource.off?.(type, handler);
            } catch {
                // Best-effort cleanup on page unload.
            }
        });
    };

    bind('OAI_PRESET_CHANGED_BEFORE', () => {
        closeRowMenu();
        resetView();
        invalidateStateCache();
    });
    bind('OAI_PRESET_CHANGED_AFTER', () => refreshFromHost());
    bind('OAI_PRESET_IMPORT_READY', () => refreshFromHost({ collapseAll: true }));
    bind('PRESET_RENAMED', data => {
        if (String(data?.apiId || '') !== 'openai') return;
        renamePreset(data?.oldName, data?.newName);
        invalidateStateCache();
    });
    bind('PRESET_DELETED', data => {
        if (String(data?.apiId || '') !== 'openai') return;
        forgetPreset(data?.name);
    });
    bind('CHATCOMPLETION_MODEL_CHANGED', () => invalidateStateCache());
}

/**
 * Optionally writes the preset to disk after an entry edit is saved.
 *
 * SillyTavern normally keeps edited entries in the live settings until the user
 * clicks "update preset", so this is off by default. Saving also carries the
 * group metadata into the preset file as a side effect.
 */
function bindEntryEditAutoSave() {
    let timer = 0;
    const handleSaveClick = event => {
        if (!settings?.promptAutoSaveOnEntryEdit || !isTakeoverEnabled()) return;
        if (!event.target?.closest?.('#completion_prompt_manager_popup_entry_form_save')) return;
        if (timer) clearTimeout(timer);
        // Let SillyTavern commit the edit first, and collapse a burst of edits
        // into a single preset write.
        timer = window.setTimeout(() => {
            timer = 0;
            if (requestPresetSave()) console.debug(`[${DISPLAY_NAME}] 条目编辑已保存，已顺带更新预设`);
        }, 600);
    };
    document.addEventListener('click', handleSaveClick);
    cleanupFns.push(() => {
        if (timer) clearTimeout(timer);
        document.removeEventListener('click', handleSaveClick);
    });
}

function bindFlushEvents() {
    // The metadata mirror is written on every change, so flushing here is only
    // about making sure a debounced settings save actually lands.
    const flush = () => {
        try {
            context?.saveSettingsDebounced?.();
        } catch {
            // The host will save on its own schedule.
        }
    };
    const handleVisibility = () => {
        if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', flush);
    cleanupFns.push(() => {
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener('pagehide', flush);
    });
}

/**
 * Connects to SillyTavern's prompt manager and takes over its list rendering.
 * Returns false when the host internals are unavailable, in which case the
 * native prompt list is left completely untouched.
 */
export async function initPrompts() {
    if (ready) return true;
    if (!await connectHost()) return false;

    const installed = installPatches({
        isEnabled: () => isTakeoverEnabled(),
        renderList: () => renderGroupedList(),
        isSuppressed: identifier => isSuppressed(identifier),
    });
    if (!installed) return false;

    bindLifecycleEvents();
    bindEntryEditAutoSave();
    bindFlushEvents();
    cleanupFns.push(bindGlobalRowMenuDismissal());
    ready = true;

    refreshFromHost();
    scheduleHostRender(0);
    console.log(`[${DISPLAY_NAME}] 预设条目分组已接管 Prompt Manager`);
    return true;
}

/** Re-applies or releases the takeover after the user flips its setting. */
export function refreshPromptTakeover() {
    if (!ready) {
        if (settings?.enhancePromptEntries) void initPrompts();
        return;
    }
    closeRowMenu();
    if (!isTakeoverEnabled()) {
        resetView();
        scheduleHostRender(0);
        return;
    }
    invalidateStateCache();
    scheduleHostRender(0);
}

export function cleanupPrompts() {
    closeRowMenu();
    closeLibraryDialog();
    if (isPatched()) removePatches();
    cleanupFns.splice(0).forEach(fn => {
        try {
            fn();
        } catch {
            // Nothing else to do during teardown.
        }
    });
    ready = false;
    try {
        getPromptManager()?.render(false);
    } catch {
        // The page is going away anyway.
    }
}
