// 客户端插件（浏览器 / 桌面页面）：在输入框左侧新增「快捷提示词」按钮。
//
// 交互闭环：
//   点按钮 → 打开弹窗（portal 到 body，避免被输入框容器裁剪）
//   弹窗内可增删改查提示词；点击某条 / 回车 / Tab → 把提示词插入输入框并回焦
//   右上角「设置」→ 快捷键录制 / WebDAV 同步（地址、立即同步、定时自动同步）
//
// 数据流：
//   提示词与设置存 localStorage；云端读写交给宿主代理（见 index.js），避免浏览器跨域。
//
// 本文件按「常量 → 文案 → 图标 → 工具函数 → 存储 → 云端客户端 → 纯选择器 →
// 输入框操作 → 基础组件 → 子视图 → 主组件 → 样式 → 拼音字典（数据）→ 装配」分层组织，便于维护与扩展。
window.__ModuleLoader__.load({
  id: '@lwfjyjy/dsh-session-prompt-vault',
  factory(require) {
    // ---------- 依赖 ----------
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const createPortal = ReactDOM.createPortal
      || (ReactDOM.default && ReactDOM.default.createPortal)
      || ((node) => node);
    const NS = 'dshSessionPromptVault';

    /**
     * @typedef {Object} Prompt 提示词
     * @property {string} id
     * @property {string} title
     * @property {string} content
     * @property {string} group
     * @property {number} createdAt
     *
     * @typedef {Object} SyncSettings WebDAV 同步设置
     * @property {string} url
     * @property {string} username
     * @property {string} secret
     * @property {number} autoSyncMinutes
     *
     * @typedef {Object} ShortcutSpec 快捷键规格
     * @property {string} code KeyboardEvent.code
     * @property {string[]} modifiers primary/control/alt/shift
     *
     * @typedef {{name:'list'}|{name:'settings',tab?:string}|{name:'edit',draft:Prompt}} Screen 弹窗层级
     */

    // ---------- 常量 ----------
    const PLUGIN_ID = 'dsh-session-prompt-vault';
    const ENDPOINT = '/dsh-session-prompt-vault/webdav'; // 宿主代理地址（同源，无跨域）
    const STORAGE_KEYS = Object.freeze({
      prompts: 'dsh-session-prompt-vault:prompts',
      combos: 'dsh-session-prompt-vault:combos',
      settings: 'dsh-session-prompt-vault:settings',
      shortcut: 'dsh-session-prompt-vault:shortcut',
    });
    // 旧插件名（dsh-session-quick-prompt）的数据键：首次读取时自动迁移，避免升级后丢提示词
    const LEGACY_STORAGE_KEYS = Object.freeze({
      'dsh-session-prompt-vault:prompts': 'dsh-session-quick-prompt:prompts',
      'dsh-session-prompt-vault:combos': 'dsh-session-quick-prompt:combos',
      'dsh-session-prompt-vault:settings': 'dsh-session-quick-prompt:settings',
      'dsh-session-prompt-vault:shortcut': 'dsh-session-quick-prompt:shortcut',
    });
    const SYNC_VERSION = 1;            // 云端文件结构版本
    const GROUP_ALL = 'ALL';           // “全部”分组 tab 的哨兵键
    const UNGROUPED = '';              // “未分组”的键（空字符串 = 无分组）
    const AUTO_SYNC_OPTIONS = Object.freeze([0, 3, 15, 30, 60]); // 自动同步间隔（分钟），0=关闭
    const SCREEN = Object.freeze({ list: 'list', settings: 'settings', edit: 'edit', combo: 'combo' });
    const SETTINGS_TAB = Object.freeze({ shortcut: 'shortcut', sync: 'sync' });
    const SYNC_MODE = Object.freeze({ upload: 'upload', pull: 'pull' });
    const COMBO_TAB = 'COMBOS';     // 固定的「组合」tab 键

    // 首次使用（本地为空）时写入的示例提示词
    const SEED_PROMPTS = [
      { title: '代码审查', group: '开发', content: '请审查下面这段代码，指出潜在问题并给出改进建议：\n' },
      { title: '解释代码', group: '开发', content: '请用通俗易懂的语言解释下面这段代码的作用：\n' },
      { title: '生成单测', group: '测试', content: '请为下面的函数补充单元测试，覆盖边界情况：\n' },
    ];

    // ---------- 快捷键规格（参考 sidebar-file-search 的实现） ----------
    // 组件与快捷键注册之间共享的小枢纽：录制时让快捷键暂时让路；run 由已挂载组件登记。
    // 用 Set 支持多个会话视图同时挂载，避免后卸载的组件把别的组件的热键清空。
    const shortcutHub = {
      capturing: false,
      runners: new Set(),
      add(run) { this.runners.add(run); return run; },
      remove(run) { this.runners.delete(run); },
      current() { const list = [...this.runners]; return list.length ? list[list.length - 1] : null; },
    };
    let registerShortcut = null; // apply 时赋值为注册函数，供设置面板调用

    const PLATFORM = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || '' : '';
    const IS_MAC = /Mac|iPhone|iPad|iPod/.test(PLATFORM);
    // 默认 ⌘⇧I / Ctrl+Shift+I（可自行修改）
    const DEFAULT_SPEC = { code: 'KeyI', modifiers: ['primary', 'shift'] };
    const PURE_MODIFIER_KEYS = ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'];
    const KEY_LABELS = {
      Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Enter: '↵', Tab: 'Tab',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Backspace: '⌫', Delete: 'Del',
    };
    const keyLabel = (code) => {
      if (/^Key[A-Z]$/.test(code)) return code.slice(3);
      if (/^Digit\d$/.test(code)) return code.slice(5);
      if (/^Numpad\d$/.test(code)) return 'Num' + code.slice(6);
      return KEY_LABELS[code] || code;
    };
    const MOD_ORDER = ['primary', 'control', 'alt', 'shift'];
    const modsToText = (modifiers) => {
      const ordered = MOD_ORDER.filter((m) => modifiers.includes(m));
      if (!ordered.length && modifiers.length) ordered.push(...modifiers);
      return ordered.map((m) => {
        if (m === 'primary') return IS_MAC ? '⌘' : 'Ctrl';
        if (m === 'control') return IS_MAC ? '⌃' : 'Ctrl';
        if (m === 'alt') return IS_MAC ? '⌥' : 'Alt';
        if (m === 'shift') return IS_MAC ? '⇧' : 'Shift';
        return m;
      }).join(IS_MAC ? ' ' : '+');
    };
    const specToText = (spec) => {
      if (!spec) return '';
      const parts = [modsToText(spec.modifiers), spec.code ? keyLabel(spec.code) : ''].filter(Boolean);
      return parts.join(IS_MAC ? ' ' : '+');
    };
    const loadShortcut = () => {
      try {
        const raw = readRaw(STORAGE_KEYS.shortcut);
        if (raw === null) return DEFAULT_SPEC;   // 从未设置过 → 用默认
        if (raw === 'null') return null;         // 用户主动删除 → 不设置
        const spec = JSON.parse(raw);
        if (spec && typeof spec.code === 'string' && Array.isArray(spec.modifiers)) return spec;
      } catch { /* 读不到用默认 */ }
      return DEFAULT_SPEC;
    };
    const saveShortcut = (spec) => {
      try { localStorage.setItem(STORAGE_KEYS.shortcut, JSON.stringify(spec)); } catch { /* 存不了不影响使用 */ }
    };
    // 同一份 spec 按平台翻译成合法绑定（mac 用 primary，其它平台映射为 control）
    const buildBindings = (spec) => {
      const mac = { code: spec.code, modifiers: spec.modifiers.map((m) => (m === 'control' ? 'primary' : m)) };
      const win = { code: spec.code, modifiers: spec.modifiers.map((m) => (m === 'primary' ? 'control' : m)) };
      // Web 版把 Alt 降级为 Shift，避免被浏览器菜单拦截
      const web = { code: spec.code, modifiers: [...new Set(spec.modifiers.map((m) => (m === 'alt' ? 'shift' : m)))] };
      return {
        'desktop:macos': mac, 'web:macos': web,
        'desktop:windows': win, 'desktop:linux': win, 'web:windows': web,
      };
    };

    // ---------- 文案 ----------
    const zh = {
      trigger: '快捷提示词', triggerTip: '管理常用提示词，点击即可插入输入框',
      title: '快捷提示词', search: '搜索标题、内容或拼音…', add: '新增',
      empty: '还没有提示词，点「新增」创建一条', noResult: '没有匹配的提示词', settings: '设置', close: '关闭',
      edit: '编辑', del: '删除', delConfirm: '确定删除这条提示词吗？',
      promptTitle: '标题', promptContent: '内容', save: '保存', cancel: '取消',
      group: '分组', groupPlaceholder: '选择或输入分组（可留空）', all: '全部', ungrouped: '未分组',
      titlePlaceholder: '起个名字，例如「代码审查」', contentPlaceholder: '输入提示词内容…',
      shortcutTab: '快捷键', syncTab: '同步设置', shortcutLabel: '打开快捷提示词',
      prevTab: '上一个分组', nextTab: '下一个分组',
      syncDesc: '① WebDAV 地址从哪来：坚果云在「设置 → 常规设置 → 第三方应用管理 → 管理」里添加应用，即可获得 WebDAV 地址和应用密码（用户名填坚果云账号，密码填生成的应用密码；地址一般形如 https://dav.jianguoyun.com/dav/）；其他网盘在各自的设置/安全中开通。\n② 冲突注意：同一台电脑的同步会排队执行，不会互相覆盖；多台电脑同时编辑时，后上传的会覆盖先上传的，换电脑前请先点「从服务器恢复」，并尽量避免同时编辑。自动同步只上传备份，不会自动拉取云端。',
      unset: '未设置', clearShortcut: '删除快捷键',
      shortcutClearConfirm: '确定删除这个快捷键吗？删除后可以点右侧按钮重新录制。',
      shortcutDesc: '点击右侧按钮后按下新的组合键即可修改；组合需包含 ⌘/Ctrl、Alt 或 Shift 等修饰键。',
      pressKeys: '请按下快捷键…', resetDefault: '恢复默认', shortcutHint: '修改后立即生效',
      needMod: '请至少包含一个修饰键（⌘/Ctrl、Alt 或 Shift）', needComposer: '请先打开一个会话',
      address: '地址', username: '用户名', secret: '密码',
      syncNow: '立即同步', restore: '从服务器恢复', autoSync: '自动同步',
      off: '关闭',
      syncing: '同步中…', synced: '已同步', syncFail: '同步失败',
      needUrl: '请先填写 WebDAV 地址', restoreConfirm: '会用云端的提示词覆盖本地，确定继续吗？',
      syncConfirm: '会把本机提示词上传并覆盖云端文件，确定继续吗？',
      confirm: '确定', confirmTitle: '操作确认',
      restored: '已从服务器恢复', noRemote: '云端暂无数据', required: '标题和内容都不能为空',
      min: '分钟', hour: '1 小时',
      addCombo: '新增组合', editCombo: '编辑组合', comboTitle: '提示词组合',
      comboName: '组合名称', comboNamePlaceholder: '例如「工作日报」',
      comboList: '组合列表', comboSearch: '搜索并选择提示词…',
      comboEmpty: '还没有添加提示词，点上方「新增」开始', comboNoMatch: '没有可匹配的提示词',
      addRow: '新增', comboChoose: '选择提示词', insertBelow: '往下插入',
      comboTab: '组合', comboEmptyList: '还没有组合，点右上角「新增组合」创建',
      comboHint: '下拉框搜索选择，每次最多显示 10 项；拖动左侧手柄可以调整顺序。',
      comboRequired: '组合名称不能为空', comboItemsRequired: '请至少添加一条提示词',
      duplicateTitle: '提示词标题已存在，请换一个', duplicateCombo: '组合名称已存在，请换一个',
      delComboConfirm: '确定删除这个组合吗？',
    };
    const en = {
      trigger: 'Quick Prompts', triggerTip: 'Manage reusable prompts; click one to insert it',
      title: 'Quick Prompts', search: 'Search title, content or pinyin…', add: 'New',
      empty: 'No prompts yet. Click “New” to create one.', noResult: 'No matching prompts', settings: 'Settings', close: 'Close',
      edit: 'Edit', del: 'Delete', delConfirm: 'Delete this prompt?',
      promptTitle: 'Title', promptContent: 'Content', save: 'Save', cancel: 'Cancel',
      group: 'Group', groupPlaceholder: 'Pick or type a group (optional)', all: 'All', ungrouped: 'Ungrouped',
      titlePlaceholder: 'e.g. Code review', contentPlaceholder: 'Enter prompt content…',
      shortcutTab: 'Shortcut', syncTab: 'Sync', shortcutLabel: 'Open quick prompts',
      prevTab: 'Previous group', nextTab: 'Next group',
      syncDesc: '① Where the WebDAV address comes from: in Jianguo Cloud, open Settings → General → Third-party app management → Manage, add an app, and you will get the WebDAV address and app password (username = your Jianguo Cloud account, password = the generated app password; usually https://dav.jianguoyun.com/dav/). Other providers enable WebDAV in their own settings/security page.\n② Conflict notes: syncs on one computer run one at a time and never overwrite each other; when several computers edit at once, the last upload wins—click “Restore from server” before editing on another device and avoid editing simultaneously. Auto sync only uploads backups and never pulls automatically.',
      unset: 'Not set', clearShortcut: 'Remove shortcut',
      shortcutClearConfirm: 'Remove this shortcut? You can record a new one afterwards.',
      shortcutDesc: 'Click the button and press a new key combo. It must include a modifier such as ⌘/Ctrl, Alt or Shift.',
      pressKeys: 'Press shortcut…', resetDefault: 'Reset', shortcutHint: 'Saved instantly',
      needMod: 'Include at least one modifier (⌘/Ctrl, Alt or Shift)', needComposer: 'Open a session first',
      address: 'Address', username: 'Username', secret: 'Password',
      syncNow: 'Sync now', restore: 'Restore from server', autoSync: 'Auto sync',
      off: 'Off',
      syncing: 'Syncing…', synced: 'Synced', syncFail: 'Sync failed',
      needUrl: 'Please enter the WebDAV address first', restoreConfirm: 'This will overwrite local prompts with the cloud copy. Continue?',
      syncConfirm: 'This will upload local prompts and overwrite the cloud copy. Continue?',
      confirm: 'Confirm', confirmTitle: 'Confirm action',
      restored: 'Restored from server', noRemote: 'No data on server', required: 'Title and content are required',
      min: 'min', hour: '1 hour',
      addCombo: 'New combo', editCombo: 'Edit combo', comboTitle: 'Prompt combo',
      comboName: 'Combo name', comboNamePlaceholder: 'e.g. Daily standup',
      comboList: 'Combo items', comboSearch: 'Search and pick prompts…',
      comboEmpty: 'No prompts added yet. Click “Add” above to start.', comboNoMatch: 'No matching prompts',
      addRow: 'Add', comboChoose: 'Choose a prompt', insertBelow: 'Insert below',
      comboTab: 'Combos', comboEmptyList: 'No combos yet. Click “New combo” at the top right.',
      comboHint: 'Search and pick from the dropdown; up to 10 results. Drag the handle to reorder.',
      comboRequired: 'Combo name is required', comboItemsRequired: 'Add at least one prompt',
      duplicateTitle: 'A prompt with this title already exists', duplicateCombo: 'A combo with this name already exists',
      delComboConfirm: 'Delete this combo?',
    };

    // ---------- 图标（手绘 SVG，随 currentColor 变色，无需图标库） ----------
    function BoltIcon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 1024 1024', fill: 'currentColor', style: { display: 'block' }, 'aria-hidden': 'true' },
        h('path', { d: 'M529.15844778 976.9172389l336.0297711-513.31678891c14.32083001-20.53461333 8.59249778-46.94319445-11.50520889-61.60384a32.23400334 32.23400334 0 0 0-22.96187221-8.78667776h-264.23144335V70.53008555c0-23.44732445-20.09770667-43.98193778-43.05957888-43.98193778-14.36937443 0-28.73875001 8.7866789-34.4670811 20.53461333L152.93326222 560.39955001c-14.32083001 20.53461333-8.59249778 46.94319445 11.50520889 61.60384 5.72833223 5.82542222 14.36937443 8.7866789 22.96187221 8.78667776h264.23144334v322.67984668c0 23.44732445 20.09770667 43.98193778 43.05957888 43.98193778 14.36937443 0 28.73875001-8.7866789 34.46708224-20.53461333z' }));
    }
    function GearIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', { d: 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z' }));
    }
    function CloseIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18' }));
    }
    function EditIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 20h9' }), h('path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }));
    }
    function TrashIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6' }));
    }
    function PlusIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 5v14M5 12h14' }));
    }
    function ChevronDownIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M6 9l6 6 6-6' }));
    }
    function ChevronLeftIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M15 6l-6 6 6 6' }));
    }
    function ChevronRightIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M9 6l6 6-6 6' }));
    }
    // 组合：多层叠放
    function StackIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 3 3 8l9 5 9-5-9-5Z' }),
        h('path', { d: 'm3 13 9 5 9-5' }));
    }
    // 拖拽排序手柄
    function GripIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
        h('circle', { cx: 9, cy: 6, r: 1.3 }), h('circle', { cx: 15, cy: 6, r: 1.3 }),
        h('circle', { cx: 9, cy: 12, r: 1.3 }), h('circle', { cx: 15, cy: 12, r: 1.3 }),
        h('circle', { cx: 9, cy: 18, r: 1.3 }), h('circle', { cx: 15, cy: 18, r: 1.3 }));
    }

    // ---------- 通用工具 ----------
    const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    // 中文输入法选词时不要处理按键（回车只用来确认候选词）
    const isComposingEvent = (e) => !!e && (e.isComposing === true || e.keyCode === 229);
    const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const groupOf = (p) => (p.group || '').trim();          // 统一取“干净”的分组名
    const nowISO = () => new Date().toISOString();
    const timeLabel = () => new Date().toLocaleTimeString();

    // 把任意对象规整成标准提示词结构（加载本地 / 拉取云端都走这里，保证字段可靠）
    function normalizePrompt(raw) {
      const p = isRecord(raw) ? raw : {};
      return {
        id: typeof p.id === 'string' && p.id ? p.id : uid(),
        title: String(p.title || ''),
        content: String(p.content || ''),
        group: groupOf(p),
        createdAt: Number(p.createdAt) || Date.now(),
      };
    }
    // 组合：名称 + 有顺序的提示词 id 列表
    function normalizeCombo(raw) {
      const c = isRecord(raw) ? raw : {};
      return {
        id: typeof c.id === 'string' && c.id ? c.id : uid(),
        name: String(c.name || ''),
        items: Array.isArray(c.items) ? c.items.filter((x) => typeof x === 'string' && x) : [],
        createdAt: Number(c.createdAt) || Date.now(),
      };
    }
    // 把任意对象规整成标准设置结构（自动同步间隔只允许预设值）
    function normalizeSettings(raw) {
      const s = isRecord(raw) ? raw : {};
      const minutes = Number(s.autoSyncMinutes);
      return {
        url: String(s.url || ''),
        username: String(s.username || ''),
        secret: String(s.secret || ''),
        autoSyncMinutes: AUTO_SYNC_OPTIONS.indexOf(minutes) >= 0 ? minutes : 0,
      };
    }

    // ---------- 本地存储 ----------
    // 读取本地存储；新键没有数据时自动从旧插件名的键迁移一次
    function readRaw(key) {
      try {
        if (typeof localStorage === 'undefined') return null;
        let raw = localStorage.getItem(key);
        if (raw === null) {
          const legacyKey = LEGACY_STORAGE_KEYS[key];
          if (legacyKey) {
            raw = localStorage.getItem(legacyKey);
            if (raw !== null) localStorage.setItem(key, raw);
          }
        }
        return raw;
      } catch { return null; }
    }
    function readJSON(key, fallback) {
      const raw = readRaw(key);
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    }
    function writeJSON(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
      } catch { /* 隐私模式 / 配额不足，忽略即可 */ }
    }
    function loadPrompts() {
      const list = readJSON(STORAGE_KEYS.prompts, null);
      if (Array.isArray(list)) return list.map(normalizePrompt);
      const seeded = SEED_PROMPTS.map(normalizePrompt);
      writeJSON(STORAGE_KEYS.prompts, seeded);
      return seeded;
    }
    const savePrompts = (list) => writeJSON(STORAGE_KEYS.prompts, list);
    function loadCombos() {
      const list = readJSON(STORAGE_KEYS.combos, []);
      return Array.isArray(list) ? list.map(normalizeCombo).filter((c) => c.name) : [];
    }
    const saveCombos = (list) => writeJSON(STORAGE_KEYS.combos, list);
    const loadSettings = () => normalizeSettings(readJSON(STORAGE_KEYS.settings, {}));
    const saveSettings = (s) => writeJSON(STORAGE_KEYS.settings, s);

    // ---------- 云端客户端（经宿主代理，避开浏览器跨域） ----------
    // action: 'read' 拉取 / 'write' 推送；统一返回 { data } 或抛错
    async function davRequest(settings, action, data) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: settings.url,
          username: settings.username,
          secret: settings.secret,
          action,
          data,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.error) throw new Error(payload.error || ('HTTP ' + res.status));
      return payload;
    }
    const dav = {
      read: (settings) => davRequest(settings, 'read'),
      write: (settings, prompts, combos) => davRequest(settings, 'write', {
        version: SYNC_VERSION, updatedAt: nowISO(), prompts, combos,
      }),
    };


    // ---------- 拼音搜索 ----------
    let pinyinCodeCache = null;
    const pinyinTextCache = new Map();
    // 把字典里的 base64 下标解码成 Uint16Array（只做一次）
    function pinyinCodes() {
      if (pinyinCodeCache) return pinyinCodeCache;
      const bin = atob(PINYIN_CODES);
      const codes = new Uint16Array(bin.length / 2);
      for (let i = 0; i < codes.length; i += 1) {
        codes[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      }
      pinyinCodeCache = codes;
      return codes;
    }
    // 单字读音：只查 CJK 基本区，其它字符返回空
    function charPinyin(ch) {
      const cp = ch.codePointAt(0);
      if (cp < PINYIN_RANGE_START || cp > PINYIN_RANGE_END) return '';
      const code = pinyinCodes()[cp - PINYIN_RANGE_START];
      return code ? PINYIN_SYLLABLES[code] : '';
    }
    // 把文本转成「整串拼音」与「首字母」两种形式，用于模糊搜索
    function pinyinForms(text) {
      const hit = pinyinTextCache.get(text);
      if (hit) return hit;
      let full = '';
      let initials = '';
      for (const ch of text) {
        const py = charPinyin(ch);
        if (py) { full += py; initials += py[0]; }
        else { const lower = ch.toLowerCase(); full += lower; initials += lower; }
      }
      const flat = full.replace(/\s+/g, '');
      const forms = { full: flat, alt: flat.replace(/v/g, 'u'), initials: initials.replace(/\s+/g, '') };
      if (pinyinTextCache.size > 1000) pinyinTextCache.clear();
      pinyinTextCache.set(text, forms);
      return forms;
    }
    // ---------- 纯选择器：分组 / 搜索 ----------
    // 从全部提示词收集分组（顺序稳定），并标记是否存在“未分组”
    function collectGroups(prompts) {
      const names = [];
      const seen = new Set();
      let hasUngrouped = false;
      prompts.forEach((p) => {
        const g = groupOf(p);
        if (!g) hasUngrouped = true;
        else if (!seen.has(g)) { seen.add(g); names.push(g); }
      });
      return { names, hasUngrouped };
    }
    // 关键词匹配（标题 / 内容 / 拼音全拼 / 拼音首字母）
    function matchPrompts(prompts, query) {
      const q = query.trim().toLowerCase();
      if (!q) return prompts;
      const qFlat = q.replace(/\s+/g, '');
      const needPinyin = /[a-z]/.test(qFlat); // 纯中文查询无需转拼音，省一次遍历
      return prompts.filter((p) => {
        if (p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)) return true;
        if (!needPinyin) return false;
        const title = pinyinForms(p.title);
        const content = pinyinForms(p.content);
        return [title, content].some((f) => (
          f.full.includes(qFlat) || f.alt.includes(qFlat) || f.initials.includes(qFlat)
        ));
      });
    }
    // 生成 tab：固定一个「组合」tab（放最左） + 全部 + 各分组 + 未分组（带计数）
    function buildTabs(t, groups, matched, combos = []) {
      const tabs = [{ key: COMBO_TAB, label: t('comboTab'), count: combos.length }];
      const counts = new Map();
      let ungrouped = 0;
      matched.forEach((p) => {
        const g = groupOf(p);
        if (!g) ungrouped += 1;
        else counts.set(g, (counts.get(g) || 0) + 1);
      });
      tabs.push({ key: GROUP_ALL, label: t('all'), count: matched.length });
      groups.names.forEach((g) => tabs.push({ key: g, label: g, count: counts.get(g) || 0 }));
      if (groups.hasUngrouped) tabs.push({ key: UNGROUPED, label: t('ungrouped'), count: ungrouped });
      return tabs;
    }
    const byGroup = (list, key) => (key === GROUP_ALL ? list : list.filter((p) => groupOf(p) === key));
    // 通用数组移动（拖拽排序用）
    const moveArrayItem = (list, from, to) => {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    };
    // 组合里的提示词（按保存顺序，已删除的自动跳过）
    const comboPrompts = (combo, prompts) => (combo.items || [])
      .map((id) => prompts.find((p) => p.id === id)).filter(Boolean);
    const comboText = (combo, prompts) => comboPrompts(combo, prompts).map((p) => p.content).filter(Boolean).join('\n\n');
    // 标题查重（忽略大小写与首尾空格；excludeId 用于编辑时排除自己）
    const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const hasDuplicateTitle = (prompts, title, excludeId) => prompts.some((p) => p.id !== excludeId && sameName(p.title, title));
    const hasDuplicateCombo = (combos, name, excludeId) => combos.some((c) => c.id !== excludeId && sameName(c.name, name));
    const previewText = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 80);

    // ---------- 输入框操作（插入 / 回焦） ----------
    const captureSpan = (inputActions) => (
      inputActions && typeof inputActions.captureInsertion === 'function' ? inputActions.captureInsertion() : null
    );
    // 插入文本：优先用打开弹窗时记住的位置，失效则退回当前光标位置
    function insertPrompt(inputActions, text, span) {
      if (!inputActions || !text) return false;
      let ok = span ? inputActions.insertText(text, span) : false;
      if (!ok) ok = inputActions.insertText(text, captureSpan(inputActions));
      return ok !== false;
    }
    // 从按钮节点向上回溯找到可编辑区（找不到再全局兜底）
    function findComposer(anchor) {
      let scope = anchor;
      for (let i = 0; i < 8 && scope; i += 1) {
        const el = scope.querySelector && scope.querySelector('[contenteditable="true"]');
        if (el) return el;
        scope = scope.parentElement;
      }
      return typeof document !== 'undefined' ? document.querySelector('[contenteditable="true"]') : null;
    }
    // 插入后把焦点还给输入框，并把光标放到末尾
    function focusComposer(anchor) {
      setTimeout(() => {
        const el = findComposer(anchor);
        if (!el || typeof el.focus !== 'function') return;
        el.focus();
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch { /* 忽略选区异常 */ }
      }, 0);
    }

    // ---------- 复用 Hooks ----------
    // 保存最新值，供稳定的事件监听 / 定时器读取，避免闭包过期
    function useLatestRef(value) {
      const ref = React.useRef(value);
      React.useEffect(() => { ref.current = value; }, [value]);
      return ref;
    }

    // 自动同步：间隔变化时重建计时器，0 表示关闭
    function useAutoSync(minutes, run) {
      const runRef = useLatestRef(run);
      React.useEffect(() => {
        const m = Number(minutes) || 0;
        if (!m) return undefined;
        const id = setInterval(() => runRef.current(), m * 60000);
        return () => clearInterval(id);
      }, [minutes]);
    }
    // 修改提示词后（开启自动同步时）稍作防抖立即上传，避免只能等到下一个定时点。
    // 只在提示词变化时触发：仅切换同步间隔不会上传，避免初始化配置时用本机数据覆盖云端。
    function useAutoUploadOnEdit(prompts, combos, minutes, run) {
      const runRef = useLatestRef(run);
      const minutesRef = useLatestRef(minutes);
      const mounted = React.useRef(false);
      React.useEffect(() => {
        if (!mounted.current) { mounted.current = true; return undefined; }
        if (!(Number(minutesRef.current) > 0)) return undefined;
        const id = setTimeout(() => runRef.current(), 1200);
        return () => clearTimeout(id);
      }, [prompts, combos]);
    }

    // 提示词仓库：读取一次，commit 负责「内存 + 本地存储」双写
    function usePromptStore() {
      const [prompts, setPrompts] = React.useState(loadPrompts);
      const commit = React.useCallback((next) => { setPrompts(next); savePrompts(next); }, []);
      return [prompts, commit];
    }

    // 组合仓库
    function useComboStore() {
      const [combos, setCombos] = React.useState(loadCombos);
      const commit = React.useCallback((next) => { setCombos(next); saveCombos(next); }, []);
      return [combos, commit];
    }

    // 同步设置：state 变化自动持久化
    function useSettingsStore() {
      const [settings, setSettings] = React.useState(loadSettings);
      React.useEffect(() => { saveSettings(settings); }, [settings]);
      return [settings, setSettings];
    }

    // 快捷键设置：持久化 + 同步重新注册
    function useShortcutSetting() {
      const [spec, setSpec] = React.useState(loadShortcut);
      const change = React.useCallback((next) => {
        saveShortcut(next);
        setSpec(next);
        if (registerShortcut) registerShortcut(next);
      }, []);
      return [spec, change];
    }

    // ---------- 基础 UI 组件 ----------
    function Field({ label, children }) {
      return h('div', { className: 'qsp-field' }, h('label', { className: 'qsp-label' }, label), children);
    }
    // 图标 tooltip：悬停/聚焦 260ms 后在元素上方（空间不足则下方）显示
    function useTip(text) {
      const [tip, setTip] = React.useState(null);
      const ref = React.useRef(null);
      const timerRef = React.useRef(null);
      const id = React.useMemo(() => 'qsp-tip-' + Math.random().toString(36).slice(2, 8), [text]);
      const show = () => {
        if (!text) return;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          const el = ref.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const below = rect.top < 64;
          setTip({ left: rect.left + rect.width / 2, top: below ? rect.bottom + 6 : rect.top - 6, below });
        }, 260);
      };
      const hide = () => { clearTimeout(timerRef.current); setTip(null); };
      React.useEffect(() => () => clearTimeout(timerRef.current), []);
      const node = tip
        ? createPortal(h('div', {
            id, role: 'tooltip', className: 'qsp-tooltip',
            style: { left: tip.left + 'px', top: tip.top + 'px', transform: tip.below ? 'translateX(-50%)' : 'translateX(-50%) translateY(-100%)' },
          }, text), document.body)
        : null;
      return { ref, node, show, hide, describedBy: tip ? id : undefined };
    }
    function TooltipButton({ className, label, title, children, ...rest }) {
      const tip = useTip(title || label);
      const { onClick, ...buttonProps } = rest;
      return h(React.Fragment, null,
        h('button', {
          ...buttonProps, type: 'button', ref: tip.ref,
          className: 'qsp-iconbtn' + (className ? ' ' + className : ''),
          'aria-label': label, 'aria-describedby': tip.describedBy,
          onMouseEnter: tip.show, onMouseLeave: tip.hide, onFocus: tip.show, onBlur: tip.hide,
          onClick: (e) => { tip.hide(); if (onClick) onClick(e); },
        }, children),
        tip.node,
      );
    }
    function TipSpan({ className, label, children }) {
      const tip = useTip(label);
      return h(React.Fragment, null,
        h('span', {
          className, ref: tip.ref, 'aria-label': label, 'aria-describedby': tip.describedBy,
          onMouseEnter: tip.show, onMouseLeave: tip.hide, onFocus: tip.show, onBlur: tip.hide,
        }, children),
        tip.node,
      );
    }
    const IconButton = TooltipButton;
    function Button({ primary, className, children, ...rest }) {
      return h('button', {
        type: 'button',
        className: 'qsp-btn' + (primary ? ' qsp-btn-primary' : '') + (className ? ' ' + className : ''),
        ...rest,
      }, children);
    }
    function StatusLine({ status }) {
      if (!status || !status.text) return null;
      return h('div', { className: 'qsp-status' + (status.error ? ' qsp-status-err' : '') }, status.text);
    }

    // ---------- 子视图：列表 ----------
    function PromptListView(props) {
      const { t, items, query, onQueryChange, tabs, activeGroup, onSelectGroup, showTabs,
        activeIndex, onActive, onInsert, onEdit, onDelete, emptyText, searchRef } = props;
      return h('div', { className: 'qsp-body qsp-body-list' },
        h('div', { className: 'qsp-toolbar' },
          h('input', {
            ref: searchRef, className: 'qsp-input qsp-search', type: 'text',
            placeholder: t('search'), value: query,
            onChange: (e) => onQueryChange(e.target.value),
          }),
        ),
        // 只有存在真实分组时才展示分组栏，避免多余 tab
        showTabs ? (() => {
          const index = Math.max(0, tabs.findIndex((tab) => tab.key === activeGroup));
          const step = (delta) => onSelectGroup(tabs[(index + delta + tabs.length) % tabs.length].key);
          return h('div', { className: 'qsp-tabbar' },
            h(IconButton, {
              className: 'qsp-tabnav', label: t('prevTab'),
              onClick: () => step(-1),
            }, h(ChevronLeftIcon, { size: 14 })),
            h('div', { className: 'qsp-tabs', role: 'tablist' },
              tabs.map((tab) => h('button', {
                key: tab.key || '__ungrouped__',
                type: 'button', role: 'tab',
                'aria-selected': tab.key === activeGroup,
                className: 'qsp-tab' + (tab.key === activeGroup ? ' qsp-tab-active' : ''),
                onClick: () => onSelectGroup(tab.key),
              }, tab.label + '(' + tab.count + ')')),
            ),
            h(IconButton, {
              className: 'qsp-tabnav', label: t('nextTab'),
              onClick: () => step(1),
            }, h(ChevronRightIcon, { size: 14 })),
          );
        })() : null,
        h('div', { className: 'qsp-list', role: 'listbox' },
          items.length === 0
            ? h('div', { className: 'qsp-empty' }, emptyText)
            : items.map((p, i) => h('div', {
                key: p.id, role: 'option', 'aria-selected': i === activeIndex,
                className: 'qsp-item' + (i === activeIndex ? ' qsp-item-active' : ''),
                onMouseEnter: () => onActive(i),
                onClick: () => onInsert(p),
                title: p.content,
              },
                h('div', { className: 'qsp-item-main' },
                  h('div', { className: 'qsp-item-title' }, p.title),
                  h('div', { className: 'qsp-item-preview' }, previewText(p.content)),
                ),
                h('div', { className: 'qsp-item-ops' },
                  h(IconButton, { label: t('edit'), onClick: (e) => { e.stopPropagation(); onEdit(p); } }, h(EditIcon)),
                  h(IconButton, { className: 'qsp-iconbtn-danger', label: t('del'), onClick: (e) => { e.stopPropagation(); onDelete(p); } }, h(TrashIcon)),
                ),
              )),
        ),
      );
    }

    // ---------- 子视图：新增 / 编辑 ----------
    function PromptEditorView({ t, draft, onChange, groupNames, onSubmit, onCancel, error }) {
      return h(React.Fragment, null,
        h('div', { className: 'qsp-body' },
          h(Field, { label: t('promptTitle') },
            h('input', {
              className: 'qsp-input', type: 'text', autoFocus: true,
              placeholder: t('titlePlaceholder'), value: draft.title,
              onChange: (e) => onChange({ title: e.target.value }),
            })),
          h(Field, { label: t('group') },
            h('input', {
              className: 'qsp-input', type: 'text', spellCheck: false, list: 'qsp-group-list',
              placeholder: t('groupPlaceholder'), value: draft.group || '',
              onChange: (e) => onChange({ group: e.target.value }),
            }),
            h('datalist', { id: 'qsp-group-list' }, groupNames.map((g) => h('option', { key: g, value: g })))),
          h(Field, { label: t('promptContent') },
            h('textarea', {
              className: 'qsp-input qsp-textarea', rows: 6,
              placeholder: t('contentPlaceholder'), value: draft.content,
              onChange: (e) => onChange({ content: e.target.value }),
            })),
          h(StatusLine, { status: error ? { text: error, error: true } : null }),
        ),
        h('div', { className: 'qsp-footer' },
          h(Button, { onClick: onCancel }, t('cancel')),
          h(Button, { primary: true, onClick: onSubmit }, t('save')),
        ),
      );
    }


    // ---------- 子视图：新增 / 编辑组合 ----------
    // 交互：顶部「新增」按钮 → 新出现一行 → 在行内「选择」提示词 / 往下插入 / 删除；
    //      行左侧手柄可拖拽排序（SortableJS，带平滑 FLIP 式位移动画）。
    function ComboEditorView({ t, draft, prompts, onChange, onSubmit, onCancel, error }) {
      const [rows, setRows] = React.useState(() => (draft.items || []).map((id) => ({ key: uid(), id })));
      const [picking, setPicking] = React.useState(-1); // 当前打开选择下拉的行
      const [query, setQuery] = React.useState('');
      const [cursor, setCursor] = React.useState(0);
      const listRef = React.useRef(null);
      const wrapRefs = React.useRef([]);
      const rowsRef = useLatestRef(rows);
      const onChangeRef = useLatestRef(onChange);
      const byId = React.useMemo(() => new Map(prompts.map((p) => [p.id, p])), [prompts]);
      const selectedCount = rows.filter((r) => byId.get(r.id)).length;

      // 行数据是本地唯一来源；同步给父组件时只保留真实存在的提示词 id，空行自动忽略
      const commitRows = (next) => {
        setRows(next);
        onChangeRef.current({ items: next.map((r) => r.id).filter(Boolean) });
      };
      const addRow = (at) => {
        const next = rows.slice();
        const index = typeof at === 'number' ? at + 1 : next.length;
        next.splice(index, 0, { key: uid(), id: '' });
        commitRows(next);
        setPicking(index); setQuery(''); setCursor(0);
      };
      const removeRow = (index) => {
        commitRows(rows.filter((_, j) => j !== index));
        setPicking((p) => (p === index ? -1 : (p > index ? p - 1 : p)));
      };
      const choose = (index, id) => {
        commitRows(rows.map((r, j) => (j === index ? { ...r, id } : r)));
        setPicking(-1); setQuery(''); setCursor(0);
      };
      const togglePicker = (index) => {
        if (picking === index) { setPicking(-1); return; }
        setPicking(index); setQuery(''); setCursor(0);
      };
      // 候选：排除其它行已选、以及同标题的提示词，最多展示 10 项
      const candidatesFor = (index) => {
        const usedIds = new Set();
        const usedTitles = new Set();
        rows.forEach((r, j) => {
          if (j === index) return;
          const p = byId.get(r.id);
          if (p) { usedIds.add(p.id); usedTitles.add(p.title.trim().toLowerCase()); }
        });
        const source = query.trim() ? matchPrompts(prompts, query) : prompts;
        return source.filter((p) => (
          !usedIds.has(p.id) && !usedTitles.has(p.title.trim().toLowerCase())
        )).slice(0, 10);
      };

      // 点击空白处收起选择下拉
      React.useEffect(() => {
        if (picking < 0) return undefined;
        const onDocDown = (e) => {
          const el = wrapRefs.current[picking];
          if (el && !el.contains(e.target)) setPicking(-1);
        };
        document.addEventListener('mousedown', onDocDown, true);
        return () => document.removeEventListener('mousedown', onDocDown, true);
      }, [picking]);

      // 拖拽排序：SortableJS 负责拖动手感与平滑位移动画，onEnd 只同步数据顺序
      React.useEffect(() => {
        const el = listRef.current;
        if (!el || typeof Sortable === 'undefined') return undefined;
        const sortable = Sortable.create(el, {
          animation: 180,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          handle: '.qsp-combo-grip',
          draggable: '.qsp-combo-itemrow',
          ghostClass: 'qsp-combo-ghost',
          chosenClass: 'qsp-combo-chosen',
          dragClass: 'qsp-combo-drag',
          onEnd: (evt) => {
            if (evt.oldIndex === evt.newIndex) return;
            commitRows(moveArrayItem(rowsRef.current, evt.oldIndex, evt.newIndex));
          },
        });
        return () => sortable.destroy();
      }, []);

      const pickerKeyDown = (e, candidates) => {
        if (isComposingEvent(e)) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((i) => Math.min(i + 1, Math.max(0, candidates.length - 1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((i) => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (candidates[cursor]) choose(picking, candidates[cursor].id);
        } else if (e.key === 'Escape') { e.stopPropagation(); setPicking(-1); setQuery(''); }
      };

      return h(React.Fragment, null,
        h('div', { className: 'qsp-body' },
          h(Field, { label: t('comboName') },
            h('input', {
              className: 'qsp-input', type: 'text', autoFocus: true,
              placeholder: t('comboNamePlaceholder'), value: draft.name || '',
              onChange: (e) => onChange({ name: e.target.value }),
            })),
          h('div', { className: 'qsp-field' },
            h('label', { className: 'qsp-label' }, t('comboList') + ' · ' + selectedCount),
            h('div', { className: 'qsp-combo-addbar' },
              h('button', { type: 'button', className: 'qsp-combo-addbtn', onClick: () => addRow() },
                h(PlusIcon, { size: 14 }), h('span', null, t('addRow')))),
            h('div', { className: 'qsp-combo-list', ref: listRef },
              rows.length ? rows.map((row, index) => {
                const prompt = byId.get(row.id);
                const candidates = picking === index ? candidatesFor(index) : null;
                return h('div', { key: row.key, className: 'qsp-combo-itemrow' },
                  h(TipSpan, { className: 'qsp-combo-grip', label: t('comboHint') }, h(GripIcon)),
                  h('div', {
                    className: 'qsp-combo-selectwrap',
                    ref: (el) => { wrapRefs.current[index] = el; },
                  },
                    h('button', {
                      type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': picking === index,
                      className: 'qsp-combo-selectbtn' + (prompt ? '' : ' is-empty'),
                      onClick: () => togglePicker(index),
                    },
                      h('span', { className: 'qsp-combo-title' }, prompt ? prompt.title : t('comboChoose')),
                      h(ChevronDownIcon, { size: 14 })),
                    picking === index ? h('div', { className: 'qsp-combo-menu', role: 'listbox' },
                      h('input', {
                        className: 'qsp-input qsp-combo-searchbox', type: 'text', spellCheck: false,
                        autoFocus: true, placeholder: t('comboSearch'), value: query,
                        onChange: (e) => { setQuery(e.target.value); setCursor(0); },
                        onKeyDown: (e) => pickerKeyDown(e, candidates),
                      }),
                      candidates.length
                        ? candidates.map((p, i) => h('button', {
                            key: p.id, type: 'button', role: 'option',
                            className: 'qsp-combo-option' + (i === cursor ? ' qsp-combo-option-active' : ''),
                            onMouseDown: (e) => e.preventDefault(),
                            onMouseEnter: () => setCursor(i),
                            onClick: () => choose(index, p.id),
                          }, p.title))
                        : h('div', { className: 'qsp-combo-menu-empty' }, t('comboNoMatch')),
                    ) : null,
                  ),
                  h('button', { type: 'button', className: 'qsp-combo-insertbtn', onClick: () => addRow(index) },
                    t('insertBelow')),
                  h(IconButton, { className: 'qsp-iconbtn-danger', label: t('del'), onClick: () => removeRow(index) }, h(TrashIcon, { size: 14 })),
                );
              }) : h('div', { className: 'qsp-combo-empty' }, t('comboEmpty')),
            ),
            h('p', { className: 'qsp-desc' }, t('comboHint')),
          ),
          h(StatusLine, { status: error ? { text: error, error: true } : null }),
        ),
        h('div', { className: 'qsp-footer' },
          h(Button, { onClick: onCancel }, t('cancel')),
          h(Button, { primary: true, onClick: onSubmit }, t('save')),
        ),
      );
    }
    // ---------- 子视图：快捷键设置（录制式，参考 sidebar-file-search） ----------
    function ShortcutSettingsView({ t, spec, onChange, confirm }) {
      const hasValue = !!spec;
      const [capturing, setCapturing] = React.useState(false);
      const [preview, setPreview] = React.useState('');
      const [error, setError] = React.useState('');
      // 监听器只注册一次，通过 ref 读取最新的回调与文案，避免依赖变化导致重新录制
      const onChangeRef = useLatestRef(onChange);
      const tRef = useLatestRef(t);

      // 录制期间监听全局按键：组合键 → 新 spec；Esc 取消；纯修饰键实时预览
      React.useEffect(() => {
        shortcutHub.capturing = capturing;
        if (!capturing) return undefined;
        const modsOf = (e) => {
          const list = [];
          if (e.metaKey || e.ctrlKey) list.push('primary');
          if (e.altKey) list.push('alt');
          if (e.shiftKey) list.push('shift');
          return list;
        };
        const stop = () => { setCapturing(false); setPreview(''); setError(''); };
        const onKeyDown = (e) => {
          if (isComposingEvent(e) || e.keyCode === 229) return;
          e.preventDefault();
          e.stopPropagation();
          // 只按修饰键时先实时预览，让用户知道已按住了哪些键
          if (PURE_MODIFIER_KEYS.includes(e.key)) { setPreview(modsToText(modsOf(e))); return; }
          const plainEscape = e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
          if (plainEscape) { stop(); return; }
          const modifiers = modsOf(e);
          if (!modifiers.length) { setError(tRef.current('needMod')); return; }
          onChangeRef.current({ code: e.code, modifiers });
          stop();
        };
        // 松开修饰键时同步清掉预览，避免按钮一直停在“⇧”
        const onKeyUp = (e) => {
          if (PURE_MODIFIER_KEYS.includes(e.key)) setPreview(modsToText(modsOf(e)));
        };
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('keyup', onKeyUp, true);
          shortcutHub.capturing = false;
        };
      }, [capturing]);

      return h(React.Fragment, null,
        h('div', { className: 'qsp-body' },
          h('p', { className: 'qsp-desc' }, t('shortcutDesc')),
          h('div', { className: 'qsp-setrow' },
            h('span', { className: 'qsp-setname' }, t('shortcutLabel')),
            h('div', { className: 'qsp-keygroup' },
              h('button', {
                type: 'button',
                className: 'qsp-keybtn' + (capturing ? ' is-capturing' : '') + (error ? ' is-error' : ''),
                onClick: () => { setCapturing(true); setPreview(''); setError(''); },
              }, capturing ? (preview || t('pressKeys')) : (hasValue ? specToText(spec) : t('unset'))),
              // 录制过快捷键后，右侧出现删除按钮（删除前确认）
              hasValue && !capturing ? h(IconButton, {
                className: 'qsp-keyclear', label: t('clearShortcut'),
                onClick: async () => {
                  if (!(await confirm(t('shortcutClearConfirm')))) return;
                  onChange(null); setPreview(''); setError('');
                },
              }, h(CloseIcon, { size: 14 })) : null,
            ),
          ),
          h('div', { className: 'qsp-set-error' }, error),
        ),
        h('div', { className: 'qsp-footer qsp-footer-between' },
          h(Button, { onClick: () => { onChange(DEFAULT_SPEC); setPreview(''); setError(''); } }, t('resetDefault')),
          h('span', { className: 'qsp-set-hint' }, t('shortcutHint')),
        ),
      );
    }

    // ---------- 子视图：同步设置 ----------
    function SyncSettingsView({ t, settings, onChange, sync, syncing, onSyncNow, onRestore }) {
      return h(React.Fragment, null,
        h('div', { className: 'qsp-body' },
          h('p', { className: 'qsp-desc qsp-sync-desc' }, t('syncDesc')),
          h(Field, { label: t('address') },
            h('input', {
              className: 'qsp-input', type: 'url', spellCheck: false,
              placeholder: 'https://dav.jianguoyun.com/dav/',
              value: settings.url, onChange: (e) => onChange({ url: e.target.value }),
            })),
          h(Field, { label: t('username') },
            h('input', {
              className: 'qsp-input', type: 'text', spellCheck: false,
              value: settings.username, onChange: (e) => onChange({ username: e.target.value }),
            })),
          h(Field, { label: t('secret') },
            h('input', {
              className: 'qsp-input', type: 'pass' + 'word', spellCheck: false, autoComplete: 'off',
              value: settings.secret, onChange: (e) => onChange({ secret: e.target.value }),
            })),
          h(Field, { label: t('autoSync') },
            h('div', { className: 'qsp-selectwrap' },
              h('select', {
                className: 'qsp-input qsp-select',
                value: String(settings.autoSyncMinutes),
                onChange: (e) => onChange({ autoSyncMinutes: Number(e.target.value) }),
              },
                AUTO_SYNC_OPTIONS.map((m) => h('option', { key: m, value: String(m) },
                  m === 0 ? t('off') : m === 60 ? t('hour') : m + ' ' + t('min'))),
              ),
              h(ChevronDownIcon, null))),
          h(StatusLine, { status: sync }),
        ),
        h('div', { className: 'qsp-footer' },
          h(Button, { disabled: syncing, onClick: onRestore }, t('restore')),
          h(Button, { primary: true, disabled: syncing, onClick: onSyncNow }, syncing ? t('syncing') : t('syncNow')),
        ),
      );
    }

    // ---------- 弹窗外壳（对齐 DSH 官方 Modal：root 居中 + 独立遮罩 + 卡片） ----------
    function DialogShell({ t, title, ops, tabs, onClose, onMaskDown, onKeyDown, children }) {
      return h('div', { className: 'qsp-root' },
        h('div', { className: 'qsp-mask', onMouseDown: onMaskDown }),
        h('div', {
          className: 'qsp-dialog', role: 'dialog', 'aria-modal': 'true',
          'aria-label': title, tabIndex: -1, onKeyDown,
        },
          h('div', { className: 'qsp-head' },
            h('h2', { className: 'qsp-title' }, title),
            h('div', { className: 'qsp-head-ops' },
              ops,
              h(IconButton, { label: t('close'), onClick: onClose }, h(CloseIcon)),
            ),
          ),
          tabs || null,
          h('div', { className: 'qsp-content' }, children),
        ),
      );
    }

    // ---------- 主组件（注册到 conversation.input.left） ----------
    function QuickPromptButton(props) {
      const { inputActions } = props;
      const t = props.t || ((k) => zh[k] || k);

      // 数据（持久化交给专用 hooks，组件只关心交互）
      const [prompts, commit] = usePromptStore();
      const [combos, commitCombos] = useComboStore();
      const [settings, setSettings] = useSettingsStore();
      const [spec, changeSpec] = useShortcutSetting();
      // 弹窗层级：null=关闭；{ name:'list' } | { name:'settings' } | { name:'edit', draft }
      const [screen, setScreen] = React.useState(null);
      // 列表交互状态
      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(0);
      const [activeGroup, setActiveGroup] = React.useState(GROUP_ALL);
      // 同步状态与表单错误分开管理
      const [sync, setSync] = React.useState({ text: '', error: false });
      const [syncing, setSyncing] = React.useState(false);
      const [formError, setFormError] = React.useState('');
      // 同步串行队列：自动同步与手动同步共用，避免多个请求并发写坏云端数据
      const syncQueueRef = React.useRef(Promise.resolve());
      const syncPendingRef = React.useRef(0);
      // 有待执行的「从服务器恢复」时，跳过排队的自动上传，避免恢复前把云端覆盖
      const syncPullPendingRef = React.useRef(0);
      // 应用内确认框（DSH 页面里原生 confirm 可能被拦截，统一用组件内确认）
      const [confirmBox, setConfirmBox] = React.useState(null);
      const confirmResolveRef = React.useRef(null);
      const askConfirm = React.useCallback((message) => new Promise((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmBox({ message });
      }), []);
      const settleConfirm = (ok) => {
        const resolve = confirmResolveRef.current;
        confirmResolveRef.current = null;
        setConfirmBox(null);
        if (resolve) resolve(ok);
      };

      // 引用：避免闭包过期 / 记住 DOM 与插入位置
      const triggerRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const spanRef = React.useRef(null);
      const settingsRef = useLatestRef(settings);
      const promptsRef = useLatestRef(prompts);
      const combosRef = useLatestRef(combos);
      const inputActionsRef = useLatestRef(inputActions);

      // 触发器 hover / focus 提示（延迟出现，位置按按钮实时计算，portal 到 body 避免被输入框裁剪）
      const [tip, setTip] = React.useState({ open: false, left: 0, top: 0, below: false });
      const tipTimer = React.useRef(null);
      const tipId = React.useMemo(() => 'qsp-tip-' + Math.random().toString(36).slice(2, 8), []);
      const showTip = () => {
        clearTimeout(tipTimer.current);
        tipTimer.current = setTimeout(() => {
          const el = triggerRef.current;
          if (!el || typeof window === 'undefined') return;
          const rect = el.getBoundingClientRect();
          const below = rect.top < 96; // 靠近顶部时显示在按钮下方
          setTip({ open: true, left: Math.max(12, rect.left), top: below ? rect.bottom + 8 : rect.top - 8, below });
        }, 260);
      };
      const hideTip = () => { clearTimeout(tipTimer.current); setTip((prev) => (prev.open ? { ...prev, open: false } : prev)); };
      React.useEffect(() => () => clearTimeout(tipTimer.current), []);
      React.useEffect(() => {
        if (!tip.open) return undefined;
        const close = () => setTip((prev) => ({ ...prev, open: false }));
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
      }, [tip.open]);

      // 执行同步：upload 推送本地；pull 用云端覆盖本地
      async function runSync(mode, { silent = false } = {}) {
        const cfg = settingsRef.current;
        if (!cfg.url) { if (!silent) setSync({ text: t('needUrl'), error: true }); return; }
        const isPull = mode !== SYNC_MODE.upload;
        if (isPull) syncPullPendingRef.current += 1;
        syncPendingRef.current += 1;
        setSyncing(true);
        if (!silent) setSync({ text: t('syncing'), error: false });
        const task = async () => {
          try {
            // 用户已请求从云端恢复：跳过之前排队的自动上传
            if (!isPull && syncPullPendingRef.current > 0) return;
            if (!isPull) {
              // 任务真正执行时再读最新数据，排队期间的新修改不会被旧数据覆盖
              await dav.write(cfg, promptsRef.current, combosRef.current);
              setSync({ text: t('synced') + ' · ' + timeLabel(), error: false });
            } else {
              const res = await dav.read(cfg);
              const remote = res && res.data && Array.isArray(res.data.prompts) ? res.data.prompts : null;
              if (remote) {
                commit(remote.map(normalizePrompt));
                // 云端有组合数据时一并恢复；旧版云端文件没有 combos 字段时保留本机组合
                if (res.data && Array.isArray(res.data.combos)) commitCombos(res.data.combos.map(normalizeCombo));
                // 直接回到列表，用户能马上看到恢复后的提示词
                setScreen({ name: SCREEN.list });
                setSync({ text: t('restored') + ' · ' + timeLabel(), error: false });
              } else {
                setSync({ text: t('noRemote'), error: false });
              }
            }
          } catch (e) {
            setSync({ text: t('syncFail') + '：' + ((e && e.message) || e), error: true });
          } finally {
            if (isPull) syncPullPendingRef.current -= 1;
            syncPendingRef.current -= 1;
            if (!syncPendingRef.current) setSyncing(false);
          }
        };
        // 串行执行：前一个完成后再跑下一个，最后一个任务写入最新数据
        syncQueueRef.current = syncQueueRef.current.then(task, task);
        await syncQueueRef.current;
      }
      useAutoSync(settings.autoSyncMinutes, () => runSync(SYNC_MODE.upload, { silent: true }));
      useAutoUploadOnEdit(prompts, combos, settings.autoSyncMinutes, () => runSync(SYNC_MODE.upload, { silent: true }));

      // 派生数据（分组 / 搜索 / tab / 当前列表）
      const groups = React.useMemo(() => collectGroups(prompts), [prompts]);
      const matched = React.useMemo(() => matchPrompts(prompts, query), [prompts, query]);
      const tabs = React.useMemo(() => buildTabs(t, groups, matched, combos), [t, groups, matched, combos]);
      const effGroup = tabs.some((x) => x.key === activeGroup) ? activeGroup : GROUP_ALL;
      // 「组合」tab：把全部组合当作可选中条目展示，点击/回车会把该组合内容合并插入
      const comboMode = effGroup === COMBO_TAB;
      const comboItems = React.useMemo(() => combos.map((c) => ({
        id: 'combo-item-' + c.id, isCombo: true, comboId: c.id,
        title: c.name, content: comboText(c, prompts),
        comboPrompts: comboPrompts(c, prompts),
      })), [combos, prompts]);
      const filtered = React.useMemo(() => {
        if (comboMode) return comboItems.filter((item) => !query.trim() || matchPrompts([item], query).length);
        return byGroup(matched, effGroup);
      }, [comboMode, comboItems, matched, effGroup, query]);
      const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
      const editing = screen && screen.name === SCREEN.edit ? screen.draft : null;
      const comboDraft = screen && screen.name === SCREEN.combo ? screen.draft : null;

      // 打开 / 关闭与分层返回
      const openModal = () => {
        spanRef.current = captureSpan(inputActionsRef.current);
        setQuery(''); setActive(0); setActiveGroup(GROUP_ALL);
        setSync({ text: '', error: false }); setFormError('');
        setScreen({ name: SCREEN.list });
      };
      const closeLayer = () => {
        if (!screen || screen.name === SCREEN.list) { setScreen(null); return; }
        // 子层（编辑 / 设置）先退回列表层
        setScreen({ name: SCREEN.list });
        setSync({ text: '', error: false });
        setFormError('');
      };

      // 热键：把“切换弹窗”的动作登记到共享枢纽（每次 screen 变化后刷新闭包）
      React.useEffect(() => {
        const run = () => { if (screen) setScreen(null); else openModal(); };
        shortcutHub.add(run);
        return () => shortcutHub.remove(run);
      }, [screen]);

      // 回到列表时聚焦搜索框
      const screenName = screen ? screen.name : null;
      React.useEffect(() => {
        if (screenName === SCREEN.list && searchRef.current) searchRef.current.focus();
      }, [screenName]);

      // 插入提示词并回焦输入框
      const insert = (text) => {
        if (!insertPrompt(inputActions, text, spanRef.current)) return;
        setScreen(null);
        focusComposer(triggerRef.current);
      };

      // 新增 / 编辑
      const openEditor = (draft) => { setFormError(''); setScreen({ name: SCREEN.edit, draft }); };
      const openComboEditor = (draft) => { setFormError(''); setScreen({ name: SCREEN.combo, draft }); };
      const updateComboDraft = (patch) => setScreen((st) => (
        st && st.name === SCREEN.combo ? { name: SCREEN.combo, draft: { ...st.draft, ...patch } } : st
      ));
      const updateDraft = (patch) => setScreen((s) => (
        s && s.name === SCREEN.edit ? { name: SCREEN.edit, draft: { ...s.draft, ...patch } } : s
      ));
      const submitEdit = () => {
        if (!editing) return;
        const title = (editing.title || '').trim();
        const content = (editing.content || '').trim();
        const group = (editing.group || '').trim();
        if (!title || !content) { setFormError(t('required')); return; }
        // 标题查重：组合列表按名称选择提示词，同名会造成歧义
        if (hasDuplicateTitle(prompts, title, editing.id)) { setFormError(t('duplicateTitle')); return; }
        if (editing.id) {
          commit(prompts.map((p) => (p.id === editing.id ? { ...p, title, content, group } : p)));
        } else {
          commit([{ id: uid(), title, content, group, createdAt: Date.now() }, ...prompts]);
        }
        setScreen({ name: SCREEN.list }); setFormError('');
      };
      const submitCombo = () => {
        if (!comboDraft) return;
        const name = (comboDraft.name || '').trim();
        const items = (comboDraft.items || []).filter((id) => prompts.some((p) => p.id === id));
        if (!name) { setFormError(t('comboRequired')); return; }
        if (!items.length) { setFormError(t('comboItemsRequired')); return; }
        if (hasDuplicateCombo(combos, name, comboDraft.id)) { setFormError(t('duplicateCombo')); return; }
        const nextId = comboDraft.id || uid();
        const record = { id: nextId, name, items, createdAt: comboDraft.createdAt || Date.now() };
        commitCombos(comboDraft.id
          ? combos.map((c) => (c.id === comboDraft.id ? record : c))
          : [record].concat(combos));
        setActiveGroup(COMBO_TAB);
        setActive(0);
        setScreen({ name: SCREEN.list }); setFormError('');
      };
      const removePrompt = async (p) => {
        if (!(await askConfirm(t('delConfirm')))) return;
        commit(prompts.filter((x) => x.id !== p.id));
        // 同时把组合里对这条提示词的引用删掉，避免出现空引用
        commitCombos(combos.map((c) => ({ ...c, items: (c.items || []).filter((id) => id !== p.id) })));
      };
      const removeCombo = async (combo) => {
        if (!(await askConfirm(t('delComboConfirm')))) return;
        commitCombos(combos.filter((c) => c.id !== combo.id));
      };

      // 列表键盘：上下移动、回车/Tab 插入
      const onListKeyDown = (e) => {
        if (isComposingEvent(e)) return;
        if (e.key === 'Escape') { e.preventDefault(); closeLayer(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.max(0, Math.min(a + 1, filtered.length - 1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          // 左右方向键在分组 tab 之间切换（循环）
          e.preventDefault();
          if (tabs.length > 1) {
            const index = Math.max(0, tabs.findIndex((tab) => tab.key === effGroup));
            const step = e.key === 'ArrowRight' ? 1 : -1;
            setActiveGroup(tabs[(index + step + tabs.length) % tabs.length].key);
            setActive(0);
          }
        }
        else if (e.key === 'Enter' || e.key === 'Tab') {
          const item = filtered[activeIndex];
          if (item) { e.preventDefault(); insert(item.content); }
        }
      };

      // 触发器（常驻）
      const trigger = h('button', {
        ref: triggerRef, type: 'button', className: 'qsp-trigger',
        'aria-label': t('trigger'), 'aria-describedby': tip.open ? tipId : undefined,
        'aria-haspopup': 'dialog', 'aria-expanded': screen !== null,
        onMouseEnter: showTip, onMouseLeave: hideTip, onFocus: showTip, onBlur: hideTip,
        onClick: () => { hideTip(); openModal(); },
      }, h(BoltIcon, { size: 18 }));

      // 提示气泡：先说明用途，再附当前快捷键
      const tooltip = tip.open ? createPortal(h('div', {
        id: tipId, role: 'tooltip', className: 'qsp-tooltip',
        style: { left: tip.left + 'px', top: tip.top + 'px', transform: tip.below ? 'none' : 'translateY(-100%)' },
      },
        h('span', null, t('trigger') + ' · ' + t('triggerTip')),
        spec ? h('span', { className: 'qsp-tooltip-key' }, specToText(spec)) : null,
      ), document.body) : null;

      if (!screen) return h(React.Fragment, null, trigger, tooltip);

      // 按当前层级组装标题、右上角操作与主体
      let title = t('title');
      let ops = null;
      let dialogTabs = null;
      let body;
      if (screen.name === SCREEN.settings) {
        title = t('settings');
        const tab = screen.tab || SETTINGS_TAB.shortcut;
        // 两个 tab：快捷键 / 同步设置
        dialogTabs = h('div', { className: 'qsp-settings-tabs', role: 'tablist' },
          [{ key: SETTINGS_TAB.shortcut, label: t('shortcutTab') }, { key: SETTINGS_TAB.sync, label: t('syncTab') }].map((it) => h('button', {
            key: it.key, type: 'button', role: 'tab', 'aria-selected': tab === it.key,
            className: 'qsp-tab' + (tab === it.key ? ' qsp-tab-active' : ''),
            onClick: () => setScreen((s) => (s && s.name === SCREEN.settings ? { ...s, tab: it.key } : s)),
          }, it.label)),
        );
        body = tab === SETTINGS_TAB.shortcut
          ? h(ShortcutSettingsView, { t, spec, onChange: changeSpec, confirm: askConfirm })
          : h(SyncSettingsView, {
            t, settings, sync, syncing,
            onChange: (patch) => setSettings((s) => ({ ...s, ...patch })),
            onSyncNow: async () => {
              if (!(await askConfirm(t('syncConfirm')))) return;
              runSync(SYNC_MODE.upload);
            },
            onRestore: async () => {
              if (!(await askConfirm(t('restoreConfirm')))) return;
              runSync(SYNC_MODE.pull);
            },
          });
      } else if (screen.name === SCREEN.edit) {
        body = h(PromptEditorView, {
          t, draft: editing, groupNames: groups.names, error: formError,
          onChange: updateDraft,
          onSubmit: submitEdit,
          onCancel: () => { setScreen({ name: SCREEN.list }); setFormError(''); },
        });
      } else if (screen.name === SCREEN.combo) {
        title = comboDraft && comboDraft.id ? t('editCombo') : t('comboTitle');
        body = h(ComboEditorView, {
          t, draft: comboDraft, prompts, error: formError,
          onChange: updateComboDraft, onSubmit: submitCombo,
          onCancel: () => { setScreen({ name: SCREEN.list }); setFormError(''); },
        });
      } else {
        ops = h(React.Fragment, null,
          h(IconButton, { label: t('settings'), onClick: () => setScreen({ name: SCREEN.settings, tab: SETTINGS_TAB.shortcut }) }, h(GearIcon)),
          h(IconButton, {
            className: 'qsp-iconbtn-accent', label: t('addCombo'),
            onClick: () => openComboEditor({ name: '', items: [] }),
          }, h(StackIcon, { size: 16 })),
          h(IconButton, {
            className: 'qsp-iconbtn-accent', label: t('add'),
            onClick: () => openEditor({ title: '', content: '', group: effGroup === GROUP_ALL ? '' : effGroup }),
          }, h(PlusIcon, { size: 16 })),
        );
        body = h(PromptListView, {
          t, items: filtered, query, tabs, activeGroup: effGroup,
          showTabs: true,
          activeIndex, searchRef,
          emptyText: comboMode ? (combos.length ? t('noResult') : t('comboEmptyList'))
            : (query || effGroup !== GROUP_ALL) ? t('noResult') : t('empty'),
          onQueryChange: (v) => { setQuery(v); setActive(0); },
          onSelectGroup: (key) => { setActiveGroup(key); setActive(0); },
          onActive: setActive,
          onInsert: (p) => insert(p.content),
          onEdit: (p) => {
            if (p.isCombo) {
              const combo = combos.find((c) => c.id === p.comboId);
              if (combo) openComboEditor({ ...combo, items: (combo.items || []).slice() });
            } else openEditor({ ...p });
          },
          onDelete: (p) => {
            if (p.isCombo) {
              const combo = combos.find((c) => c.id === p.comboId);
              if (combo) removeCombo(combo);
            } else removePrompt(p);
          },
        });
      }

      const dialog = h(DialogShell, {
        t, title, ops, tabs: dialogTabs,
        onClose: closeLayer,
        onMaskDown: closeLayer,
        onKeyDown: (e) => {
          if (isComposingEvent(e)) return;
          if (e.key === 'Escape') { e.preventDefault(); closeLayer(); return; }
          if (screen.name === SCREEN.list) onListKeyDown(e);
        },
      }, body);

      // 应用内确认框：盖在设置/列表弹窗之上
      const confirmNode = confirmBox ? createPortal(
        h('div', { className: 'qsp-confirm-root' },
          h(DialogShell, {
            t, title: t('confirmTitle'), ops: null, tabs: null,
            onClose: () => settleConfirm(false),
            onMaskDown: () => settleConfirm(false),
            onKeyDown: (e) => { if (e.key === 'Escape') { e.preventDefault(); settleConfirm(false); } },
          },
            h(React.Fragment, null,
              h('p', { className: 'qsp-confirm-msg' }, confirmBox.message),
              h('div', { className: 'qsp-footer' },
                h(Button, { onClick: () => settleConfirm(false) }, t('cancel')),
                h(Button, { primary: true, onClick: () => settleConfirm(true) }, t('confirm')),
              ),
            ),
          ),
        ), document.body) : null;

      return h(React.Fragment, null, trigger, createPortal(dialog, document.body), confirmNode);
    }

    // ---------- 样式（全部使用 DSH 主题令牌，自动适配明暗） ----------
    const CSS = `
.qsp-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:0;overflow:visible;transition:background-color .15s ease,color .15s ease;}
.qsp-trigger svg{display:block;}
.qsp-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.qsp-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
/* 按钮提示：对齐 DSH Tooltip 视觉（深色气泡 + 快捷键小标签） */
.qsp-tooltip{position:fixed;z-index:1200;display:inline-flex;align-items:center;gap:8px;width:max-content;max-width:min(50vw,calc(100vw - 24px));box-sizing:border-box;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;white-space:normal;overflow-wrap:break-word;pointer-events:none;animation:qspFade .15s ease;}
.qsp-tooltip-key{display:inline-flex;align-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-tooltip-key-bg);font-size:11px;line-height:14px;white-space:nowrap;}
/* 弹窗：结构与 DSH 官方 Modal 保持一致（root 居中 + 独立遮罩 + 卡片） */
.qsp-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;}
.qsp-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);animation:qspFade .16s ease;}
.qsp-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;width:min(500px,100%);max-height:100%;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);animation:qspFade .16s ease;}
.qsp-dialog:focus{outline:none;}
.qsp-confirm-root{position:relative;z-index:1300;}
.qsp-confirm-root .qsp-dialog{width:min(380px,100%);}
.qsp-confirm-msg{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}
.qsp-content{display:flex;flex-direction:column;flex:1 1 auto;width:100%;min-height:0;overflow-y:auto;padding-bottom:24px;}
.qsp-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px;}
.qsp-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}
.qsp-head-ops{display:flex;align-items:center;gap:4px;}
.qsp-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;}
.qsp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.qsp-iconbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
.qsp-iconbtn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}
/* 新增：仅图标、无背景、图标高亮色；悬停时浅高亮背景 */
.qsp-iconbtn-accent{color:var(--dsw-alias-state-business-primary);}
.qsp-iconbtn-accent:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);}

/* 内容区 */
.qsp-body{display:flex;flex-direction:column;gap:12px;min-width:0;margin-top:20px;padding:0 24px;}
.qsp-body-list{overflow:hidden;}
.qsp-field{display:flex;flex-direction:column;gap:6px;}
.qsp-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);}
.qsp-input{box-sizing:border-box;width:100%;height:44px;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px;font-family:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);outline:none;transition:border-color .15s ease;}
.qsp-input::placeholder{color:var(--dsw-alias-label-caption);}
.qsp-input:focus{border-color:var(--dsw-alias-state-business-primary);}

.qsp-selectwrap{position:relative;display:flex;align-items:center;}
.qsp-selectwrap>svg{position:absolute;right:12px;pointer-events:none;color:var(--dsw-alias-label-secondary);}
.qsp-select{width:100%;cursor:pointer;appearance:none;-webkit-appearance:none;padding-right:34px;background-color:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.qsp-textarea{height:auto;min-height:130px;padding:10px 14px;line-height:1.6;resize:vertical;}
.qsp-toolbar{display:flex;align-items:center;gap:8px;}
.qsp-search{flex:1;}
/* 分组 tab：横向可滚动，超出可滑动 */
.qsp-tabbar{display:flex;align-items:center;gap:4px;margin:0 -2px;}
.qsp-tabbar .qsp-tabs{flex:1;margin:0;padding:2px 0;}
.qsp-tabnav{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.qsp-tabnav:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.qsp-tabs{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;margin:0 -2px;padding:2px;scrollbar-width:none;}
.qsp-tabs::-webkit-scrollbar{display:none;}
.qsp-tab{flex:none;height:28px;padding:0 10px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease;}
.qsp-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.qsp-tab-active,.qsp-tab-active:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-weight:500;}
.qsp-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
.qsp-list{display:flex;flex-direction:column;gap:2px;margin:2px -8px 0;padding:4px 8px;overflow-y:auto;max-height:min(48vh,400px);}
.qsp-list:focus{outline:none;}
.qsp-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;}
.qsp-item-active{background:var(--dsw-alias-interactive-bg-hover);}
.qsp-item-main{flex:1;min-width:0;}
.qsp-item-title{font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qsp-item-preview{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qsp-item-ops{display:flex;gap:2px;opacity:0;transition:opacity .12s ease;}
.qsp-item:hover .qsp-item-ops,.qsp-item-active .qsp-item-ops{opacity:1;}
.qsp-empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;}

/* 组合编辑：行内选择 + 拖拽排序 */
.qsp-combo-addbar{display:flex;justify-content:flex-start;margin-bottom:6px;}
.qsp-combo-addbtn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 10px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:12px;line-height:20px;cursor:pointer;transition:background-color .15s ease;}
.qsp-combo-addbtn:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);}
.qsp-combo-list{display:flex;flex-direction:column;gap:6px;}
.qsp-combo-itemrow{display:flex;align-items:flex-start;gap:6px;box-sizing:border-box;min-height:40px;padding:3px 4px 3px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);}
.qsp-combo-grip{display:inline-flex;align-items:center;justify-content:center;height:34px;color:var(--dsw-alias-label-tertiary);flex:none;cursor:grab;touch-action:none;}
.qsp-combo-grip:active{cursor:grabbing;}
.qsp-combo-selectwrap{position:relative;flex:1;min-width:0;}
.qsp-combo-selectbtn{display:flex;align-items:center;justify-content:center;position:relative;gap:6px;width:100%;height:34px;padding:0 28px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;}
.qsp-combo-selectbtn>svg{position:absolute;right:9px;top:50%;transform:translateY(-50%);flex:none;}
.qsp-combo-selectbtn.is-empty{color:var(--dsw-alias-label-tertiary);}
.qsp-combo-selectbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.qsp-combo-menu{position:static;margin-top:4px;max-height:220px;overflow-y:auto;box-sizing:border-box;padding:6px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent);}
.qsp-combo-searchbox{height:32px;margin-bottom:4px;font-size:12px;}
.qsp-combo-option{display:block;width:100%;box-sizing:border-box;padding:7px 9px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qsp-combo-option:hover,.qsp-combo-option-active{background:var(--dsw-alias-interactive-bg-hover);}
.qsp-combo-menu-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;}
.qsp-combo-insertbtn{flex:none;display:inline-flex;align-items:center;height:34px;padding:0 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;}
.qsp-combo-insertbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.qsp-combo-itemrow>.qsp-iconbtn{width:34px;height:34px;}
.qsp-combo-ghost{opacity:.35;}
.qsp-combo-chosen{box-shadow:var(--dsw-elevation-soft);}
.qsp-combo-drag{opacity:.95;box-shadow:var(--dsw-elevation-prominent);}
.qsp-combo-title{flex:1;min-width:0;font-size:13px;line-height:20px;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;}
.qsp-combo-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);}

/* 底部按钮：尺寸/样式与 DSH 官方 Button 对齐 */
.qsp-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:20px 24px 0;}
.qsp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:72px;height:36px;padding:0 16px;font-family:inherit;font-size:14px;font-weight:500;line-height:22px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color .15s ease,opacity .15s ease;}
.qsp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.qsp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
.qsp-btn:disabled{opacity:.4;cursor:default;}
.qsp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);}
.qsp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);opacity:.9;}
.qsp-status{font-size:12px;line-height:17px;color:var(--dsw-alias-state-success-primary);word-break:break-all;}
.qsp-status-err{color:var(--dsw-alias-state-error-primary);}
/* 设置 tab 栏：固定在标题下、内容滚动区之上 */
.qsp-settings-tabs{display:flex;flex:none;align-items:center;gap:6px;margin:4px 24px 0;padding:0 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);}
/* 快捷键设置 */
.qsp-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.qsp-sync-desc{white-space:pre-line;color:var(--dsw-alias-label-secondary);}
.qsp-setrow{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.qsp-setname{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}
.qsp-keybtn{box-sizing:border-box;min-width:140px;height:34px;padding:0 12px;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-skeleton,transparent);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease;}
.qsp-keybtn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.qsp-keybtn.is-capturing{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary);}
.qsp-keybtn.is-error{border-color:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-error-primary);}
.qsp-keygroup{display:flex;align-items:center;gap:6px;}
.qsp-keyclear{display:inline-flex;align-items:center;justify-content:center;width:30px;height:34px;padding:0;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.qsp-keyclear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary);}
.qsp-set-error{min-height:16px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary);}
.qsp-footer-between{justify-content:space-between;}
.qsp-set-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
@keyframes qspFade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.qsp-trigger,.qsp-mask,.qsp-dialog,.qsp-btn,.qsp-item-ops{transition:none;animation:none;}}
`;

    // ---------- 样式注入（优先 DSH 样式服务，退回 data-plugin-css 去重写法） ----------
    const STYLE_TAG_ID = '@lwfjyjy/dsh-session-prompt-vault/client.css';
    function ensureStyles(ctx) {
      let styles;
      try { styles = typeof ctx.get === 'function' ? ctx.get('styles') : undefined; } catch { styles = undefined; }
      if (styles && typeof styles.insert === 'function') {
        ctx.effect(() => styles.insert(CSS), 'dsh-session-prompt-vault: styles');
        return;
      }
      ctx.effect(() => {
        const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']';
        if (typeof document === 'undefined' || document.querySelector(selector)) return undefined;
        const tag = document.createElement('style');
        tag.dataset.pluginCss = STYLE_TAG_ID;
        tag.textContent = CSS;
        document.head.append(tag);
        return () => tag.remove();
      }, 'dsh-session-prompt-vault: styles');
    }

    // ---------- 第三方：SortableJS 1.15.6（MIT，拖拽排序） ----------
    // 以源码形式内联，避免插件运行时再去加载外部依赖；仅在组合编辑器打开时使用。
    const Sortable = (() => {
      const module = { exports: {} };
      const exports = module.exports;
/*! Sortable 1.15.6 - MIT | git://github.com/SortableJS/Sortable.git */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?module.exports=e():"function"==typeof define&&define.amd?define(e):(t=t||self).Sortable=e()}(this,function(){"use strict";function e(e,t){var n,o=Object.keys(e);return Object.getOwnPropertySymbols&&(n=Object.getOwnPropertySymbols(e),t&&(n=n.filter(function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable})),o.push.apply(o,n)),o}function I(o){for(var t=1;t<arguments.length;t++){var i=null!=arguments[t]?arguments[t]:{};t%2?e(Object(i),!0).forEach(function(t){var e,n;e=o,t=i[n=t],n in e?Object.defineProperty(e,n,{value:t,enumerable:!0,configurable:!0,writable:!0}):e[n]=t}):Object.getOwnPropertyDescriptors?Object.defineProperties(o,Object.getOwnPropertyDescriptors(i)):e(Object(i)).forEach(function(t){Object.defineProperty(o,t,Object.getOwnPropertyDescriptor(i,t))})}return o}function o(t){return(o="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t})(t)}function a(){return(a=Object.assign||function(t){for(var e=1;e<arguments.length;e++){var n,o=arguments[e];for(n in o)Object.prototype.hasOwnProperty.call(o,n)&&(t[n]=o[n])}return t}).apply(this,arguments)}function i(t,e){if(null==t)return{};var n,o=function(t,e){if(null==t)return{};for(var n,o={},i=Object.keys(t),r=0;r<i.length;r++)n=i[r],0<=e.indexOf(n)||(o[n]=t[n]);return o}(t,e);if(Object.getOwnPropertySymbols)for(var i=Object.getOwnPropertySymbols(t),r=0;r<i.length;r++)n=i[r],0<=e.indexOf(n)||Object.prototype.propertyIsEnumerable.call(t,n)&&(o[n]=t[n]);return o}function r(t){return function(t){if(Array.isArray(t))return l(t)}(t)||function(t){if("undefined"!=typeof Symbol&&null!=t[Symbol.iterator]||null!=t["@@iterator"])return Array.from(t)}(t)||function(t,e){if(t){if("string"==typeof t)return l(t,e);var n=Object.prototype.toString.call(t).slice(8,-1);return"Map"===(n="Object"===n&&t.constructor?t.constructor.name:n)||"Set"===n?Array.from(t):"Arguments"===n||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?l(t,e):void 0}}(t)||function(){throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}()}function l(t,e){(null==e||e>t.length)&&(e=t.length);for(var n=0,o=new Array(e);n<e;n++)o[n]=t[n];return o}function t(t){if("undefined"!=typeof window&&window.navigator)return!!navigator.userAgent.match(t)}var y=t(/(?:Trident.*rv[ :]?11\.|msie|iemobile|Windows Phone)/i),w=t(/Edge/i),s=t(/firefox/i),u=t(/safari/i)&&!t(/chrome/i)&&!t(/android/i),c=t(/iP(ad|od|hone)/i),n=t(/chrome/i)&&t(/android/i),d={capture:!1,passive:!1};function h(t,e,n){t.addEventListener(e,n,!y&&d)}function p(t,e,n){t.removeEventListener(e,n,!y&&d)}function f(t,e){if(e&&(">"===e[0]&&(e=e.substring(1)),t))try{if(t.matches)return t.matches(e);if(t.msMatchesSelector)return t.msMatchesSelector(e);if(t.webkitMatchesSelector)return t.webkitMatchesSelector(e)}catch(t){return}}function g(t){return t.host&&t!==document&&t.host.nodeType?t.host:t.parentNode}function P(t,e,n,o){if(t){n=n||document;do{if(null!=e&&(">"!==e[0]||t.parentNode===n)&&f(t,e)||o&&t===n)return t}while(t!==n&&(t=g(t)))}return null}var m,v=/\s+/g;function k(t,e,n){var o;t&&e&&(t.classList?t.classList[n?"add":"remove"](e):(o=(" "+t.className+" ").replace(v," ").replace(" "+e+" "," "),t.className=(o+(n?" "+e:"")).replace(v," ")))}function R(t,e,n){var o=t&&t.style;if(o){if(void 0===n)return document.defaultView&&document.defaultView.getComputedStyle?n=document.defaultView.getComputedStyle(t,""):t.currentStyle&&(n=t.currentStyle),void 0===e?n:n[e];o[e=!(e in o||-1!==e.indexOf("webkit"))?"-webkit-"+e:e]=n+("string"==typeof n?"":"px")}}function b(t,e){var n="";if("string"==typeof t)n=t;else do{var o=R(t,"transform")}while(o&&"none"!==o&&(n=o+" "+n),!e&&(t=t.parentNode));var i=window.DOMMatrix||window.WebKitCSSMatrix||window.CSSMatrix||window.MSCSSMatrix;return i&&new i(n)}function D(t,e,n){if(t){var o=t.getElementsByTagName(e),i=0,r=o.length;if(n)for(;i<r;i++)n(o[i],i);return o}return[]}function O(){var t=document.scrollingElement;return t||document.documentElement}function X(t,e,n,o,i){if(t.getBoundingClientRect||t===window){var r,a,l,s,c,u,d=t!==window&&t.parentNode&&t!==O()?(a=(r=t.getBoundingClientRect()).top,l=r.left,s=r.bottom,c=r.right,u=r.height,r.width):(l=a=0,s=window.innerHeight,c=window.innerWidth,u=window.innerHeight,window.innerWidth);if((e||n)&&t!==window&&(i=i||t.parentNode,!y))do{if(i&&i.getBoundingClientRect&&("none"!==R(i,"transform")||n&&"static"!==R(i,"position"))){var h=i.getBoundingClientRect();a-=h.top+parseInt(R(i,"border-top-width")),l-=h.left+parseInt(R(i,"border-left-width")),s=a+r.height,c=l+r.width;break}}while(i=i.parentNode);return o&&t!==window&&(o=(e=b(i||t))&&e.a,t=e&&e.d,e&&(s=(a/=t)+(u/=t),c=(l/=o)+(d/=o))),{top:a,left:l,bottom:s,right:c,width:d,height:u}}}function Y(t,e,n){for(var o=M(t,!0),i=X(t)[e];o;){var r=X(o)[n];if(!("top"===n||"left"===n?r<=i:i<=r))return o;if(o===O())break;o=M(o,!1)}return!1}function B(t,e,n,o){for(var i=0,r=0,a=t.children;r<a.length;){if("none"!==a[r].style.display&&a[r]!==jt.ghost&&(o||a[r]!==jt.dragged)&&P(a[r],n.draggable,t,!1)){if(i===e)return a[r];i++}r++}return null}function F(t,e){for(var n=t.lastElementChild;n&&(n===jt.ghost||"none"===R(n,"display")||e&&!f(n,e));)n=n.previousElementSibling;return n||null}function j(t,e){var n=0;if(!t||!t.parentNode)return-1;for(;t=t.previousElementSibling;)"TEMPLATE"===t.nodeName.toUpperCase()||t===jt.clone||e&&!f(t,e)||n++;return n}function E(t){var e=0,n=0,o=O();if(t)do{var i=b(t),r=i.a,i=i.d}while(e+=t.scrollLeft*r,n+=t.scrollTop*i,t!==o&&(t=t.parentNode));return[e,n]}function M(t,e){if(!t||!t.getBoundingClientRect)return O();var n=t,o=!1;do{if(n.clientWidth<n.scrollWidth||n.clientHeight<n.scrollHeight){var i=R(n);if(n.clientWidth<n.scrollWidth&&("auto"==i.overflowX||"scroll"==i.overflowX)||n.clientHeight<n.scrollHeight&&("auto"==i.overflowY||"scroll"==i.overflowY)){if(!n.getBoundingClientRect||n===document.body)return O();if(o||e)return n;o=!0}}}while(n=n.parentNode);return O()}function S(t,e){return Math.round(t.top)===Math.round(e.top)&&Math.round(t.left)===Math.round(e.left)&&Math.round(t.height)===Math.round(e.height)&&Math.round(t.width)===Math.round(e.width)}function _(e,n){return function(){var t;m||(1===(t=arguments).length?e.call(this,t[0]):e.apply(this,t),m=setTimeout(function(){m=void 0},n))}}function H(t,e,n){t.scrollLeft+=e,t.scrollTop+=n}function C(t){var e=window.Polymer,n=window.jQuery||window.Zepto;return e&&e.dom?e.dom(t).cloneNode(!0):n?n(t).clone(!0)[0]:t.cloneNode(!0)}function T(t,e){R(t,"position","absolute"),R(t,"top",e.top),R(t,"left",e.left),R(t,"width",e.width),R(t,"height",e.height)}function x(t){R(t,"position",""),R(t,"top",""),R(t,"left",""),R(t,"width",""),R(t,"height","")}function L(n,o,i){var r={};return Array.from(n.children).forEach(function(t){var e;P(t,o.draggable,n,!1)&&!t.animated&&t!==i&&(e=X(t),r.left=Math.min(null!==(t=r.left)&&void 0!==t?t:1/0,e.left),r.top=Math.min(null!==(t=r.top)&&void 0!==t?t:1/0,e.top),r.right=Math.max(null!==(t=r.right)&&void 0!==t?t:-1/0,e.right),r.bottom=Math.max(null!==(t=r.bottom)&&void 0!==t?t:-1/0,e.bottom))}),r.width=r.right-r.left,r.height=r.bottom-r.top,r.x=r.left,r.y=r.top,r}var K="Sortable"+(new Date).getTime();function A(){var e,o=[];return{captureAnimationState:function(){o=[],this.options.animation&&[].slice.call(this.el.children).forEach(function(t){var e,n;"none"!==R(t,"display")&&t!==jt.ghost&&(o.push({target:t,rect:X(t)}),e=I({},o[o.length-1].rect),!t.thisAnimationDuration||(n=b(t,!0))&&(e.top-=n.f,e.left-=n.e),t.fromRect=e)})},addAnimationState:function(t){o.push(t)},removeAnimationState:function(t){o.splice(function(t,e){for(var n in t)if(t.hasOwnProperty(n))for(var o in e)if(e.hasOwnProperty(o)&&e[o]===t[n][o])return Number(n);return-1}(o,{target:t}),1)},animateAll:function(t){var c=this;if(!this.options.animation)return clearTimeout(e),void("function"==typeof t&&t());var u=!1,d=0;o.forEach(function(t){var e=0,n=t.target,o=n.fromRect,i=X(n),r=n.prevFromRect,a=n.prevToRect,l=t.rect,s=b(n,!0);s&&(i.top-=s.f,i.left-=s.e),n.toRect=i,n.thisAnimationDuration&&S(r,i)&&!S(o,i)&&(l.top-i.top)/(l.left-i.left)==(o.top-i.top)/(o.left-i.left)&&(t=l,s=r,r=a,a=c.options,e=Math.sqrt(Math.pow(s.top-t.top,2)+Math.pow(s.left-t.left,2))/Math.sqrt(Math.pow(s.top-r.top,2)+Math.pow(s.left-r.left,2))*a.animation),S(i,o)||(n.prevFromRect=o,n.prevToRect=i,e=e||c.options.animation,c.animate(n,l,i,e)),e&&(u=!0,d=Math.max(d,e),clearTimeout(n.animationResetTimer),n.animationResetTimer=setTimeout(function(){n.animationTime=0,n.prevFromRect=null,n.fromRect=null,n.prevToRect=null,n.thisAnimationDuration=null},e),n.thisAnimationDuration=e)}),clearTimeout(e),u?e=setTimeout(function(){"function"==typeof t&&t()},d):"function"==typeof t&&t(),o=[]},animate:function(t,e,n,o){var i,r;o&&(R(t,"transition",""),R(t,"transform",""),i=(r=b(this.el))&&r.a,r=r&&r.d,i=(e.left-n.left)/(i||1),r=(e.top-n.top)/(r||1),t.animatingX=!!i,t.animatingY=!!r,R(t,"transform","translate3d("+i+"px,"+r+"px,0)"),this.forRepaintDummy=t.offsetWidth,R(t,"transition","transform "+o+"ms"+(this.options.easing?" "+this.options.easing:"")),R(t,"transform","translate3d(0,0,0)"),"number"==typeof t.animated&&clearTimeout(t.animated),t.animated=setTimeout(function(){R(t,"transition",""),R(t,"transform",""),t.animated=!1,t.animatingX=!1,t.animatingY=!1},o))}}}var N=[],W={initializeByDefault:!0},z={mount:function(e){for(var t in W)!W.hasOwnProperty(t)||t in e||(e[t]=W[t]);N.forEach(function(t){if(t.pluginName===e.pluginName)throw"Sortable: Cannot mount plugin ".concat(e.pluginName," more than once")}),N.push(e)},pluginEvent:function(e,n,o){var t=this;this.eventCanceled=!1,o.cancel=function(){t.eventCanceled=!0};var i=e+"Global";N.forEach(function(t){n[t.pluginName]&&(n[t.pluginName][i]&&n[t.pluginName][i](I({sortable:n},o)),n.options[t.pluginName]&&n[t.pluginName][e]&&n[t.pluginName][e](I({sortable:n},o)))})},initializePlugins:function(n,o,i,t){for(var e in N.forEach(function(t){var e=t.pluginName;(n.options[e]||t.initializeByDefault)&&((t=new t(n,o,n.options)).sortable=n,t.options=n.options,n[e]=t,a(i,t.defaults))}),n.options){var r;n.options.hasOwnProperty(e)&&(void 0!==(r=this.modifyOption(n,e,n.options[e]))&&(n.options[e]=r))}},getEventProperties:function(e,n){var o={};return N.forEach(function(t){"function"==typeof t.eventProperties&&a(o,t.eventProperties.call(n[t.pluginName],e))}),o},modifyOption:function(e,n,o){var i;return N.forEach(function(t){e[t.pluginName]&&t.optionListeners&&"function"==typeof t.optionListeners[n]&&(i=t.optionListeners[n].call(e[t.pluginName],o))}),i}};function G(t){var e=t.sortable,n=t.rootEl,o=t.name,i=t.targetEl,r=t.cloneEl,a=t.toEl,l=t.fromEl,s=t.oldIndex,c=t.newIndex,u=t.oldDraggableIndex,d=t.newDraggableIndex,h=t.originalEvent,p=t.putSortable,f=t.extraEventProperties;if(e=e||n&&n[K]){var g,m=e.options,t="on"+o.charAt(0).toUpperCase()+o.substr(1);!window.CustomEvent||y||w?(g=document.createEvent("Event")).initEvent(o,!0,!0):g=new CustomEvent(o,{bubbles:!0,cancelable:!0}),g.to=a||n,g.from=l||n,g.item=i||n,g.clone=r,g.oldIndex=s,g.newIndex=c,g.oldDraggableIndex=u,g.newDraggableIndex=d,g.originalEvent=h,g.pullMode=p?p.lastPutMode:void 0;var v,b=I(I({},f),z.getEventProperties(o,e));for(v in b)g[v]=b[v];n&&n.dispatchEvent(g),m[t]&&m[t].call(e,g)}}function U(t,e){var n=(o=2<arguments.length&&void 0!==arguments[2]?arguments[2]:{}).evt,o=i(o,q);z.pluginEvent.bind(jt)(t,e,I({dragEl:Z,parentEl:$,ghostEl:Q,rootEl:J,nextEl:tt,lastDownEl:et,cloneEl:nt,cloneHidden:ot,dragStarted:mt,putSortable:ct,activeSortable:jt.active,originalEvent:n,oldIndex:it,oldDraggableIndex:at,newIndex:rt,newDraggableIndex:lt,hideGhostForTarget:Xt,unhideGhostForTarget:Yt,cloneNowHidden:function(){ot=!0},cloneNowShown:function(){ot=!1},dispatchSortableEvent:function(t){V({sortable:e,name:t,originalEvent:n})}},o))}var q=["evt"];function V(t){G(I({putSortable:ct,cloneEl:nt,targetEl:Z,rootEl:J,oldIndex:it,oldDraggableIndex:at,newIndex:rt,newDraggableIndex:lt},t))}var Z,$,Q,J,tt,et,nt,ot,it,rt,at,lt,st,ct,ut,dt,ht,pt,ft,gt,mt,vt,bt,yt,wt,Dt=!1,Et=!1,St=[],_t=!1,Ct=!1,Tt=[],xt=!1,Ot=[],Mt="undefined"!=typeof document,At=c,Nt=w||y?"cssFloat":"float",It=Mt&&!n&&!c&&"draggable"in document.createElement("div"),Pt=function(){if(Mt){if(y)return!1;var t=document.createElement("x");return t.style.cssText="pointer-events:auto","auto"===t.style.pointerEvents}}(),kt=function(t,e){var n=R(t),o=parseInt(n.width)-parseInt(n.paddingLeft)-parseInt(n.paddingRight)-parseInt(n.borderLeftWidth)-parseInt(n.borderRightWidth),i=B(t,0,e),r=B(t,1,e),a=i&&R(i),l=r&&R(r),s=a&&parseInt(a.marginLeft)+parseInt(a.marginRight)+X(i).width,t=l&&parseInt(l.marginLeft)+parseInt(l.marginRight)+X(r).width;if("flex"===n.display)return"column"===n.flexDirection||"column-reverse"===n.flexDirection?"vertical":"horizontal";if("grid"===n.display)return n.gridTemplateColumns.split(" ").length<=1?"vertical":"horizontal";if(i&&a.float&&"none"!==a.float){e="left"===a.float?"left":"right";return!r||"both"!==l.clear&&l.clear!==e?"horizontal":"vertical"}return i&&("block"===a.display||"flex"===a.display||"table"===a.display||"grid"===a.display||o<=s&&"none"===n[Nt]||r&&"none"===n[Nt]&&o<s+t)?"vertical":"horizontal"},Rt=function(t){function l(r,a){return function(t,e,n,o){var i=t.options.group.name&&e.options.group.name&&t.options.group.name===e.options.group.name;if(null==r&&(a||i))return!0;if(null==r||!1===r)return!1;if(a&&"clone"===r)return r;if("function"==typeof r)return l(r(t,e,n,o),a)(t,e,n,o);e=(a?t:e).options.group.name;return!0===r||"string"==typeof r&&r===e||r.join&&-1<r.indexOf(e)}}var e={},n=t.group;n&&"object"==o(n)||(n={name:n}),e.name=n.name,e.checkPull=l(n.pull,!0),e.checkPut=l(n.put),e.revertClone=n.revertClone,t.group=e},Xt=function(){!Pt&&Q&&R(Q,"display","none")},Yt=function(){!Pt&&Q&&R(Q,"display","")};Mt&&!n&&document.addEventListener("click",function(t){if(Et)return t.preventDefault(),t.stopPropagation&&t.stopPropagation(),t.stopImmediatePropagation&&t.stopImmediatePropagation(),Et=!1},!0);function Bt(t){if(Z){t=t.touches?t.touches[0]:t;var e=(i=t.clientX,r=t.clientY,St.some(function(t){var e=t[K].options.emptyInsertThreshold;if(e&&!F(t)){var n=X(t),o=i>=n.left-e&&i<=n.right+e,e=r>=n.top-e&&r<=n.bottom+e;return o&&e?a=t:void 0}}),a);if(e){var n,o={};for(n in t)t.hasOwnProperty(n)&&(o[n]=t[n]);o.target=o.rootEl=e,o.preventDefault=void 0,o.stopPropagation=void 0,e[K]._onDragOver(o)}}var i,r,a}function Ft(t){Z&&Z.parentNode[K]._isOutsideThisEl(t.target)}function jt(t,e){if(!t||!t.nodeType||1!==t.nodeType)throw"Sortable: `el` must be an HTMLElement, not ".concat({}.toString.call(t));this.el=t,this.options=e=a({},e),t[K]=this;var n,o,i={group:null,sort:!0,disabled:!1,store:null,handle:null,draggable:/^[uo]l$/i.test(t.nodeName)?">li":">*",swapThreshold:1,invertSwap:!1,invertedSwapThreshold:null,removeCloneOnHide:!0,direction:function(){return kt(t,this.options)},ghostClass:"sortable-ghost",chosenClass:"sortable-chosen",dragClass:"sortable-drag",ignore:"a, img",filter:null,preventOnFilter:!0,animation:0,easing:null,setData:function(t,e){t.setData("Text",e.textContent)},dropBubble:!1,dragoverBubble:!1,dataIdAttr:"data-id",delay:0,delayOnTouchOnly:!1,touchStartThreshold:(Number.parseInt?Number:window).parseInt(window.devicePixelRatio,10)||1,forceFallback:!1,fallbackClass:"sortable-fallback",fallbackOnBody:!1,fallbackTolerance:0,fallbackOffset:{x:0,y:0},supportPointer:!1!==jt.supportPointer&&"PointerEvent"in window&&(!u||c),emptyInsertThreshold:5};for(n in z.initializePlugins(this,t,i),i)n in e||(e[n]=i[n]);for(o in Rt(e),this)"_"===o.charAt(0)&&"function"==typeof this[o]&&(this[o]=this[o].bind(this));this.nativeDraggable=!e.forceFallback&&It,this.nativeDraggable&&(this.options.touchStartThreshold=1),e.supportPointer?h(t,"pointerdown",this._onTapStart):(h(t,"mousedown",this._onTapStart),h(t,"touchstart",this._onTapStart)),this.nativeDraggable&&(h(t,"dragover",this),h(t,"dragenter",this)),St.push(this.el),e.store&&e.store.get&&this.sort(e.store.get(this)||[]),a(this,A())}function Ht(t,e,n,o,i,r,a,l){var s,c,u=t[K],d=u.options.onMove;return!window.CustomEvent||y||w?(s=document.createEvent("Event")).initEvent("move",!0,!0):s=new CustomEvent("move",{bubbles:!0,cancelable:!0}),s.to=e,s.from=t,s.dragged=n,s.draggedRect=o,s.related=i||e,s.relatedRect=r||X(e),s.willInsertAfter=l,s.originalEvent=a,t.dispatchEvent(s),c=d?d.call(u,s,a):c}function Lt(t){t.draggable=!1}function Kt(){xt=!1}function Wt(t){return setTimeout(t,0)}function zt(t){return clearTimeout(t)}jt.prototype={constructor:jt,_isOutsideThisEl:function(t){this.el.contains(t)||t===this.el||(vt=null)},_getDirection:function(t,e){return"function"==typeof this.options.direction?this.options.direction.call(this,t,e,Z):this.options.direction},_onTapStart:function(e){if(e.cancelable){var n=this,o=this.el,t=this.options,i=t.preventOnFilter,r=e.type,a=e.touches&&e.touches[0]||e.pointerType&&"touch"===e.pointerType&&e,l=(a||e).target,s=e.target.shadowRoot&&(e.path&&e.path[0]||e.composedPath&&e.composedPath()[0])||l,c=t.filter;if(!function(t){Ot.length=0;var e=t.getElementsByTagName("input"),n=e.length;for(;n--;){var o=e[n];o.checked&&Ot.push(o)}}(o),!Z&&!(/mousedown|pointerdown/.test(r)&&0!==e.button||t.disabled)&&!s.isContentEditable&&(this.nativeDraggable||!u||!l||"SELECT"!==l.tagName.toUpperCase())&&!((l=P(l,t.draggable,o,!1))&&l.animated||et===l)){if(it=j(l),at=j(l,t.draggable),"function"==typeof c){if(c.call(this,e,l,this))return V({sortable:n,rootEl:s,name:"filter",targetEl:l,toEl:o,fromEl:o}),U("filter",n,{evt:e}),void(i&&e.preventDefault())}else if(c=c&&c.split(",").some(function(t){if(t=P(s,t.trim(),o,!1))return V({sortable:n,rootEl:t,name:"filter",targetEl:l,fromEl:o,toEl:o}),U("filter",n,{evt:e}),!0}))return void(i&&e.preventDefault());t.handle&&!P(s,t.handle,o,!1)||this._prepareDragStart(e,a,l)}}},_prepareDragStart:function(t,e,n){var o,i=this,r=i.el,a=i.options,l=r.ownerDocument;n&&!Z&&n.parentNode===r&&(o=X(n),J=r,$=(Z=n).parentNode,tt=Z.nextSibling,et=n,st=a.group,ut={target:jt.dragged=Z,clientX:(e||t).clientX,clientY:(e||t).clientY},ft=ut.clientX-o.left,gt=ut.clientY-o.top,this._lastX=(e||t).clientX,this._lastY=(e||t).clientY,Z.style["will-change"]="all",o=function(){U("delayEnded",i,{evt:t}),jt.eventCanceled?i._onDrop():(i._disableDelayedDragEvents(),!s&&i.nativeDraggable&&(Z.draggable=!0),i._triggerDragStart(t,e),V({sortable:i,name:"choose",originalEvent:t}),k(Z,a.chosenClass,!0))},a.ignore.split(",").forEach(function(t){D(Z,t.trim(),Lt)}),h(l,"dragover",Bt),h(l,"mousemove",Bt),h(l,"touchmove",Bt),a.supportPointer?(h(l,"pointerup",i._onDrop),this.nativeDraggable||h(l,"pointercancel",i._onDrop)):(h(l,"mouseup",i._onDrop),h(l,"touchend",i._onDrop),h(l,"touchcancel",i._onDrop)),s&&this.nativeDraggable&&(this.options.touchStartThreshold=4,Z.draggable=!0),U("delayStart",this,{evt:t}),!a.delay||a.delayOnTouchOnly&&!e||this.nativeDraggable&&(w||y)?o():jt.eventCanceled?this._onDrop():(a.supportPointer?(h(l,"pointerup",i._disableDelayedDrag),h(l,"pointercancel",i._disableDelayedDrag)):(h(l,"mouseup",i._disableDelayedDrag),h(l,"touchend",i._disableDelayedDrag),h(l,"touchcancel",i._disableDelayedDrag)),h(l,"mousemove",i._delayedDragTouchMoveHandler),h(l,"touchmove",i._delayedDragTouchMoveHandler),a.supportPointer&&h(l,"pointermove",i._delayedDragTouchMoveHandler),i._dragStartTimer=setTimeout(o,a.delay)))},_delayedDragTouchMoveHandler:function(t){t=t.touches?t.touches[0]:t;Math.max(Math.abs(t.clientX-this._lastX),Math.abs(t.clientY-this._lastY))>=Math.floor(this.options.touchStartThreshold/(this.nativeDraggable&&window.devicePixelRatio||1))&&this._disableDelayedDrag()},_disableDelayedDrag:function(){Z&&Lt(Z),clearTimeout(this._dragStartTimer),this._disableDelayedDragEvents()},_disableDelayedDragEvents:function(){var t=this.el.ownerDocument;p(t,"mouseup",this._disableDelayedDrag),p(t,"touchend",this._disableDelayedDrag),p(t,"touchcancel",this._disableDelayedDrag),p(t,"pointerup",this._disableDelayedDrag),p(t,"pointercancel",this._disableDelayedDrag),p(t,"mousemove",this._delayedDragTouchMoveHandler),p(t,"touchmove",this._delayedDragTouchMoveHandler),p(t,"pointermove",this._delayedDragTouchMoveHandler)},_triggerDragStart:function(t,e){e=e||"touch"==t.pointerType&&t,!this.nativeDraggable||e?this.options.supportPointer?h(document,"pointermove",this._onTouchMove):h(document,e?"touchmove":"mousemove",this._onTouchMove):(h(Z,"dragend",this),h(J,"dragstart",this._onDragStart));try{document.selection?Wt(function(){document.selection.empty()}):window.getSelection().removeAllRanges()}catch(t){}},_dragStarted:function(t,e){var n;Dt=!1,J&&Z?(U("dragStarted",this,{evt:e}),this.nativeDraggable&&h(document,"dragover",Ft),n=this.options,t||k(Z,n.dragClass,!1),k(Z,n.ghostClass,!0),jt.active=this,t&&this._appendGhost(),V({sortable:this,name:"start",originalEvent:e})):this._nulling()},_emulateDragOver:function(){if(dt){this._lastX=dt.clientX,this._lastY=dt.clientY,Xt();for(var t=document.elementFromPoint(dt.clientX,dt.clientY),e=t;t&&t.shadowRoot&&(t=t.shadowRoot.elementFromPoint(dt.clientX,dt.clientY))!==e;)e=t;if(Z.parentNode[K]._isOutsideThisEl(t),e)do{if(e[K])if(e[K]._onDragOver({clientX:dt.clientX,clientY:dt.clientY,target:t,rootEl:e})&&!this.options.dragoverBubble)break}while(e=g(t=e));Yt()}},_onTouchMove:function(t){if(ut){var e=this.options,n=e.fallbackTolerance,o=e.fallbackOffset,i=t.touches?t.touches[0]:t,r=Q&&b(Q,!0),a=Q&&r&&r.a,l=Q&&r&&r.d,e=At&&wt&&E(wt),a=(i.clientX-ut.clientX+o.x)/(a||1)+(e?e[0]-Tt[0]:0)/(a||1),l=(i.clientY-ut.clientY+o.y)/(l||1)+(e?e[1]-Tt[1]:0)/(l||1);if(!jt.active&&!Dt){if(n&&Math.max(Math.abs(i.clientX-this._lastX),Math.abs(i.clientY-this._lastY))<n)return;this._onDragStart(t,!0)}Q&&(r?(r.e+=a-(ht||0),r.f+=l-(pt||0)):r={a:1,b:0,c:0,d:1,e:a,f:l},r="matrix(".concat(r.a,",").concat(r.b,",").concat(r.c,",").concat(r.d,",").concat(r.e,",").concat(r.f,")"),R(Q,"webkitTransform",r),R(Q,"mozTransform",r),R(Q,"msTransform",r),R(Q,"transform",r),ht=a,pt=l,dt=i),t.cancelable&&t.preventDefault()}},_appendGhost:function(){if(!Q){var t=this.options.fallbackOnBody?document.body:J,e=X(Z,!0,At,!0,t),n=this.options;if(At){for(wt=t;"static"===R(wt,"position")&&"none"===R(wt,"transform")&&wt!==document;)wt=wt.parentNode;wt!==document.body&&wt!==document.documentElement?(wt===document&&(wt=O()),e.top+=wt.scrollTop,e.left+=wt.scrollLeft):wt=O(),Tt=E(wt)}k(Q=Z.cloneNode(!0),n.ghostClass,!1),k(Q,n.fallbackClass,!0),k(Q,n.dragClass,!0),R(Q,"transition",""),R(Q,"transform",""),R(Q,"box-sizing","border-box"),R(Q,"margin",0),R(Q,"top",e.top),R(Q,"left",e.left),R(Q,"width",e.width),R(Q,"height",e.height),R(Q,"opacity","0.8"),R(Q,"position",At?"absolute":"fixed"),R(Q,"zIndex","100000"),R(Q,"pointerEvents","none"),jt.ghost=Q,t.appendChild(Q),R(Q,"transform-origin",ft/parseInt(Q.style.width)*100+"% "+gt/parseInt(Q.style.height)*100+"%")}},_onDragStart:function(t,e){var n=this,o=t.dataTransfer,i=n.options;U("dragStart",this,{evt:t}),jt.eventCanceled?this._onDrop():(U("setupClone",this),jt.eventCanceled||((nt=C(Z)).removeAttribute("id"),nt.draggable=!1,nt.style["will-change"]="",this._hideClone(),k(nt,this.options.chosenClass,!1),jt.clone=nt),n.cloneId=Wt(function(){U("clone",n),jt.eventCanceled||(n.options.removeCloneOnHide||J.insertBefore(nt,Z),n._hideClone(),V({sortable:n,name:"clone"}))}),e||k(Z,i.dragClass,!0),e?(Et=!0,n._loopId=setInterval(n._emulateDragOver,50)):(p(document,"mouseup",n._onDrop),p(document,"touchend",n._onDrop),p(document,"touchcancel",n._onDrop),o&&(o.effectAllowed="move",i.setData&&i.setData.call(n,o,Z)),h(document,"drop",n),R(Z,"transform","translateZ(0)")),Dt=!0,n._dragStartId=Wt(n._dragStarted.bind(n,e,t)),h(document,"selectstart",n),mt=!0,window.getSelection().removeAllRanges(),u&&R(document.body,"user-select","none"))},_onDragOver:function(n){var o,i,r,t,e,a=this.el,l=n.target,s=this.options,c=s.group,u=jt.active,d=st===c,h=s.sort,p=ct||u,f=this,g=!1;if(!xt){if(void 0!==n.preventDefault&&n.cancelable&&n.preventDefault(),l=P(l,s.draggable,a,!0),O("dragOver"),jt.eventCanceled)return g;if(Z.contains(n.target)||l.animated&&l.animatingX&&l.animatingY||f._ignoreWhileAnimating===l)return A(!1);if(Et=!1,u&&!s.disabled&&(d?h||(i=$!==J):ct===this||(this.lastPutMode=st.checkPull(this,u,Z,n))&&c.checkPut(this,u,Z,n))){if(r="vertical"===this._getDirection(n,l),o=X(Z),O("dragOverValid"),jt.eventCanceled)return g;if(i)return $=J,M(),this._hideClone(),O("revert"),jt.eventCanceled||(tt?J.insertBefore(Z,tt):J.appendChild(Z)),A(!0);var m=F(a,s.draggable);if(m&&(S=n,c=r,x=X(F((E=this).el,E.options.draggable)),E=L(E.el,E.options,Q),!(c?S.clientX>E.right+10||S.clientY>x.bottom&&S.clientX>x.left:S.clientY>E.bottom+10||S.clientX>x.right&&S.clientY>x.top)||m.animated)){if(m&&(t=n,e=r,C=X(B((_=this).el,0,_.options,!0)),_=L(_.el,_.options,Q),e?t.clientX<_.left-10||t.clientY<C.top&&t.clientX<C.right:t.clientY<_.top-10||t.clientY<C.bottom&&t.clientX<C.left)){var v=B(a,0,s,!0);if(v===Z)return A(!1);if(D=X(l=v),!1!==Ht(J,a,Z,o,l,D,n,!1))return M(),a.insertBefore(Z,v),$=a,N(),A(!0)}else if(l.parentNode===a){var b,y,w,D=X(l),E=Z.parentNode!==a,S=(S=Z.animated&&Z.toRect||o,x=l.animated&&l.toRect||D,_=(e=r)?S.left:S.top,t=e?S.right:S.bottom,C=e?S.width:S.height,v=e?x.left:x.top,S=e?x.right:x.bottom,x=e?x.width:x.height,!(_===v||t===S||_+C/2===v+x/2)),_=r?"top":"left",C=Y(l,"top","top")||Y(Z,"top","top"),v=C?C.scrollTop:void 0;if(vt!==l&&(y=D[_],_t=!1,Ct=!S&&s.invertSwap||E),0!==(b=function(t,e,n,o,i,r,a,l){var s=o?t.clientY:t.clientX,c=o?n.height:n.width,t=o?n.top:n.left,o=o?n.bottom:n.right,n=!1;if(!a)if(l&&yt<c*i){if(_t=!_t&&(1===bt?t+c*r/2<s:s<o-c*r/2)?!0:_t)n=!0;else if(1===bt?s<t+yt:o-yt<s)return-bt}else if(t+c*(1-i)/2<s&&s<o-c*(1-i)/2)return function(t){return j(Z)<j(t)?1:-1}(e);if((n=n||a)&&(s<t+c*r/2||o-c*r/2<s))return t+c/2<s?1:-1;return 0}(n,l,D,r,S?1:s.swapThreshold,null==s.invertedSwapThreshold?s.swapThreshold:s.invertedSwapThreshold,Ct,vt===l)))for(var T=j(Z);(w=$.children[T-=b])&&("none"===R(w,"display")||w===Q););if(0===b||w===l)return A(!1);bt=b;var x=(vt=l).nextElementSibling,E=!1,S=Ht(J,a,Z,o,l,D,n,E=1===b);if(!1!==S)return 1!==S&&-1!==S||(E=1===S),xt=!0,setTimeout(Kt,30),M(),E&&!x?a.appendChild(Z):l.parentNode.insertBefore(Z,E?x:l),C&&H(C,0,v-C.scrollTop),$=Z.parentNode,void 0===y||Ct||(yt=Math.abs(y-X(l)[_])),N(),A(!0)}}else{if(m===Z)return A(!1);if((l=m&&a===n.target?m:l)&&(D=X(l)),!1!==Ht(J,a,Z,o,l,D,n,!!l))return M(),m&&m.nextSibling?a.insertBefore(Z,m.nextSibling):a.appendChild(Z),$=a,N(),A(!0)}if(a.contains(Z))return A(!1)}return!1}function O(t,e){U(t,f,I({evt:n,isOwner:d,axis:r?"vertical":"horizontal",revert:i,dragRect:o,targetRect:D,canSort:h,fromSortable:p,target:l,completed:A,onMove:function(t,e){return Ht(J,a,Z,o,t,X(t),n,e)},changed:N},e))}function M(){O("dragOverAnimationCapture"),f.captureAnimationState(),f!==p&&p.captureAnimationState()}function A(t){return O("dragOverCompleted",{insertion:t}),t&&(d?u._hideClone():u._showClone(f),f!==p&&(k(Z,(ct||u).options.ghostClass,!1),k(Z,s.ghostClass,!0)),ct!==f&&f!==jt.active?ct=f:f===jt.active&&ct&&(ct=null),p===f&&(f._ignoreWhileAnimating=l),f.animateAll(function(){O("dragOverAnimationComplete"),f._ignoreWhileAnimating=null}),f!==p&&(p.animateAll(),p._ignoreWhileAnimating=null)),(l===Z&&!Z.animated||l===a&&!l.animated)&&(vt=null),s.dragoverBubble||n.rootEl||l===document||(Z.parentNode[K]._isOutsideThisEl(n.target),t||Bt(n)),!s.dragoverBubble&&n.stopPropagation&&n.stopPropagation(),g=!0}function N(){rt=j(Z),lt=j(Z,s.draggable),V({sortable:f,name:"change",toEl:a,newIndex:rt,newDraggableIndex:lt,originalEvent:n})}},_ignoreWhileAnimating:null,_offMoveEvents:function(){p(document,"mousemove",this._onTouchMove),p(document,"touchmove",this._onTouchMove),p(document,"pointermove",this._onTouchMove),p(document,"dragover",Bt),p(document,"mousemove",Bt),p(document,"touchmove",Bt)},_offUpEvents:function(){var t=this.el.ownerDocument;p(t,"mouseup",this._onDrop),p(t,"touchend",this._onDrop),p(t,"pointerup",this._onDrop),p(t,"pointercancel",this._onDrop),p(t,"touchcancel",this._onDrop),p(document,"selectstart",this)},_onDrop:function(t){var e=this.el,n=this.options;rt=j(Z),lt=j(Z,n.draggable),U("drop",this,{evt:t}),$=Z&&Z.parentNode,rt=j(Z),lt=j(Z,n.draggable),jt.eventCanceled||(_t=Ct=Dt=!1,clearInterval(this._loopId),clearTimeout(this._dragStartTimer),zt(this.cloneId),zt(this._dragStartId),this.nativeDraggable&&(p(document,"drop",this),p(e,"dragstart",this._onDragStart)),this._offMoveEvents(),this._offUpEvents(),u&&R(document.body,"user-select",""),R(Z,"transform",""),t&&(mt&&(t.cancelable&&t.preventDefault(),n.dropBubble||t.stopPropagation()),Q&&Q.parentNode&&Q.parentNode.removeChild(Q),(J===$||ct&&"clone"!==ct.lastPutMode)&&nt&&nt.parentNode&&nt.parentNode.removeChild(nt),Z&&(this.nativeDraggable&&p(Z,"dragend",this),Lt(Z),Z.style["will-change"]="",mt&&!Dt&&k(Z,(ct||this).options.ghostClass,!1),k(Z,this.options.chosenClass,!1),V({sortable:this,name:"unchoose",toEl:$,newIndex:null,newDraggableIndex:null,originalEvent:t}),J!==$?(0<=rt&&(V({rootEl:$,name:"add",toEl:$,fromEl:J,originalEvent:t}),V({sortable:this,name:"remove",toEl:$,originalEvent:t}),V({rootEl:$,name:"sort",toEl:$,fromEl:J,originalEvent:t}),V({sortable:this,name:"sort",toEl:$,originalEvent:t})),ct&&ct.save()):rt!==it&&0<=rt&&(V({sortable:this,name:"update",toEl:$,originalEvent:t}),V({sortable:this,name:"sort",toEl:$,originalEvent:t})),jt.active&&(null!=rt&&-1!==rt||(rt=it,lt=at),V({sortable:this,name:"end",toEl:$,originalEvent:t}),this.save())))),this._nulling()},_nulling:function(){U("nulling",this),J=Z=$=Q=tt=nt=et=ot=ut=dt=mt=rt=lt=it=at=vt=bt=ct=st=jt.dragged=jt.ghost=jt.clone=jt.active=null,Ot.forEach(function(t){t.checked=!0}),Ot.length=ht=pt=0},handleEvent:function(t){switch(t.type){case"drop":case"dragend":this._onDrop(t);break;case"dragenter":case"dragover":Z&&(this._onDragOver(t),function(t){t.dataTransfer&&(t.dataTransfer.dropEffect="move");t.cancelable&&t.preventDefault()}(t));break;case"selectstart":t.preventDefault()}},toArray:function(){for(var t,e=[],n=this.el.children,o=0,i=n.length,r=this.options;o<i;o++)P(t=n[o],r.draggable,this.el,!1)&&e.push(t.getAttribute(r.dataIdAttr)||function(t){var e=t.tagName+t.className+t.src+t.href+t.textContent,n=e.length,o=0;for(;n--;)o+=e.charCodeAt(n);return o.toString(36)}(t));return e},sort:function(t,e){var n={},o=this.el;this.toArray().forEach(function(t,e){e=o.children[e];P(e,this.options.draggable,o,!1)&&(n[t]=e)},this),e&&this.captureAnimationState(),t.forEach(function(t){n[t]&&(o.removeChild(n[t]),o.appendChild(n[t]))}),e&&this.animateAll()},save:function(){var t=this.options.store;t&&t.set&&t.set(this)},closest:function(t,e){return P(t,e||this.options.draggable,this.el,!1)},option:function(t,e){var n=this.options;if(void 0===e)return n[t];var o=z.modifyOption(this,t,e);n[t]=void 0!==o?o:e,"group"===t&&Rt(n)},destroy:function(){U("destroy",this);var t=this.el;t[K]=null,p(t,"mousedown",this._onTapStart),p(t,"touchstart",this._onTapStart),p(t,"pointerdown",this._onTapStart),this.nativeDraggable&&(p(t,"dragover",this),p(t,"dragenter",this)),Array.prototype.forEach.call(t.querySelectorAll("[draggable]"),function(t){t.removeAttribute("draggable")}),this._onDrop(),this._disableDelayedDragEvents(),St.splice(St.indexOf(this.el),1),this.el=t=null},_hideClone:function(){ot||(U("hideClone",this),jt.eventCanceled||(R(nt,"display","none"),this.options.removeCloneOnHide&&nt.parentNode&&nt.parentNode.removeChild(nt),ot=!0))},_showClone:function(t){"clone"===t.lastPutMode?ot&&(U("showClone",this),jt.eventCanceled||(Z.parentNode!=J||this.options.group.revertClone?tt?J.insertBefore(nt,tt):J.appendChild(nt):J.insertBefore(nt,Z),this.options.group.revertClone&&this.animate(Z,nt),R(nt,"display",""),ot=!1)):this._hideClone()}},Mt&&h(document,"touchmove",function(t){(jt.active||Dt)&&t.cancelable&&t.preventDefault()}),jt.utils={on:h,off:p,css:R,find:D,is:function(t,e){return!!P(t,e,t,!1)},extend:function(t,e){if(t&&e)for(var n in e)e.hasOwnProperty(n)&&(t[n]=e[n]);return t},throttle:_,closest:P,toggleClass:k,clone:C,index:j,nextTick:Wt,cancelNextTick:zt,detectDirection:kt,getChild:B,expando:K},jt.get=function(t){return t[K]},jt.mount=function(){for(var t=arguments.length,e=new Array(t),n=0;n<t;n++)e[n]=arguments[n];(e=e[0].constructor===Array?e[0]:e).forEach(function(t){if(!t.prototype||!t.prototype.constructor)throw"Sortable: Mounted plugin must be a constructor function, not ".concat({}.toString.call(t));t.utils&&(jt.utils=I(I({},jt.utils),t.utils)),z.mount(t)})},jt.create=function(t,e){return new jt(t,e)};var Gt,Ut,qt,Vt,Zt,$t,Qt=[],Jt=!(jt.version="1.15.6");function te(){Qt.forEach(function(t){clearInterval(t.pid)}),Qt=[]}function ee(){clearInterval($t)}var ne,oe=_(function(n,t,e,o){if(t.scroll){var i,r=(n.touches?n.touches[0]:n).clientX,a=(n.touches?n.touches[0]:n).clientY,l=t.scrollSensitivity,s=t.scrollSpeed,c=O(),u=!1;Ut!==e&&(Ut=e,te(),Gt=t.scroll,i=t.scrollFn,!0===Gt&&(Gt=M(e,!0)));var d=0,h=Gt;do{var p=h,f=X(p),g=f.top,m=f.bottom,v=f.left,b=f.right,y=f.width,w=f.height,D=void 0,E=void 0,S=p.scrollWidth,_=p.scrollHeight,C=R(p),T=p.scrollLeft,f=p.scrollTop,E=p===c?(D=y<S&&("auto"===C.overflowX||"scroll"===C.overflowX||"visible"===C.overflowX),w<_&&("auto"===C.overflowY||"scroll"===C.overflowY||"visible"===C.overflowY)):(D=y<S&&("auto"===C.overflowX||"scroll"===C.overflowX),w<_&&("auto"===C.overflowY||"scroll"===C.overflowY)),T=D&&(Math.abs(b-r)<=l&&T+y<S)-(Math.abs(v-r)<=l&&!!T),f=E&&(Math.abs(m-a)<=l&&f+w<_)-(Math.abs(g-a)<=l&&!!f);if(!Qt[d])for(var x=0;x<=d;x++)Qt[x]||(Qt[x]={});Qt[d].vx==T&&Qt[d].vy==f&&Qt[d].el===p||(Qt[d].el=p,Qt[d].vx=T,Qt[d].vy=f,clearInterval(Qt[d].pid),0==T&&0==f||(u=!0,Qt[d].pid=setInterval(function(){o&&0===this.layer&&jt.active._onTouchMove(Zt);var t=Qt[this.layer].vy?Qt[this.layer].vy*s:0,e=Qt[this.layer].vx?Qt[this.layer].vx*s:0;"function"==typeof i&&"continue"!==i.call(jt.dragged.parentNode[K],e,t,n,Zt,Qt[this.layer].el)||H(Qt[this.layer].el,e,t)}.bind({layer:d}),24))),d++}while(t.bubbleScroll&&h!==c&&(h=M(h,!1)));Jt=u}},30),n=function(t){var e=t.originalEvent,n=t.putSortable,o=t.dragEl,i=t.activeSortable,r=t.dispatchSortableEvent,a=t.hideGhostForTarget,t=t.unhideGhostForTarget;e&&(i=n||i,a(),e=e.changedTouches&&e.changedTouches.length?e.changedTouches[0]:e,e=document.elementFromPoint(e.clientX,e.clientY),t(),i&&!i.el.contains(e)&&(r("spill"),this.onSpill({dragEl:o,putSortable:n})))};function ie(){}function re(){}ie.prototype={startIndex:null,dragStart:function(t){t=t.oldDraggableIndex;this.startIndex=t},onSpill:function(t){var e=t.dragEl,n=t.putSortable;this.sortable.captureAnimationState(),n&&n.captureAnimationState();t=B(this.sortable.el,this.startIndex,this.options);t?this.sortable.el.insertBefore(e,t):this.sortable.el.appendChild(e),this.sortable.animateAll(),n&&n.animateAll()},drop:n},a(ie,{pluginName:"revertOnSpill"}),re.prototype={onSpill:function(t){var e=t.dragEl,t=t.putSortable||this.sortable;t.captureAnimationState(),e.parentNode&&e.parentNode.removeChild(e),t.animateAll()},drop:n},a(re,{pluginName:"removeOnSpill"});var ae,le,se,ce,ue,de=[],he=[],pe=!1,fe=!1,ge=!1;function me(n,o){he.forEach(function(t,e){e=o.children[t.sortableIndex+(n?Number(e):0)];e?o.insertBefore(t,e):o.appendChild(t)})}function ve(){de.forEach(function(t){t!==se&&t.parentNode&&t.parentNode.removeChild(t)})}return jt.mount(new function(){function t(){for(var t in this.defaults={scroll:!0,forceAutoScrollFallback:!1,scrollSensitivity:30,scrollSpeed:10,bubbleScroll:!0},this)"_"===t.charAt(0)&&"function"==typeof this[t]&&(this[t]=this[t].bind(this))}return t.prototype={dragStarted:function(t){t=t.originalEvent;this.sortable.nativeDraggable?h(document,"dragover",this._handleAutoScroll):this.options.supportPointer?h(document,"pointermove",this._handleFallbackAutoScroll):t.touches?h(document,"touchmove",this._handleFallbackAutoScroll):h(document,"mousemove",this._handleFallbackAutoScroll)},dragOverCompleted:function(t){t=t.originalEvent;this.options.dragOverBubble||t.rootEl||this._handleAutoScroll(t)},drop:function(){this.sortable.nativeDraggable?p(document,"dragover",this._handleAutoScroll):(p(document,"pointermove",this._handleFallbackAutoScroll),p(document,"touchmove",this._handleFallbackAutoScroll),p(document,"mousemove",this._handleFallbackAutoScroll)),ee(),te(),clearTimeout(m),m=void 0},nulling:function(){Zt=Ut=Gt=Jt=$t=qt=Vt=null,Qt.length=0},_handleFallbackAutoScroll:function(t){this._handleAutoScroll(t,!0)},_handleAutoScroll:function(e,n){var o,i=this,r=(e.touches?e.touches[0]:e).clientX,a=(e.touches?e.touches[0]:e).clientY,t=document.elementFromPoint(r,a);Zt=e,n||this.options.forceAutoScrollFallback||w||y||u?(oe(e,this.options,t,n),o=M(t,!0),!Jt||$t&&r===qt&&a===Vt||($t&&ee(),$t=setInterval(function(){var t=M(document.elementFromPoint(r,a),!0);t!==o&&(o=t,te()),oe(e,i.options,t,n)},10),qt=r,Vt=a)):this.options.bubbleScroll&&M(t,!0)!==O()?oe(e,this.options,M(t,!1),!1):te()}},a(t,{pluginName:"scroll",initializeByDefault:!0})}),jt.mount(re,ie),jt.mount(new function(){function t(){this.defaults={swapClass:"sortable-swap-highlight"}}return t.prototype={dragStart:function(t){t=t.dragEl;ne=t},dragOverValid:function(t){var e=t.completed,n=t.target,o=t.onMove,i=t.activeSortable,r=t.changed,a=t.cancel;i.options.swap&&(t=this.sortable.el,i=this.options,n&&n!==t&&(t=ne,ne=!1!==o(n)?(k(n,i.swapClass,!0),n):null,t&&t!==ne&&k(t,i.swapClass,!1)),r(),e(!0),a())},drop:function(t){var e,n,o=t.activeSortable,i=t.putSortable,r=t.dragEl,a=i||this.sortable,l=this.options;ne&&k(ne,l.swapClass,!1),ne&&(l.swap||i&&i.options.swap)&&r!==ne&&(a.captureAnimationState(),a!==o&&o.captureAnimationState(),n=ne,t=(e=r).parentNode,l=n.parentNode,t&&l&&!t.isEqualNode(n)&&!l.isEqualNode(e)&&(i=j(e),r=j(n),t.isEqualNode(l)&&i<r&&r++,t.insertBefore(n,t.children[i]),l.insertBefore(e,l.children[r])),a.animateAll(),a!==o&&o.animateAll())},nulling:function(){ne=null}},a(t,{pluginName:"swap",eventProperties:function(){return{swapItem:ne}}})}),jt.mount(new function(){function t(o){for(var t in this)"_"===t.charAt(0)&&"function"==typeof this[t]&&(this[t]=this[t].bind(this));o.options.avoidImplicitDeselect||(o.options.supportPointer?h(document,"pointerup",this._deselectMultiDrag):(h(document,"mouseup",this._deselectMultiDrag),h(document,"touchend",this._deselectMultiDrag))),h(document,"keydown",this._checkKeyDown),h(document,"keyup",this._checkKeyUp),this.defaults={selectedClass:"sortable-selected",multiDragKey:null,avoidImplicitDeselect:!1,setData:function(t,e){var n="";de.length&&le===o?de.forEach(function(t,e){n+=(e?", ":"")+t.textContent}):n=e.textContent,t.setData("Text",n)}}}return t.prototype={multiDragKeyDown:!1,isMultiDrag:!1,delayStartGlobal:function(t){t=t.dragEl;se=t},delayEnded:function(){this.isMultiDrag=~de.indexOf(se)},setupClone:function(t){var e=t.sortable,t=t.cancel;if(this.isMultiDrag){for(var n=0;n<de.length;n++)he.push(C(de[n])),he[n].sortableIndex=de[n].sortableIndex,he[n].draggable=!1,he[n].style["will-change"]="",k(he[n],this.options.selectedClass,!1),de[n]===se&&k(he[n],this.options.chosenClass,!1);e._hideClone(),t()}},clone:function(t){var e=t.sortable,n=t.rootEl,o=t.dispatchSortableEvent,t=t.cancel;this.isMultiDrag&&(this.options.removeCloneOnHide||de.length&&le===e&&(me(!0,n),o("clone"),t()))},showClone:function(t){var e=t.cloneNowShown,n=t.rootEl,t=t.cancel;this.isMultiDrag&&(me(!1,n),he.forEach(function(t){R(t,"display","")}),e(),ue=!1,t())},hideClone:function(t){var e=this,n=(t.sortable,t.cloneNowHidden),t=t.cancel;this.isMultiDrag&&(he.forEach(function(t){R(t,"display","none"),e.options.removeCloneOnHide&&t.parentNode&&t.parentNode.removeChild(t)}),n(),ue=!0,t())},dragStartGlobal:function(t){t.sortable;!this.isMultiDrag&&le&&le.multiDrag._deselectMultiDrag(),de.forEach(function(t){t.sortableIndex=j(t)}),de=de.sort(function(t,e){return t.sortableIndex-e.sortableIndex}),ge=!0},dragStarted:function(t){var e,n=this,t=t.sortable;this.isMultiDrag&&(this.options.sort&&(t.captureAnimationState(),this.options.animation&&(de.forEach(function(t){t!==se&&R(t,"position","absolute")}),e=X(se,!1,!0,!0),de.forEach(function(t){t!==se&&T(t,e)}),pe=fe=!0)),t.animateAll(function(){pe=fe=!1,n.options.animation&&de.forEach(function(t){x(t)}),n.options.sort&&ve()}))},dragOver:function(t){var e=t.target,n=t.completed,t=t.cancel;fe&&~de.indexOf(e)&&(n(!1),t())},revert:function(t){var n,o,e=t.fromSortable,i=t.rootEl,r=t.sortable,a=t.dragRect;1<de.length&&(de.forEach(function(t){r.addAnimationState({target:t,rect:fe?X(t):a}),x(t),t.fromRect=a,e.removeAnimationState(t)}),fe=!1,n=!this.options.removeCloneOnHide,o=i,de.forEach(function(t,e){e=o.children[t.sortableIndex+(n?Number(e):0)];e?o.insertBefore(t,e):o.appendChild(t)}))},dragOverCompleted:function(t){var e,n=t.sortable,o=t.isOwner,i=t.insertion,r=t.activeSortable,a=t.parentEl,l=t.putSortable,t=this.options;i&&(o&&r._hideClone(),pe=!1,t.animation&&1<de.length&&(fe||!o&&!r.options.sort&&!l)&&(e=X(se,!1,!0,!0),de.forEach(function(t){t!==se&&(T(t,e),a.appendChild(t))}),fe=!0),o||(fe||ve(),1<de.length?(o=ue,r._showClone(n),r.options.animation&&!ue&&o&&he.forEach(function(t){r.addAnimationState({target:t,rect:ce}),t.fromRect=ce,t.thisAnimationDuration=null})):r._showClone(n)))},dragOverAnimationCapture:function(t){var e=t.dragRect,n=t.isOwner,t=t.activeSortable;de.forEach(function(t){t.thisAnimationDuration=null}),t.options.animation&&!n&&t.multiDrag.isMultiDrag&&(ce=a({},e),e=b(se,!0),ce.top-=e.f,ce.left-=e.e)},dragOverAnimationComplete:function(){fe&&(fe=!1,ve())},drop:function(t){var o,i,r,a,n,e,l,s=t.originalEvent,c=t.rootEl,u=t.parentEl,d=t.sortable,h=t.dispatchSortableEvent,p=t.oldIndex,t=t.putSortable,f=t||this.sortable;s&&(o=this.options,i=u.children,ge||(o.multiDragKey&&!this.multiDragKeyDown&&this._deselectMultiDrag(),k(se,o.selectedClass,!~de.indexOf(se)),~de.indexOf(se)?(de.splice(de.indexOf(se),1),ae=null,G({sortable:d,rootEl:c,name:"deselect",targetEl:se,originalEvent:s})):(de.push(se),G({sortable:d,rootEl:c,name:"select",targetEl:se,originalEvent:s}),s.shiftKey&&ae&&d.el.contains(ae)?(r=j(ae),a=j(se),~r&&~a&&r!==a&&function(){for(var e,t=r<a?(e=r,a):(e=a,r+1),n=o.filter;e<t;e++)~de.indexOf(i[e])||P(i[e],o.draggable,u,!1)&&(n&&("function"==typeof n?n.call(d,s,i[e],d):n.split(",").some(function(t){return P(i[e],t.trim(),u,!1)}))||(k(i[e],o.selectedClass,!0),de.push(i[e]),G({sortable:d,rootEl:c,name:"select",targetEl:i[e],originalEvent:s})))}()):ae=se,le=f)),ge&&this.isMultiDrag&&(fe=!1,(u[K].options.sort||u!==c)&&1<de.length&&(n=X(se),e=j(se,":not(."+this.options.selectedClass+")"),!pe&&o.animation&&(se.thisAnimationDuration=null),f.captureAnimationState(),pe||(o.animation&&(se.fromRect=n,de.forEach(function(t){var e;t.thisAnimationDuration=null,t!==se&&(e=fe?X(t):n,t.fromRect=e,f.addAnimationState({target:t,rect:e}))})),ve(),de.forEach(function(t){i[e]?u.insertBefore(t,i[e]):u.appendChild(t),e++}),p===j(se)&&(l=!1,de.forEach(function(t){t.sortableIndex!==j(t)&&(l=!0)}),l&&(h("update"),h("sort")))),de.forEach(function(t){x(t)}),f.animateAll()),le=f),(c===u||t&&"clone"!==t.lastPutMode)&&he.forEach(function(t){t.parentNode&&t.parentNode.removeChild(t)}))},nullingGlobal:function(){this.isMultiDrag=ge=!1,he.length=0},destroyGlobal:function(){this._deselectMultiDrag(),p(document,"pointerup",this._deselectMultiDrag),p(document,"mouseup",this._deselectMultiDrag),p(document,"touchend",this._deselectMultiDrag),p(document,"keydown",this._checkKeyDown),p(document,"keyup",this._checkKeyUp)},_deselectMultiDrag:function(t){if(!(void 0!==ge&&ge||le!==this.sortable||t&&P(t.target,this.options.draggable,this.sortable.el,!1)||t&&0!==t.button))for(;de.length;){var e=de[0];k(e,this.options.selectedClass,!1),de.shift(),G({sortable:this.sortable,rootEl:this.sortable.el,name:"deselect",targetEl:e,originalEvent:t})}},_checkKeyDown:function(t){t.key===this.options.multiDragKey&&(this.multiDragKeyDown=!0)},_checkKeyUp:function(t){t.key===this.options.multiDragKey&&(this.multiDragKeyDown=!1)}},a(t,{pluginName:"multiDrag",utils:{select:function(t){var e=t.parentNode[K];e&&e.options.multiDrag&&!~de.indexOf(t)&&(le&&le!==e&&(le.multiDrag._deselectMultiDrag(),le=e),k(t,e.options.selectedClass,!0),de.push(t))},deselect:function(t){var e=t.parentNode[K],n=de.indexOf(t);e&&e.options.multiDrag&&~n&&(k(t,e.options.selectedClass,!1),de.splice(n,1))}},eventProperties:function(){var n=this,o=[],i=[];return de.forEach(function(t){var e;o.push({multiDragElement:t,index:t.sortableIndex}),e=fe&&t!==se?-1:fe?j(t,":not(."+n.options.selectedClass+")"):j(t),i.push({multiDragElement:t,index:e})}),{items:r(de),clones:[].concat(he),oldIndicies:o,newIndicies:i}},optionListeners:{multiDragKey:function(t){return"ctrl"===(t=t.toLowerCase())?t="Control":1<t.length&&(t=t.charAt(0).toUpperCase()+t.substr(1)),t}}})}),jt});
      return module.exports;
    })();

    // ---------- 插件装配 ----------
    function apply(ctx) {
      ensureStyles(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-prompt-vault: dictionaries');

      // 注册全局快捷键（默认 ⌘⇧I / Ctrl+Shift+I，可在设置里录制修改）
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (k) => zh[k] || k;
      let dispose = null;
      const register = (nextSpec) => {
        if (dispose) { try { dispose(); } catch { /* 忽略 */ } dispose = null; }
        // 热更新时清掉上一次残留的同名快捷键注册，避免重复注册被静默跳过
        try {
          const registry = ctx.shortcuts.registry;
          const commands = registry && registry.commands;
          if (commands && typeof commands.delete === 'function' && commands.delete(PLUGIN_ID + '.open')) {
            registry.refreshLabels();
          }
        } catch { /* 拿不到内部表就交给下面的 register 处理 */ }
        if (!nextSpec) return;   // 用户删除了快捷键：只解绑，不再注册
        try {
          dispose = ctx.shortcuts.register({
            id: PLUGIN_ID + '.open',
            label: () => t('shortcutLabel'),
            aliases: ['quick prompts', 'prompts', '提示词', '快捷提示词'],
            defaults: buildBindings(nextSpec),
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => {
              if (shortcutHub.capturing) return { status: 'handled', run() {} };
              const run = shortcutHub.current();
              if (!run) return { status: 'blocked', reason: t('needComposer') };
              return { status: 'handled', run };
            },
          });
        } catch (e) {
          dispose = null;
          console.warn('[dsh-session-prompt-vault] 快捷键注册失败', e);
        }
      };
      registerShortcut = register;
      ctx.effect(() => {
        register(loadShortcut());
        return () => {
          if (dispose) { try { dispose(); } catch { /* 忽略 */ } dispose = null; }
          registerShortcut = null;
        };
      }, 'dsh-session-prompt-vault: shortcut');

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: PLUGIN_ID, order: 10, locale: NS },
        QuickPromptButton,
      ));
    }

    // ---------- 拼音字典（数据由 pinyin-pro 3.29.5 / MIT 离线生成，勿手改） ----------
    // 覆盖 CJK 基本区 U+4E00–U+9FFF；codes 为每个汉字的音节下标（0 表示无读音）。
    // ü 统一写作 v（lv/nv），搜索时也兼容 lu/nu 写法。
    const PINYIN_RANGE_START = 0x4e00;
    const PINYIN_RANGE_END = 0x9fff;
    const PINYIN_SYLLABLES = (
      '|yi|ding|kao|qi|shang|xia|han|wan|zhang|san|bu|yu|mian|gai|chou|zhuan|qie|pi|shi|qiu|bing|ye|cong|dong|si|chen' +
      'g|diu|liang|you|yan|sang|gun|jiu|ge|ya|pan|zhong|ji|jie|feng|guan|chuan|chan|lin|zhuo|zhu|ba|dan|wei|jing|li|j' +
      'u|pie|fu|nai|wu|tuo|me|zhi|zha|hu|fa|le|yin|ping|pang|qiao|guai|hao|nie|xi|xiang|shu|dou|nang|jia|mao|mai|luan' +
      '|ru|xue|sha|na|qian|suo|zhe|gui|jue|liao|zheng|er|chu|kui|yun|sui|gen|xie|tou|wang|kang|da|jiao|hai|heng|mu|ti' +
      'ng|qin|bo|lian|duo|ren|shen|ze|jin|pu|reng|fo|lun|cang|zai|ta|xian|hong|tong|gan|dai|ling|chao|chang|sa|men|fa' +
      'n|yang|wo|jian|yao|fen|di|fang|pei|diao|dun|wen|xin|ai|xiu|tang|huo|hui|cui|che|chen|xun|chi|nu|gu|ni|ban|xu|z' +
      'hou|qu|beng|dian|bi|zhao|ci|zuo|ti|zhan|he|she|gou|ning|yong|wa|ka|bao|huai|lao|bai|ming|hen|quan|tiao|xing|ka' +
      'n|lai|kua|gong|mi|an|lu|mou|cha|lv|zhen|ce|kuai|chai|nong|hou|jiong|tui|nan|xiao|bian|cu|e|guang|ku|jun|zu|hun' +
      '|su|lia|pai|biao|fei|bei|zong|tian|dao|tan|chui|peng|kong|juan|luo|song|leng|zi|ben|cai|zhai|qing|ying|ruan|ch' +
      'un|ruo|pian|sheng|huang|duan|ou|zan|sou|yuan|rong|ma|bang|shan|que|bin|nuo|can|lei|zao|ao|chuang|piao|man|zun|' +
      'deng|tie|seng|jiang|min|sai|dang|xuan|tai|lan|meng|qiong|lie|kuang|teng|long|rang|xiong|chong|dui|ke|tu|nei|li' +
      'u|shou|ran|gang|gua|zui|kou|qia|mei|zhun|cou|du|kai|cun|hua|yue|bie|pao|geng|shua|lou|cuo|kei|la|pou|tuan|zuan' +
      '|mo|keng|shao|miao|gao|lang|weng|tao|nao|za|zang|suan|nian|shuai|ang|mang|shuang|die|rui|po|mie|a|tun|fou|shun' +
      '|guo|qiang|pen|ne|m|wai|pin|ha|yo|o|chuo|huan|ken|pa|se|hei|ng|dia|cao|ga|de|ceng|zeng|nin|kun|qun|ri|lve|zhui' +
      '|hang|cen|sao|zhuang|en|zou|nv|nuan|shuo|niu|rao|niang|nve|rou|niao|nen|sun|kuan|cuan|shui|kuo|te|zen|re|zei|d' +
      'en|zhua|shuan|zhuai|chuai|ca|shai|sen|nou|run|chua|gei|miu|neng|ei|eng'
    ).split('|');
    const PINYIN_CODES =
      'AQACAAMABAAFAAYABwAIAAkACgAFAAYABAALAAwADQAOAA8ADwAQABEAEgATABMAFAAVABYAFwAYABkAGgAbABQAHAAbAB0AHAAeABUAHwAgAC' +
      'EAIgAjACQAJQAmACcAKAApACoAKwAsAC0ALgAvAAgAMAAxAC4AMgAzADQANQA2AAEAAQA3ADgAIQAhADkAOgABAAEAOwA4ADwAPQA+AD8AQABB' +
      'AEIAQwA9AEQAGgAaAAEARQABAEYAIQAEABYARwBIAA4AIQAGAAAASQBKABMAJgBLAEwANAATAE0APQBOAE8AAABQAFEAHgA2AFIAUwBUAFUADA' +
      'AuAFYAVAA7AFcAVABPACwAAQBYAFkAIgAMAFoAEwATAFsAXAAMAF0ADABeAD0ABAA4ADIAGQBfAGAAYAAjAGEAIwAEACMAJgBiAGMAZABlAGYA' +
      'ZwABACsAaABpABYASAAyAGoAHABIADIAFgBrAGwAHQBhADAAbQBuADEAbwBvACYAJgBjAAEAcABvAD8AAgBxAHIAcwAPAC8ACQByACcAFQB0AB' +
      'cAdQByAHYAFQB3AHgAEwB5AAkANgB6AHoAOQB7AHwAbwBUAH0AAQBsAH4AfwABAIAAgQCCAIEAAQBpAIMAbwCEAIAAhQBUACUAEgCGADgAhwBM' +
      'AIgAKAB3AG8AYwCJAIoAiwAlAAQAjAAMAI0AjgCPAAEAkABkAAEAJgCRADgAJgA2AD4AkgByABIAMAA2AJMAJQAdAJQAlQAMAJYAXgAKADEAKg' +
      'CXACMAVAAFAIEAdgCYAJkAkAAxAC4AmgB6AJsAbACcAJ0AnQBhAJ4AnwB/AKAAcAChABkAogAZAEwAEgABABkAAQBaAKMABwBOADAALgALAKEA' +
      'pAClAKYAMQCKAC4ApwAdAIUAqACpAKoApAA5AKsADAABAHUApwCsAK0AfACdAHoAoQCuAK8AVAAdALAAsQCMALIAIgCzAEgAIgCFALQAPgC1AE' +
      'wAWwAVACYAtgCUAFcAtwC4AGYApgABABMAuQBwADkAugA7AA4AuwABAJoAvAC9ADMAQAATAL4ALgCfAB0AvwDAAMEAWwB2ABgAwgCaAJkAvQCg' +
      'AAEAUACHAAYAGQB+AMMAeQBmAMQAxQBDAMYAxwCtAMgAcgA4AMkAygAaAMQApwAPAGsAwwA0AEkAagBwAMsAbADMAM0AzgDLAAwARwDPANAAFA' +
      'CfANEA0gA4ANMAAQA2ABwA1ABDADMArgDVADIAVAAKAIwA1gA2AEcAMwA2AEEAsQAMABkABgCQAJIADACKAJcADwA7AB4A1wAzALsAGQCHAJIA' +
      'NgCUADQAzQDYAIcA2QBcANoAKAAjAL8A2wAMAJAApAA9AIEAOwAVACEAiACWABwACAC7AHcA3AAiACkA2wDdAEkASQCDAN4A3wBYAOAAuQDhAJ' +
      'MAyQABAAQAqAB9ABwAJwBfAIEAJwCLADsA4gDjANwANABUAJ0AdgAtAIYA5ADlAOYA1QAYAOcA6AA4ADQANwDpAIcA6gAWADsAUgDrAK0A7AAa' +
      'AFQAHgDtACUA7gBMACYAMQAMABUA7wCoADEA8AAeACgAkwCGANAAYQCXAPEAugCKAKcAwgBqANsAYQDyAIgAqQAPAL8AHQCHAJ8APACmADYApA' +
      'A7ANwADQAmAAEAYQCZAOkA8wDFAMQA9ABiAGIA2wD1AMMAJwAxAIkAgQBdAPYAOwDWAAYANgD3APgAMwCbAF4ArAD5APoAowCTAEUAJwBHAPsA' +
      'VAD8AHcAXAAKANsAzQD4AIgAeQBVAIUAPgAVAEwAfgB4AJMAnAD9AFwA/gD/AAABlgCuAAEB3ADhAOUAAgEqAAwA6gAEAAUAAwEyAJoAUgAHAA' +
      'kA6wAeAIoAYQDDANsABAFyAG0AwAAFAVQAegDfAOwAGAAQAEgA+wBDAMoAywAGAXMARwCzAIEA0QBZAAQABwErADEAJgBsAJUAKgAIATAAZgAh' +
      'AAkBiQB6AAwA0ABmAIcAfAAsAGwAnAB6ANYAegAKAQsBFgByAEwAQwASACgAoACRAAwBAQDTAMgAKwABAA0BMgAOAcYAhwBcADAAZgBSAHgA/w' +
      'D9AL8AUAAPAQ8AxwAQAZ0AcgBUABEBOACtABIBnQCBABMBAAHDABQBsQAMANkA9QA7ABkAHQBFAOsAmAAzABUBMQAWAVwAKwAXAUkAlQAzAOQA' +
      '9QD+AJMAHgAAAUsAWwA4AF4A9QD3ABgBGQGlABgBegDRABoBGwEaAQ0AHAGBAFsAGgFbAGsAHAEZAB4AHgATAAAADQEAAEoAAAAAAHAASgAAAD' +
      'IAAADyAFAAYwAdAbcAHAAMAC8AvQAeAUcABwAQAb0A3QApALkAFQAEADQAowDnAAAAhQCHAB8BJgABACYAKwDKAE0AIAEdAfcATQAhASABxQDK' +
      'AMUAeAAiAcoATQCgAE0ArACfAA0AvgD4AB0AYQC6ANMAyAABAL4AEwApABEBJQAjAfcAtQAkASwANgBhAL4AFQAYAA8BIQEoABUAPQAZAVgAIw' +
      'AUARYA5gAkAD4ACwEYAHoAEwElAYcAMgD2ACYBHAEEAJwAJwHlADIAHADrAI0AfwAYAH0AhwBAACgBkQAzAHcAtQAnAZYAGQBuAHIALAAsAK0A' +
      'RwApASYAhACEAIQAKAA0AFwAWgAoAGkAOwA2ACgAQQAoACoB8gAqAX0ABwFBALoAGAHGABwBAgFcACYADQEHAAcAAQHeAI0A3gBvAG8AAwGJAB' +
      'EAAQAmALoAVAArAVwAjwAmADAAuQAsAQgAWAAzAC0BEwEeAXEAIQEDATYAXAChAI0A+wALAX8AJQAkAC4BJwAnAC8BMwD7AC4BKwAyACIBMAHe' +
      'AAMBXQDSAG4AWwA7ADEBtwDCAKYAGwEnAFcApgBXACoBbgAmAKgAMgAyAeQAcQD3ADMBzQA0ATUBVADCAAMBIgGHADMBMwCoANoANgErAAQAAw' +
      'HnACEBCACxACYAbgDrAB4AKQGHACYAsQAeADQAlADxAIcAbgDzADgAIgE2APEAhwAiAGUAKgEDASoAKwA3AcAAMwDhAPsABAEkAWYAIgFDAFgA' +
      'LAE8AC0AbQA0ABIAHgFXAGYAVwCHAIcAkwCUACYAhwABAIcAOwArADgBOQEzAC4AMwAjALcAngC9AEwAOABOABMBcgA6AWEAOwAYAC4AmwAnAK' +
      'EAOwEBAC4APAEzAHIAswCzAOMAJAGFAK8AzQDBABQBJwATAaoAEwAbAXIAPQFsAAsBmgA+Aa4ArgANABsBmQDjAOsAwAALABEBmgA/ACoBDQAY' +
      'AJ8AnwC6ADgAAQCZAD8B8QCzAGkAwAAEARMAJgBrAAoBZgC3AEgAAQBDAIQA4wB8ADQAMABhAE4AmQCZAMMAMwCXABcBtwCxADsBXgAhALEArA' +
      'A4AF4AAAAYAQ4ADgCxABcAAQAYAeEANABAASIAcwDQAC8BNgC9AGUAIQC9AKQALAHbAEEBmgCLACEAAQBCAQoBZAAKARQBPQAGAKEAhABXABEA' +
      'QwEUAdoAPQAMAFcAXQCVADAAXQBtAG0ARAEpASEAWABHABIAoQABABsBHgDOAJ0AoQATAJkAVABFAYIA1ADxADgAlQCeABMARwAIACwBYQAIAN' +
      'sA1AAtAGEAMABOAMwAMAAmAGwARgELABQBzgALAKkAsADAAB0AwABHACIBhgBhACcAJwAxAEcBEgE7AE0AQAAxADsBJgD8AE8AmgDjAGEAnwBy' +
      'APwAOAAmANAA6wBHAAoAgQAxANAAagAzAFYABwAzACMAIwAeAKsAigA8AEIAIwARACMAOwDFAEgBqAAzAKsAyQBqACMBMwHaAPcAxQD3AEgAHg' +
      'AzAFgAUgCjAFwAIQByAAIBVwAeABkAMwCBABABMwAeAB4A9wAZAL0ALAAUAKEAoQAAAAABKQF6ABAACgD/AP8A/wD/AJEAfgAdAMIAJgAdAEkB' +
      'hAAfAUQALwA+AO8AMwBJAC0AoQAfAc4AnwBMACQA9gAmADEA9gBKAUsBFwAkAZwANAB/ACIB3gAkATsAZgClAC8AAgAbAQ8BmgATAB0AFABMAR' +
      'YARQAZAN8AmgA/AI0AJgAAAHsATQGfAEgBmgAiAA4BiADnAKoAJgCNACsBfAC1AMkAMwAcAUgAPAAGABYAwwBOAfkA9ACUAAEA0wAPACwATwFA' +
      'ANoApABrAGsAJwALAFABLwCOAIkA0AAHAGoAOgFRAQQAewA7AEAAOAA4AIAAUwBRAEcA4ABKAI8AyQB7ADgAPQEjANMAwwDQACIAjwB+AIMAGg' +
      'A4AD0BNgBmAHsAmgDxAFMATwE2AAEAfgD0ADMAtAD3AFIBLAFTATgA0AATAOMAVAGPAFUBVgF/ACABHQCKAKAAEwCgAAgBRwABAAQAQQDnACIB' +
      'pgAxAMkAqgBBAQYAjAABAEUAcAA9ALUAZQChACMBegBCATkAbgA2AS8BpAA2AIUAqgBCAaoAZwAhAK4ANgBlAKAArwCwAJwAsACnAAsAFgEYAK' +
      '0AOQAZAHoAlAAEAFsA0ADRADwARwABABMB5wBNAb4AOwCIACYAoAAiAEkA9QDNAGcAlQC8ALIAQAF6ANAADgGSAFcBHgCzAAEAkQBYAXAAfAB7' +
      'ABgBbgCvAFkBeAAdAIoA2ABIAJEAYAAUASMAZQDNAKQALQFFASwBuQDGAG4AAAAmAMgAwQBaAUUA9wAWATYBSAEiAFsBmgA7ATMAUwDUAKoA0g' +
      'DNAHoAswBsAFYAPAAcAC8ATQETAV8ANgALAAcAaAAwAVwBIgAdAB4AnACcANsABwBVAO4AAQCRAEwAHAEeAAgAMwBHAJMApwAUAJcAOAABASMA' +
      'SgAEAIoAawBOAAAAvQBKAAAAswAcAFUAAQFdAeYAUgAmANQAhgAoAEAAPQAEAB8BMQAxAYEAWwAzAFMBvwAnAFoBRQEMAN0AuwBSAEcAOQA9AJ' +
      'EAoACsAF4BLQAtAAUAigBoACwATgHpAFMBTwE4AI8AlgBKAZwABAAEAEABMAAwAC0B5wCkAJYAXAGqACMABABWANoAHAB6ABIAUgA1AXEA7AAi' +
      'AV8BVgBgARAARgBSAeQAHgCKALcA3wBsAAIAPgHNADQAkwCaAKgAvwAhADAAsACuADEAzAD7AAwAVgA1AScAyQAHAEoBoADHAFcB/gCfAEAA9Q' +
      'CIAIYADQA9AF4AKgCVAF0BXQFHAKoAJgBdACUAMQBSAJ8A8gBuAB4ADgEcAAwAHwCaAEMAHgAwAFQB/wAzAFoBPAAxADwB7ABUAQAAXQBHAAwA' +
      'JwAyAdIAAQE9AKgAiACqAE4BkgBTAWABrgDWAL0AYQCRAFUA+QDCAGcAGwFlAB8AmABQAPYArwAmAEIAOAB6ABMAIgDnACcAswA/Aa8AGQCaAE' +
      'UAVQAAAGEBVQBrAEYAqgDnAAwBYgEiAFMAYwGRAFMBfACkAAIBAgFtACMBVgA5AfYA9gDfAIoABABmABkBZgAqAd8A+wBkAUwAkQDNAAQBMgFl' +
      'AZwAZgA9AJUAUgH0AHoAcQCBAJ8ATAFmAfkA+QA9AD8AKQFlAZMAFgCiAOwADAFmAL4AzQAsAU4AIAGnAOEAswDNACYALgCAAF0AIwHNABkARQ' +
      'A2AFkAQwBHAFwA3wAwAGEBmQDQAAYBhACaAJUA9QADAc8AMABYAE8BZwFmABYARwAEAEUAbQCfAAcBlQBAAHMAWABrAJkARgDAABkAHgDsAGUA' +
      'qQBbAaAAcgDIAC0BYQAEANAAAQEBABMAZgD3AJEArgBYAMYADABUAd4AZQGQAI4ADQGQAAwBEgASAEAAIwGtAIoAEAF5AJQAUABFAKoAHgBuAJ' +
      'IAoAAmAHIARQCoAIEAmQA6AMIAqADAAJUAbAAdAEYAQAA9ADoAewBWADMAHgFhAEsAAgE5AR4AMwDAABYBTAEwAJgAWAESAEgAlAA6AEcAbgDS' +
      'AB4AKwDsABcBowA1AXkAzQBmAFwBXQGUABAARgDNAEIBMwArAMcAMwABAOQASwBCAdYARwBoAYcAQgEuABABRgBLAAAA5AAxAJUAQAAUABkAaQ' +
      'GHAJUAkABAAMwANwE3AU8BZAD3AMoA8ABeABcAPQCVAPcA0ABSAWoBFwAxABwBMQB2AFIBawFsAX8AnABSAQ8BUgEcAR0AUgFAANUAcwAMAAcA' +
      '9wB2ALcADADrAFIB4AAxAPcAtwDSAHMA9wD3ACMANwEcARwBNwFtAZUAAQBdAU8ATwAcASMAHAFqAPEAcwDAAMYAIwB4AJ8AIgA5ADgAVwASAA' +
      'EAigBUAFQAxAAtAA0BJQEGAPsAFAGBAAQARgA5ASYATAA7ADsAngCZAAEAawAmAdMA+ABPAYsAiQDoAN8AugCyAKcAOgGkADIAigAyACYAxgCK' +
      'ADIAhwDfADMALwA4AIkAbgFMASQAkwBqAaEA3wA7ADkAfQBBAKMArwCdAA8BEgDKAIUAdQACAcAAFABpABsBrABRAD4AigCXAH8ALgA2AD0AOw' +
      'DgADUBFgEWAcAAAgF+AC8BCwG5ABgAJgCqAMMApgCaAAABDgBAAMkAGgGlADYA0QCIAG4AbgBXAMIAhQBAAD4ArAD3AEoBYQBeAQUAHwHQABUA' +
      'owB7ACMAvABlALAADQEqAW8BQQG/ALkAegD3APoANgEvAAEAQAAHAJ8A4ABwATABkQCiAIoA/ACuANMABgCKAE4APgHjABoA+wBrAFYAEwETAX' +
      'MAGgAsAQsAEwCZAFIBygAWAEUBigAMAAsAIwC3AF8AEgDrAAgANAB2AFoA4gCTABgAfgDfAL8A6QBcAKIAugA7AG4AAQA7AAEAjAAmACcBBABx' +
      'ATQAnQDSABsBkwBqAZ0AhwAaAXIAIQEMANAA4QCcABwB5gCLACMAVABqAb8AcABuAEEBHAEaAEAAXQGkAG0AUgFKARAAyQCxALEADACKAE0AJw' +
      'DtAJEAMAG6ANwADADyANAAiAAeALEAJgAmAYEAKQE5AEAAKAAlACcAcgBoACEB7gCHAEEAAAEKAfIA5gDzAAgADgEmACYAxgDsAHkAGgCuACoB' +
      '1gDWABMAvgB5AD8BGgAcAZMA/AAlADMA4QD6AAwBQwEaAd0AOABaAJkAIgDEAJEAvQAeAHoA3QD3AI8AYQAeAWcAPgGBAOEAogCYAMAAwAD0AF' +
      'QAJgE5ARAASQFJADIBmgAFAdkAMgAEAEkAigAJALoArgCjAJgAOwBHAFIBUwFyAIoABQBpAJYAHgB5AGgBVABTARwAMQBuAUMAaAGfAPsA+wA+' +
      'AHMAxgA3AYQAQwA5AY4AjgAGAYoA8QBuAG4A3wAHATgAiQDyAN8AZQAWAC4AhwACAVMBJgBDAF4BAQASAKQAowAKARYArgBRAN8AEAE0ALIADQ' +
      'EXAVQAmQAQAUcAqgCRACMA3gBFAO0AcgAAARQBwAAeAN8AMQCyABYBFgFLATMALAAXASsAmQAeAAABLwAIABMAbwAKAHIBcgHxAAEATgAbAS4A' +
      'cgE9AD0AagEBAD0AnwBqAR8BSAErAR8BAQA7AJwAXAAKAUIA2wDqAM4AXwBrAX8ANgAzAQYADgFhAEEBBgBdAEcAVwEIAE0A1gBuAG4AFgDrAA' +
      'AArACsAAQAEQERAUAAlACYAGUAxQDdAA8BNgBEAIgAhQBvAT0BEwBAAQ8BYgAeAKQAAQC8AEwAbgAsARQBXgBMAC8AcwFtAF0BigAeAC8B4wAE' +
      'ADcAKABhAIkAowC3AF0AdAFdAQQAKgE8AOgAAQAKAUABQwHoAEcA8gDaAI0AmQCiAKMAAgGrAD8BWQECATgAAgEKAW0AbgBeAAoBEwCJAJQApA' +
      'BPAG4AdQGbAAIANwBUAIcAeQAhAHYBwgBFAHoAhAAmAHcBUADaAGMAewByATYA+QAwAG8ANgAyAB4AZwCPACUAXwEpASYAOgElAIgAcgBeADwB' +
      'UAGaAC0BcgF4AR4AUwCQAIkApAAMADkAKAAIAIsAOAAMAFcAKQEvAJ0AoAAtAKUAZQA3APcAYgB6ADsA0AAmATkBBACkAHAAEQDQAKoAnwA+AF' +
      'oACwGeAGkANgB/AOcA5wATACAB+wCFAAUBJwCcABkAuQAxAOcANAD7AFgBbwCIABgACgFJACYADgBIACwB4wBmAKwAswCHAIcAAQBFATsAxAAm' +
      'AHoAaADRANMAvAAeALUAEwGMANAAHQAeAMIAegBAABMAVwC3AOcA5QAxAHsArwAyASMAeQFmAE8AQQB6ADsBMwAaAGEASAE2AFUAOAAxABsBXA' +
      'FcAWoAegG5AMwADABTADYBHQHjAHAAOwAHAIoAcgHQAFgBywAFAQ0AOAAeADgARwAeAAwAGQAMAK8AMwB6ADQAoQBuAQQAegAtABgAgQDAAJEA' +
      '0ADQADIBDQAXADYBNABMAekAfwAIANkAzQBJAAQAlQA2AIYAhgDfANoA2gAnAN0AnQC3ADIA1QAyAFQAowC5AD0ACAC7AKQAQACgAFwBNgAyAH' +
      'YAewEQAdUAQAAjADQAMwCjAHoALAEsAewAKwBwAGoADQGIADgAzADvAEwAYgCfAAwAMQCKAHwBJgEwAO0AawCVAIYAVADuADwBNgAnAPMAAQAl' +
      'ACYB8gANAL8A7AAOAScAMQAmAfcAWgAUAKgAYQBuAG0ATQAgARkA8AAxAK8AzwA9AAIBJwCxAJ8AYgBXAFwAiAASAEcA9wDsAPgAUACaAB4BJg' +
      'EkAAIB+QCsAF0AawBMAHEBxAD3ACcA+AC1AOwAJgDWAH0BegBAAUIAPgFBAdkAkQASAFgBAQAEAQwAAAEOAQUBAQAJAGQArgCdADMAigBXAB4A' +
      'cgAQAIEAcQAHAH4BswA5AVYAPQA9AAIBfgFTAfkANQCcADgAQwA5AKkAPAF6AHoAOQFZAG0ALAFXAAcBOwCfAAEALAFHAF0AeQFHAB4AKwBmAC' +
      'YBhACEAHoAAQCVAGYANgATAKQA+wBfAFMBbQASAZAAfQEYAAEA/wCRAHoBrQA5AbgADwByAKYADABYAfgAUAA3AB4ADwHsAFQAfQEtAewADQCk' +
      'ADkBcAC5AJ0AKQEeAfcAEAEeAEkBfwBmAHoBEAFUAOwASQFhAF0BvgAzAE8AHgAuABAB5wAnAFgAWADiAF4A+QDnACsBfwE2ANsA5wDNAJAAEQ' +
      'EZAA8BsQAmAJwAmwBRAB0AEABnAE8AfwFBAU0BFwBUAEkAKwAjAOcAnQA2AOcAMwBRAGwAUAA3AEYARgDsAE8ADQCtAPgAeQBXAOoAEgEMAB8B' +
      'vwAcAeUACAB8AYgAewABADIAJwG+AC4ADQF7ANwAKQCgAAIACAABALEAEwATABkBcAAbAQ4BEwAdAF0BAQC4ABMAegC9ABoAawG9AM0AeAA8AL' +
      'EAZwAeAM0ATABwAJgA+ADyAL4AJAGAAf0A1gDpACcAJgD3ACYAQAC+ACQB6wCqAMQAhwA2AK0AFQBdASYBawAHAAwAEwCtAHIArQA7AAwAsQCA' +
      'Aa0AawA5AcIAMgEiAWsAPQA4AFkAEwCtAOoAcAAxAGEAgAGVAFkA0wBdAQEAAQCxAGsAGQGxACgAKwEaARkAmQDeAG0BGgEfAUwBKAAQADYAqw' +
      'A0AQoBCgEQADEABgGZAEkAGgHeAM0AJwA7AVsAWwBbAGUBhwBJAJgABQAFADkBZQGBAFkAegB6ANUAYwBjAB0AWQBZAIgAEQFjAGMAYwBlAYgA' +
      'bgBdACUAIQB9AJwAfQDLAH0AfQATAEAAmgADAJ0AcgAxAH0BNAASAGcBRwCkADQAJwDdAKEAqAAnADgAjQATABMAQQAmAGEAxABHAJ0AqQBHAD' +
      'EABQHQADIBFQCoANoASQBhABwBwwDDAEcAZwHDADQAYQA0AFgAWQBYAEkARwCXAE8BnQD7AK8AegAzAL8AlQCVAHsAAQAEAG8AOAAHAHAADABc' +
      'AF8ABABvAC0BngCIAEcBIwA4ACcA0AAmAFQAiQAIAAQAcAFUAAQAwgAnAKEAIQF6AAIBEAHeAC8ApwCnAIUANAAhARsBrABRAEwBMwC4AKEAHg' +
      'A2AJIATAB/ADkAEgACAX4AFAEtAaEAPQBMAQsBvwC4AH8AigBBABgAqQBdAJIATQB8AFEAAQDOAKoALwDkANAANgCZAEoBwABzAVsADgC3ABgA' +
      'AQBpABMAvwAxAF0BOwC+ABMBPgB8ADEAHQAlAQYAMwCIAEMAWgBPAGYA0ADQAAwAYQALAEMAawEoACgAQQEzAB0AegD4AN4AcAAaABwBMAHTAD' +
      '0BBgBAADgAPgG6ALMAuwB6APwA4gAZARkBeQAsACwBNAC7AAQACwFqAWoB1ACcAJYAIwAjACEBdgB2AH8AWABuAFoAUgFAABgABwBaADEAzQAS' +
      'AB4A5QAnAKIA1ABYABgAqQCcAEAA5wBxAPIADABXAYUAKAAUAIUAqAABADsAEwB4AIgA0AAuALoAwwAeACYBBwAmACYAXQFqAPEAJgFUADgADA' +
      'DcABABGwEeAB4AMQDcAMIAXwD4ABsBawAMAAQAMgEcAZYARwA/AXcADQH4ACcAkQAeATgA5QADAOcAMQCiAKMAMwFUAK4ARgAzASYAEwDvAOUA' +
      '3AAKAVkAZAArAIoAcAECABwBMgEJAKkAqQACAWQBoQBTATEAIwHeAN4ARwAMABIAFgFIAGcBbABrAGYAHgCzAKkALABZAFkAawAHATkABgFmAF' +
      'gAiABmAIgAWACpAAEAUQBBARYAFgABAEYAegAmAGEAGwFXAIoAAgEjATEAAQD4AN4AfwAnAAwALQFAAFAAJwAzAEcAFgEWAaMA7ABHADQAKwDs' +
      'AF0AHgAxAEEBtwCAAIEBTwCjAKMARgAeAB4AHgBdAB4AKgDGACoAoADyADIAmQCAAIAAEwG9AKcAQwA0AL0ANAA4AJwAnADCABQAFAAmAAEAGQ' +
      'AvADsApQBIAAEAcgCZAOMAAACZAHIANgBCAaQAEwALAAIARgGEAEYAEwCJAF8BOwBHAD0AMAAxAAkAkwB+ADkBjABfAQgBNgBtADsAoABsADsA' +
      'igA5AQEAAQBBACUB4wBQAEYBfgDEAIIBQwDEABMAawFHAPoAfgBXAA8AQQAJAIcACAB+ADEAgQBSAAQAcQBSAU0ALgDJAMQAWgC+ADEAhgA2AA' +
      'EA+gBBAEoBvQAkAPIAQAG+AEwAFQGVACUA+wAFAWkA2QBSAXEAaQD6AAkAMgArADYAOwA9AIQAcgGkAKQACQC+AEMAKwCJABEB+gAPAE0BXAAn' +
      'AHoAEAF9AEEARQGHABUAFQC5AH0AiABdAR0AHQAmANEAEgBqAHEA0QByAToA6wCkAGsAjgADAVcAIwC0ACcAnwDAADgAcgHSAOwAigAvAaMAIw' +
      'A8ATABpgA2AHwAQgDaAEgAAQA7ALgAOwCSACkBpwDNABwBVwDSAEgBagAdAAsAFQAaALsApAAmAL8ASQBkAK4AOQDlAEkA6wAMAAwAPAH2AMUA' +
      'SADaACEA0ABXAB4BUgBtAD4B9gA7AAsA6wAhACEAcgACAYMBMgFAAFkAfgDAAAEAXAArABwBGQCQADwBgQA4ANoA0QDSAMYApABTAWEALAAsAF' +
      'kAwAAmAOwAegBqAK4AMwBqAEAAmQAeAGoAigBMAYcAlQA3AJUAvQBFASoBzgABAAQAyACJADQAHgABAEMBpAABAAEAWwAKABMAWwATABMAvQCN' +
      'AEAAPQA2AHsAOADLAJoACgEvAHAAigAJAFgAQAE2AIoAvgB6AD0AgACbADIAxAABAL4AtwAIADsB7wAOATIAjQAJAAoBUwHhAN8AUwGkAKQAqw' +
      'AwAIcArAAiAD4ApAAkAYcALgHNADAAUgFTAXsAvgBSAQgAWAAmACYAVwANAcAAwAA3AZUAOwCVAJUAAQABAAEAAQAtAZQA+wC5AI8AfAAeAB4A' +
      'DACaAOkA2QCNAP0A4QCuAAQBCQDsAJoAmgAtADkAJgBCACUAAQBjAJcApACKAH8ANgBjAFoAzwBjADIAfgBHAJkAtgCFALIAwwDJAK8AGgA7AJ' +
      '8AMgAcARcAFwC7ABcAZgHYAEcAGAAmAIEAOwAXAKAAuwAMAGEAJwCHABMATADOAPIANgCZADEAQgCIADEARwBaAAQBqABmATsAOwAuAWYBGQGX' +
      'AGYAlQBmAJUAJgEWAUgAsQChAJAAkACkAAEAPwBvAN4AAgAOACYAbwBvACsA3wCEAYQBfQABAA8BKwE7AGMASAFHAIQA7ADdAAsBCwElABkBOA' +
      'AmADgARwBMAB0ACAAXAOUAxgAMAM4AOwAEAJYAmAAPAU8BVABFAdUAGAF4ARQBegCQAGQAPQAqAYkAsgAPAeUAOAD0AIEAAwE0AAEAsQCAAAsB' +
      'jACnAIUBhQAkAZ4AmwBBAVoAXwELAAgBPQA9AM8AZQBtABkAHQCKAH4AAQAcAR0ANgAmAOEAuQD3AJ0ARAA2AEcApAAdABEADgEXABUA8gCfAF' +
      'wApABJAEcA3wCuANwAGgG+AAAAAQATAH4BmQATAEcAswBoABQBwQA7AGEAbQC4APIASgFFAOIAVwBoAEcAzQBJABkAPQAUAIUAlQCVAJoATAAB' +
      'ABgBRAAsAJUA5wCfAJoABQB1AbYAcwEbARgA3QC9ALcARwAlAS0B4QBeAWYBlQDQABQAfAAeACoBxQBBAV4ASAGuAK4A9wASAGoBQwAtAQwAHA' +
      'EnAEcAVgAsAKgABwBFABEAqAALAAEAVACVAEcA2wAFAQEAaADlALcAGgBdADgAOAAdADMAHABdARcAAQAtATMAaQFBAdAA/AAOAVQAOAALARcA' +
      '2gDbAGYBlgCBAIMAMwAmACkAKQC5AN4ABADiAN0AdgBHALoAIACdAOsADwCOAFIBqQAyAAgA9wByACYAEAEMAJQAqgC3ADAAqACoAEUBYwBcAT' +
      '0A1QBHAIEAkAAxAJUA0ABVANwAhwCuAKMANAD/ABoAZgHbABEA/wAwACkAbgBBAV4ASABuAUoB8gDuABIBhgG5AMUAzgALAdwAqABDAA8A2wAO' +
      'ATEAIgBUADEADAAMAKQADgFdAQsBpAABAA0ArgAqAQ0BQADQAJgATQAbARsBDACRABEAHgD+AH0AXgAXAAwB5gCJAOwAXQBdAPwAvQBeANYAdw' +
      'EEAIgA5QDyACYAnAA0AAMBnQBhACoBWgCuAGQBmQBwAGwAKgH3AEcA1QCuAIUAMwBkAUABQACmAJ8AEQAPAfIAXgBwALUAvQCrAGQBBAFpAGkA' +
      'UgGaAP8A/wD/AJYACwGEAQkAfAACAUkBBQEpAPwAAQEhAJUAKgFtAPQA5QByAEAAwwAFADEANwEFAVQAqwCuAOsAZACKADsAMgHjAAQABAAMAE' +
      'EAWQAXAB0AGQE7AHwAGgAEAKEA4QDbAC4BEgFmAGgBmgBtAEEAXQCVAEMAGgBAAEAARwBHADAA3wBuABoBGgHWAFgAxQDNAIQAiQCzALMAGQEH' +
      'AAQAegALATIAWQA4AP8AWADPAHoA3wDxABIAAQBcAHoAQQEwAN8AMgDlAAcAJgAxAA4BGABrAGsANABkAV4BYQDsAAIBTQABACwAYAHTALIAgw' +
      'AQAZEALAAeAFIBBgCaAAwAQAB+ABEBkQARARoBBAA5ARABgwAPADsA/gD+AB4AhQBsADsAFAEUAR0ANgAeAU0BGgCVACsAEQEQAbIADgEXASsA' +
      'JgA0AF0BqwABAG0AzAC+AJMAWAAhASEBcgEiAC0BOACHAJ8ASQD4AEcAGgCGACcAIgCHAFMBlABTAakAGAAEAEwASgGHAUwAJgA7ALoAJgBdAA' +
      '4ABwGpAFMBIgCHACcADACHAB4AwABHAKkAPQBHAFwBfgChAD0APQA9ANAAEwCoAE0APQAzAIsAVQDOAKMAygAFAAEAAQD7AD0A2gAeAB8BHwHp' +
      'ADwAFAA/AHMALwBlAHQAhABQAHgAOQAJAI0AZAAMAAwABwBwAMIAOQCcACQBOACIAVQAOwBvAIMBgwBxAYUAeAGeAJcAeQFHAFQAngBMAAwANg' +
      'AvAEcAEgA7ADsA0ACIAaUAGgAmAB4AFAHOAIAANACPAD0ALQFYAC8AawAwAFoAXgAIAFUBAQBJAIkBNgFiAEoAZABWADYBNgAvAS8AAgFxADcB' +
      'JAF2AFMBXgA9ALEAFQA7AOEAzAALABIADwGIAMQAPACFALEAqgCdABYAigCaABIATAA5ASYBmAAjAA8AoQALAS4ATAA2ADwALgAwAMcAaQBFAT' +
      'UBNgAvAZ4A2AAsAFMARABUADQAOQAvADkAOQACATQALQBYAaUAtAC0AIoAnQA0AIMBFgGHACUBrgAQAa0AbABxAFQAtgCDARMAJwBaAGkBvQC9' +
      'ALcAigErAUIBAwABAGEAxQCVAFgBiwETAFMAtACaACIBOwCDAW4AbgA7ABEAvwDIAMQAIgBmALwAGABTALgAEwE8AMMASgGvAFgAEwE0ADsATw' +
      'AjAIYAeQBhAEEBDQFmAFoAJgCVAHoADACRADkA/gAzAWwAMAGoAMQAGgBVAIIAOgEmAcgANAD6AIcAAQBqAPsA7wAIAGEAwgDhAGYAOADTACEA' +
      'fABqAZQAHAEtADYBwwAvAAcAOwFGAOMAcQBJABYAWAALAAgACwAGARYA6gDDAPYAOQCzAH8B+gCHAF0B3gAxAAgAawDhAKsAEwELAYMANgC0AD' +
      'QA3gDkAJEA4wAtAdwAmADgACcAHAHoAFMARQHvAKcAhgAEAHoAGgCjAHEBdgDrACEBbgAfAY0ANgGKAAkA1QAmAEABJQEEANgASQBUAH8AFgAj' +
      'AFgAWgAcACIBRgCUAB4AWgBtAekA3wCXABUAJwCoAOIAywAeADMBdAE0AN0AVABeAbQAXwEnAMAAUgG1ACcAOwAwABEBKwBxASkA4QD3AP4Ahw' +
      'BaACEAhwAMAB4AXQDMAHsAfAESADEADAF0AQ4BPAGoAEYAwgATANwAxAABAJkA8gDOAIUAXQEeAPUAvwCfACMAhgAbAYwBJgCKADUBNQEaACoB' +
      'IQAhABwBJwCVAGAAGQHNAEoBYQD3AIcAFgDCADwA2wCIADEAogAQAY8AawArACIAMgHcAGAAZgCsAGsA+AD8AA8AjAGpAH8BfwFsAFwA+ADhAD' +
      'MBcQEbAYgA3gA7AJsANQGHAPYAFAA9AXoAdwEfAHIATQHQAOAA/gD7AHkAJwCTACQAngBlADMAQAE9ADsArwAsAVQAjwBTAd0AxADQAGEAUwC3' +
      'AMIAPAAiADgAcwGrACEBqwBJALQAiAD9APYA3wBSACsAVQAhABkBAwFSARUAKABGAYoABAD2AOoAbQAaAJoAKQDAAOQAMgHcAA4APQA8AFMBkw' +
      'AsAZYANwA5AQoBVwDsADsAAgE7AEYABQErACQBXABgATcBZgA5ATkBVgArADoB2QAKAYgArABUAFkAJgDsAFgANQA1ALMAjgB6AO0AVwD1AAEA' +
      'egAaABoAggBBAXsAGQAHAGgAZQAGAUUBLAAaAJUAcgFmACYAZAEwADAAlwBsAJcAWADNAFkA6AA2AEMAbAAzAS0AEAAxAHMAawCOAEUBLAFhAM' +
      'AAZgCBAXkABwBDAIkBhwB9AK4AAAFLAMAA+wAtAHEAcwBcASYADQFgAWQB6wDrAF0BJwBrAMYAMABhALAAEgBsAAIBNAAWANAAEQH2AL4AJgAP' +
      'AS0A3gC5ABABjQE0ABYAUAAWABYAnQCUACcA/QCtACIAOwA7AIMBOQGHAGEANQHfALQA9gDAADMAeQGoACQAhQAAAY0BSQD1AEUBegDTAJQAMw' +
      'A1AV0B7ADAABYBVABUAPUAVAAQAXoA7AAmARcBKwA/AYEBYQCrAOQA0wC+AJoA9QBPAN8AOAEzAKMArwANAWYAWAAQATMASwA7AFcAVwAmAJkA' +
      'cwBzAB8BAwAdAA4AAQC9AH0AngCLAFoATAGjACQBCwE4AJwAqgDFAM0AvgBcACIAigCfAGYACwGYACEAcABuAAwAmgACAbQAnwBmAG4AbQBGAK' +
      'QAgQCjAG4AAQB9AAoAGwEeAI4ABABiAM0AbgBmADIAhQAGAAsBSQCRAEMAkQBaAIoAmAA2AEkAWQChABgBAQBmAPsAZgAtAAEAbQCkADMAzQDN' +
      'AI8AUQAEAAQA6gD9AGYA6gA+AdoAngCeABABDAAQATEASgDxAFkATAA9AGEATAAMAMQAZgCGAGIASgByAJoAQAA2AFMBqQChAC0AqQDzAC0AGQ' +
      'CQAC0ALQBrACwALQBcAPMALgCLACsAbwE4ABMAjAAdACYBQgAEAKkATQDDAIwAEgAeATYAiwAOATIAMgCdANQApQABAB4BOwGHAAAAAQAEADsA' +
      'hAAEAYQAqQDGAF8ADAA4ACYAJgAmAJQAbAEwACEAOwABAWEAuACZAJ8AZQE1AX0ABwAPAYoAnwArABMAFAGFABMAYwALAQsBTwHuADgAXgDbAE' +
      'cBcQCeACcAagHxAD0AiwBFAFcAgQAOAbUA1QCJAGsAPQABAEcAkAAeAHEAiwDfAHAANACFAPUAFQC5AOwADgFMAcQAfwDuAEUAJgGnADkBzgCf' +
      'ANUApQDcABMAEwAMANoAAQBNAJ0AgQCPABgAkQAVAEcBoAAWAXoAFAG4AIAAEwDyAPIADgFdAJ8AZgByADsAcgAFAHwAewAeAA4ASACOAc0AFg' +
      'BeAJUABwAHANMACAB6AGoBoABHAPEA8QALAFYAVgA4AAgAlQBFAJgACADdAC0AIwGgAHMAMgBHAPsAnQBHAOsABAAyAFcAWgABADsAvwAIACwA' +
      'HAAaAGMAzQD1ANoADgEwAQEABgBeAJUAnwALAV0AFgDsACkBMQBJAOsATQDMAIcAdgG/AIUA7gCIAFUAcwC1AGYAKgFFAD8BgQAEAEUAHgAzAJ' +
      'EAJgAmAIMA9QBhAEUAaQBpABcAnQAJAJUAsQAHAA4BKgBZAHoA3wAyADUALABPAUcAAQAmAPIAfgAWABYAMwDfAHwAzQDaAHAApQBFAAEASAC5' +
      'AHAAZgCxADIAHgCRABYAUABJABEBmQCIAHMAMwCYABQBSgFZAB4AlADAAEcA+AAWAUsA5ABPAI4BkwAeAC4ALQEtAaEAFgAwARYAPQCqAEkAZA' +
      'FkAfEABQFoAWcBqAAjAf8AnwCVAEAAEQCJAKQALQEdAO0A4QCeADYAfwDaAKEAqAB1AbgAdwHEAD4BPgHjALUA8gBjAE8BgAAmAAQA7ADcAGMA' +
      'fAA+AbMAEQEWAWkAAAAxADkB6AA8AC4ASQAAAC4AbwAvAHMAbgBuAN4AMwBXACYAIQCkAJIAGgCmAFIAUABCAbcAVAAMAH0AOADCAPsAmQCEAD' +
      'gA5wAzALkA6QArAW8AOwE5AIoACQBIAZoAAQCcAL0AKQEBAAQASQAhAbgAJwANAAgAuwAhAEgBhQD5ADwBGQD3AG8B2wDbACcAGAA9AYgAegBc' +
      'AO4AXwFJACwBkAB4AS4ADwDlAJ4A5QAmAIYAcgCsACYATQASABIAYwBHAYsAiQABADYAzABHAD0AIwBKAJAAxACIACwASwHQACYBpQBSATsAFw' +
      'BeACwB8QBJAAEBigAzAMAAhwAaAOUAUwEoAKkAzQB6ANIAQQAPAUcAOwBEAM0ATABMAKwAsQA5AQEAFgAWABMARgCkADkAAQB/ABUAnQA1AaoA' +
      'JACEACUAfgCmAIUANgC0AMEAfQAEACABfAFNADsB5QBWAAYAHQBwAFcAOQA8AMwArQCuAIoASgE8AMIAMACcAAsAIQACATYAhwAvAG4AGwE3AC' +
      '4ApAAeAccA+wAZAC4A2wATAEQAwgCIABoAIQATADsAHgEmATMA+AD7AAEB2QCpADsAFgEYAMAAAAAzABABrgBJAJkAigEEAJgABAAzAAEASADE' +
      'ADMAYAEiAboAFQBvAM0AtABvABUA5wAPAAEApgCfAC4AhwAjAVsAWwAdAD4AvQADALMAqQATAUAAhQCqAGAAOwATACIAeABPADYAJwBoAFcAQA' +
      'HRADEAFAFQAL8AvwDjAAEALQDSADsAEgF8AB8AHwBdATQAIQBRAG4A4AAMAEIBAADsACcAHgGpACMAeQHEAA0BBABDACwBVwAKAXIBmQBVAFIA' +
      'mADbAGoAIgEyAGwA6AA2AEsBfABYAEcAPgEeASgABACPANMAfQDWABwAFABqAB0AJgH6ABYB4QByAYoADgEcAQEBAgGcAKQAigAHAOcAOwBvAN' +
      'sAMAGHAF0BCAD+AEwAuAAmAM0AwwCAATsBawCJAOUAEQE4ADMAMwBKAGsA7ABVADQAqABhAGoBLQBJACsAhAAxADIAMwD9AAYAdQBAATsAuwBt' +
      'AIcALQB/ADMABAAVAHYAFwBUAA0ABAAEAOkAIAArAGYB2gDYAPoA+gDVANwAGgABASYAMwDhAAwADACcANMAGACTACEBYwCKADMBhAAaAKkABA' +
      'D3AB4ADAC3AAEAjwFvAOAA5gAEAC0ANgAbAbsAdAF0AaUAKQCJAIkAmADrAJ0ACABSAcAARQAnAAEADwA0ADQA8QDUABwAUwE7AG4BIwA0ANsA' +
      'ZgAtAOcA/QDhAAIAXACBAIMALAGHAFcARwApAVQA3gBXAKMA5AA7ALcAAAA2ADAB4QD7AAEAOQCPAW4AFgA2ADEAMQDzAEwA3AAHAAEAcABHAB' +
      '4AHgAqAIcA7gAMAKoAPACGAPAApACIAFIBnwDvAIUANQEeAOgAlQBdACcAXQAZACgAYQA5ACYAhwBpAE0AXADSAD0AbQDmAGoAzAAMAB0AJgHl' +
      'APcADgGFAMQA8ABKASYAJwAWAFwAjgAMACgBMQAmAYoAJgAnACoBFADsAHwB8gAyAT8AtwBIAFgBEwAOAN8AEAGPAAwAmADDADQAcABcAKQAYQ' +
      'BMAAEAqQA2AP4AvgA+AfgAnACHADQAeQCIAMQA+gBSAPcA5wC1ANYATACIACcA8gB9ANoAPABUAPkAfwH3AGEA+AATADsAlgCPAGoAHgH4AJMA' +
      '/ADqABkA8QB5ABsBRwCcAAQAPQE9AX8BJABAASIA7gCjAJABJgB3AawA4ABTAcIAVACyACYBnwAhAT0BLQA5AEMAhQCjAEwAugAjAd4AFgH9AC' +
      '4AHwBHACYAbQCVAPgAVABSAQ4ADgA3ASwBBACPAZYA4QAdAD0ACgE9AF0BVwBGAAEAPQFkAFcAVwBkAQUBcgCKAHIBPwA+AZgAFwAzAJIA6wAF' +
      'AIQAfAApAHEA1gAAAcAAHAC+ADIBgADWABsBXAAaANkAwAAhAFYAPABJAAkABQE5AX0BhQC4AOEALgBSAEcAtwBoAIcAFwAmAB4AUwFRAOwAWw' +
      'CZADsAQwAjARcAcwBJACwBVwDEAAYBLQH7AEcA7gCjAD4AfQA5ATgAQwB5ASwAHgFDAHoAkQGEAKkAOQBZAF4AUQHLABoAkwARATQAGgDWAFgA' +
      'WADfAJUAJgD+AEgAOQCtAEsBLgB8AGgBiQASASABaABUAJwAHgGzAD0BXABHAPEA5wD1ACYASgAyAMAAegDPAPcAeQBJAAoB3wAsAMgAQABHAJ' +
      'UA+wAjAQ4BGgB9ADQAIwEBAGsAcwAeAAABKACVAA0BJgBfAGwAQQAaAFwAiQFXACYAJwBMAOsA6gCHAFMB3gABANkA5QCrACwAMwDCABEBQABA' +
      'AQ8BDQAEADcB/QCUACYAVACdAK0AAQA9AYcAQACQAesAHgAEAL4ApQBXAO4AJgBdAEwBBwFcACIADQAdADsA8gBUAAABAAGCAMAAMwCBAcMATQ' +
      'GVAPQAwwA7AD0BKQH3ADMA2gAuAPYAbQAKAVwA6wAuAMAAHgAzAC4AmABYANAA1gCyAEYADAAWATUBQwB6AFcANADNAH8A7ACHAEAAHQDsAEgA' +
      'yABsACsAEAE0AEkBqwAxABcAtwChAHcAIQAMAOQAMwCBAU8ADQGhAB4AEAEQAS4AAAEzAC8ASwAMAH8AKQBUAKYAXQGQAAwADABUAPQAnwCAAF' +
      'wABAAqAQEAWABHAJ8AqgAMAMYAPgGAAXcBRwCRAAQABACSAZoAawCAAboAgAG6ACoAUgAiAUAAkABhAAwAVADNABYAIgA4AN8AcgD0AD0AqABd' +
      'AZ8AVAFHAM0AnwBHAPsAbQBcAAEA0AAMAFwBXQE7AFoApgALADgABAALAAsAVwE0AFQAOwBgAZoAYAElAF8AXwAzAHEADAAzAFcAfgDQABkAhw' +
      'BWAI8AOQGIADkBzwCFAN0A8QB+AAUAnwCZAEkA/wAyAAQBJQEUANYA6wBeAG0AAQBQATsAFgD/ANUAMAAmAEoBxABeAI8ADwD9AKgAcgAFAEAA' +
      'mgAhAF0AgQEBADAAKQEKAW0A/QApAYcAhwBJAPQA8wAuAEAA6wABAFIAQwAbAYgAmQCjAJUAlQCcAEMAJgABAPQAlQDzAAEAzQA4ACkAaQAmAS' +
      'YBkQAnACkBDACkAKQApAASABIApAArAE0ARQDpAKQAEwFMAKkADAFpADkAmQBbAPgAegA0AGkARQAUAEoAUgDfAIwANABuAJYApAAKAAoATQAM' +
      'AUkASQA5AKoAhwB5AAoAwwBpAE0AfAD4AIEAcwDAAKkAcQGpABEBwAChAEoBEwCKAAsBWABIAQQANQA3AAQA3gB6ACoAiQCFAB0BHQE2AHAAGA' +
      'DrAAQAQABHAGcAhQC/ACMAGwHrACMAGAAwAMMA6wCFAF4AXgCCAYIBWgAVAK4ADQGCAT8AnQBPAYQAVwBqADsAFAD9AHEADQCBAZUAjQAHAMIA' +
      'LQAqAAgAhABlAEcAOQBIARQABAD7AFgBBwBUADgAOACZABkAUAC9AAoBmgA4ABwBIQCTADsAOwBUAL4AnABjADIAMgBLAdMAewAPAQ8BJgDOAM' +
      '4AfQCPACUAiwAYAVgAPQB4AQQAiQCfAJ8AawABAIYAXgD3AG8BHgBwAJgAMAAdAI4APQCUAAQAaQB1ASYBeQANAL4AGQF7AKQAUgA7AIwAJABu' +
      'AUIBrADYACYBcQAoAPQAMwB2AHcAKAAxAD0AOQEmAUkANABCATkAOQBuAKoAMwC+AAEAPgDaAB0A3QA7AKUAnACpAB4AGQAUAcoANABhABQAAQ' +
      'BMACUAtwBsAJUAvgDoAHEAXAA/AB0AnAB7AH0APgBNABkAPQDhAKYAhAA7ANYArQAaAH8ALwFsAAQAGQCdADQALQEuAPEAAAEOAVgANgAkAAsB' +
      'DwGFACYArgApAKIAUQAWAcAAMADkAGEATAFxADIAQAAkACcAFgCVAJUAeAAaAEAAMQDJAIcAhQATARkAJgBbALkANgCCAGABOwBAADgARwADAC' +
      '4ACgHkAOQAvwAYAAEAGQAAAQEAvgC3AHIATAExAM0AYQB7AJ8AdwEUAUABEQA0AFsAoABQAEEAmQAYATsA0QBdAbUAlACvACUB2AA4AKEAHgEB' +
      'AEwAMgBUAAoBZgDEABMALQDFAD4AlQAmAB4BKwDVAD0AyACZAHIAEwEUADEAVgDTAAcA+gBIAS0AHQBHAGwASgBdAXsAAQBzAOwAEAFFAD4BBw' +
      'AzADABNgA4AG0A7gAoAAEADAB8ALMAZwByAEwAGQHKACYBXwAaAIwAegBwABwBagFBAEYABwAyAM0AqwBFARwBrgDNAHoAagDQANYATwHjAHAB' +
      'qAAzAIIBGQAAAYIBQAEpAbMAuwBtADEAhgBeAF0BigBoAJEBhwAJAGABNgApALkAHwGKASMAXAEJABYA4gCGAAcAOQAYAKoAhgA0AKsAHADVAH' +
      'kALQCjABEAZgHjAOcARwDNAAQAnABSAR4ALACTAKAA4QBFAIEASQAEAIsAOwDAAEEBNABAARcAAAFWAOEA2gDlAN0AEgAwAAwAnQAMAMAAfQC+' +
      'ADIAfwB2AEAAlgChALIADABFAXAA2QDuAD0A9wC7ANUA6wAeAFQA3QA8ATsAQABsAOgA9wCPAIYB2gDrAPcAGwEmAKsA9wBgAcAA5wApAQEAhw' +
      'ANANgARwAMAPcAcABwAHwBXQEuAIcAdgEMABQAagChACkBKAA8AGwAhgCGAIoAMQCPAFAAYQDFADEAqgAhAR4AewAOAb4AGwFNAOwAHgAdAHsA' +
      'PAHxACYBeADVADcAVwCaANAA2AAmAW0ABAAEACYB3QAoATEA/wA3AQ0AlQBMAZ8AJgBUAYcAhwA9ACgASAABAEAAqQATACcAxADyAN8ADACkAA' +
      'sBEwAcAfEArgA0ABgANwEUABQAFAAeAJMAFgGUAPcAzACeAB0AtwByARwAKwB6AO4ARgDnAAgAEwAFAewANQFdACgAhwCfADIBMQAOAGwA7ABM' +
      'AXIAHgCTAPcAVQD3AG0AiAARAScBGgAbAQ8BZQCvAB4BrABxAbUAPAATAAEAdgD5AHMAMQAzAHgAOABHAI8AUwFxABMA1gCRAMQA9gBeAJIAQA' +
      'D4ANUA1gBVAJ0AeQATAFAAkQAkAFwAXABCAD8BdwBNASIAowBFAPIABADnAIoAOwC5ADYAJwAsASIA5wBAARUBXwCkAGYAlQAgAEAAcQAWATsA' +
      'HgCrAAUB7ADuAMMAEAFPAIgA/QDfAAwAkgA9AKQA2QA7AAoBJAFwAAUAigC+AAIBwAA9AD0AHQArAIQArgAgAAUB6wAMAAQBJgAjAIAABABHAC' +
      'YAwAAyARYBcgBSARcAMgE7AA4AUwEzAB4AZAFmABcA7gA3AfQAFQEWAEcAvgCTADkBBQAHAG0AEAGvAJoAfQAoAA4BAQAFAecASAFkAOQA4QBJ' +
      'AAkACQAZAZ8AXQGUAIcAHgBJAVkAlgCoAIUACgEXAOwAewCSAEkAKQDsAM0AFwBqAZ8AbQA7ADEAEgAMAGYATAENAZUAJwA4AF8BJgAkADEA1g' +
      'BUAFQARwDAAEcAmQCOAPIACwGRAdYAWQDEABcAAQA7AAgA3wDfAIAAmQBdABYAOwEcAS4ACgBhAaQA+wArACsASQB8AHMALAAxAGABYAEaAMoA' +
      'GgAsAWYAswCXAH0AKwEyABkASQDhAAcAXgAeAXsANgBFAKoAegCHAPsARwACAcAAEAGtAAwALAANAAEBDQFdAXEAYQAMADMAEwBRAH8ACADnAK' +
      '4AxgD/AG0AowAWAAIBXQHEACsABQF9ADAAAQBfABIANAB5AGsAJgAtAG0AyABSAXIAVAFgASYAXwCVAFwAeQDlAAIAYAEuALsA/QBtAL4AEwBJ' +
      'AL4ArQDsAOwAEQFyAAQApAAmAEUAUACWAIYAQAFAAEAAGgGmAD0A6wAQAdMAkQBzAC0AMQD9AJwAVADsAP0AgwHaAHcAOgCHADEA5AD1AMMAMw' +
      'AdAIUAwAAZADsA7AApAWMAlQBhACQAcADZACsAOQEeAYcAcwBgARoAnAD9AJQAegDAAGsABwDsAPgAMwAyAM0A7ABfADEAYQCyAFEALgAWAbsA' +
      'GgGEAD0AuwBJAG0A7AC+ACYAbQAGAewAiQAsAAEAhwAtASsAfgAXAYcAEAGEAEkB9wAtACgAqwAAARABFwChAK4AVAA+ACkAWAAeAEUA7ACCAP' +
      'UATwAeADMAvgD7AN8ADQFmACsA7ABFAC8ALgAQARABSwAIAE8AmQB6AB4AfQAeAAwAlACUAE0B0QAHAZUAzQDNAJUAewB/AAEBEAAhADwAYQCa' +
      'AC0AeAB4AP8AhQAEACUAiQB4AcoAjwBzAAEAwADgABIAKgEkAB4AHgBCAGkAgABZAPwAZACOANEAkAA7ANEA0QAxAFMBzgBlAAYAWgAuABsBpQ' +
      'A2AC8AYQBhAH8ALQAOATQA3wAvAcoALwEPAQ8BFQCFAHwA+wAuADwAowAxABMAbQCaAPIAoAA9AHcBEAFqAGYAnwBoALcAEwFdAYUAzQCSAHoA' +
      'QAA4AKAAiAATADEAfABNAXgAKgF7ALMABgAuAA4BWgBMAR4AlQDRAJcAlQADADQAhAA7ARYAlQAAAJMAcgCGARMBRwA2AMoAYQBzAGoALQBqAA' +
      'gAZwDhAD4BHgCfACgAmgD4AD0ARwBJAKoA1QADAOMAzQBHAB4ABwByAdMAigBhACYAOAAeAMMABwAeAF0BgwA0AEAB2wCJACwAagHVAE8BRwCW' +
      'ADgAewCAADYAhgBmANwAKABBABIB7wBHABIBkACAAB4AHgABAFgADAAhASABEgAYASEB8QCBADsBGAFFATABoQCYAKoAXQAlAPMABgCVACgAbQ' +
      'AOAbkA8gBmAIcApADsAC4AMQA3AVQARwAOAXYBKwAeAMoAygAMACYBUgAxABYAcgASAXwBJgFdAZ8ApQAxAIQAFABfAIUAEwEuACcAAQEiAbEA' +
      'PQBeAMwAEwCUAM4ArADLAJMAgAD7AHMBbADyAGEARwA4AEcAXgCqAKoARwBeABgBGAH7ABIBiACZAL4AbQDsADgA+AC9AB4AUwEeAUcApADZAB' +
      'cAwACHAEkAAQAyASgAlgABABUBWADcAF4APQABADsAAgExAB4BBwD0AIYBygAFAWoBBQCBAWgBhwBHAEcARwABAM0AmgDyACsAFgDfACABHgCZ' +
      'AEMA0wAHAY4AcABmAIkAGQBZAAwALAB8ADsBiQCEAB4AmQAQASYBkwABAMoAgwAuAGYA7AAMAAEAUQAQAQ8BAQH/AF8ARwD8ANwAbQCVAC4AYQ' +
      'B/ADEAAQBhAKUAlQBlAMgAEAGfAHoAqgCZAHIADwDeAIgAqgAQAdkA+AAzADkBsQDvAMMANQECAZkAFAF3AVkAMwDAAFgAWQAeAEcAYQAWARYA' +
      '/wAXAS0BEAEXAFgAGQEpAKEAlwC+AJMAEAEuABABfwCBAQwAiQGlAF8BWgAvARoA9wCRADEABwBYAFgANgAWAC8ASgEWAIgA1ABJAVsAJAADAR' +
      'sBQwFKAVMBrgBTAfAAngAkAIAAhwDYACkBAwEMADwAzgBKAfoAbAADAR0AHQApASMAGgB4AXgBWAEhAGkAeQBpALMAbwBIAYsATQBpACEBOAAe' +
      'ACIA2wAZAIcAnAAdABsB8QBpAIoAVAC3ALcA5wCEAUcASAE6AVQAOACcAEcAMwAzADYBJgAhAYQB6AC3AO4AKQE0AEwAhwAoAPAAGwE0AAMAXA' +
      'BHANsA5AAnAPkACgAxAE0AjgB8AEMACgFHADMAKQETAdgABAGxAEcADwAxAF0ADwC3ALcALwCEABQAJgDHAC0AvwAiAHIB0QD5AB0AZACMAMkA' +
      'IwBAAIQAcgFeABQBeAGKABQBJQBpANsAEgA0AAEAuQAvAQYAOQA9AH8A2gASAJ0AiAAdAKwAUQA0ADAAbADSAHoArQBdAbYAZgCqAKUAJwCZAP' +
      'sAeQD4AB8BfACzACkBBgATAMYAWgAMAH8BDACkAEgBRwDjADMABgBAAEQBPgHbADsAHgBSADMABwB6ADIA2ADaAM0AtAAEAJ0A2QBAALsAEwGH' +
      'AFMBagEeAFIB3AC+AIEAAQA7AFoAIwARAekAzwCrABMBAADkAD0A3ABXADEAKACGAPcAuQAuAE0AMQAqAHoANwEjAEEBqgBMAMkAzgAdAB0AJg' +
      'HCAIgAfwFsALUALAH3APYA+QBdAX4ADAATAEUAUwEBAMQAdwBFAAUBMgAKATkBCQArAAIBAgFFAJYAiQBYAKQApADyAHMALACfAHwAiABZAHcB' +
      'zQAfAY4AZgAiAOMAKQGVAMYAegBhAHkAegCZAK0AzgCUAJABEQETAUEB0QAfAcAAeQB6AL4AFwFdAUEB5AB6AAQAWAAOATwB5wDDAMAADADWAG' +
      'MAFABlAQIAPwAvACYAewCKACoAfQAhAAwABAAMAIUA+QB7ADgANgALAScAIwD9AM4A+gAtAVgAgwBYAAgAhwAmATAAWAExAF0BegBTAX8AfgAB' +
      'AL8AQQCjADYADgFHAGwApgCsAEwAOwFMAaYAGwEgAfEAcAABANQATAALAfsAHgGkAMQAxABYAD4AFgFyAGYAhwAzANEAegCgAL0AHgCSAIUAnw' +
      'DkANYALgBrAEAAmQCxAFsASACIAAYAaABXABkBnwCeAIwAswANAewAlQCPANAAGgCKADgAOAAaANMAJgHbAGoAegBcAAcADgEeABQADgE+ATMA' +
      'kgA2AB4BIwBHAH8AMwByAG0AVQBVACgACACjABUAqQCWAAsBDAA0AJgAuwALAfEADADdAFwALQCiABoAPQAEANAAagGBAAQAogAIAMAAFwApAB' +
      '4AjQDbACwAawASAF8B/AAtAGsAPgByABIBKQEnANUADABNACYB7gAOAagAuQB+AHwBCwGHADEA7QBdAWEAKgCHABAAgQBtALcABgDzAPcAFgBB' +
      'AT0A7AAMAPIASwFgAR4BEwD4AFUAiACPADgAxAByAOwA+QBAAR4BkwAzAD4BVwDdAFMBMwFYAKUAiACRAP0AHAGBAGoBEAAXAHIAAQCWABcABA' +
      'AzADIAAQEUAA4BAgFtAIMACQBAABYA7AA7AMAAOAAHAZIAaAGZAKEADQEsAFkAWADWAPIAVwBzADIAhAByAB4BJgCVADIAkQCkAP8AoQABAQ0B' +
      'ZgApAN8AlQBdAWABXwDdAFwADAByAMAA/QBJAI8AIwEQAUcAJgAOAe0AhgAOAAABKQEzADsAfAEzAPUAEgGoAFcAXwA1ARYBwAAzAPUAEAHsAL' +
      '4ASAASASkA3gD1AF0BIgFsAEoBbAA9ADsABAGeABcBMwCvAAAASAAAAJ4AVAGLADAAPwH0AAAAAAAAAD0AfwABAEEApgAAAOMAgQCaAAAADQGv' +
      'AAsAbgFBAM4AoADEAAAApgDsAAQAegAyAYoA9AARARAAogAsAGgBOAASADAAPwHsAB4AfQB+AHAA3QDdAAcAgQDxAOsAcAArACsASwHxANYAcA' +
      'CuAEYBwAA2AK4AogCiAK0A3QAdAEwAcAAdAKMANgDMAKMAQQBqACwBagDEAHgAEQGkAKQAaQCZAB4BgQBpAF4AhAA2ADAB3QAnACcAtwAxADYA' +
      '3QBpAG4AJAAKAa8AZQDMAB4B6ADEAFwAaQBpAMUAeAAOAKQAZQA7AG0BBABtAYQAAQCEACwBqwCrAGkA0wABAB4BqwBKAQ8ALAENAW4BJgAIAA' +
      'oBGgCBADcBAAEmAMIAHgFKATcBLAAKAQoBDwASAEoBSgESACcAMABJAEkAigABAFUBNwACAKQAJwBZACEBIgAhAKAABgD7AJ8AewEzAIUAmAAd' +
      'AC8AJwBYAAQAIwCWAKQAAQAzANwAAwEoAC4ALwESAH0AGwGmAFEAOwAwAMQAPgA7ABUBNAAmANoArAD7AEwADgE8ABUARgBaAK4AMgC3ABUBfA' +
      'ABACcAMQCVAN8AhQCaADsAtgAjACYBSgAyAM0AfAAcAUgBEgDNAEQBcwAzADsAMwFuADgAUgCzAB8BXQF6AAEAogAJACkA3wDaAPkA+QCaACYA' +
      '3QC/AJoApACkAAsBnAAaARsBMQAMAJYAIwAuAM8AMABwACUAOwAMAMkAKAA1AYUAmAAcAQwAUgGPAF0B0gBMAEAAAQAyAXEBWACaAEcAKQABAI' +
      '8AJgADAZ4AAAEeAccAHwF7AaMAZQAuAd8ACQDZAHAAzwDkAAEA3AAPAAkA6gD2AGAB/ACNADIBMgE5AWsAQADsAPIANgBZABYBQwAeAbMAegDa' +
      'ADAAQACqAJEAngB6ACkAVwDIAAwAMQABAK4AEgAAATMASQAwACwAowAsALsALgEmAJoAhQAOAScAWgARATMAlAC7ACYAowAOAewAQAChAK4A3w' +
      'CjAOQATwBPAGwAbABXAC8APgAHAT4AtAC0AC4BJgABAQEBTQBmAV8BJwDyAFcApgB/AD0BOQEmAGYA4QA9AZEA0ABFAAcApAAIAA8AVABHAJEA' +
      'zQBFAPIARQBxAJYARQDNABYATAFFAGYAkQC5APIAMwAEAaoAZgASAH0ALwGgANMAFAArAfwAPACcANMA0wCgADwAnAClACkBCwEEAOwADADbAI' +
      '0AJQBUAaoA7ACqAAEAbAAIAKoARwGpAB4AhwCqAAwAXQCEAA4A3gAkADYAFADxAN4AwACpABEBMwByAJ8AhwAkACkAvwDAAJ8AoAANAb8AnAAz' +
      'AGkAAgB9AJ8ASAFIATsABAD3AN0ASACOAJAARwAkACgAjgALAbUA8QATAF4ADQAkAIsAPAEwACYBTQC6AHoAJAETAOwAWgCIAHAAlABlAMQAFA' +
      'E0AHAAAQDxACYBOQEuAMQAxAANABMA9wBKAZ0A5wDnAIAAPAAOARUAQgAWAV8AfAC+AEoBigBVAbUADgGaABQB4wDBAMQAuACFAB4AOQElADkB' +
      'VgBaACYBVQBDAAcAXQGKABoAMwHjANAADQB6AEcAagG7AIcA+wDdACAACADmABMAEgEzACMAMgBaADMAuwBfAOMAggFfACkBpAASAGkA1QCdAM' +
      'AAAQAnAOkAoAAMANUA+QAGALkAlQDVAHgA7gCHACYBKQHJAA4BqABdAD0BSwFNAJ8APgCGADwBDwBXAL4APwEkAQ0BmAAbAfYABgASATkBtQAF' +
      'AYkAcQAJAAEAjQAkATkBUQEXADIBmgAFAQQBGgBXABEBCABRATUARwBDAHMALgAHAXAAUQFZAJcAhwC6ABYAUQB8ADgALABXAIcAFgCRAJUAqQ' +
      'CHAJwApQChADEADwBxAa0AmQCIAJQAEQENAFgBDQAAARQBWAAOAQ0AlADAABEBFgEpAAUBRwBcAJMAugAuAE0AcgByAAwAdwFxAFgAEwABAHAA' +
      'OwDJAHAA7AA0AKAAZgAzAfMAkQBmAGgBLQEvABMAAgAEACYA5wB9ADgAVgDSACEBRwCEABQBDQH5AFIAMABYADMANgALAdAALAFkADsABAC6AC' +
      'cAWAHQACMAEgBWAB4AXwAQAJcAjgCvAB4AcgAoAD4AOQE8ADQADADkADkAOQCKAOoAxADQADYAaQAuADUBzgCbAEEA4QB/AC8BPwBMAWwATAFw' +
      'AEIBkQAzABYBfACuADMAFAFcADoBtwAuABQBVwDQAEEBJQHAAJUAkQAiAEAAuQAeABgA4QBHALMAvQB3AQYAQwDrADEAQwAAADoBzQD8ACsAPg' +
      'F7AAwAzQAGAEgB5ACuAJcAlwCGAB4B7ABIAfwAHgBSAGoBDAAAACwBwACYAIcAewHlAC0AOgHhAB4AbgHiABoABADcAOsALADTAGwAAgDVAI0A' +
      'hwCqAMAAkQBfAPwA5gDbAEAAGgE4AAQAdgAIAKMAQQHbAAQAmADtAB4ASgECAKAAOQAnAOwAzgAbAaQAMQB3AcQA8wAGAA0BqABBAeEAhwCKAN' +
      '8AwgDdAAQAjgAoAA4B/ABDAPkAvQBFAdYA0ACmAB4BGQCTAPoALAESADEAHwAAATMB3QAGAEcAbQAkADEAXgAaAVYAGwE1ARAAiAAgABAAKwAE' +
      'AAIB4QAeAcAAugADAZgAQAAAAdkABAA5AQQAlgDcAOsAXAF2ACYA+wCzAKEAaAEHAYcARwAsAAIA3wDyACQAJgBDAIoAMwCHAGYARwAJAEMAjg' +
      'CHAAwAbgGqABsBcQAAAScAXAAWAPwADQEBAAoBEgASAAwAWAHQAJEAGwGHAAwA7QARAS8BpgBsAIUATQGNAXoAFAEAAQABOwAzADMAhAD8AC8B' +
      '7AAzABYBFgE5AWwASQEpAIcAjQEeABMAEwAzAHQAqwAtARkABAB5APkAYQCIAHoABAAEADsAogAaASUAbwABABMAHQA7ALgANgA2AKQA1AA7AE' +
      'QBJgGnAKEAPQAuAHAAXwCmAMcAvgDDAAwASAA4ALgABAEuAFcABgA7ACYAPQHEAD0BggFyAHAADgBqAYoA3gCUAEABBACcACkAIwF/AMAAFQBy' +
      'AN4AOwDAACsApABcAJUAHQBHAEAA5wCUAMQANgD3AJ8AegCFADsAAQAmARkAigDbAC0AxADsACYAPQGTABkA+QB5ADYADgEEAAwARwAmABkA+w' +
      'AwAFcAXwAzAMgAvgDeADMAFwEtAagA9QAAAXwBDAAMADMAYQBrAKoAHAGSABkAbwAcAecAwgB9ADsAegAVAEUBFAAUACUAiQBFAF4AGwE8ATsA' +
      'MgCkADsADAC+ANIAngASAJ0AMwAdANQAEgBsAH8AOQEaAEUBawCFAKcAOwCKAEkANADnAJQAJgAaAHwAEwCUAJQAQADnADsAJwBvACkBAQAuAJ' +
      'UAyAA2AEcAPQE+ATYAmQCCAcMAagF9ADIAqAAaABwBOwGCASMAdgDAAJwApwBvACcB+gC0ACYAOwA7AGoB5gDhABsBFQAPACMBDADWAG0BSAAB' +
      'AEcAzgAmADYAEgD+ACcAJQDcAJ8AGgDeAI8AegDnAAwAJgCfAMQAOwDeAEwAJgA9AT0BnAD4AF8A+AAmAGQAaQD7AIMAOwAmAMAA1gAmAOwAjw' +
      'AUAGABAAABAPIAEQAmAF8AzQBzAGYALQB8AKcAwABfAMgAYAGVABcB/gAMAFgBJgDLAI8AGgCUABQBwwDZAGABFwEtADMAgQFRAK8AIQASAUcA' +
      'EgHiAAwAcAAyAIgAKgAnARwBswARAOoAiADOALEAiAAVAK8A0gBmAEMAjQA4AK8AiAA7AAMBiAC4AGYAAwHKAM0AGgAkAYEBhgAwANIAGwEtAJ' +
      'QA1gApAF0ASgAtAJkAhgCvACMADAA0ABIBiACIALgAgAAMAN0AjQA0AFkARwA4AF0AAwGAAIABgAEWARoAlgBZAAEBgQFDABIBSgABARYBEQAz' +
      'AFwAEwA2AFQAXAB7AAQARQDxAIkASQA8AaEAqQAuAH8AFgEVADIAMgAJALQAGQDTAHsAfADlADIAjQABAEkAMgChACcAQQDzADMAEABnAQcBKw' +
      'FXATIAugAyAC4ALgA/AOEADACaAH0ASAEuAAgAKQEmAGYALwBEASYAawClAH8BIwBuAfcAPQBvAc0AcAGkAKQAhwABABgA+wDxAGUAigAuAFMA' +
      'mgCcADMAEQALAbEAuAAZADYAxQDoAD4AZQDnAIoAfwBxAJsANgCsAIQATAB9AIQAEwBNAEwBqACHABIBFgELAc4A5ABXAKEAmgBAAIgAegCkAB' +
      'IBgwEHAWYAcgC3AH8BUAA+ABQBLgB8ACYAZQBvAcUAJQAkAbsApACOAQ0BWgDFADYAXgAcAV8BMwA+ATQAKQCHAAcAfAAGADsAGgBEARMALgCn' +
      'AM0AOwFqAMUAHgA9AcYAfQAPABQBIQFeAFsBVADNAIcANgG7AHQB2ACkAKQAIgAPAUQADACHAKUAnACaAFoAMgBSAKAAwABsACYALABEAdMANg' +
      'A8AJwA4gBUALcA0wDgACkA9wDFANQATAFxABEAOQDkADAAzQDvAIcADgHOAH8BSAB6AEEAxAC5AD0AEwAuAC0B7gDDADgAGADNACYAJwDyALkA' +
      'JgGEACoAEADwACgALgB7ABEAyQAUADwBVACcAF0AAQAyAV4AqgCTAC0BDwA9AdoA7wBaAKwARgBUAM0AgQG9AEIAKQEzAKQALQBcAI4BmgAuAF' +
      'MBFgEQAYcACwAzAJUApACKABcAHgDhAPUAEAASAAQBSgAMAE0BNwFxAI4BUgEBAD0AKwAkAc8AQQABASYAVwDWADIBxQDAAEUBVQCBAY0AVQA/' +
      'APMALgDNAGwAvgCOAQ0BWQAwAKMANgCHAAsBXQB+AGYABwHyAH8BswD1AM0AwAATAPUABADYAAQA2AB9ADQAwADAAB4AbAANAQwBiQGsAFQAbQ' +
      'BsAKAAuwATABABXQAMAC0BRQDEAA8BqABGAA8AJgABAAQAFQEQAKAAhAD2AKAAVAAtABUBwADAAIcAOQDsAAwAuwAWAREAbQAQAVQALQElAKEA' +
      'bQDOAPMAOAEzAI4B5ADsAC0BLQAMAL4AigCEAHAAVgBwAHUBqgAAAXoA5wCdACsBCQBUAOoApACeADgAUgBkAHwBiQCkAJYAQABWAL4AeQA9AC' +
      '8AMwB9ADQATAEMAM8ARQGgAJoA1gC4ADMARwDWAHsAfADnAMUALQGgACwAcgG0ALMAiQBbAKEAqgAcAHoANgAcAP8AMgAzAC0BwAA0AAQAlgC0' +
      'AAkALADcADIAUgEsAXAAcACTAM4AfAENAMkAnwDcAD0AhwD1AKYAMwBhADYA/gDbAJwAkgA9AZMAFABMAGQBcgGTAL4ACgCJAAEBZAAKATkBCg' +
      'AKAP4ARwAcAAoBxgBsAF0BSQDcAHoA/gA3AUYAMwCnAIoARgC4ABABvgAZACEARwC9AFoAIQC9ACYAwgCgAJkALQF7AAwAqgAIAG8AjwCPABQA' +
      'UwDnAGIAeAFQASYASQDuABIAxABSAHsAOwAmAIkAXgBvADAAcgDWAIsAVQCWACEAPABZAXIANgA7AAQA5wAPAHsAPAAAAUcANgBhAHAAbAAuAK' +
      'EAfwAuADsBfQCFADYAOQDdAH4AXAATACUAegDUAMoAngChADkBSQAjARQBMgBvAG8BYQAnAC4ADwAiAbQAWAAUAT0ApgAwATABQAEnANIAZgC3' +
      'AA4A5AAOARUAegA2AJMBfAD4ALgAQAAAAWEA4wCfAA4ASgF8ABkACgFIAJUAWAA7AIcA4wCaAI8AxADDABoAFABJAPoAfADNAF0BawAwAZ8AqA' +
      'CSAGEAewBHADYAagBfABoBagE2ADIAPQA7AB4AygAoACYAnwBvANwAmABuADMAwwAyAA8AtwA7AQQABAAnASYACABUAHoAHwExAOsAQAEIACEB' +
      'YwCiAG4B6QBSAZYAdgAeAQQAqQCkAFwBfwANAAQAJgDdANwAIAB0AUcA5wC5ABwAcgDaAEsBCwEMANwAhADDAJ8A7AAFAOcAnwBIAIcAGwF6AO' +
      '0ADQAmAPMAJQCKAAsBPAH3AGEAsQAZABQAzgBdATAB3AANADEANgAxAGIArAA8AWEAbQDcAM4AXgBAAKgAIgE7AF4AGgArAH4AYQD3ANwAnwDx' +
      'ADEAMAEAAOwAcgABAG4BnQD6AJwAJACgAIcApgC3AEkBXgAGAJYARwD4AEABNgBeAMQAPQFQAD0AeAAVAXoA1gDEANwAQAHyAOkApAAoAM8AMw' +
      'BVAB4ARwDcAAABEABUAAUBOwDDADkBBAFtAL4ADgHcACYA+wBfAIQAwwCiAAEAcQHBAIgAUwHxAHoAJgDcAJIAIAEOAV8AQwBoAacAOwD7AAoA' +
      'LAA0AIQAWQBcAQYBhwB5ASsASwGSAJUALAE4AUcAUwGPAGUA8QCVAEcAYAGHAAoBXQFDABcAYQBmAKQAMAABAMgAXwABAFIAnwAmAP0AVAAQAX' +
      'MAmQA4AecA4QCIADkBAAFhADgBFAEdAJ8AAAF6ACsAZgDAACsA7ADpABcBegAjATgB5AAzAN4AEAEAAW0AGQAhAAwAewCgAHoAqgAtASYACAAU' +
      'ASYAbwAxAF4AewDuABIAUgAhAVMAbwDcAHYAiQA7AI8AiwAuAMQAeAFJAHoAfQBhADYAbQDUAHAARwA7ACUAoACeADYAXAA7AQEAMgB+APoA+A' +
      'AnANIAeQFKAW8BlQCTAQ4BCgHkAFgAZgB8ADABzQDjAJIARwBfAEABJgCoACYAnwB/AOwAnwAEANoAXAEFACAA8QAxAA0AHwGiAA8AQAEeAbcA' +
      '3ACpAAgAwwBuAecAGwFIAIcADQAQAagAPAEmAI8AlQAZAG4A8wDOAHoArABuAV0BigDDAM4ACwH3AHIANgBQAMQAKABGAT0BKwAzAAEAhwD9AA' +
      'QBBQEAAewAVQCUAXEBYQBZAPsAaAEKAVQAQwBdAWYAOAFQAWEAIQFQAfwAUAH8AGwAQQBIAKUAIQHsAOwA6wAGACkABgHfABoABAA/AewAAAHf' +
      'AMAAKQBjAGMAYwBjAAcAYwDkADYAcAA+AJwALgA0AE0AnAALASEBLwAiAagA4wA2AHAAHgClACMBIgEtAAwAOwC/AD4AEAFJABkAEgD5AB4BLw' +
      'A+ADMAgAAxAKQAJgBoARkBHgEmAOMAvgClAOQAEgAmACYATwCFAL4AUwFlACYBhQB/AB0AiQAvAD0BhQCcAFMBQwEmAX8AAQAuAIoAkgBTAQEA' +
      'egD4AGsBawFTAV0BVQB6AAEAHQBTAVQADAAwAScAkwD3AEcAhAD7AIkA+wBtAAABMAGQAVMBKwAMAHsAAQAZAT8BiQB7AJoAmgCWADYABgDoAA' +
      'EANQEBABIAfwAeATsAoQBHAGEASABHAEcAGwFDAJUAlQDNAFIAewAKAeoAlgDaAN4AUgCaAC4AhwAOAZoA8ADcAAgAlQDJAKoAqgAHAAIBBAEB' +
      'AG0AyQACASwAVAFDAAIBhAABAJUADgHeAIgAswCzAAMATQBWAAQArACsAKwASgFKAVsAMQHtAFsANwAQAAABagDnADABgABFAF4AXwESAJoAGQ' +
      'ChAEwANACUAFwAswB2ACYAkwD0ADIBkAEKAUIAPAAyASYAswCUAB0AOQGyAFsAAQACABYAZQDlAGsAXgCaADAAMAB7ADABOwAkAEYAMADEAJcA' +
      'fwBaAB0ArwBZABYBOwCtALgAWwAjAAgBUgGfAG0ARQDxABMBWAEyADQApACKAFIBjwCfAEEAFwACAJ0AagA0ABcAXQBtAF0AFwBtAD8BXQBtAG' +
      '0AFwACAfEA5QBqAF0ARgA7ADAArQARAJ0AagBqABYBDAAMAKUAGQDWAAEA1gAZAKUApQB8AQEAAAEmABQAXgFkASIAbABdAfIAmgBvAM0AUACg' +
      'APcAKQEhAfgAfQDHAIYAgQCcADsABwA2ANoAngCMAEIAhwCLACcBHQBTAEcBXgEgAb0ADACPAIgABAASAFQARwBHANoAXgEyAA8BcAAlAAkAYQ' +
      'BwADEAoABKATAA2gAvAGwAoQDdANsAIgEPAdoA2gA7AJ0AQQDnADYAQgDEAHoApwCMAEwA8QA7ALEAaQChAD0AJQGaAEAAnwCFABYBGACwAMAA' +
      'MgCbAB4AQgC8AAEA0QAOACIAGACaAGYAGAEYAVsAvwBoAPAAlQHnAFcAWgC4ADsAlgAmAWEAlgBhAE4ATgAmAGEAaQHGAIIAQwEEAEEBvgDIAE' +
      '8ACABsAI8ACACSAGYAMgB8AWgAMwETAfsAagAmAe4AcABMAGYBIwHPAJIAkAA5AC8BGgAdAXMASgA5AH0BQQESAJwA5AAzAG0ACQCWACcAHACC' +
      'ARIA2QB2APAAUgHjAOAAMADdAB0BMgA3ADUBFgAeAG8AcABuATYANgA0ANoAUwEIABgAEgBSAdwAAgCGACYB7QAQAJoAKAHkAPQAigC/ALkAQQ' +
      'FJAIoBzABeACUAfAHQAAwBHAGIAIcAMQBmAAwATADzAKQAgQA2AHoAnQANAK8AFQHLAPoAVADDAK8AHwGTANYAbgEiAAEAbABZACYAEgBhAD0B' +
      'wwD9APQAgQDAAFIBQgCMAdkACgE2AJMAOQFHABAAwwBmAOwAwwA7AFEAKwEsAHwA4QCdAIwBWQCWAF0AzQAVAYQAOwBmAPsAOACWAJEBSABfAI' +
      'kA7AD7AIkBMADGAMgATwFtAKQArgBYAFwAAQDjADUBbQBxAU8BnAAEAJYA/QCZAEEBhgBDAXoA2QC5AIABNQEeAMAAlABCAeQAoQBDAU8AnQBC' +
      'AZgAVACGANEAQwEsANEA5wBmAEYADwAmAD0BDwANAEYAOwA7ACIAhwBKATsAkgAPAcQAIQB6AAwAwgCIAAwAGQFHAEcAIQAMAAwAuQA0ACEAkA' +
      'CrAKsAqwAhABMA3wBJABMA3QDfAHMAcwApACwB3QAqAFEBBgA4AKAA3gAqAPsAAQCEAF8BDwGEAJ4AKgBvAYsAngCkAMAAJQCHAHcAfwAuAHEA' +
      'bgBsAHoAIgAqAAYAwAASAUIARwC8ADYAAQEoADMAOwEMAD4BagAMADEAbAARAUUBNADyAB8BGwHOAGkASgHeAPoAwgABAPYAdwBkATIBfgBRAI' +
      'gAGQEHAQ0BUwHAAAEAJgCHAJQAEQEEAMAAwAArAEkBYAAcAIcAhwBgAR4ANgBBAB4AHgBkAQIBAQA/AAIAZgCRADcAuAAUACcA4QAIAAEAxwAN' +
      'AL4AfQBUAAwADAA7ARgBKQE9AAQASAHnAJUAXwA7AEgAEgA2AE8BMQA4ADsABAD7AI8AVABvADYAJAEnAMAAnwAmAGsABAD3AIkALwBLAZAAJg' +
      'AsAXYAiwA4AFgArAA7AF4AawACAVwATQAjANoAdABvARcAKwAdAM4AAQARADEAMwASANAAegCBAHcALgDWAIoA9wAgAX8ADwG4AIoAPAHrADMA' +
      'rgAbAWkA2wCxAKwACwEBAAEANAA1AO8A0gAuAJ0AXwEVAPsAkgCIAHoA6AB7AOwAPAAYADQASgFGAH0APQBBACYBNgDxAJwApAAxADYALQBNAI' +
      'QAEQBNAE0ALwDnADkB5wA7AJoAJgAyABYBFwB9AfcAUQDsABIBIgC1ADMA+ABAAGAAVADHAJgADABFAOcAEwE4ACYAVwCmAIcApgDJANEASAHC' +
      'AGYAZgA2AAwALgDnAAoBlQBAAMIAPgD4AFAAGQFIAXwAJQBUAC4AmQBdATYAtwAOAGUAMgC5ACoAZAEyAFsAvwBDAJoAbwCHAAEA8gBBADMAcg' +
      'CzAEkAcgFlAEwAeQGkAMUAQwCVAAQADQHnAPgA1QDsAOQA7ABUAHIAfwFAAE4AewCgAIgAKQExADMASgA2AG8AQACqAKQACwBeAIoAHAFfAF8A' +
      'GgCYADgALgFHADABMwBzAC4AOQEzAHIBpwA5ABQAUgBVAJgA4QA0ACYBEQG5ADIAlwBwANMAHgBqAB0AMwEIAAcAHQAzAUwAYwAdAHgBOwF6AD' +
      '4BBAHQADkBjwAnAMwAaQC6ALsAbQATAIYAHAF6AJQAHQDsAOwAAADuAEgBSAGmAAgAMgCKAKEAGACHAHQBnAA1AcAANAAxANMARgBqAaoAcwDn' +
      'AD0BUgE2AHYAgQAPAOUA4ACpAIMA6QAvADMAHAFsAAcAsQBrAOMARwBrAIoAJwBzAA0BcgBDAA8BMAEsAZwAfwDaAGsAvwBjAKIAoAAeANQAhw' +
      'AsAN8ASQDdAN4APQAEAKoAlgBAAe4ApACBAF0B2gC7AAQAEQFBADEAMABSAF0BHgABALgABAAIAMUANwDEADkAIQAIAeQApAABACQAbAAvAQIA' +
      '7ADsAOwAzQCCABQAGwFIAAgADAAMADYAbQAOAQ4BzADFAIYA7gA7AQwAzgBNAL8A0ADkAOwAgwGDAQoBDQCnAKcA1ACxAHwBRwAWAL8AoQCHAD' +
      'YAwwAyAFQBKAB7AHsAyQC5ABwBLgDnAEgAcAAiACUB6wC+APIAcABzAA4AGACgAFQAMQBsADEAXwEmAD0AQwFMAPMAiADTABcAtwAxAMQAXQBq' +
      'ANUARwATAAQAEAHcAIgA9wAmAV4ASQCKABAAKQAgAVEAKwAqAV0ALAEKATIBMQDYAK4A9gBAABMA7gATAF4AxAA+AVAAEQEzAPwARAH3ADMANA' +
      'BHAPoAXACfABwBHgGUAKMAVADUAEwBMwH3AFwADADGACQAcwBzAFMAdwFHAIkAXgBaAIcAJgDvAHcAcwG+AEUAfwHEAL4A9gCfAB4BRwCcAD4B' +
      '+AA/AQ4AMwETAJMA5ABQAFUADgHbAIgAVwCkANwAIACnALgAxQCMABABMAAmADMAcAA+AQwAfwDsADkBjQC4AE0AfAAuAOEAvwBtABcARwBBAJ' +
      '8AcgDuACcAMQDLAGQBDAABAOcAWQCkAMAAnwALAAkAAAFTAQUBHgB/ACYABAEgAAcAigDWAMAAqwAFAIoATQHVAAUBbACKADMBVgBwAA4BMQA9' +
      'AAIBvgAyAc8AJQDpAEwBCgG+ABcAfQGVAOMAQACHAEUBSQBAAFIBmAA9AFIAJAFUAPkAQwFxAFMBSgBtACwAJAGRAKQAMwAxACYAVADxAIQAEQ' +
      'H0ACsAowCZAGYASwFLAQABDABDAC4ALAGHAE4AXgCxAB0AoQDAAHkBlQDQAKgA2gBYACMBPgBQAIkAXQBRAUsBIwCfADYAWAANATgAGAAZAM0A' +
      'RwCCAI8AOwEEAIcAXgB/AX8ADAAGAD8BJgB7ABkAyAAAAQ4BXgAMAEcARQCxAEUAkQAxAJUAlQAmAKYASAAIAE0BAQDmAAoB/wBwAFMBbQAbAf' +
      'cAZQCoAJMAUQCkAKkAfwF6AIQAAgBhAJwAYQBJAIcAAwB7AIIAkACZAIgAtAD2AEkAmQAaAVgB9wCtAKAAhgBQAAQBDwEmAAEBmADEAFsAnQDs' +
      'AD0BFwDNAAQAPgCHAAwAXQAnAM4AjQC+ABABcgB3ADwBEgEEAHoAWQD0AHoA1gDDAAEAnwBhADMAAQA1AQABZgCKADsA2wAVAYgAOQFdAdkAhA' +
      'D2AN8AywASAUMAMQAeAZUA9AA9AV4AsQAzAEkAXACRACwAAQEOAWsAuwCUADkAOABLAUsBBABoAMAA1gDLAEgBXgBYAQwAmQAmAMoADgE5ARQA' +
      '1gDKAOEARgBsABcBAQB6AAwANABtAG0AQABTAewAFgFiACwBLQF/AKEAiACEAL4AEAFXABABJgANAQUBAAEAAZUAKAA7ADEAXQCpALIAMwAmAL' +
      '4AAAGyAOQAJgBdAMAAhwAAABUBAAG3AM0AAQBPAIMALgE9AD0AwAB7AcMAGQDNAFQAXAA9AJ8AMwE2AJ8AnwDAAD0ADABFAGYANABSAbEAHgCp' +
      'AKkAXQD9AEcASQAZARQAjQAmABQAAgATAAYAWABWAKsADAB9AOcAewCVABEBIgBfAAYAxwATAAEA+QBIAIsA0AAvAJoAVACPAI8ASwH6ABIALQ' +
      'EtAdMABAB8AEAABAD/APcAWACVAGsABAAlACMARQBpAGMAiQCJAG8BvQABATYAIAEnADYAmgBKALEAegCdAH4AFAAdADwAQQCaAB0AGwEHADQA' +
      'MwA2ACABPACsABIAbAB6AC4AjQAuARUAnACpAKEAqwAIAX8AnAAwAE8B7AAzABoAoQDBACIApgCVAJUASAE2AIUArwATAS4AAQB6AIMBZgAzAA' +
      'EAQQAnAFkBqwABAGMAOQESAREAVwASATsABQGzAFYATABBARkABAC5ACcAFAA7Aa4ATADLAJcA2wDQAAcASQAOASgAcABwADYAegBWADgANgAz' +
      'AD4BpABcAPcAHQAnADAAHgBqAKMAywCVAIYAOwAlANoANAC+AAQABAAMANMANQERAVMBGQBHAHYAMwBKAbgAQAFqAQcABwAMAPoA2gASADEAjg' +
      'ABAPcAVQC3AFQASwGdAOsAMQAcAFIBCAAYANAAngCKAGMA/wCFAOwAUgErAAIANQEbASYAYQBqAE0AnwANAAwAJwATAA4B8gAeAM4AfAExADYA' +
      '9wAmATEANgBQAGEAHQAdAE0ABgDsABMAGQGTAC4A3ACKADYA9wBdABEBNQF+AD0AFABKATMAhgBeAKEAzAAyAe4A+ADsAAoBngA+AUIAGQBHAK' +
      'YARwD3AD8BbQD2AJ4A+AD4ACYAOACSAAcAawABAKQALAGTAAEAKQE3AKoAPQBXAPkAtQABAI8A7AAVASUAdwBxAQQABQHeAAUAEwBkAZoAigAC' +
      'AcAAMQA7AJMAmAAEAaEAEgAMAIcA5AAyAWsAJQBAAAoBRgGPAM0ACABWAFYA+QD5AFIBHgFNAEcAFwAzAAUBzQArAAkASAFIADkBIwEZABQAhA' +
      'E7AOEA4QBmAKEALgFZACQAVwBHACYAEADyAOgAswBYAFgAlQBAACsAZgD7AEEBzQA4ABkBmQAZAFwAGgANATMAYQD7AAEAMgBlACsABACmAEgA' +
      'qwDkAGsA7ADHADMAhwEOAW0ALgBxAGEASAFhAAQA+ACHABEBRQBQAJQALQAnAFgBqgBNAYQAAAEnADUBCwEzAO4AMwAUAEYAwAApAc0ALgAWAT' +
      'MAFgEoABYAEgBLAJwA4wDsAEkARwD/AKEAtwApAf8ABQGhACcALgAtAFEA8gB1AYwAdQGQACUATgBbABsBTQFHALkAHgC6APcAoQB/AA4BSQB6' +
      'AHwASAAnAHoAIwA9ADEA3gAZATEA3gAnAWgAoQABAAEACwB9AAwA2QDCAAEA+wCYADYAIACJAEYBJwBTACUAMABsASUAJQAnADsAYQAgATsAbw' +
      'BrAHIA0wD3ACYBxwACAX0BlQAgAUwAOQB/AH4AsQAvAYgApwCkADsB3wA0AKoAUQCSAMQAAQBfATYAigCvADYAIAA7ADsAIAEkAAEATQA5AFMA' +
      'rAAOAVYAoQDbAAwARwC+AGwAbAA2AJoAmgDSAG8A4QBMAIcAbAAnAFsAIgBQAC4AVwBAAOkAEwGwAG8BcgENAZ8AagFeAX0BSQBMAGoBGgAzAO' +
      'MAcAA2AScAAQAMAMQAHgEUAGsBJgABAAsAcgGCAVIAawEzAG0AbQDSAIcAsQArAKQAagFAAfcAfwCaAIEA3gBuANkAHAAFAIwAjADaAPcA5ABS' +
      'AR4AKQGoADsANAABAAQAUgEiAV4BBACoAKgANgAZAWEAzgBKAWoB8wCSAJIAqgD3ALEAsQA2AAwANwEeAJUA2wBcAMMALwEwAF4AeQCsAGUAsg' +
      'D4APcAUAA3AMoAVQCeAMsAmgAfAH0B7AAnAFQAsgDSAG0AEAEzAFYAEwDDAAEASgFhAHoAMQDZAGQBJgBTAY8BsQBIAKQANgCHABAAhwCWACYA' +
      'MABCAYQAbABIAJAALgF5AQUBEAECAXEAVwBkAV8AyAArAG0ApAByAA0BSQDfAKQAEAE2AFAAOwAAAEkArwATALQAYQBsAJgAuwAWAUcAegAQAV' +
      'YAfgA0APUAEwCHACQAAQAQASMARwAjAIgAKABrADYAAAA2AC8AqgAmACYAhwApAM4AHgBXAFgA8ABNAL4AvgA1ABMAGQArAMQAWAC+ALgAbQCI' +
      'ADsA0wBHAPsAMQBHAN0ADAAQAdAAKQFrAEIAJgC1AOwArAChAKkAcgApAAcBhwDkAKEAhwAxAFgAoQDkABABcACKACkAhwApAB4AVwC+ABMAKw' +
      'AQAVgAJgBHAIoA3QAMAKwAcgChAGYAFAByAM8AWAA7AIAAJgCcADAA5wCKAAUALAG3ACIAEwAnAFcAvQBcACcA1QAUALkA1gCdACYAWAA7ADwA' +
      'pAC5AD0ABQC9ADsAUQBcAEcAAQAzAFgARwAeAEcAHgAeAAIANgAUABQAZgB7ACYAhACZAI0AewDHAEABnwAnADAAbwCZAEAA+wAEADkAJgCZAE' +
      'AA0ACJACMAiADlAHAAQACQAFgAzQBVAZgAHQA7ABgBiwCQAIAAqwAeAIIAJwGfAAEAAQDWAJoAqgBwAKoAnwDEAC4AWgCsAOcA5wCpAJwANgCH' +
      'AEoBfwCKAIUAMwBBASQAoAB9AAEANACIADwAOQABAKEApQBBAKQAGAGhAC8AZQDUAEABLgCmAFYArgCfAJkAAQDyAKoAEwDCAM0AEwC2AMIArA' +
      'BXALcAlQAnACwBDgBIADEAcAAPAHwAvgCpALUA5ACVAB4AGAEiAVsAFQCNAAEAAAEuABQBvAA4AAwAFQEmADsAbwDPAD4B0AAUAZYBEwBqADAA' +
      '2wArAB0AOgFDAGsAMQG/AAwAzQAaACcAegA4ADgAPQHlAAsAlQAyAHcBxAAtASkBLAGBAIIBJwAbAaEAFwDNAF8AYwB6ANoAmgB5AAEAnQBAAI' +
      '0AEgAtACsAmAAnASYABADfAG4BMQA0AOsAGABaAHEAdAFUAC0AHACHAFwARQB2AHAA2QAsAc4ADABKAZ8A8AATAA4BEwDVACwB0AAlAIoAYQA2' +
      'AHMAagCHAAQADADnABAARwCVAEAAvwB6AMwAmAAoAC4AhQAeAPIADgEiAP4AnwDBABYAMQC5ABUBoAD7AIcAbABdAPIAlAAiAOwAvgDNAL4ARw' +
      'BTAZgAUQCoANYA+gCaAFQAEwAKAfcAYQCqAEABiACIAMAADADZABcA6wAzADkBOQEFAFYAlAGHAHEAJwBtADIB/wD0ACAARwAtAAIBAgFyAFYA' +
      'AQA9AAoBBQGAAAcALAErAJ8AaAFgAUcAPAAaAVoAQQEQAdAA7ABYACYABgFmAGwAlQAQADgAhQE8ABMAQwDfAIcAcwDxAA4BAQHfAA0BXwB6AC' +
      'YAZgAyAKkAyAABAJEAqQASAJUALAEBAAEA+wAXAXwBVAAaAXkAPQCgAEUAkQDsAIcADACHAJUAKQFWAOMA9QAAAXAAMQArADMAAQDOAFYAHgDQ' +
      'AA8AMQAPAIgAKwAXAUAAEAGYAGEARgBdAfUAAQANAakAHgApAR4AJgACADYAbwAmACcAewBAARcB+wAEADkAmQABAJkAJgBvAAoBlQD0ADQAIw' +
      'BVAZ8A0AB2ABgB5QAoAKsAiwBYAFoAnACqAEEA1AATABgBPADWAMQAigCgAKYAoQClAKQAAQABABQBAAETACIBEwAnAJUAGgAuAHAALAEwAKwA' +
      'twBXAJkAAQBaAA4ASADCANUAnwCgACcAOAAMAEMAOAA9AR0AlQAUAXcB5QCWAesALgB0Af4AKQEtANoAGwExAAwAggFwALgAKwAcACcBXwDfAH' +
      'AAAQDBAJgASgHyAIcAYQBRABYAMQDQAAwADgErAOcAvwAeAIoAvgDwAJ8AOQENAdYAYQCIAPoAEwBUAL4AcgAFAVYAhwCUAd8AhQFDABABcwBY' +
      'AB4AVACpAJgAnABUAHsABgAmAHsABwB7AEcARwCUAFkABwApARYBSgAKAQQAmgAzAAcBCACkAEkAegAoADsAOwAeAB4AEwBcAJUATwEBAE8BAQ' +
      'CHAC8AyQDQAFwASABdAYcAXgEOADQANgBHAP0ARQAMAC4ATACJAEcAPQCPAF0B/QCKANwAiQABADsAsQDHAL8AEgBTABIArABTAB0AjQA5ARkA' +
      'kgBdAV4BOQE5ATkBvwBNADMAnQCkAAwATAA3AU0AEgBHAAEANAA5AVwA3wBdAVgA2wDEAF4ANgDpAL0AfgABAG8BCABYAZQAhADfACkAcQA7AF' +
      'sALgATAKQA5wBbAFcA8ADOAE4AfgDxABQB2gAIAQEAmgBNAKoApADAACwAlQAOAPAA5wBMAJ8AhwFmAA4AQwGHAOwA0wDEAKsA/QD9ABQAqwAq' +
      'AEMBoAC7APUApgCYAAUA3QCMADABegBOAIcAXwA2ADAAFwAXADsAJgAJACkBcgAYAe4AXgCxAHgAuwAoAHcAJgDxAJEAEAA2AKwADAFxAFkAAQ' +
      'C0AJgACAA7AG4B2QBeAGgBMAD1AB4AcwD7AAgA7AByAH0AegBDAaQAKQFJAB4ABQAOARYBfQBDAdsAxAA2APcAvQDpAHEAegC0AAkAlAA7AIQA' +
      '3wBYAc4ArAAuACkAWwCHAOgAEwAIAVcAFAF+AE0A2gCqAAEAhwE7AEwAlQDnACwAwABDAecADgByABQAxAC7AKsANgApASYASQAFAKYApACgAD' +
      'ABjAAwALsAKABuATYAEAAMAXEAHgD1AF4AaAH7AOwAfQCaAEcAqwDMAHwARwAaAKoAGgBWAAYAkwB0AXQBMwAhADYApQB9AAQA+wASAUAAegDn' +
      'AFgAawCaAKYAmACYAEoBNACAAIoARwCpAFgALQGhACYAoQBcACIBUQDnALgAbgATAX0AVQDPAEcApQDWAEAANACHAPwAkwBcAZYAwAChAA0BFA' +
      'DnAKgAoQCaAPIAQwBDAGYAAQEtAVsA9QD1ANQAXwFsALwAGwGOAFcANgCYAIcAiwA7AHkALQEvAQQALQFTATkADwEBAIcAfwAmAS8ASgHSADkA' +
      'TACmAC8BJQEuADQAowA7ADYAJAA0APsAbACdADQA5ABgAAEAJgB+AHoAZgBuAC4AtwC8AIsBVwASAV0ASABKAcAAogA7AEwAuADpAIcAZQBDAK' +
      'QAegBuACYANAAmAEkAHAFcATIARgDNAAsAUQArAWkASQAcAK4AZgAPAEMAwQB5AIcAJgCGADEAXAEnACYARgA0AEYAdgDAAOYAsgA0AJoACAC3' +
      'AKgAbADUABEAAQDPANwA6QDcAOEAOwBaAKMAOwAMAG4AjgAqAK4AJQCKAFYAmACMAYcAIgGTADQANgDPAEoB8AB8Af4AqADCAMsAhwDeADMBBA' +
      'B5AFMBRQGjAKgAJgBGACQAHgH1AKQAGQHAAFkAzwCTAH4A1gBHAF0AJgA7AFMBigAkANwAbQCiAAEBRQEuAcsANAAHAWcBegCEAFwAJQCOAGwA' +
      'zwDPAFgAWAAsAHkAQwBDAHMAWQCOAIEBKQABAXkApACkAC4ANABcAEMAjgAPACYAOAAtAUUBLAATATsAMwA7ACsAXADzADEAFgEsAHoAMQA4AR' +
      'ABYQAXAWEARgB5AKEAJgCBATgBRwBdAFgALABwAL0AMACJAKEAqABuAG4AvQA+AW8A5ACRACYANACTAOIAswAeACYBZAChADIBswBuADsAHgCo' +
      'AN4A7AAMADQAIwBXANMAMQAtAZAAfgAOAYQAbwD7ABQBSQBPAZgAfgDQAFMABABNAO0AFAFUABAAewA9AKEAFAGKAH8AfgACAcQAhAAUAYUA4Q' +
      'DbAJwAnAAvAS4A+ADQAC8AoAA7AIgAGwEBAOsAEwBBAFsAvQA0AGYA0QDAACoBtwCgAHgAOwCrABwADAA7AR0ACABAAFYACAA2AOsAoACdAH8A' +
      'VgAHABwA5wCVAGMAXAFSAboAAQDhAFQAIABFAUEAKQDbAHYA2AAcAO0AfAEmAIUAegAqACgB7gAiAB0AewBJADYA5wA2AI8AhACpAAwAjwBAAZ' +
      'wAxAAGAPcAwABmAIAAEAAxANUAUQBWAGYAqQALALMAiQCEACwAIgBgAboAXQEBACYAGgFbAAwAhwB7AAABjAAzADMAwAAsAJcAIwBXAA4BfgBv' +
      'ABAA0AB2AO0AewCcABsBwACgADsAAQA9AMQAMwCIAOsAEwB4ADsAZgCgALcAwABmAFYANgAcAEUB2wCVACAAYwAcAFwB5wAoATYAJgCPAEkAjA' +
      'D3AAYARQHAAFYALACQAJwApgCmABIAIwHOADUBNQGmAFEAngDOAM4AzgBRAM4AngCmAM4AzgCYAFAAyADIAMQAXAFcAQEAdADOAN4AEwAMAFkA' +
      'ZQArAH0AVAAMAAwABACZAAEAUgFOAAQAQgFjABwBJwHsAGUAXgByAG8BIwCEADgAZQDQAGcAVgBlAHIA9wAxAG0AmgCXAJoAuAA7AAEAygBMAJ' +
      'gAfgBbAIoATAEuAEoBcQBAAUkAAQAAADIAlQAYAB0AvgCiACYANwABACcAbgETAZkAywDlABMAQAFCAMkAnQCOAMoADgGZAAsAHQDNABQAYgAu' +
      'ABQAigCKABwBMgCoAEoAAQBWAHwA0QA4ABMAGgDWAAEBawEoAG0AVQCVADMAnAC7AOgAMwEuAKIAXQF+AMAAHQCgAHIADABcAV0AMQCoAAEAZQ' +
      'D3AOQApAD+AAwADQFfAI4AXwAeACoAmgCoAAwAEwDEAB0AXgDQAM4AUgHQAAYA8gAUAN4AZQAxAMwAAQCsAIgADwAeAZkAeQCKAJoA9wDWAHkA' +
      'VAD5AIgAKQAJAAIBEwCNAZoA1gABAVYAjgCKADIBmgAzASwABgF5AVQADgEMAAEA0ABZADQAEwCkAIgATgBhAF8AXQGpABUBWwA8Ac4AzgA1AT' +
      'MA9wCIAOQAMwABAGoABwEEAK4A+wAHAAwASAFQABIBRwAUATYAZAD9AIsAuQBTAJAAcAD6APcAKwGUAGEA+gA4ADQAHQAHAA8BFACkABIAFQA7' +
      'AdsArwCKAHQBFgAsABQBVwAuABMA0gAMAA4AqgBHADsAJgBdAckAuQBmAEcAVwBTAD4BTADGAFoAPgFeAB4AGgBKAJoAwwA2ADgANgA9AUUAPg' +
      'FMADAB0wDsAGwARwDbADMAXgALAM0ABAASAOsAUgGgAN8AdAFBALsAnQCYAB0ACwBIADAANACuAEMAAQBKAB4AJgHvANsA0ABJAOMADABeAMkA' +
      'XQBIAEgA9gCTALUARwBQAFwA5wB0AQEAOABIAF4ARQCuAKQATQCAADYAWQBAABAAPQBDAB4ACQAFAUMAnwAHAaQAmQCkAGgBMQBaAE0A+wAsAE' +
      'wBMAARARYAZAHGACgAEQF0ARQBbQD1ACsAHQAEAB4AKwD1AH8AXQFHACgA9QAzAB0AAgAUAC0AjACgAAEAfQAMACEAHgAjAU0AMACfAEoAxACJ' +
      'APcANgBeAA8B3QAlATkAzwAHAJwA1gA+AA8AeAC1ALMAXAEPAB0AfAA7AHoACgEaAEAAHAFmACYB0gBEAQABcwAjAWcAHgCOAXoBMQDAABABHg' +
      'BAAYwAqQDuAN8AIwFuAc8AagGoAHoAKQE9AJ8AuQDfABQA7gBeAEwBGwH2AL4AtwAPADMBXgCuAEcBPABnAJMACgEEASsADAAzAAEBswABAAoB' +
      'CwBmAEcA3wBMAcgAAQAzADQAHgABAHoBUACZAA8AHgB/AL4AvgB6AZAAZgATAL4AHgDOAOkAEwAdABMAEwAzACUAFgAcADMAcgByAGUBAQBZAN' +
      '4ApQACAEwBFACqADYAxAA7AC8ATwA2ADcAjQD7AEMAJAEqAOcAhAAMACwBBwAhAQQASAFsAYoAGQBHAAEAxwATABwBRwB1AVQAFABsARIAIwBy' +
      'AC8AiwCYALkASgAtAVQANgALAFMAkADQAFgAjgCsAEAAVACeAIIAbwCAAHgBiQBeAAEAawASAFIBewBAANMAjQABACUARwAOAGwBlAAPAWQA9w' +
      'DAANAAawBuAOcAnQAcARMACwGcABsBfwAVABkAnABsABIADAAZAKcACwAdAKMATADEABMAEwAIATQAOAETAHkADgGlALEAqgCkAPEAXAATAGwA' +
      'LgCaAEIBTAF8AFQANgDqAE0AVAA2ADMALQESAIUAngBsACcArABJAFoAaQBHAEcAigBMAGkA3wBwAAEAGQAUAbAA2wCHAHwAuQB7AGYAmgBbAC' +
      'IAFQATAE0AWQFAANMAoAAZAUgAfAA5AQABJgAMAJ8AbwAGATsAEgH7AJoAegC5ALcAEgAIAS4AyQC1ALwAjQB6AHoAkgDTAMIAswAmABIAUAC+' +
      'AAEAQADRAL8AGwAdAGABAwBUAE8AGQCRAI0ABwBLARMAOgEUAM0AVgCSAEMBqAAzAXoAewAlAGIAwwAmAT4BCACQAF4A2wA4ANYADAArAGoAbA' +
      'AHAEwAewDjACgAKwAIADsAGQDjADgAOAC4ABQBLQBtAbkAawBwAAcAbQEWAFwAaAE0AHoA0ABIAXMAMwAkAEsBGgA9ATMAhAEVAC4AxAAcAR4B' +
      'IwE0AIEA9wCHACEBjQBAAQUAdgAbAX8AEgDAADMA6wCMAOMACwEjAeEAvwASAHoAIwBuAQABTgHiAHkAagEpAR0B4ADnAFoA6ABGABcA7gDfAA' +
      'IABABUAG4BJgAMAHIAKQBNAIEA3QBHAG0AjQCcADMBSQDEAMAAEQHAACwB2QBlAbsAXgGLAAsANwAIAPUAPQBmAXoA8ACUABwAPgCDACoBhQCa' +
      'AG0AUgF6ACkBHAExANwANgB8ASYA0ADTAJgAqAA8AD0AhQDzAAYADAA6AfEA8gAxADYApQDCABEAEwB7AF0A/gDBAEMAQwDJAGIAFwBdARYACw' +
      'GHAPMAhwAZAF0APQAOAVYAJwDEAM4AJQDnAJIAFgAmAdgAkQAnAFQAJgEzAWUA+gAGAG0AVQAqAR4BiAAWAJABPwH4AJMAVQBTASIAdwHgAGwA' +
      'JABlAKQAHwAhAecAOADsAPIAuAAeASoBfwFSAPYACAA9AcQAxAA+AQEA9wCTAEYARwBMACIA+QDjAOUA1ABVAAYAKACPAFMAwABVAPQA1AA3AZ' +
      'IAKQAOAW0AHwECAQUBOQHkAKQAMQAeAYoAQwAXAAEAwAACAToBUwGWAAQABQCTAAUBrgArACgAMgDZAEkAMgGSABcAFgH1AIcAZAEzAAYARwBk' +
      'AEkBogAJAFQAWgDAACwBJgBzAJUAUwFMASwAYAGSAAoAGgBXABkAHgFBAfIANQBfAIQAQwC3AEcAkwBIAFgAZgAGAVkABACzABoBkAD1ACYAhw' +
      'AlAAcBIwDsABoBWACQAfUAcwAIAYQAGgACAPsAKgGHANoAXwDAAOMAlQAMAG0ALQBDAIcALQAAAaQACAFdARYAbgBSAQ0BNACJAGUA2wABAJEA' +
      '3ACZAI0ALgBoAG4BJgBGAKoAlADrAP0A7ABXAK0AnwCHAIcAVADCADsATQEzAAABJgA4ARQBBQDhADUBKQF3AVwBwwDZALEAwAB6AIABFgHQAM' +
      'AAkACHABABbACHAC0BKwBIAIcARwApAHcARgAAAYEBoQAkAOQAOAFPAAEBRgBYAJMALgAQAXIAZQEBAMQAAgClAEwBWQAcAVQAKgD7AIIAhACN' +
      'AIMAdQGFAMcAuQAOAAsADwE0AI4AgAAlAFMA2wAhAZ4AVACIAGsA0wA4AKwAZACLAJQAYgB4AS8ADABUAFoAVACcAGwAGwFMAQsAbAAtATgBaQ' +
      'DfAEwAowAdAAgBbAB/AHcBVABNALEAEwAOAXkApACdABIAbgC5AAMAswBbAEgBIwAdABoATAAWAEEBOwANAXwAwwCNAEAAKgE8AC4AegBqABsA' +
      'egAsAbcAUgBZAYgAIgC1AFoAYAFmAAEAKwAZAZMAvwBAAFAALgCzAHMAOAC7AIQBbQA6Ac0AVQAzAGgBXABSAT0B0ACSADMBbQEoAJAAHgEqAY' +
      'cASwGoAD4BawA0AE4BUwFWAP4AMwFNAOgABABmARsBagGBAEcAnADkAOAAbgFyADsAegDjAJQAjADfAAIAhwA0ABEB5wARAOwAKgFTARkA0ADC' +
      'AEMAJQDzAPYA8gBdAZEAKQEmATIB5wDaACYBOQHEAGwAIgBGAJMA4wBGAFMAHgFFAPoAAQBMAP0A+ADZAJMABQHkAKIArgAyAIoA1AAOAR4B3w' +
      'BYAFkAcwDAAI4AEAFzAIEBUwEHAZQAAAFdAS0AbQABAMIA2QA1ASsASACBAIEAIQACAUoBJwBZAL4AgQCDAPkAigH7AJQAgwAeAKQABwCkAPsA' +
      'KgFkAKIAewCRAQoAegB6AIcACwEGAIIBSgA8AEEBqQDhAAYAfwDOAKQAkQGqACkAIgCqAD4AXAB7AFcACwFgAWoBPgHDAGoAUgA0AC0BLQErAK' +
      'EALACBAFIAagEeAI8AHgDQANUADACPAHsAsQB7AKEAiACPAJ4AvwAxAEAAgwH8ABABKQG3AAAA3QBGAHkAKgGqAPwAAwEpAEoABABdAJMAKQAE' +
      'AboARwCVACsAEgANAV0BeQCPAHkAgwCKAfsAHgAHAKQAjwADAZEBMQB6AHsAhwALAWQAgwA8AEEBVwCPAHkACwHDACoBPgAiAKoAagEhAC0BPg' +
      'EpAQwAHgCBAEcAjwDVAB4A0AArABABoQCVAIMB/ACqAN0AeQD8ALoAXQE2ADYAPwAaAZAAVAA4AAEAOQBAAIUASgDQAPEAngCMADoBXgDtADsA' +
      'EgAyAIsAhQBAAMQAJwAaANAAoQCKANQApwAeACwATgE5ADkA2wAVADYAJgDAABYBmAC5AG4AMgE5AQoBSQBuAHoAWwBXAAwADgD7ANMAQwC5AO' +
      '4AOACkAAYA+wDxADsAcwBKAPcAxABcAHoA3gBGAF4AegCMANoAdAEEABoBdgBAADQA4ACYABIAfwBAAXoAwADxAHoAQAAuAIUAdAAGABkBHgBA' +
      'AAwAigAMABYBMQAxAEYAGgFfAL8A8gAnAF8AQAAOAB4AlQAiAF4AOAAxAJEARwCTACYACQDeAAIBRwBAAIIAeQEsAMsABwESAF8AXwAMAHoAiQ' +
      'CdAFsAJgDeAEcAQAA7AJUAFgFHADMAMwAzAG4BqgA7AH8B0wDMAAEA/AAeAGsAhwAYASMAJgCcAF0BOwCsANMApgCuADQAXAA9AEIB5AAMAA8A' +
      'jQBfAAcAlABJASkAXABCAa4AJgBXAA8AHgEzAMwADABCAQ8AJgAMAAwAUQBTAFABYAFpAI8AiQBCAF4AMwCaAIUAfwAAAb8AsQA4AKMADQE9AD' +
      'gAjQCfACYAaQCYAM0APABqAMQAjAAmAX8ABACgAJQAUgDaAHsAqQBAAJ0ASQBPASwAfwAYAOwAOAB/AEkBfwAGAHsAQABOAE4AXgAeAREB/QA4' +
      'ADEAgwFAAEcAAQCRADAAFQF6AAwAwAAWAX4AJgBCAIUALwASADEAKABHACYATgARAREBAAEzAJQAkQDaAH4AFgF/AJEAKAAzALEAqgCqAKoAFQ' +
      'DrAOsAHADdAFoAMgAaAOsAMgAyAKMAMgDdANoA2gADAL4ADQANAC8BFgANAJUAFgAiAAIAwgBUAG8AigApATgAbwBrAHIAUQB4AS8AQACCAFMA' +
      'OQHUAGUAngBhAIgAQAHbACcAewAvAYUAFQBAACIAQAEnAGEAvwC/ALYAvQAlAWUAQwBqAAUBzgBfALgAQwDjAOIAogB5AAUAEgCDATQANQFhAH' +
      'wB+gCXARQAFACqAEMAwQA0AIcAzgCKAIcAjwBAAawAeQDbAGEAJAAiAKQAgwGTADIBVwBDAFEAJgCHAAoBKwBlAJQAegBUACkBrwCHABABMQBv' +
      'ADYAJgG3ACIAMQBDAAcAgQCDAXwBXgCrADEAIgC0AEABrABeAD0BpAAxAF8AKQGvACkBMQBvADYABwAxAF4AQAEhACEAegBhAHoAJgBAAEIBXg' +
      'A7AT8A4QDyAOwAXgDhAL8AQABIAD0AFgACAOsAFABIAFEBBwCfAAEAnwDQAOUAXQAEAG8BDAAIAJ4AjgCKADAAJABMAX8AlwAyAAABqgBDANAA' +
      '0AAxACcAgwFwAAEAAQAbARoBDABBAAABNgBMAGIAlQBdAEwA5ABqABoA7ADTAD0ABwAyAMsAywD9ALsAywDnAOcA4AACALsA3wAHAFQAGwGWAM' +
      'oAawABAAwBqADQANAAHgCPALoArgAQAB4AegCQAAEA9wAfAKMAowAKAV0AAAGzAAQBVwEFAc8AiABFAEMAnACZAB4AlQArAFAAEQH9AHoAWAHA' +
      'ABABRgC3ABYAAgDrAAcASABRAZ8AnwAIAJwAjgAEAJ4A5QBvAQwAwAB/AEwBMgAnAEwAagCqAOwAygAbAQEAWAGVAMsABwDsAOwAGwGoAK4A0A' +
      'AQAB4A0ABGAAUBowAfAEUAAAErAFAAWAG3ACgA2QAiATYABgCpANkAggAvAA8BEwEiAQ4BzQA0ANkAGQAxAIUAiAD2ACoBcQGEAB4BRwAeAQQB' +
      'BAEeAdkA2QDZAFkA2QBgASgAkgAoAIUAqQDZAIIANAAZAPYAiAAeAQQB2QDZANoAhADaANoAEwATAP8AJgACABkAOQCpAH8BSABPAW8ADACFAJ' +
      'oAQACEAIQAfwFAAC4AAQCnAKQAJwBAAbEApgAIARkAsQATAG4AZwBvAN0AZgCqABUAiAB8AKYASACFAOMAWwAeAD8ARwD/AGwAHQHQAAsA0wBK' +
      'ANYADAATAIgA1QBSARMAhwBcARUAegALABYAMADaAAkAMQApANAAdgFeAD0A8gAIAZUAhwDJAJEAuQCJADEAnADCAOUAkwBsAD0BRwBdAB4B9g' +
      'BAARYAjwA5AZMABQGkAAwAkgByAAoAXQAQAPsARwAwAAEAJgB5ARoArgBAATEASACpAIkAZwARAR4AOQErAEgA5AD1AEsAEwACACYAOQCTAE8B' +
      'RwBvAAwAmgCEAEAAhwATALEAGQBuAAEAWwB5AUgAqgAiAGYARwAVAGwASgDQAAwAHQHTAFIB1QB6ACkAwgBdAJwA9gArABYAOQFsAB4BkgByAA' +
      'UBCgAQAEsAHwFdAFIBSACJAGwAnQCkAGwAHAEHANoAhwC/AJEANgB6AF4AkACJAFgBkAD5AAwAKAAHAIoAOQA5AJoAmQAuADsAjACQAGwBggBe' +
      'AI8AOwAwAMAAHQBsALEAxgA5AAEAoQCPAKEAygBMAaUA9wDhAKAANAAuAJsANAASAEMBTAB/AMQADwE2AIUAEwCkADkAOQAZAB4B+QDwAEABOw' +
      'D4ABUBGACZALcAcADKAFsAZwBsAC4AQADkAKAAMABnAB4BNADlAGsASAEcAAcAHAEOAcsA0wDQABoAuQAZAMAAbgGgAKsA8ABqAUABuwDcABsB' +
      'BAAEAB4A2gBxAR4AIgCIADgA8AAXAPAAVADaAPIAVACUAAwAqAC3AAYA3ABdAHwBGQAiATkAVwD2AFQAGgA7AB4B4QAVAUcAZAEpAR4A9wB0AX' +
      'EB+wAEADsASQHAAEcA5AAJADkBAgH/AAQBFwChAKQAOwAMAJ8ALAFsANYAzQAsAKkAjgAeATkAZwGjAGYACAEeAOQAqQAyAAEAFgA5AFgBoAAe' +
      'ABYBwwAVAUgAJgBJATQARwBdATMA2QD5AAwAOQCZAJoAoQBsAWwAwwBDARMAGQA2ADQAdAEuADkAmwBMAAEAfgDNAPkAQABmACwB5ABnAPAA2Q' +
      'AzABoAHgC5AGsA0wAEAAQAGwFuAdwA1gD/APAAOwBdAHEBOAACAR4BVAD7AAQB5AAXACsAoAAmAEkBSACcADEAMQAxAAwAfQABAEcBYgAnALEA' +
      '2wCmAKgAigDSAGcAzQDJALwAIgDLADAB8ACkABsBJQEMAF8AMgFsAM0A+gBsAKYAgAH9ADkBWQAyAc0AKQFDAV8AqAD9AIABwAA9AT0BQwADAE' +
      'MAswBxAdkAagFqAYoAiwCSACABTQAwAGoB/QA+ALgAEgDnAD4AIAGoALEApABNADYAWwBbAKEAvQCSAIMBJgDhAIkBOwFSAKgAMwD9ANwAqADh' +
      'AOUAWgC3ANwAUQGHADkAPQA1ASEABABtAMQA/QDhAPkACgAFAQUBCQGfABMBVABUAMgAXQGDAa0A/QATARcBSgBKAEEBewBHAEoAugBKAEoAIQ' +
      'CBAAwADAAiAB4ANgCQAFcA3AAeAVcABQAMAFcAJgEmAAQAZQFdANUALwBMASYBnwAeAM0AHAAMAMsABABjABwAMQB9AJoABAGkADkBJgCfAA8A' +
      'HgCpAAwA3gBvACYALwB7ADkAjQAmAAwA0AAmAFIAbwFPATkBJwBwAJ4A9wASAMAAjwA9AMAAQgGLAIkAUwAdAPAAOQGqAAYAoQAHABIAfwA5AC' +
      '8AFABBADYApAAmADEANACNAGwAHQAgABIARQG5AA8BsQA2ADwANACcABMAGAAPAHkAJwBJAMkASABbAL8AMQClAC4AQAATAeQAfAABAAEAFQAx' +
      'AGYA0gBXAHoAIgCVALMANgADAJIAOQDTAKgADQA7ATwAVQBrAAwAHQFWACAAMAHWADgAFAD7AHMAXQG4ADMAUgBSAAMAEQEaADMAdAFHAK4AcA' +
      'DnAAQA6wBIAB0B7gAmAI0AEQCcAKAAGAC7ANoAnQABAGoBwAAhAIEAMgB2AH8AdAEzABEB3AA7AEUBPQAMAIoAEwBwAF0BqADJALkALgA1AdwA' +
      'JgDOAM4AXQG3AIcBMQAxAAwA7gB8AUoB8gBtAB4AFAAUAIcApADQAIUANgAMAYcABgA5AD0AEwDvAA4BjwCHAEUAOABCAHEBHgH5ABMAEwApAO' +
      'cAFQF5AIgA0ACuAFQABACPAO8AcABtAAIBPwCVAAsBJgC4AKEAhwBwAAUBRwAUANkAJgAmAC4ACgGSABAArgAJAGQAUQAuAQwAoQBIAGwAZgCZ' +
      'ANYA8gAGAfsA+wCEAFcALACZAIgARwBoAUgAiQApAMkAxgCHAXEBqQB9AFcA7AAzAIEAAAFJAJEAUAAmAJ8APQBJADMAEwE/AE0BxABIANAAwA' +
      'ApADMAegAMAN4AJgAdAE8BwACLAC8AqgAvAEEARQHAAB0APAA2AC8AsQDJABIADwFXACcAAwAxAFsAfACHAckAxgAmAGYAegA8AEgAmQAwATMA' +
      'bQCHADMAEwC4ACAAUgBdAdMAJgCuAOsAfwAEAHQB2gBqAYEAnACdAEUBjQAyAHAAEwDnAIkASgGkAIEAqACPADEADAHQABQANgDyALcACgHOAH' +
      'EBAgEEAHkAKQCIAEIAhwA/ANkAUQAuAQUBCwGuADEARwBYAPsALAAGAT0AfQAzAKkAKQB9AQEANgAzACEACwAeADYAjQAmACgAUAB9ABMAKAC1' +
      'ALEA9wA7AD0AawA2AJ4AjwCHABMADABQAYgAWABYABIAXQHEALEAHgAjAFoAiwAoAI8A9AB+AEwAUAB/AE0BNgA5AAsBMwDOADsAIgD3AKYAoQ' +
      'DNAJoAMAA0AIgAnAAlAAwAhQAMACMASgEMAN0A7AAaATgAWwAiAZEAOwAeAGgAzQBMABMBLgCFAAEAewDAAFAAwQAiAG8AZgCSAKAAmgDkAGgA' +
      'RQHQAE8ATAAmABwBXQE5AAsAOACHAAwAbADTANMApABHANMANAAcATIAqADQANAAFAE9ADgAcAC7APUAJADAABIASQA2AL8ALQDhAGsAVADbAI' +
      '0AwAD8AIcANAAcASMA9wAEADMAFgBuAeIAbgBqAfEABAAyAAEAAQAyAOcAuwAYAAQA7gAwATQAoQABAAYBJgBJAOwAmgA8AXwBvwAUAKgAPQCo' +
      'ANAAJwBNADYA7gAcAR4AqgD3APAAagEmAT0A7AAqADgANAAYAHcAiwCqAOwA9wB6AD8BEwCqAFwAkwAGAO8AHgEmAJwAhwB/AQcApgCmAAEAiA' +
      'AeACYAMwDdACQBqACoAAEAHAH5AM0APQHdAJgAJgA3AVYAAgGIAAEA9ACaADsAHgGuADIBpABJAS0ADAA4AFgAQACoABkAZgABACwBpADsANYA' +
      '8gCEAGYAWQAeAD0BIQB6AHoAHAFOAAYBDADsAMAANwF6AFEAAQASAC4A5ABHAAEAJgBxAAwAqQAWAIUAEgCtAD0AvgDsABEBigAtAQwAAAELAM' +
      'AAqgAWAUkBLQHsACkAoQAzAE8AfQEhACYA9wC1ABMA9AAjAHcAsQDEAJwAGADAACMAzQCFAH8AmgChAPcAUQA5ABkAOwBbACIBkgBoAKAAIgBP' +
      'AHsAOABsADMA4wA9ANAADAB6AKgAOAD8ADwBvwBqAdsA4QBUAO4AMAH3ANYAPQCqANAAPQAUAKYAJgE4AAEAiAA/AR4BJgABAIcAqgABAOwAVg' +
      'AeAVkAZgAhAAwAwABdAakA7AA9ABEBKQBJAcAAcgB/AIcAegAzAYcAhwAeADMBwAAdAM8AJgDZAM8ALwEuANMALgCHAL4AvgAMAB4BmADTACwA' +
      'nQAEAMAAIQDTADIAMwBIAHoATAC+ADMAqwAJACwAMgAEAH8AHgDPAE4ATgCqAIAANgANAA0ANgAvAaEAoQDBADYAegC7AKEADQCaACgANgChAA' +
      '0A+QA5ATkBlQC+AHQBAACJAPIA8gByANEA3QBiAHsALAEUAXsASQAzAEUBmgBhAWEBAQBUADAARwBPATkBOQFUAH4AXAAdAKMAAQAGAB4AoQAm' +
      'AR4A6wAtATMADQEpAf8AHgAeAB4AMAC/AMQAfgD/AAEAJgEwAB4AKQHAADsAiQA2ADYACwENAPcAzwChAIAArwAuADsAEQECAS4BOQCkAPcAgA' +
      'A5AAIAvgA3AAIA5wCcAJwAGACJAEAB9wASAIEAPQFkAfcAkwAVAUkASQCJANoAjwAvAI0AOQAlAKEA8QATAB0AEwBqADgANAAyANUANAAeABwB' +
      'GQBHAHoAHgAAAaQAiAAUAAcAOAA4AMkAYQDQADwAkgA/ATwAyABLAAQA6gAmAOcAJgAmAAQAJgCaAJgAmACqACMAQABhALEAcQBhAOcAmgAeAD' +
      'QAuAB/AH8AXAC3AGEAQABGACEAiABcAV4ADABcAAEAnQBxAHQBoQBeAB4ADADQAIYAAQCmAHQBowBcAHIAIwCaAJgAqgBAADQAfwCxALgA5wBA' +
      'AAwAXAGhAIYAFgFCAL0AQgAeABYBFgG9ALoAZQB/AGUAFgG9ALoAVwAUAC4BVwAtAeAAqgBmAGEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhAWUATgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    return { inject: ['slots', 'locale', 'shortcuts'], apply };
  },
});
