import {
    adapters,
    cleanupResources,
    exportGroupingData,
    getManagerAdapters,
    getManagerItems,
    importGroupingData,
    initResources,
    migrateLegacyState,
    onInventoryChanged,
    openManager,
    refreshAllMounts,
    renderManager,
    setSettingsPanelFactory,
    applySmartGrouping,
} from './resources.js';
import { cleanupPrompts, initPrompts, refreshPromptTakeover } from './prompts/index.js';
import { readState } from './prompts/state.js';
import {
    DISPLAY_NAME,
    isTauriRuntime,
    loadSettings,
    readHostContext,
    scheduleSave,
    SETTINGS_ID,
    setContext,
    settings,
    toast,
    VERSION,
} from './shared.js';

let initialized = false;

function createSettingsPanel() {
    const host = document.getElementById('extensions_settings2');
    if (!host || document.getElementById(SETTINGS_ID)) return false;
    const panel = document.createElement('div');
    panel.id = SETTINGS_ID;
    panel.className = 'srg-settings extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${DISPLAY_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="srg-settings-note">把 SillyTavern 的预设、模板、UI 主题和世界书下拉框变成可搜索、可折叠的分组列表，并给 Chat Completion 预设内部的条目加上分组、收藏与批量整理。只改变列表呈现与分组记录，不改写任何资源本体。</p>
                <div class="srg-settings-group-title">资源下拉框</div>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enabled"><span>启用插件</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhancePresets"><span>接管全部预设 / 模板下拉框</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhanceThemes"><span>接管美化 / UI 主题下拉框</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhanceWorldInfo"><span>接管世界书选择器</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="autoGroupOnDiscovery"><span>发现新增条目时自动整理</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="compactRows"><span>管理器使用紧凑行高</span></label>
                <label class="srg-number-setting"><span>自动成组所需的最少条目数</span><input type="number" min="2" max="12" step="1" data-srg-setting="minGroupSize"></label>
                <div class="srg-settings-group-title">预设条目（Chat Completion）</div>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="enhancePromptEntries"><span>接管预设条目列表（分组、收藏、批量）</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="promptAutoSaveOnEntryEdit"><span>编辑条目后自动保存预设</span></label>
                <label class="checkbox_label"><input type="checkbox" data-srg-setting="promptDragLocked"><span>锁定条目拖拽（避免误拖）</span></label>
                <div class="srg-settings-actions">
                    <button type="button" class="menu_button" data-srg-settings-open><span>打开管理器</span></button>
                    <button type="button" class="menu_button" data-srg-settings-all><span>整理全部</span></button>
                    <button type="button" class="menu_button" data-srg-export><span>导出分组</span></button>
                    <button type="button" class="menu_button" data-srg-import><span>导入分组</span></button>
                    <input type="file" accept="application/json,.json" data-srg-import-file hidden>
                </div>
                <div class="srg-settings-status" data-srg-status></div>
            </div>
        </div>
    `;
    host.appendChild(panel);

    for (const input of panel.querySelectorAll('[data-srg-setting]')) {
        const key = input.dataset.srgSetting;
        if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
        else input.value = String(settings[key]);
        input.addEventListener('change', () => {
            settings[key] = input.type === 'checkbox' ? input.checked : Math.max(2, Math.min(12, Number(input.value) || 2));
            if (key === 'minGroupSize') input.value = String(settings[key]);
            refreshAllMounts();
            scheduleSave();
            if (key === 'enabled' || key === 'enhancePromptEntries' || key === 'promptDragLocked') {
                refreshPromptTakeover();
            }
            updateSettingsStatus();
        });
    }
    panel.querySelector('[data-srg-settings-open]')?.addEventListener('click', () => openManager());
    panel.querySelector('[data-srg-settings-all]')?.addEventListener('click', () => {
        let groups = 0;
        let assigned = 0;
        for (const adapter of getManagerAdapters()) {
            const result = applySmartGrouping(adapter, { announce: false, items: getManagerItems(adapter) });
            groups += result.groups;
            assigned += result.assigned;
        }
        toast(`全部整理完成：${groups} 个分组，${assigned} 个条目`, 'success');
        renderManager();
    });
    panel.querySelector('[data-srg-export]')?.addEventListener('click', exportGroupingData);
    const fileInput = panel.querySelector('[data-srg-import-file]');
    panel.querySelector('[data-srg-import]')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) await importGroupingData(file, { onImported: refreshPromptTakeover });
    });
    updateSettingsStatus();
    return true;
}

function updateSettingsStatus() {
    const status = document.querySelector('[data-srg-status]');
    if (!status || !settings) return;
    const resourceAdapters = getManagerAdapters();
    const itemCount = resourceAdapters.reduce((sum, adapter) => sum + getManagerItems(adapter).length, 0);
    const groupCount = Object.values(settings.resources).reduce((sum, resource) => sum + (Array.isArray(resource?.groups) ? resource.groups.length : 0), 0);
    let promptSummary = '';
    try {
        const promptState = readState();
        if (promptState.groups.length) {
            promptSummary = ` 当前预设有 ${promptState.groups.length} 个条目分组。`;
        }
    } catch {
        // The prompt manager may not be ready yet.
    }
    const nextText = `已发现 ${resourceAdapters.length} 类资源、${itemCount} 个条目；当前保存 ${groupCount} 个分组。${promptSummary}`;
    if (status.textContent !== nextText) status.textContent = nextText;
}

async function boot() {
    if (initialized) return;
    const hostContext = readHostContext();
    if (!hostContext) {
        window.setTimeout(boot, 300);
        return;
    }
    setContext(hostContext);
    try {
        loadSettings();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 初始化失败`, error);
        return;
    }
    initialized = true;

    document.documentElement.classList.toggle('srg-tauri-runtime', isTauriRuntime());
    setSettingsPanelFactory(createSettingsPanel);
    onInventoryChanged(updateSettingsStatus);

    const migrated = migrateLegacyState();
    initResources();
    if (migrated) toast(`已迁移旧版 v1.5.5 的 ${migrated} 条手动分组记录`, 'success');

    if (settings.enhancePromptEntries) {
        void initPrompts().then(connected => {
            if (connected) updateSettingsStatus();
        });
    }
    console.log(`[${DISPLAY_NAME}] v${VERSION} loaded`);
}

function cleanup() {
    cleanupPrompts();
    cleanupResources();
    document.getElementById(SETTINGS_ID)?.remove();
    document.documentElement.classList.remove('srg-tauri-runtime');
    adapters.clear();
}

window.addEventListener('pagehide', cleanup, { once: true });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.setTimeout(boot, 0), { once: true });
else window.setTimeout(boot, 0);

export { boot as init, cleanup };
