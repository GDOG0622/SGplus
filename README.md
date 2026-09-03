# SGplus

SGplus 是一个 SillyTavern 第三方扩展，把两件事合到一起：

- **资源下拉框分组** —— 预设、格式模板、UI 主题（美化）、世界书的下拉框变成可搜索、可折叠、可手动整理的分组列表。来自 [SillyTavern-SmartGroups（嘎嘎资源分组）](https://github.com/puppyyoho/SillyTavern-SmartGroups)。
- **预设条目管理** —— Chat Completion 预设**内部**的 prompt 条目列表支持分组、折叠、收藏、整组静音、批量操作和拖拽排序。功能取自 [ST-BaiBai-Tools（柏宝箱）](https://github.com/baibai-git/ST-BaiBai-Tools) 的预设模块，用零构建原生 JS 重写，视觉上与嘎嘎资源分组统一。

两层刚好互补：一层管「有哪些预设」，另一层管「预设里有哪些条目」。

SGplus 不改写你的预设、模板、主题或世界书文件。所有分组记录都保存在 SillyTavern 的 `extensionSettings` 里；关掉扩展后，原生界面会完整恢复。

## 功能

### 资源下拉框

- Chat Completion、Text Completion、KoboldAI、NovelAI 等生成预设
- Context、Instruct、System Prompt、Reasoning 等高级格式模板
- UI Theme（美化 / 主题）
- 世界书：全局启用多选和世界书编辑选择器共用一套分组
- 以后由 SillyTavern 或其他扩展注册的 `data-preset-manager-for` 预设选择器

选择器是动态发现的，所以切换 API、导入新预设或世界书、重命名或删除资源后都不用手动刷新。

- 一个通用分组引擎服务全部资源，自动识别版本号、A/B 版、测试版、括号标签、分隔符前缀和共同名称前缀
- 自动分组与手动安排分离：手动移动过的条目会被「固定」，再次智能整理不会覆盖
- 统一管理器：在不同预设、模板、主题和世界书之间用标签页切换
- 小窗快速搜索、折叠分组、移动端布局、键盘 `Esc` 关闭
- 分组配置支持 JSON 导入导出
- 自动迁移旧脚本 `preset-group-manager:state` 里的「预设分组 v1.5.5」记录
- 兼容 Tauri 桌面 WebView：检测到 Tauri 时会为叠加式标题栏预留顶部空间
- 不提供「删除预设」捷径，永久删除仍交给 SillyTavern 原生按钮，降低误删风险

### 预设条目（Chat Completion）

在 SillyTavern 自己的 Prompt Manager 列表里就地生效，条目行仍然是原生结构，所以宿主主题和其他扩展都不受影响。

- **条目分组**：新建、重命名、删除、折叠、整块上移下移。删除分组只让条目回到「未分组」，不会删条目。
- **智能整理**：用资源分组那套名称推断引擎去猜条目分组，已经手动分过组的条目不会被打乱。
- **整组静音**：整个分组不参与生成，但**保留每一条自己的开关状态**。静音期间条目行会变暗并标注「静音」，恢复后原状态原样回来。主提示词（`main`）始终保留，避免其他扩展的相对插入失效。
- **条目收藏**：星标条目会在列表顶部出现一个收藏区镜像，可以直接开关或编辑，不参与拖拽和分组归属。
- **快速开关**：点开关只更新当前行，Token 统计延后合并刷新，不会每次都重建整份列表。
- **条目搜索**：按名称过滤，搜索时自动展开全部分组；中文输入法组词期间不会抖动，光标位置会保留。
- **多选批量**：批量启用、停用、收藏、移动到分组（可现场新建分组）。SillyTavern 不允许开关的条目会被跳过并在提示里说明。
- **拖拽排序**：桌面端可拖动条目跨分组、拖动分组整块换位；触屏设备改用每行的「⋯」菜单（移动到分组 / 上移 / 下移），避免和页面滚动打架。
- **拖拽锁定**：工具栏的锁按钮可以一键禁用全部拖拽，防误触。

条目顺序的唯一真源始终是 SillyTavern 自己的 `prompt_order`：一个分组就是这个数组里连续的一段。所以就算以后卸载 SGplus，条目顺序照旧，只是没有分组了。

## 分组记录存在哪里

预设条目的分组会同时写两份：

1. **镜像**：`extensionSettings` 里的 `promptGroups[预设名]`，每次改动立即保存。这样即使你没点「更新预设」，切换预设或刷新页面也不会丢分组。
2. **随预设**：当前预设的 `extensions.sgplus.promptEntries`。你点 SillyTavern 的「更新预设」或导出预设时，分组会跟着预设文件走，可以分享给别人。

两份都存在时取更新时间更晚的那份。SGplus 自己**不会**偷偷保存你的预设文件——要落盘到预设，仍然由你点原生的「更新预设」。

首次加载时，SGplus 还会读取柏宝箱写在预设里的 `extensions.baibaiToolkit.presetPromptGroups`、`presetPromptFavorites` 以及更早的 `extensions.entryGrouping`，所以从柏宝箱迁过来不用重新分组。

## 安装

### 从 GitHub 安装（推荐）

1. 打开 SillyTavern 的「扩展」面板。
2. 选择「安装扩展 / Install Extension」。
3. 粘贴仓库地址：

   ```text
   https://github.com/GDOG0622/SGplus
   ```

4. 安装完成后重载页面。

### 手动安装

1. 下载仓库 ZIP 并解压。
2. 把整个 `SGplus` 文件夹放到以下任一位置：
   - 当前用户：`SillyTavern/data/<你的用户>/extensions/`
   - 全局：`SillyTavern/public/scripts/extensions/third-party/`
3. 重载 SillyTavern 页面；如未出现，请执行一次强制刷新。
4. 在「扩展设置」中找到「SGplus」，或从扩展菜单打开管理器。

需要 SillyTavern `1.12.0` 或更新版本。

## 使用

### 资源下拉框

- 点击任一被接管的预设、模板、主题或世界书下拉框，按分组浏览或直接搜索。
- 世界书的全局启用入口支持多选，点击条目可启用或停用且不会关闭面板；编辑入口仍保持单选并打开对应世界书。
- 点击小窗右上角的齿轮进入完整管理器。
- 「智能整理」只重新安排自动条目；用每行右侧的下拉框手动移动后，该条目会固定。

### 预设条目

1. 把 API 切到 Chat Completion。
2. 打开「AI Response Configuration」面板，往下滚到 Prompts。
3. 列表顶部就是 SGplus 的工具栏：搜索、智能整理、新建分组、多选、拖拽锁。

分组是按预设保存的，换预设会看到那个预设自己的分组。

## 从旧扩展迁移

- **嘎嘎资源分组**：SGplus 使用同一套设置键（`smart_resource_groups`）和同样的 `srg-` / `pgm-` 类名，所以已有的分组和自定义 CSS 都能直接用。两个扩展不要同时启用。
- **柏宝箱**：预设条目分组和收藏会被自动读取。柏宝箱的其他优化（长聊天渲染、CodeMirror 编辑器、自动备份等）不在 SGplus 范围内；如果你要继续用那些功能，请在柏宝箱设置里关掉「预设分组」，避免两套 UI 同时接管条目列表。
- **预设分组 v1.5.5（酒馆助手脚本）**：首次加载会自动迁移它的 localStorage 记录。迁移完请关掉旧脚本。

## 安全与兼容性

- 扩展完全在浏览器端运行，不请求外部网络，不读取 API Key。
- 资源选中操作仍通过原生 `<select>` 的 `change` 事件完成，SillyTavern 仍是数据与行为的唯一来源。
- 预设条目列表接管失败时会自动回退到 SillyTavern 原生列表并在控制台留下原因，不会让你面对一个空列表。
- 如果拿不到 SillyTavern 的 Prompt Manager 内部对象（例如宿主版本差异过大），预设条目功能会整体静默停用，资源分组不受影响。
- 如遇冲突，可在扩展设置里分别关闭「接管预设」「接管主题」「接管世界书」或「接管预设条目列表」；原生界面会立即恢复。

## 开发

跑测试：

```bash
npm test
```

在一个一次性的 SillyTavern 沙盒里试跑（会克隆 SillyTavern 到 `.sandbox/`，默认端口 `8719`）：

```bash
npm run sandbox          # 首次会自动克隆并安装依赖
npm run sandbox:reset    # 重置用户数据后再启动
```

代码结构（零构建，浏览器直接加载 ES 模块）：

```text
index.js          引导、设置面板、菜单入口
shared.js         公共状态与工具（设置、弹窗、IME 安全搜索、Tauri 适配）
grouping.js       名称分组推断引擎
resources.js      资源下拉框接管：快速选择器与分组管理器
prompts/host.js   SillyTavern Prompt Manager 桥接与可撤销的 patch
prompts/state.js  条目分组与收藏的数据模型、双层持久化、兼容读取
prompts/list.js   条目列表渲染与全部交互
prompts/index.js  条目功能装配与预设生命周期接线
```

`prompts/host.js` 是唯一接触 SillyTavern 内部模块的地方，而且用动态 `import()` 加多路径回退，任何一步失败都只会让条目功能停用，不会影响其余部分。

## 致谢与许可

SGplus 是衍生作品：

- 资源分组部分来自 **puppyyoho** 的 [SillyTavern-SmartGroups](https://github.com/puppyyoho/SillyTavern-SmartGroups)，其许可为「个人非商业使用」，禁止未经授权的转载、重新打包与再发布。
- 预设条目部分的功能设计来自 **baibai-git** 的 [ST-BaiBai-Tools](https://github.com/baibai-git/ST-BaiBai-Tools)。

因此本仓库沿用上游的个人非商业使用条款，见 [`LICENSE`](./LICENSE)。**公开分发 SGplus 需要先取得上述两位原作者的授权。** 如果你只是自己用，直接装即可。
