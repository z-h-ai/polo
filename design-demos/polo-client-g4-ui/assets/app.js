(() => {
  const icons = {
    home: "M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-8.5Z",
    spark: ["m12 3-1.6 5.4L5 10l5.4 1.6L12 17l1.6-5.4L19 10l-5.4-1.6L12 3Z", "m19 16-.7 2.3L16 19l2.3.7L19 22l.7-2.3L22 19l-2.3-.7L19 16Z"],
    grid: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
    file: ["M6 3h8l4 4v14H6z", "M14 3v5h5", "M9 13h6M9 17h6"],
    task: ["M5 4h14v16H5z", "m8 9 1.5 1.5L12 8", "M13 10h3", "m8 15 1.5 1.5L12 14", "M13 16h3"],
    bell: ["M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21h4"],
    play: ["M8 5v14l11-7z"],
    search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4-4"],
    settings: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M4.9 4.9 7 7", "M17 17l2.1 2.1", "M4 12H2", "M22 12h-2", "M12 4V2", "M12 22v-2"],
    moon: ["M21 12.7A9 9 0 1 1 11.3 3 7 7 0 0 0 21 12.7Z"],
    sun: ["M12 4V2", "M12 22v-2", "m4.93 4.93-1.41-1.41", "m20.48 20.48-1.41-1.41", "M4 12H2", "M22 12h-2", "m4.93 19.07-1.41 1.41", "m20.48 3.52-1.41 1.41", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
    arrow: "m9 18 6-6-6-6",
    close: ["M18 6 6 18", "M6 6l12 12"],
    check: "m5 12 4 4L19 6",
    clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
    shield: ["M12 3 5 6v5c0 4.8 2.9 8.3 7 10 4.1-1.7 7-5.2 7-10V6l-7-3Z", "m9 12 2 2 4-5"],
    user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 21a8 8 0 0 1 16 0"],
    download: ["M12 3v12", "m7 10 5 5 5-5", "M4 20h16"],
    refresh: ["M20 11a8 8 0 1 0 2 5.5", "M20 4v7h-7"],
    external: ["M14 4h6v6", "m20 4-9 9", "M18 13v6H5V6h6"],
    app: ["M4 5h16v14H4z", "M8 9h8M8 13h5"]
  };

  const icon = (name, className = "") => {
    const paths = Array.isArray(icons[name]) ? icons[name] : [icons[name]];
    return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(path => `<path d="${path}"></path>`).join("")}</svg>`;
  };

  const spaces = {
    personal: { name: "我的空间", type: "个人工作上下文", short: "我", payer: "个人承担 AI 算力" },
    enterprise: { name: "知远智能", type: "企业空间 · Member", short: "知", payer: "知远智能承担 AI 算力" }
  };

  const catalog = {
    personal: {
      recent: [
        { id: "assistant", name: "Polo 助手", detail: "8 月项目复盘 · 2 分钟前", kind: "spark", action: "打开" },
        { id: "research", name: "客户访谈整理", detail: "北极星工作室 · 昨天", kind: "app", action: "打开" },
        { id: "files", name: "文件", detail: "12 个文件发生变化 · 周一", kind: "file", action: "查看" }
      ],
      added: [
        { id: "research", name: "客户访谈整理", source: "认证创作者 · 北极星工作室", description: "把录音与笔记整理为可审核洞察。", status: "可使用", tone: "good", action: "打开" },
        { id: "cleaner", name: "素材清洗器", source: "认证创作者 · 北极星工作室", description: "检查格式与字段，准备本次执行。", status: "准备中", tone: "info", action: "查看" },
        { id: "brand", name: "品牌洞察", source: "认证创作者 · 桥见圈子", description: "新版本将在下次启动时生效。", status: "更新中", tone: "info", action: "查看更新" },
        { id: "disabled", name: "增长顾问", source: "认证创作者 · 增长顾问圈", description: "该作品已停止向此空间分发。", status: "已停用", tone: "neutral", action: "查看说明" },
        { id: "blocked", name: "合规审阅", source: "认证创作者 · 桥见圈子", description: "该版本因严重风险被平台阻断。", status: "不可用", tone: "bad", action: "查看原因", disabled: true }
      ],
      available: [
        { id: "writing", name: "商务写作", source: "认证创作者 · 桥见圈子", description: "根据选定材料生成正式商务文本。", status: "可添加", tone: "good", action: "添加到首页" },
        { id: "weekly", name: "销售周报助手", source: "企业内部导入 · 仅知远智能", description: "企业成员可用，个人空间不能添加。", status: "不可用", tone: "bad", action: "查看权限", disabled: true }
      ],
      skills: [
        { name: "资料研究", source: "Polo 内置", description: "检索已授权的材料并整理出处。", status: "已启用", tone: "good" },
        { name: "商务写作", source: "认证创作者 · 桥见圈子", description: "将提纲转换为正式中文稿件。", status: "可启用", tone: "neutral" },
        { name: "会议摘要", source: "认证创作者 · 北极星工作室", description: "从会议材料提取决定与待办。", status: "已启用", tone: "good" }
      ],
      results: [
        { title: "客户访谈洞察 · 第 12 版", description: "客户访谈整理已保存 4 条洞察和 2 个待确认问题。", meta: "客户访谈整理 · 12 分钟前" },
        { title: "文件变化", description: "“Q3 访谈材料”新增 3 个文件。", meta: "文件 · 昨天" },
        { title: "作品版本提醒", description: "品牌洞察有一个新版本可供下次启动使用。", meta: "品牌洞察 · 周一" }
      ]
    },
    enterprise: {
      recent: [
        { id: "board", name: "项目交付看板", detail: "季度交付 · 6 分钟前", kind: "app", action: "打开" },
        { id: "assistant", name: "Polo 助手", detail: "企业知识检索 · 昨天", kind: "spark", action: "打开" },
        { id: "tasks", name: "任务与结果", detail: "3 项运行记录 · 周一", kind: "task", action: "查看" }
      ],
      added: [
        { id: "board", name: "项目交付看板", source: "企业内部导入 · 知远智能", description: "查看当前项目的里程碑、风险和交付材料。", status: "可使用", tone: "good", action: "打开" },
        { id: "weekly", name: "销售周报助手", source: "企业内部导入 · 知远智能", description: "正在生成本周销售摘要，完成后通知你。", status: "准备中", tone: "info", action: "查看" },
        { id: "knowledge", name: "企业知识检索", source: "企业内部导入 · 知远智能", description: "只读取企业已授权的知识库。", status: "可使用", tone: "good", action: "打开" },
        { id: "legacy", name: "旧版报价助手", source: "企业内部导入 · 知远智能", description: "企业已停用此版本，历史结果仍保留。", status: "已停用", tone: "neutral", action: "查看结果" }
      ],
      available: [
        { id: "research", name: "客户访谈整理", source: "认证创作者 · 北极星工作室", description: "该作品已获授权，但尚未添加到企业首页。", status: "可添加", tone: "good", action: "添加到首页" },
        { id: "private", name: "财务摘要", source: "企业内部导入 · 财务组", description: "需要 Owner 扩大成员范围后才能使用。", status: "不可用", tone: "bad", action: "查看权限", disabled: true }
      ],
      skills: [
        { name: "企业知识检索", source: "企业内部导入 · 知远智能", description: "在企业授权范围内检索资料。", status: "已启用", tone: "good" },
        { name: "项目风险摘要", source: "企业内部导入 · 知远智能", description: "整理项目材料中的风险和阻塞。", status: "已启用", tone: "good" },
        { name: "资料研究", source: "个人空间授权不可继承", description: "个人空间中的 Skill 不会进入企业空间。", status: "不可用", tone: "bad" }
      ],
      results: [
        { title: "季度交付摘要", description: "项目交付看板已保存本周里程碑和 3 个风险项。", meta: "项目交付看板 · 6 分钟前" },
        { title: "运行状态变化", description: "销售周报助手完成材料准备，等待企业数据读取。", meta: "任务与结果 · 1 小时前" },
        { title: "企业目录变化", description: "企业知识检索更新到 v3.2.0，下一次启动生效。", meta: "企业目录 · 昨天" }
      ]
    }
  };

  const state = { space: "personal", activeTab: "home", tabs: [], theme: localStorage.getItem("polo-g4-theme") || "light", openMenu: null, runtimeOpen: false, notificationOpen: false, accountOpen: false, toastTimer: null };
  const $ = selector => document.querySelector(selector);
  const main = $("#workspace-main");

  const appName = id => ({ assistant: "Polo 助手", research: "客户访谈整理", cleaner: "素材清洗器", brand: "品牌洞察", writing: "商务写作", board: "项目交付看板", weekly: "销售周报助手", knowledge: "企业知识检索", files: "文件", tasks: "任务与结果", disabled: "增长顾问", blocked: "合规审阅", legacy: "旧版报价助手", private: "财务摘要" }[id] || "应用");
  const appIcon = id => id === "assistant" ? "spark" : id === "files" ? "file" : id === "tasks" ? "task" : id === "board" ? "app" : "grid";

  function renderSpaceMenu() {
    const active = state.space;
    $("#space-menu").innerHTML = `<div class="menu-label">切换空间</div>${Object.entries(spaces).map(([id, space]) => `<button class="space-row ${active === id ? "active" : ""}" data-space="${id}" role="menuitem"><span class="space-avatar">${space.short}</span><span><b>${space.name}</b><small>${space.payer}</small></span>${active === id ? icon("check", "check") : ""}</button>`).join("")}`;
  }

  function renderAccountMenu() {
    const dark = state.theme === "dark";
    $("#account-menu").innerHTML = `<div class="menu-section-title">林然 · 普通账号</div><button class="menu-row" data-action="notifications" role="menuitem"><span class="menu-icon">${icon("bell")}</span><span class="menu-copy"><b>通知中心</b><small>查看所有空间的通知</small></span>${icon("arrow", "menu-arrow")}</button><button class="menu-row" data-action="settings" role="menuitem"><span class="menu-icon">${icon("settings")}</span><span class="menu-copy"><b>账号与偏好</b><small>安全、外观、通知与下载</small></span>${icon("arrow", "menu-arrow")}</button><button class="menu-row" data-action="theme" role="menuitem"><span class="menu-icon">${icon(dark ? "sun" : "moon")}</span><span class="menu-copy"><b>${dark ? "切换到浅色" : "切换到深色"}</b><small>当前为${dark ? "深色" : "浅色"}主题</small></span></button><div class="menu-divider"></div><div class="menu-section-title">管理入口</div><button class="menu-row" data-action="enterprise-admin" role="menuitem"><span class="menu-icon">${icon("grid")}</span><span class="menu-copy"><b>企业组织管理端</b><small>管理成员、目录与企业预算</small></span>${icon("external", "menu-arrow")}</button><button class="menu-row" data-action="creator-workbench" role="menuitem"><span class="menu-icon">${icon("spark")}</span><span class="menu-copy"><b>创作者工作台</b><small>管理你拥有的作品与圈子</small></span>${icon("external", "menu-arrow")}</button>`;
  }

  function renderTabs() {
    $("#tabs").innerHTML = `<button class="home-tab ${state.activeTab === "home" ? "active" : ""}" data-tab="home" aria-label="首页">${icon("home")}</button>${state.tabs.map(id => `<button class="tab ${state.activeTab === id ? "active" : ""}" data-tab="${id}"><span class="tab-icon">${icon(appIcon(id))}</span><span>${appName(id)}</span><span class="tab-close" data-close="${id}" aria-label="关闭 ${appName(id)}">×</span></button>`).join("")}`;
  }

  function productCard(item) {
    return `<article class="product-card"><div class="card-heading"><span class="app-art ${item.tone === "good" ? "teal" : item.tone === "info" ? "amber" : "ink"}">${icon(appIcon(item.id))}</span><div class="card-title"><h3>${item.name}</h3><p class="source-line">${item.source}</p></div></div><p class="product-description">${item.description}</p>${item.status === "准备中" ? `<div class="progress-bar" aria-label="准备进度 68%"><i></i></div>` : ""}<div class="status-line"><span class="status ${item.tone}">${item.status}</span><button class="card-action ${item.action === "打开" || item.action === "添加到首页" ? "primary" : ""}" data-open="${item.id}" ${item.disabled ? "disabled" : ""}>${item.action}</button></div></article>`;
  }

  function continueCard(item) {
    return `<article class="continue-card"><span class="app-art ${item.kind === "spark" ? "" : item.kind === "file" ? "teal" : "ink"}">${icon(item.kind)}</span><div class="card-title"><h3>${item.name}</h3><p>${item.detail}</p></div><button class="card-action" data-open="${item.id}">${item.action}</button></article>`;
  }

  function skillCard(item) {
    return `<article class="skill-card"><div class="card-heading"><span class="app-art ${item.tone === "good" ? "teal" : item.tone === "bad" ? "ink" : "amber"}">${icon("spark")}</span><div class="card-title"><h3>${item.name}</h3><p class="source-line">${item.source}</p></div></div><p class="product-description">${item.description}</p><div class="skill-callout">由 Polo 助手调用 · ${item.status}</div></article>`;
  }

  function section(title, subtitle, content, link = "") {
    return `<section class="section"><div class="section-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${link ? `<button class="section-link">${link}</button>` : ""}</div>${content}</section>`;
  }

  function homeView() {
    const space = spaces[state.space];
    const data = catalog[state.space];
    return `<div class="page-heading"><div><p class="eyebrow">Polo 工作台</p><h1>${space.name}</h1><p>从当前空间打开已授权的工作应用。空间切换会同时替换目录、数据、权限和费用承担方。</p></div><div class="heading-context">${icon("shield")}<span>当前付款方：<strong>${space.payer}</strong></span></div></div>${section("继续使用和最近打开", "从上次离开的地方继续。", `<div class="continue-grid">${data.recent.map(continueCard).join("")}</div>`)}${section("当前空间已添加的 Apps", "已添加到首页的工作应用。", `<div class="card-grid">${data.added.map(productCard).join("")}</div>`, "管理首页")}${section("可添加的 Apps", "已获授权但尚未添加，或当前空间不具备使用权限。", `<div class="card-grid">${data.available.map(productCard).join("")}</div>`)}${section("Polo 内置应用", "由 Polo 提供并维护，在每个空间中拥有独立实例。", `<div class="built-in-grid"><article class="built-in-card"><span class="app-art">${icon("spark")}</span><div><h3>Polo 助手</h3><p>对话、材料处理和已授权 Skill 调用。</p></div><button class="card-action primary" data-open="assistant">打开</button></article><article class="built-in-card"><span class="app-art teal">${icon("file")}</span><div><h3>文件</h3><p>查看当前空间的上传、保存和导出文件。</p></div><button class="card-action" data-open="files">打开</button></article><article class="built-in-card"><span class="app-art amber">${icon("task")}</span><div><h3>任务与结果</h3><p>查看 Polo 掌握的运行状态与已保存结果。</p></div><button class="card-action" data-open="tasks">打开</button></article></div>`)}${section("当前空间可供 Polo 助手使用的 Skills", "Skills 是助手的扩展能力，不会生成独立 App Tab。", `<div class="skills-grid">${data.skills.map(skillCard).join("")}</div>`)}${section("最近结果与内容变化", "已保存到当前空间的结果和目录变化。", `<div class="results-grid">${data.results.map(result => `<article class="result-card"><h3>${result.title}</h3><p>${result.description}</p><div class="result-foot"><span>${result.meta}</span><a href="#" data-result="${result.title}">查看</a></div></article>`).join("")}</div>`)}`;
  }

  function appView(id) {
    const name = appName(id);
    const space = spaces[state.space];
    const detail = id === "assistant" ? "这是当前空间独立的 Polo 助手实例。会话、文件、已启用 Skills 和费用承担方不会与其他空间混用。" : id === "files" ? "这里展示用户上传、App 保存、助手生成和用户导出的文件，并标记来源、创建者、空间和时间。" : id === "tasks" ? "这里展示 Polo 掌握的运行状态、最小计量和明确保存的结果。App 内部业务工作项仍由 App 自己管理。" : `${name} 正在${space.name}中运行。当前 App 保留自己的业务数据结构，Polo 只提供可信的账号、空间和授权边界。`;
    return `<div class="page-heading"><div><p class="eyebrow">${space.name} · 应用</p><h1>${name}</h1><p>${detail}</p></div><div class="heading-context">${icon("shield")}<span>空间：<strong>${space.name}</strong></span></div></div><section class="section"><div class="section-header"><div><h2>${id === "assistant" ? "会话工作区" : id === "files" ? "当前空间文件" : id === "tasks" ? "运行与结果" : "应用工作区"}</h2><p>应用内操作留在当前 App Tab。</p></div><span class="status good">可使用</span></div><div class="product-card app-placeholder"><div class="app-placeholder-icon">${icon(appIcon(id))}</div><h2>${id === "assistant" ? "开始一段新的对话" : id === "files" ? "文件已按当前空间隔离" : id === "tasks" ? "没有需要你处理的运行项" : "准备开始一次新的使用"}</h2><p>${id === "assistant" ? "选择材料后，Polo 助手会在对话中说明调用的 Skill 和权限。" : "这是纯产品壳层中的 App 入口，后续流程将在此 Tab 内承载。"}</p><button class="button primary" data-action="app-primary">${id === "tasks" ? "查看最近结果" : "开始使用"}</button></div></section>`;
  }

  function renderMain() {
    main.innerHTML = state.activeTab === "home" ? homeView() : appView(state.activeTab);
  }

  function renderChrome() {
    const space = spaces[state.space];
    $("#space-avatar").textContent = space.short;
    $("#space-name").textContent = space.name;
    $("#space-type").textContent = space.type;
    document.documentElement.dataset.theme = state.theme;
    renderSpaceMenu();
    renderAccountMenu();
    renderTabs();
    $("#space-menu").hidden = state.openMenu !== "space";
    $("#account-menu").hidden = state.openMenu !== "account";
    $("#space-trigger").setAttribute("aria-expanded", String(state.openMenu === "space"));
    $("#account-button").setAttribute("aria-expanded", String(state.openMenu === "account"));
    $("#notification-button").setAttribute("aria-expanded", String(state.notificationOpen));
    $("#runtime-button").setAttribute("aria-expanded", String(state.runtimeOpen));
  }

  function render() { renderChrome(); renderMain(); }

  function openTab(id) {
    if (!["assistant", "files", "tasks", "research", "cleaner", "brand", "writing", "board", "weekly", "knowledge"].includes(id)) id = "assistant";
    if (!state.tabs.includes(id)) state.tabs.push(id);
    state.activeTab = id;
    state.openMenu = null;
    state.notificationOpen = false;
    state.runtimeOpen = false;
    render();
  }

  function closeTab(id) {
    state.tabs = state.tabs.filter(tab => tab !== id);
    if (state.activeTab === id) state.activeTab = "home";
    render();
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
  }

  function showModal(content) {
    const layer = $("#modal-layer");
    layer.innerHTML = content;
    layer.hidden = false;
    layer.querySelector(".dialog")?.focus();
  }

  function closeModal() { $("#modal-layer").hidden = true; $("#modal-layer").innerHTML = ""; }

  function openRuntime() {
    state.openMenu = null;
    state.runtimeOpen = true;
    renderChrome();
    showModal(`<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-title" tabindex="-1"><div class="dialog-header"><div><h2 id="runtime-title">运行中心</h2><p>当前空间的执行会持续显示在这里。切换空间前必须完成或终止运行。</p></div><button class="close-button" data-close-modal aria-label="关闭">${icon("close")}</button></div><div class="dialog-body"><div class="dialog-list"><div class="dialog-row"><span class="app-art amber">${icon("app")}</span><span class="row-copy"><strong>${state.space === "personal" ? "客户访谈整理" : "销售周报助手"}</strong><small>${spaces[state.space].name} · 已准备 68% · 由当前空间承担费用</small></span><span class="row-state">运行中</span></div></div></div><div class="dialog-footer"><button class="button" data-close-modal>关闭</button><button class="button primary" data-action="view-runtime">查看任务与结果</button></div></section>`);
  }

  function openNotifications() {
    state.openMenu = null;
    state.runtimeOpen = false;
    state.notificationOpen = true;
    renderChrome();
    showModal(`<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="notification-title" tabindex="-1"><div class="dialog-header"><div><h2 id="notification-title">通知中心</h2><p>通知可以来自不同空间，每条通知都会标明所属空间。</p></div><button class="close-button" data-close-modal aria-label="关闭">${icon("close")}</button></div><div class="dialog-body"><div class="notice-list"><div class="notice"><span class="notice-mark"></span><div><strong>销售周报助手正在准备材料</strong><p>任务准备完成后，你可以在知远智能中继续查看。</p><small>知远智能 · 6 分钟前</small></div></div><div class="notice success"><span class="notice-mark"></span><div><strong>客户访谈整理已保存结果</strong><p>新增 4 条洞察和 2 个待确认问题。</p><small>我的空间 · 12 分钟前</small></div></div><div class="notice"><span class="notice-mark"></span><div><strong>品牌洞察有新版本</strong><p>下次启动时将使用更新后的稳定版本。</p><small>我的空间 · 周一</small></div></div></div></div><div class="dialog-footer"><button class="button" data-close-modal>关闭</button></div></section>`);
  }

  function requestSpace(next) {
    if (next === state.space) { state.openMenu = null; render(); return; }
    if (state.space === "personal") {
      state.openMenu = null;
      render();
      showModal(`<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="switch-title" tabindex="-1"><div class="dialog-header"><div><h2 id="switch-title">切换到知远智能</h2><p>当前空间有一项运行中的任务。必须先终止它，才能安全切换空间。</p></div><button class="close-button" data-close-modal aria-label="关闭">${icon("close")}</button></div><div class="dialog-body"><div class="dialog-list"><div class="dialog-row"><span class="app-art amber">${icon("app")}</span><span class="row-copy"><strong>客户访谈整理</strong><small>我的空间 · 材料准备中</small></span><span class="row-state">运行中</span></div></div></div><div class="dialog-footer"><button class="button" data-close-modal>留在我的空间</button><button class="button primary" data-action="stop-and-switch">终止并切换</button></div></section>`);
    } else {
      state.space = next;
      state.activeTab = "home";
      state.tabs = [];
      state.openMenu = null;
      render();
      showToast(`已切换到${spaces[next].name}，目录和会话已重新加载。`);
    }
  }

  document.addEventListener("click", event => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.matches("[data-close-modal]")) { closeModal(); state.runtimeOpen = false; state.notificationOpen = false; renderChrome(); return; }
    if (target.id === "space-trigger") { state.openMenu = state.openMenu === "space" ? null : "space"; state.accountOpen = false; renderChrome(); return; }
    if (target.id === "account-button") { state.openMenu = state.openMenu === "account" ? null : "account"; renderChrome(); return; }
    if (target.id === "runtime-button") { if (state.runtimeOpen) { closeModal(); state.runtimeOpen = false; renderChrome(); } else openRuntime(); return; }
    if (target.id === "notification-button") { if (state.notificationOpen) { closeModal(); state.notificationOpen = false; renderChrome(); } else openNotifications(); return; }
    if (target.matches("[data-space]")) { requestSpace(target.dataset.space); return; }
    if (target.matches("[data-tab]")) { state.activeTab = target.dataset.tab; state.openMenu = null; render(); return; }
    if (target.matches("[data-close]")) { event.stopPropagation(); closeTab(target.dataset.close); return; }
    if (target.matches("[data-open]")) { openTab(target.dataset.open); return; }
    if (target.dataset.action === "notifications") { openNotifications(); return; }
    if (target.dataset.action === "theme") { state.theme = state.theme === "dark" ? "light" : "dark"; localStorage.setItem("polo-g4-theme", state.theme); render(); showToast(`已切换到${state.theme === "dark" ? "深色" : "浅色"}主题。`); return; }
    if (["settings", "enterprise-admin", "creator-workbench"].includes(target.dataset.action)) { state.openMenu = null; render(); showToast(target.dataset.action === "settings" ? "账号与偏好将在设置中打开。" : "此入口将在系统浏览器中打开。"); return; }
    if (target.dataset.action === "stop-and-switch") { closeModal(); state.space = "enterprise"; state.activeTab = "home"; state.tabs = []; state.runtimeOpen = false; render(); showToast("运行项已终止，已安全切换到知远智能。"); return; }
    if (target.dataset.action === "view-runtime") { closeModal(); state.activeTab = "tasks"; state.runtimeOpen = false; openTab("tasks"); return; }
    if (target.dataset.action === "app-primary") { showToast("已在当前 App Tab 中准备新的使用。后续流程将在此继续。"); return; }
    if (target.dataset.result) { event.preventDefault(); showToast(`已打开“${target.dataset.result}”。`); return; }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!$("#modal-layer").hidden) { closeModal(); state.runtimeOpen = false; state.notificationOpen = false; renderChrome(); }
      else if (state.openMenu) { state.openMenu = null; renderChrome(); }
    }
  });

  window.addEventListener("resize", () => { $("#window-guard").hidden = window.innerWidth > 640; });
  $("#window-guard").hidden = window.innerWidth > 640;
  render();
})();
