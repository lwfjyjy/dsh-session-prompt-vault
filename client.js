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
      settings: 'dsh-session-prompt-vault:settings',
      shortcut: 'dsh-session-prompt-vault:shortcut',
    });
    // 旧插件名（dsh-session-quick-prompt）的数据键：首次读取时自动迁移，避免升级后丢提示词
    const LEGACY_STORAGE_KEYS = Object.freeze({
      'dsh-session-prompt-vault:prompts': 'dsh-session-quick-prompt:prompts',
      'dsh-session-prompt-vault:settings': 'dsh-session-quick-prompt:settings',
      'dsh-session-prompt-vault:shortcut': 'dsh-session-quick-prompt:shortcut',
    });
    const SYNC_VERSION = 1;            // 云端文件结构版本
    const GROUP_ALL = 'ALL';           // “全部”分组 tab 的哨兵键
    const UNGROUPED = '';              // “未分组”的键（空字符串 = 无分组）
    const AUTO_SYNC_OPTIONS = Object.freeze([0, 3, 15, 30, 60]); // 自动同步间隔（分钟），0=关闭
    const SCREEN = Object.freeze({ list: 'list', settings: 'settings', edit: 'edit' });
    const SETTINGS_TAB = Object.freeze({ shortcut: 'shortcut', sync: 'sync' });
    const SYNC_MODE = Object.freeze({ upload: 'upload', pull: 'pull' });

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
      restored: '已从服务器恢复', noRemote: '云端暂无数据', required: '标题和内容都不能为空',
      min: '分钟', hour: '1 小时',
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
      restored: 'Restored from server', noRemote: 'No data on server', required: 'Title and content are required',
      min: 'min', hour: '1 hour',
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

    // ---------- 通用工具 ----------
    const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
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
      write: (settings, prompts) => davRequest(settings, 'write', {
        version: SYNC_VERSION, updatedAt: nowISO(), prompts,
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
    // 生成分组 tab：全部 + 各分组 + 未分组（带计数）。一次遍历统计，避免每组重复过滤。
    function buildTabs(t, groups, matched) {
      const counts = new Map();
      let ungrouped = 0;
      matched.forEach((p) => {
        const g = groupOf(p);
        if (!g) ungrouped += 1;
        else counts.set(g, (counts.get(g) || 0) + 1);
      });
      const tabs = [{ key: GROUP_ALL, label: t('all'), count: matched.length }];
      groups.names.forEach((g) => tabs.push({ key: g, label: g, count: counts.get(g) || 0 }));
      if (groups.hasUngrouped) tabs.push({ key: UNGROUPED, label: t('ungrouped'), count: ungrouped });
      return tabs;
    }
    const byGroup = (list, key) => (key === GROUP_ALL ? list : list.filter((p) => groupOf(p) === key));
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
    function useAutoUploadOnEdit(prompts, minutes, run) {
      const runRef = useLatestRef(run);
      const minutesRef = useLatestRef(minutes);
      const mounted = React.useRef(false);
      React.useEffect(() => {
        if (!mounted.current) { mounted.current = true; return undefined; }
        if (!(Number(minutesRef.current) > 0)) return undefined;
        const id = setTimeout(() => runRef.current(), 1200);
        return () => clearTimeout(id);
      }, [prompts]);
    }

    // 提示词仓库：读取一次，commit 负责「内存 + 本地存储」双写
    function usePromptStore() {
      const [prompts, setPrompts] = React.useState(loadPrompts);
      const commit = React.useCallback((next) => { setPrompts(next); savePrompts(next); }, []);
      return [prompts, commit];
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
    function IconButton({ className, label, title, children, ...rest }) {
      return h('button', {
        type: 'button',
        className: 'qsp-iconbtn' + (className ? ' ' + className : ''),
        'aria-label': label,
        title: title || label,
        ...rest,
      }, children);
    }
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
        showTabs ? h('div', { className: 'qsp-tabs', role: 'tablist' },
          tabs.map((tab) => h('button', {
            key: tab.key || '__ungrouped__',
            type: 'button', role: 'tab',
            'aria-selected': tab.key === activeGroup,
            className: 'qsp-tab' + (tab.key === activeGroup ? ' qsp-tab-active' : ''),
            onClick: () => onSelectGroup(tab.key),
          }, tab.label + '(' + tab.count + ')')),
        ) : null,
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

    // ---------- 子视图：快捷键设置（录制式，参考 sidebar-file-search） ----------
    function ShortcutSettingsView({ t, spec, onChange }) {
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
              hasValue && !capturing ? h('button', {
                type: 'button', className: 'qsp-keyclear',
                title: t('clearShortcut'), 'aria-label': t('clearShortcut'),
                onClick: () => {
                  if (typeof window !== 'undefined' && !window.confirm(t('shortcutClearConfirm'))) return;
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

      // 引用：避免闭包过期 / 记住 DOM 与插入位置
      const triggerRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const spanRef = React.useRef(null);
      const settingsRef = useLatestRef(settings);
      const promptsRef = useLatestRef(prompts);
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
              await dav.write(cfg, promptsRef.current);
              setSync({ text: t('synced') + ' · ' + timeLabel(), error: false });
            } else {
              const res = await dav.read(cfg);
              const remote = res && res.data && Array.isArray(res.data.prompts) ? res.data.prompts : null;
              if (remote) {
                commit(remote.map(normalizePrompt));
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
      useAutoUploadOnEdit(prompts, settings.autoSyncMinutes, () => runSync(SYNC_MODE.upload, { silent: true }));

      // 派生数据（分组 / 搜索 / tab / 当前列表）
      const groups = React.useMemo(() => collectGroups(prompts), [prompts]);
      const matched = React.useMemo(() => matchPrompts(prompts, query), [prompts, query]);
      const tabs = React.useMemo(() => buildTabs(t, groups, matched), [t, groups, matched]);
      const effGroup = tabs.some((x) => x.key === activeGroup) ? activeGroup : GROUP_ALL;
      const filtered = React.useMemo(() => byGroup(matched, effGroup), [matched, effGroup]);
      const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
      const editing = screen && screen.name === SCREEN.edit ? screen.draft : null;

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
      const updateDraft = (patch) => setScreen((s) => (
        s && s.name === SCREEN.edit ? { name: SCREEN.edit, draft: { ...s.draft, ...patch } } : s
      ));
      const submitEdit = () => {
        if (!editing) return;
        const title = (editing.title || '').trim();
        const content = (editing.content || '').trim();
        const group = (editing.group || '').trim();
        if (!title || !content) { setFormError(t('required')); return; }
        if (editing.id) {
          commit(prompts.map((p) => (p.id === editing.id ? { ...p, title, content, group } : p)));
        } else {
          commit([{ id: uid(), title, content, group, createdAt: Date.now() }, ...prompts]);
        }
        setScreen({ name: SCREEN.list }); setFormError('');
      };
      const removePrompt = (p) => {
        if (typeof window !== 'undefined' && !window.confirm(t('delConfirm'))) return;
        commit(prompts.filter((x) => x.id !== p.id));
      };

      // 列表键盘：上下移动、回车/Tab 插入
      const onListKeyDown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeLayer(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.max(0, Math.min(a + 1, filtered.length - 1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
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
          ? h(ShortcutSettingsView, { t, spec, onChange: changeSpec })
          : h(SyncSettingsView, {
            t, settings, sync, syncing,
            onChange: (patch) => setSettings((s) => ({ ...s, ...patch })),
            onSyncNow: () => runSync(SYNC_MODE.upload),
            onRestore: () => {
              if (typeof window !== 'undefined' && !window.confirm(t('restoreConfirm'))) return;
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
      } else {
        ops = h(React.Fragment, null,
          h(IconButton, { label: t('settings'), onClick: () => setScreen({ name: SCREEN.settings, tab: SETTINGS_TAB.shortcut }) }, h(GearIcon)),
          h(IconButton, {
            className: 'qsp-iconbtn-accent', label: t('add'),
            onClick: () => openEditor({ title: '', content: '', group: effGroup === GROUP_ALL ? '' : effGroup }),
          }, h(PlusIcon, { size: 16 })),
        );
        body = h(PromptListView, {
          t, items: filtered, query, tabs, activeGroup: effGroup, showTabs: groups.names.length > 0,
          activeIndex, searchRef,
          emptyText: (query || effGroup !== GROUP_ALL) ? t('noResult') : t('empty'),
          onQueryChange: (v) => { setQuery(v); setActive(0); },
          onSelectGroup: (key) => { setActiveGroup(key); setActive(0); },
          onActive: setActive,
          onInsert: (p) => insert(p.content),
          onEdit: (p) => openEditor({ ...p }),
          onDelete: removePrompt,
        });
      }

      const dialog = h(DialogShell, {
        t, title, ops, tabs: dialogTabs,
        onClose: closeLayer,
        onMaskDown: closeLayer,
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.preventDefault(); closeLayer(); return; }
          if (screen.name === SCREEN.list) onListKeyDown(e);
        },
      }, body);

      return h(React.Fragment, null, trigger, createPortal(dialog, document.body));
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
