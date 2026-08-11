(() => {
  const icons = {
    home: "M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-8.5Z",
    spark: ["m12 3-1.6 5.4L5 10l5.4 1.6L12 17l1.6-5.4L19 10l-5.4-1.6L12 3Z", "m19 16-.7 2.3L16 19l2.3.7L19 22l.7-2.3L22 19l-2.3-.7L19 16Z"],
    grid: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
    file: ["M6 3h8l4 4v14H6z", "M14 3v5h5", "M9 13h6M9 17h6"],
    folder: ["M3 6h6l2 2h10v11H3z", "M3 8V5h7l2 3"],
    task: ["M5 4h14v16H5z", "m8 9 1.5 1.5L12 8", "M13 10h3", "m8 15 1.5 1.5L12 14", "M13 16h3"],
    bell: ["M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21h4"],
    play: "M8 5v14l11-7z",
    settings: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M4.9 4.9 7 7", "M17 17l2.1 2.1", "M4 12H2", "M22 12h-2", "M12 4V2", "M12 22v-2"],
    moon: ["M21 12.7A9 9 0 1 1 11.3 3 7 7 0 0 0 21 12.7Z"],
    sun: ["M12 4V2", "M12 22v-2", "m4.93 4.93-1.41-1.41", "m20.48 20.48-1.41-1.41", "M4 12H2", "M22 12h-2", "m4.93 19.07-1.41 1.41", "m20.48 3.52-1.41 1.41", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
    arrow: "m9 18 6-6-6-6",
    left: "m15 18-6-6 6-6",
    close: ["M18 6 6 18", "M6 6l12 12"],
    check: "m5 12 4 4L19 6",
    clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z", "M12 7v5l3 2"],
    shield: ["M12 3 5 6v5c0 4.8 2.9 8.3 7 10 4.1-1.7 7-5.2 7-10V6l-7-3Z", "m9 12 2 2 4-5"],
    external: ["M14 4h6v6", "m20 4-9 9", "M18 13v6H5V6h6"],
    app: ["M4 5h16v14H4z", "M8 9h8M8 13h5"],
    circle: ["M16 11a4 4 0 1 0-8 0", "M4 21a8 8 0 0 1 16 0", "M18 4v4M16 6h4"],
    info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 10v6M12 7h.01"],
    upload: ["M12 16V4", "m7 9 5-5 5 5", "M4 20h16"],
    plus: "M12 5v14M5 12h14",
    more: ["M5 12h.01M12 12h.01M19 12h.01"],
    stop: "M7 7h10v10H7z",
    wifi: ["M5 12.5a10 10 0 0 1 14 0", "M8.5 16a5 5 0 0 1 7 0", "M12 20h.01"],
    refresh: ["M20 7v5h-5", "M4 17v-5h5", "M6.1 9A7 7 0 0 1 18 7l2 5", "M17.9 15A7 7 0 0 1 6 17l-2-5"],
    phone: ["M7 3h10v18H7z", "M10 6h4", "M12 18h.01"],
    lock: ["M6 10h12v10H6z", "M8 10V7a4 4 0 0 1 8 0v3"]
  };

  const icon = (name, className = "") => {
    const paths = Array.isArray(icons[name]) ? icons[name] : [icons[name]];
    return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(path => `<path d="${path}"></path>`).join("")}</svg>`;
  };

  const spaces = {
    personal: { name: "我的空间", type: "个人空间", role: "个人", short: "我", dataOwner: "林然" },
    enterprise: { name: "北辰智能科技", type: "企业空间", role: "Member", short: "北", dataOwner: "北辰智能科技" }
  };

  const apps = {
    research: { name: "客户访谈整理", icon: "app", source: "认证创作者 · 北极星工作室", version: "v2.4.1", description: "整理录音与笔记", availability: "available" },
    cleaner: { name: "素材清洗器", icon: "grid", source: "认证创作者 · 北极星工作室", version: "v1.8.0", description: "检查格式与字段", availability: "available" },
    brand: { name: "品牌洞察", icon: "grid", source: "认证创作者 · 桥见圈子", version: "v3.1.0", description: "分析品牌表达", availability: "available", update: true },
    brand_north: { name: "品牌洞察", icon: "grid", source: "认证创作者 · 北极星共创社", version: "v2.9.2", description: "分析品牌表达", availability: "available" },
    disabled: { name: "增长顾问", icon: "grid", source: "认证创作者 · 增长顾问圈", version: "v1.2.0", description: "查看已存结果", availability: "unavailable", reason: "已停止分发。请查看已存结果。" },
    blocked: { name: "合规审阅", icon: "shield", source: "认证创作者 · 桥见圈子", version: "v2.0.3", description: "查看阻断原因", availability: "blocked", reason: "版本已阻断。请查看历史结果。" },
    writing: { name: "商务写作", icon: "app", source: "认证创作者 · 桥见圈子", version: "v1.6.0", description: "生成商务文稿", availability: "available" },
    board: { name: "项目交付看板", icon: "app", source: "企业内部导入 · 北辰智能科技", version: "企业版 v4.2.0", description: "查看里程碑与风险", availability: "available" },
    weekly: { name: "销售周报助手", icon: "app", source: "企业内部导入 · 北辰智能科技", version: "企业版 v2.7.1", description: "生成销售周报", availability: "available" },
    knowledge: { name: "企业知识检索", icon: "grid", source: "企业内部导入 · 北辰智能科技", version: "企业版 v3.2.0", description: "检索企业知识", availability: "available" },
    legacy: { name: "旧版报价助手", icon: "grid", source: "企业内部导入 · 北辰智能科技", version: "企业版 v1.9.4", description: "查看历史结果", availability: "unavailable", reason: "版本已停用。请联系企业管理员。" },
    compliance: { name: "合规文档检索", icon: "shield", source: "企业内部导入 · 北辰智能科技", version: "企业版 v1.1.0", description: "检索合规文档", availability: "available" },
    contract: { name: "合同风险扫描", icon: "shield", source: "企业内部导入 · 北辰智能科技", version: "企业版 v2.1.0", description: "扫描合同风险", availability: "available" },
    review: { name: "项目复盘生成", icon: "app", source: "企业内部导入 · 北辰智能科技", version: "企业版 v1.4.0", description: "生成项目复盘", availability: "available" },
    customer_summary: { name: "客户资料摘要", icon: "grid", source: "企业内部导入 · 北辰智能科技", version: "企业版 v2.0.0", description: "整理客户资料", availability: "available" }
  };

  const catalog = {
    personal: {
      added: ["research", "cleaner", "brand", "disabled", "blocked"],
      available: ["writing"],
      recent: [
        { id: "assistant", detail: "8 月项目复盘 · 2 分钟前" },
        { id: "research", detail: "客户访谈洞察 · 昨天" },
        { id: "files", detail: "12 个文件发生变化 · 周一" }
      ],
      skills: [
        { id: "research_skill", name: "资料研究", source: "Polo 内置", description: "检索资料与出处", permissions: "读取已选文件" },
        { id: "meeting_bridge", name: "会议摘要", source: "认证创作者 · 桥见圈子", description: "提取决定与待办", permissions: "读取会议文件" },
        { id: "meeting_north", name: "会议摘要", source: "认证创作者 · 北极星工作室", description: "生成复盘纪要", permissions: "读取会议文件" },
        { id: "writing_skill", name: "商务写作", source: "认证创作者 · 桥见圈子", description: "生成中文稿件", permissions: "读取对话与文件" }
      ],
      results: [
        { title: "客户访谈洞察 · 第 12 版", description: "查看 4 条洞察", meta: "客户访谈整理 · 12 分钟前" },
        { title: "Q3 访谈材料", description: "查看 3 个新文件", meta: "文件 · 昨天" },
        { title: "品牌洞察版本变化", description: "下次使用 v3.1.0", meta: "目录变化 · 周一" }
      ]
    },
    enterprise: {
      added: ["board", "weekly", "knowledge", "legacy", "compliance"],
      available: ["contract", "review", "customer_summary"],
      recent: [
        { id: "board", detail: "季度交付 · 6 分钟前" },
        { id: "assistant", detail: "企业知识检索 · 昨天" },
        { id: "tasks", detail: "3 项运行记录 · 周一" }
      ],
      skills: [
        { id: "enterprise_search", name: "企业知识检索", source: "企业内部导入 · 北辰智能科技", description: "检索企业资料", permissions: "读取企业知识库" },
        { id: "risk_summary", name: "项目风险摘要", source: "企业内部导入 · 北辰智能科技", description: "整理项目风险", permissions: "读取项目文件" }
      ],
      results: [
        { title: "季度交付摘要", description: "查看 3 个风险项", meta: "项目交付看板 · 6 分钟前" },
        { title: "销售周报等待数据", description: "等待读取材料", meta: "任务与结果 · 1 小时前" },
        { title: "企业目录更新", description: "打开合规文档检索", meta: "企业目录 · 昨天" }
      ]
    }
  };

  const creatorCircles = [
    { id: "bridge", name: "桥见圈子", creator: "桥见创作室", initials: "桥", status: "有效", tone: "good", price: "¥39 / 月", renewal: "2026-09-08", apps: ["brand", "writing", "blocked"], skills: ["meeting_bridge", "writing_skill"], update: "本周新增商务写作 v1.6.0" },
    { id: "north", name: "北极星共创社", creator: "北极星工作室", initials: "北", status: "有效", tone: "good", price: "免费", renewal: "长期有效", apps: ["research", "cleaner", "brand_north"], skills: ["meeting_north"], update: "新增北极星版本的品牌洞察" },
    { id: "growth", name: "增长顾问圈", creator: "增长顾问工作室", initials: "增", status: "已取消续费", tone: "info", price: "¥59 / 月", renewal: "2026-08-31", apps: ["disabled"], skills: [], update: "查看历史结果" }
  ];

  const createSpaceState = (space) => ({
    tabs: [],
    activeTab: "home",
    homeView: "home",
    selectedCircle: null,
    highlightedApp: null,
    highlightedCircle: null,
    highlightedSkill: null,
    circleQuery: "",
    circleFilter: "all",
    catalogQuery: "",
    circleMemberships: space === "personal" ? { bridge: "active", north: "active", growth: "cancelled" } : {},
    assistantPanel: "chat",
    fileQuery: "",
    added: [...catalog[space].added],
    skillEnabled: space === "personal" ? { research_skill: true, meeting_bridge: true } : { enterprise_search: true },
    executions: space === "personal"
      ? [{ id: "exec-research", appId: "research", name: "客户访谈整理", detail: "正在分析 18 份访谈材料", status: "running", background: false }]
      : [{ id: "exec-weekly", appId: "weekly", name: "销售周报助手", detail: "正在准备企业授权数据", status: "preparing", background: true }],
    messages: [
      { role: "assistant", text: space === "personal" ? "使用我的空间内容" : "使用北辰智能科技内容" }
    ]
  });

  const query = new URLSearchParams(window.location.search);
  const initialScene = query.get("scene") || "home-normal";
  const entryScenes = new Set(["login", "access", "logout", "session-expired", "preparing", "home-loading", "account-suspended", "contract-mismatch", "upgrade-help", "upgrade-available", "post-upgrade-rebuild", "safe-degraded"]);
  const initialSystemPhase = ["access", "logout"].includes(initialScene)
    ? "login"
    : ["upgrade-help", "upgrade-available", "post-upgrade-rebuild"].includes(initialScene) ? "contract-mismatch" : initialScene;

  const enterpriseScenes = new Set(["ent-home", "ent-catalog-empty", "ent-app-running", "ent-skills", "ent-assistant", "ent-context", "ent-restricted", "member-out-of-scope", "member-removed", "member-suspended", "ent-restricted-owner", "ent-restricted-manager", "ent-closing"]);
  const state = {
    space: enterpriseScenes.has(initialScene) ? "enterprise" : "personal",
    theme: localStorage.getItem("polo-g4-theme") || "light",
    openMenu: null,
    runtimeOpen: false,
    notificationOpen: false,
    settingsOpen: false,
    toastTimer: null,
    scene: initialScene,
    systemPhase: entryScenes.has(initialScene) ? initialSystemPhase : null,
    authMode: "phone",
    authPhone: "",
    authError: "",
    newAccountJourney: ["login", "access"].includes(initialScene),
    systemHelpOpen: initialScene === "upgrade-help",
    upgradeStage: initialScene === "post-upgrade-rebuild" ? "rebuild" : "available",
    online: !["offline-home", "offline-start-blocked", "running-disconnected", "reconnect-revalidate", "unknown-not-success", "terminate-offline"].includes(initialScene),
    reconnecting: false,
    pendingSwitch: null,
    accessLoss: ["member-removed", "member-suspended"].includes(initialScene) ? initialScene : null,
    enterpriseRestriction: ["ent-restricted", "ent-restricted-owner", "ent-restricted-manager", "ent-closing"].includes(initialScene) ? initialScene : null,
    catalogFailed: initialScene === "catalog-failed",
    homeLoading: initialScene === "home-loading",
    unavailableSpaces: new Set(),
    spaces: { personal: createSpaceState("personal"), enterprise: createSpaceState("enterprise") }
  };

  if (initialScene === "home-empty") {
    state.spaces.personal.added = [];
    state.spaces.personal.executions = [];
    state.spaces.personal.circleMemberships = { bridge: "left", north: "left", growth: "left" };
    state.spaces.personal.skillEnabled = {};
    catalog.personal.results = [];
  }
  if (["running-disconnected", "unknown-not-success", "terminate-offline"].includes(initialScene)) {
    state.spaces.personal.executions[0].status = "waiting_for_network";
    state.spaces.personal.executions[0].detail = initialScene === "unknown-not-success" ? "连接中断，执行结果尚未确认" : "网络已断开，等待恢复或终止";
  }
  if (["offline-home", "offline-start-blocked"].includes(initialScene)) state.spaces.personal.executions = [];
  if (initialScene === "terminate-failed") {
    state.spaces.personal.executions.push({ id: "exec-cleaner", appId: "cleaner", name: "素材清洗器", detail: "正在校验 42 个素材文件", status: "running", background: true });
  }
  if (state.enterpriseRestriction) state.spaces.enterprise.executions.forEach(item => { item.status = "stopped"; item.detail = "企业空间受限，执行已终止"; });
  if (initialScene === "assistant-switch") {
    state.spaces.personal.tabs = ["assistant"];
    state.spaces.personal.activeTab = "assistant";
  }
  if (["history-preserved", "running-disconnected", "unknown-not-success", "terminate-offline"].includes(initialScene)) {
    state.spaces.personal.tabs = ["tasks"];
    state.spaces.personal.activeTab = "tasks";
  }

  const catalogScenes = new Set(["catalog-normal", "catalog-empty", "work-hidden", "work-restore"]);
  const circleScenes = new Set(["my-circles-empty", "my-circles", "join-success-detail", "already-joined", "cancel-renewal", "leave-now", "grace-period"]);
  const assistantScenes = new Set(["skills-list", "skill-enable-confirm", "skill-enabled", "assistant-home", "chat-normal", "skill-source-picker", "skill-permission-confirm", "skill-running", "skill-result", "chat-failed", "skill-expired", "skill-blocked", "skills-empty", "history-loading", "ent-skills", "ent-assistant", "personal-no-ent-history"]);
  const accountScenes = new Set(["account-overview", "admin-entry-owner", "admin-entry-creator-active", "admin-entry-creator-suspended", "deletion-blocked"]);

  if (catalogScenes.has(initialScene)) {
    state.spaces.personal.homeView = "catalog";
    if (initialScene === "catalog-empty") state.spaces.personal.added = [];
    if (initialScene === "work-hidden") state.spaces.personal.added = state.spaces.personal.added.filter(id => id !== "brand");
    if (initialScene === "work-restore" && !state.spaces.personal.added.includes("brand")) state.spaces.personal.added.push("brand");
  }

  if (circleScenes.has(initialScene)) {
    state.spaces.personal.homeView = "circles";
    if (initialScene === "my-circles-empty") state.spaces.personal.circleMemberships = { bridge: "left", north: "left", growth: "left" };
    if (["join-success-detail", "already-joined", "cancel-renewal", "grace-period"].includes(initialScene)) state.spaces.personal.selectedCircle = "bridge";
    if (initialScene === "cancel-renewal") state.spaces.personal.circleMemberships.bridge = "cancelled";
    if (initialScene === "grace-period") state.spaces.personal.circleMemberships.bridge = "grace";
  }

  if (assistantScenes.has(initialScene)) {
    const targetSpace = initialScene.startsWith("ent-") ? "enterprise" : "personal";
    state.space = targetSpace;
    state.spaces[targetSpace].tabs = ["assistant"];
    state.spaces[targetSpace].activeTab = "assistant";
    state.spaces[targetSpace].assistantPanel = ["skills-list", "skill-enable-confirm", "skill-enabled", "skills-empty", "ent-skills"].includes(initialScene) ? "skills" : "chat";
    if (initialScene === "skill-enable-confirm") {
      state.spaces.personal.highlightedSkill = "writing_skill";
      state.spaces.personal.skillEnabled.writing_skill = false;
    }
    if (initialScene === "skill-enabled") state.spaces.personal.skillEnabled.writing_skill = true;
  }

  const appSceneMap = {
    "app-detail": ["research", null],
    "app-preparing": ["cleaner", "preparing"],
    "app-running": ["research", "running"],
    "app-update-available": ["brand", null],
    "app-failed": ["cleaner", "failed"],
    "ent-app-running": ["board", "running"]
  };
  if (appSceneMap[initialScene]) {
    const targetSpace = initialScene.startsWith("ent-") ? "enterprise" : "personal";
    const [appId, executionStatus] = appSceneMap[initialScene];
    state.space = targetSpace;
    state.spaces[targetSpace].tabs = [appId];
    state.spaces[targetSpace].activeTab = appId;
    state.spaces[targetSpace].executions = executionStatus ? [{ id: `fixture-${appId}`, appId, name: apps[appId].name, detail: executionStatus === "failed" ? "准备资源时失败，可以安全重试" : executionStatus === "preparing" ? "正在准备首次使用所需资源" : "正在处理当前空间中的材料", status: executionStatus, background: false }] : [];
  }

  if (initialScene === "ent-catalog-empty") {
    state.spaces.enterprise.homeView = "catalog";
    state.spaces.enterprise.added = [];
    state.spaces.enterprise.executions = [];
  }
  if (initialScene === "offline-start-blocked") {
    state.spaces.personal.tabs = ["research"];
    state.spaces.personal.activeTab = "research";
  }
  if (initialScene === "reconnect-revalidate") {
    state.spaces.personal.tabs = ["tasks"];
    state.spaces.personal.activeTab = "tasks";
    state.spaces.personal.executions[0].status = "waiting_for_network";
    state.spaces.personal.executions[0].detail = "恢复网络后继续";
  }
  if (initialScene === "ent-home" || initialScene === "ent-context") state.spaces.enterprise.executions = [];
  if (initialScene === "personal-no-ent-history") {
    state.space = "personal";
    state.spaces.personal.messages = [{ role: "assistant", text: "开始我的空间新对话" }];
  }
  if (["switcher-normal", "client-space-appears"].includes(initialScene)) state.openMenu = "space";
  if (accountScenes.has(initialScene)) state.settingsOpen = true;

  const $ = selector => document.querySelector(selector);
  const current = () => state.spaces[state.space];
  const currentSpace = () => spaces[state.space];
  const main = $("#workspace-main");
  const shell = $("#app-shell");
  const systemScreen = $("#system-screen");
  const builtIns = {
    assistant: { name: "Polo 助手", icon: "spark", source: "Polo 内置", version: "由 Polo 维护" },
    files: { name: "文件", icon: "folder", source: "Polo 内置", version: "由 Polo 维护" },
    tasks: { name: "任务与结果", icon: "task", source: "Polo 内置", version: "由 Polo 维护" }
  };
  const permissionScopes = {
    assistant: space => `读取${space.name}已选文件与 Skills`,
    files: space => `查看${space.name}最近文件与位置`,
    tasks: space => `查看或终止${space.name}任务`,
    research: space => `读取访谈材料并保存结果`,
    cleaner: space => `读取素材并保存清洗结果`,
    brand: space => `读取品牌材料并保存洞察`,
    brand_north: space => `读取品牌材料并保存洞察`,
    writing: space => `读取提纲并保存文稿`,
    board: space => `读取项目与交付材料`,
    weekly: space => `读取销售与补充材料`,
    knowledge: space => `检索${space.name}企业知识库`,
    compliance: space => `检索合规文档并保存引用`,
    contract: space => `读取合同并保存风险清单`,
    review: space => `读取项目材料并保存复盘`,
    customer_summary: space => `读取客户资料并保存摘要`
  };

  const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const appMeta = id => builtIns[id] || apps[id] || { name: "应用", icon: "grid" };
  const visibleCircles = () => creatorCircles.filter(circle => current().circleMemberships[circle.id] !== "left");
  const circleById = id => creatorCircles.find(circle => circle.id === id);
  const circleMembership = circle => {
    const stateName = current().circleMemberships[circle.id];
    if (stateName === "cancelled") return { label: "已取消续费", tone: "info", renewal: circle.renewal === "长期有效" ? "长期有效" : `可用至 ${circle.renewal}` };
    if (stateName === "grace") return { label: "续费宽限期", tone: "bad", renewal: "7 天内完成续费" };
    return { label: circle.status, tone: circle.tone, renewal: circle.renewal };
  };
  const authorizedCircleAppIds = () => [...new Set(visibleCircles().flatMap(circle => circle.apps))];
  const currentSkills = () => state.space === "enterprise" ? catalog.enterprise.skills : catalog.personal.skills.filter(skill => skill.source === "Polo 内置" || visibleCircles().some(circle => circle.skills.includes(skill.id)));
  const activeExecutions = (space = state.space) => state.spaces[space].executions.filter(item => ["preparing", "running", "waiting_for_network", "stopping"].includes(item.status));
  const finishedExecutions = (space = state.space) => state.spaces[space].executions.filter(item => ["stopped", "failed", "completed", "unknown"].includes(item.status));
  const executionFor = id => activeExecutions().find(item => item.appId === id);
  const statusLabel = status => ({ preparing: "准备中", running: "运行中", waiting_for_network: "等待网络", stopping: "停止中", stopped: "已终止", failed: "失败", completed: "已完成", unknown: "结果待确认" }[status] || status);

  function renderSpaceMenu() {
    $("#space-menu").innerHTML = `<div class="menu-label">切换空间</div>${Object.entries(spaces).filter(([id]) => !state.unavailableSpaces.has(id)).map(([id, space]) => `<button class="space-row ${state.space === id ? "active" : ""}" data-space="${id}" role="menuitem"><span class="space-avatar">${space.short}</span><span><b>${space.name}</b><small>${space.type} · ${space.role}</small></span>${state.space === id ? icon("check", "check") : ""}</button>`).join("")}`;
  }

  function renderAccountMenu() {
    const dark = state.theme === "dark";
    const owner = state.scene === "admin-entry-owner";
    const creator = ["admin-entry-creator-active", "admin-entry-creator-suspended"].includes(state.scene);
    const management = `${owner ? `<button class="menu-row" data-action="enterprise-admin" role="menuitem"><span class="menu-icon">${icon("grid")}</span><span class="menu-copy"><b>管理企业</b><small>打开浏览器</small></span>${icon("external", "menu-arrow")}</button>` : ""}${creator ? `<button class="menu-row" data-action="creator-workbench" role="menuitem"><span class="menu-icon">${icon("spark")}</span><span class="menu-copy"><b>管理作品</b><small>打开浏览器</small></span>${icon("external", "menu-arrow")}</button>` : ""}`;
    $("#account-menu").innerHTML = `<div class="menu-section-title">林然 · 普通账号</div><button class="menu-row" data-action="settings" role="menuitem"><span class="menu-icon">${icon("settings")}</span><span class="menu-copy"><b>账号与偏好</b><small>管理客户端设置</small></span>${icon("arrow", "menu-arrow")}</button><button class="menu-row" data-action="theme" role="menuitem"><span class="menu-icon">${icon(dark ? "sun" : "moon")}</span><span class="menu-copy"><b>${dark ? "切换浅色" : "切换深色"}</b><small>${dark ? "深色主题" : "浅色主题"}</small></span></button>${management ? `<div class="menu-divider"></div><div class="menu-section-title">管理入口</div>${management}` : ""}<div class="menu-divider"></div><button class="menu-row" data-action="logout" role="menuitem"><span class="menu-icon">${icon("lock")}</span><span class="menu-copy"><b>退出登录</b><small>保留本机文件</small></span></button>`;
  }

  function renderTabs() {
    const context = current();
    $("#tabs").innerHTML = `<button class="home-tab ${context.activeTab === "home" ? "active" : ""}" data-tab="home" aria-label="首页">${icon("home")}<span class="home-tab-label">首页</span></button>${context.tabs.map(id => { const meta = appMeta(id); return `<div class="tab ${context.activeTab === id ? "active" : ""}"><button class="tab-activate" data-tab="${id}"><span class="tab-icon">${icon(meta.icon)}</span><span>${meta.name}</span>${executionFor(id) ? `<span class="tab-run-dot" aria-label="${statusLabel(executionFor(id).status)}"></span>` : ""}</button><button class="tab-close" data-close="${id}" aria-label="关闭 ${meta.name}">×</button></div>`; }).join("")}`;
  }

  function renderChrome() {
    const space = currentSpace();
    const running = activeExecutions();
    $("#space-avatar").textContent = space.short;
    $("#space-name").textContent = space.name;
    $("#space-type").textContent = `${space.type} · ${space.role}`;
    $("#runtime-label").textContent = running.length ? `${running.length} 项运行中` : "无运行项";
    $("#runtime-dot").className = `status-dot${running.length ? " running" : ""}`;
    document.documentElement.dataset.theme = state.theme;
    renderSpaceMenu();
    renderAccountMenu();
    renderTabs();
    $("#space-menu").hidden = state.openMenu !== "space";
    $("#account-menu").hidden = state.openMenu !== "account";
    $("#space-trigger").setAttribute("aria-expanded", String(state.openMenu === "space"));
    $("#account-button").setAttribute("aria-expanded", String(state.openMenu === "account"));
    $("#runtime-button").setAttribute("aria-expanded", String(state.runtimeOpen));
    $("#notification-button").setAttribute("aria-expanded", String(state.notificationOpen));
  }

  function authView() {
    const mode = state.authMode;
    const isCode = mode === "code";
    const isPassword = mode === "password";
    const masked = state.authPhone ? `+86 ${state.authPhone.slice(0, 3)}••••${state.authPhone.slice(-4)}` : "+86 138••••8000";
    const title = isCode ? "验证码" : isPassword ? "密码登录" : "手机号";
    const description = isCode ? `输入 ${masked} 收到的验证码` : isPassword ? "输入账号密码" : "验证手机号";
    const field = isCode
      ? `<label class="auth-field"><span>验证码</span><input id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字" autofocus></label>`
      : `<label class="auth-field"><span>手机号</span><span class="auth-phone-input"><b>+86</b><input id="auth-phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="11" value="${escapeHtml(state.authPhone)}" placeholder="请输入 11 位手机号"></span></label>${isPassword ? `<label class="auth-field"><span>密码</span><input id="auth-password" type="password" autocomplete="current-password" placeholder="请输入密码"></label>` : ""}`;
    return `<div class="auth-root"><div class="auth-ambient" aria-hidden="true"></div><section class="login-split" aria-labelledby="auth-title"><div class="login-story"><div><div class="auth-brand"><span class="brand-mark">P</span><span>Polo AI</span></div><h1>开始使用 Polo</h1><p>打开 Apps，完成工作</p></div><div class="value-points"><div class="value-point"><span>✓</span>切换工作空间</div><div class="value-point"><span>✓</span>使用 Apps 与 Skills</div><div class="value-point"><span>✓</span>查看运行状态</div></div></div><div class="login-panel"><p class="eyebrow">登录与注册</p><h2 id="auth-title">${title}</h2><p>${description}</p>${state.systemPhase === "session-expired" ? `<div class="inline-alert bad" role="alert"><i></i><span>会话已失效，请重新登录</span></div>` : ""}${state.authError ? `<div class="inline-alert bad" role="alert"><i></i><span>${state.authError}</span></div>` : ""}<form class="auth-form" id="auth-form">${field}<button class="button primary auth-primary" type="submit">${isCode || isPassword ? "继续" : "获取验证码"}</button><button class="button quiet" type="button" data-auth-method="${isPassword ? "phone" : "password"}">${isPassword ? "验证码登录" : "密码登录"}</button></form><div class="trust-row">✓ 同意协议与隐私政策<br>✓ 首次登录创建我的空间</div></div></section></div>`;
  }

  function systemStateView(kind) {
    const configurations = {
      preparing: { tone: "info", glyph: "refresh", eyebrow: "首次使用", title: "正在准备我的空间", description: "等待准备完成", facts: [["账号", "林然"], ["进度", "正在准备内容"], ["下一步", "进入首页"]], actions: `<button class="button primary" data-retry-preparing>立即重试</button>` },
      "home-loading": { tone: "info", glyph: "refresh", eyebrow: "正在进入", title: "正在加载我的空间", description: "等待加载完成", facts: [["进度", "加载 Apps 与文件"], ["下一步", "进入首页"]], actions: `<button class="button primary" data-complete-home-loading>完成加载</button>` },
      "account-suspended": { tone: "bad", glyph: "shield", eyebrow: "账号受限", title: "暂时无法进入 Polo", description: "联系支持恢复账号", facts: [["账号", "林然"], ["状态", "已暂停"], ["参考编号", "ACC-0182"]], actions: `<button class="button" data-auth-method="phone">重新登录</button><button class="button primary" data-system-help>查看恢复帮助</button>` },
      "safe-degraded": { tone: "bad", glyph: "shield", eyebrow: "加载失败", title: "暂时无法打开工作台", description: "重新加载我的空间", facts: [["账号", "林然"], ["状态", "内容未加载"], ["参考编号", "PS-LOAD-0182"]], actions: `<button class="button" data-action="logout">退出登录</button><button class="button primary" data-retry-personal-space>重新加载</button>` }
    };
    const config = configurations[kind];
    return `<section class="system-state-card" aria-labelledby="system-title"><span class="state-icon ${config.tone}">${icon(config.glyph)}</span><p class="eyebrow">${config.eyebrow}</p><h1 id="system-title">${config.title}</h1><p class="state-description">${config.description}</p><dl class="state-facts">${config.facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>${state.systemHelpOpen ? `<div class="inline-alert"><i></i><span>联系支持并提供参考编号</span></div>` : ""}<div class="state-actions">${config.actions}</div></section>`;
  }

  function contractView() {
    if (state.upgradeStage === "updating") return `<section class="system-state-card" aria-labelledby="system-title"><span class="state-icon info state-spinning">${icon("refresh")}</span><p class="eyebrow">正在升级</p><h1 id="system-title">正在安装新版本</h1><p class="state-description">等待安装完成</p><div class="system-progress"><span style="width:68%"></span></div><p class="system-progress-label">验证更新包 · 68%</p></section>`;
    if (state.upgradeStage === "rebuild") return `<section class="system-state-card" aria-labelledby="system-title"><span class="state-icon info">${icon("refresh")}</span><p class="eyebrow">升级已安装</p><h1 id="system-title">重建本机缓存</h1><p class="state-description">重建后重新启动</p><dl class="state-facts"><div><dt>授权缓存</dt><dd>待重建</dd></div><div><dt>运行缓存</dt><dd>待重建</dd></div><div><dt>已存文件</dt><dd>继续保留</dd></div></dl><div class="state-actions"><button class="button primary" data-complete-upgrade>重建并重启</button></div></section>`;
    return `<section class="system-state-card" aria-labelledby="system-title"><span class="state-icon info">${icon("shield")}</span><p class="eyebrow">需要升级</p><h1 id="system-title">升级后继续使用</h1><p class="state-description">安装兼容版本</p><dl class="state-facts"><div><dt>当前版本</dt><dd>v0.16</dd></div><div><dt>可用版本</dt><dd>v0.17</dd></div></dl>${state.systemHelpOpen ? `<div class="inline-alert"><i></i><span>查看帮助或退出登录</span></div>` : ""}<div class="state-actions"><button class="button" data-system-help>查看升级帮助</button><button class="button primary" data-start-upgrade>下载并安装</button></div></section>`;
  }

  function renderSystemScreen() {
    document.documentElement.dataset.theme = state.theme;
    if (!state.systemPhase) {
      systemScreen.hidden = true;
      systemScreen.innerHTML = "";
      shell.hidden = false;
      shell.removeAttribute("inert");
      shell.removeAttribute("aria-hidden");
      return false;
    }
    shell.hidden = true;
    shell.setAttribute("inert", "");
    shell.setAttribute("aria-hidden", "true");
    systemScreen.hidden = false;
    systemScreen.innerHTML = state.systemPhase === "login" || state.systemPhase === "session-expired"
      ? authView()
      : state.systemPhase === "contract-mismatch" ? contractView() : systemStateView(state.systemPhase);
    return true;
  }

  function renderConnectionBanner() {
    const banner = $("#connection-banner");
    shell.classList.toggle("has-connection", !state.online || state.reconnecting);
    if (state.online && !state.reconnecting) { banner.hidden = true; banner.innerHTML = ""; return; }
    const waiting = activeExecutions().some(item => item.status === "waiting_for_network");
    banner.hidden = false;
    banner.innerHTML = state.reconnecting
      ? `<span class="connection-icon state-spinning">${icon("refresh")}</span><span class="connection-copy"><strong>正在恢复连接</strong><small>校验空间、授权和版本</small></span>`
      : `<span class="connection-icon">${icon("wifi")}</span><span class="connection-copy"><strong>${waiting ? "等待网络" : "当前离线"}</strong><small>缓存非最新授权</small><small>${waiting ? "恢复网络或终止任务" : "禁止启动 App、Skill 与助手"}</small></span><button class="button quiet" data-reconnect>重试连接</button>`;
  }

  function section(title, subtitle, content, action = "") {
    return `<section class="section">
      <div class="section-header">
        <div>
          <h2>${title}</h2>
          ${subtitle ? `<p>${subtitle}</p>` : ""}
        </div>
        ${action}
      </div>
      ${content}
    </section>`;
  }

  function availability(item) {
    if (item.availability === "blocked") return { label: "已阻断", tone: "bad" };
    if (item.availability === "unavailable") return { label: "不可用", tone: "neutral" };
    if (item.update) return { label: "可使用 · 有更新", tone: "info" };
    return { label: "可使用", tone: "good" };
  }

  function appCard(id, mode = "open") {
    const item = apps[id];
    const available = availability(item);
    const running = executionFor(id);
    const isHome = mode === "open";

    const action = mode === "manage"
      ? `${item.availability === "available" ? "" : `<button class="card-action" data-explain="${id}">查看原因</button>`}
         <button class="card-action" data-remove="${id}">移出首页</button>`
      : item.availability === "available"
        ? mode === "add"
          ? `<button class="card-action primary" data-add="${id}">添加到首页</button>`
          : mode === "add-full"
            ? `<button class="card-action" disabled title="请先移出一个工作 App">首页已满</button>`
            : `<button class="card-action home-ghost-action" data-open="${id}" aria-label="打开 ${item.name}">打开</button>`
        : `<button class="card-action ${isHome ? "home-ghost-action" : ""}" data-explain="${id}">查看原因</button>`;

    const availabilityBadge = isHome
      ? item.availability === "blocked"
        ? `<span class="status bad">已阻断</span>`
        : item.availability === "unavailable"
          ? `<span class="status neutral">不可用</span>`
          : item.update
            ? `<span class="status info">有更新</span>`
            : ""
      : `<span class="status ${available.tone}">${available.label}</span>`;

    const runningBadge = running
      ? `<span class="status info">${statusLabel(running.status)}</span>`
      : "";

    const badges = `${availabilityBadge}${runningBadge}`;
    const version = isHome ? "" : `<div class="card-meta">${item.version}</div>`;

    return `<article class="product-card ${current().highlightedApp === id ? "highlighted-card" : ""}">
      <div class="card-heading">
        <span class="app-art ${item.availability === "blocked" ? "ink" : item.update ? "amber" : "teal"}">${icon(item.icon)}</span>
        <div class="card-title">
          <h3>${item.name}</h3>
          <p class="source-line">${item.source}</p>
        </div>
      </div>
      <p class="product-description">${item.description}</p>
      ${version}
      <div class="status-line ${badges ? "" : "actions-only"}">
        ${badges}
        ${action}
      </div>
    </article>`;
  }

  function assistantHomeCard() {
    const enabledCount = Object.values(current().skillEnabled).filter(Boolean).length;

    return `<article class="product-card assistant-card">
      <div class="card-heading">
        <span class="app-art">${icon("spark")}</span>
        <div class="card-title">
          <h3>Polo 助手</h3>
          <p class="source-line">Polo 内置 · ${enabledCount} 个 Skill 已启用</p>
        </div>
      </div>
      <p class="product-description">调用已启用的 Skills</p>
      <div class="status-line actions-only">
        <button class="card-action home-ghost-action" data-open-assistant-skills>管理 Skills</button>
        <button class="card-action primary home-primary-action" data-open="assistant" aria-label="打开 Polo 助手">打开助手</button>
      </div>
    </article>`;
  }

  function assistantManagementCard() {
    const enabledCount = Object.values(current().skillEnabled).filter(Boolean).length;
    return `<article class="product-card assistant-card"><div class="card-heading"><span class="app-art">${icon("spark")}</span><div class="card-title"><p class="card-kicker">内置 App</p><h3>Polo 助手</h3><p class="source-line">Polo 内置 · ${enabledCount} 个 Skill 已启用</p></div></div><p class="product-description">管理助手 Skills</p><div class="status-line"><span class="status good">固定在首页</span></div></article>`;
  }

  function homePlacementCard(id, circle = null) {
    const item = apps[id];
    const available = availability(item);
    const running = executionFor(id);
    const onHome = current().added.includes(id);
    const atLimit = current().added.length >= 5;
    const reasonAction = item.availability === "available" ? "" : `<button class="card-action" data-explain="${id}">查看原因</button>`;
    const placementAction = onHome
      ? `<button class="card-action" data-remove="${id}">移出首页</button>`
      : atLimit
        ? `<button class="card-action" disabled title="请先移出一个工作 App">首页已满</button>`
        : `<button class="card-action" data-add="${id}">显示在首页</button>`;
    const openAction = item.availability === "available" ? `<button class="card-action primary" data-open="${id}">打开</button>` : "";
    const action = `${reasonAction}${placementAction}${openAction}`;
    const highlighted = current().highlightedApp === id && (!current().highlightedCircle || current().highlightedCircle === circle?.id);
    return `<article class="product-card placement-card ${highlighted ? "highlighted-card" : ""}"><div class="card-heading"><span class="app-art ${item.availability === "blocked" ? "ink" : item.update ? "amber" : "teal"}">${icon(item.icon)}</span><div class="card-title"><h3>${item.name}</h3><p class="source-line">来源圈子：${circle?.name || item.source}</p></div></div><p class="product-description">${item.description}</p><div class="card-meta">${circle?.creator || item.source} · ${item.version}</div><div class="status-line"><span class="status ${available.tone}">${available.label}</span>${running ? `<span class="status info">${statusLabel(running.status)}</span>` : ""}<span class="home-placement ${onHome ? "on" : ""}">${onHome ? "已在首页" : "未在首页"}</span>${action}</div></article>`;
  }

  function circleAppGroup(circle, appIds = circle.apps) {
    const membership = circleMembership(circle);
    const homeCount = appIds.filter(id => current().added.includes(id)).length;
    const highlighted = current().highlightedCircle === circle.id;
    return `<section class="circle-app-section ${highlighted ? "highlighted-section" : ""}"><header class="circle-app-header"><span class="circle-avatar">${circle.initials}</span><div><div class="circle-app-title"><h3>${circle.name}</h3><span class="status ${membership.tone}">${membership.label}</span></div><p>${circle.creator} · ${appIds.length} 个 Apps · ${homeCount} 个显示在首页</p></div><button class="section-link" data-circle="${circle.id}">查看圈子详情</button></header><div class="card-grid">${appIds.map(id => homePlacementCard(id, circle)).join("")}</div></section>`;
  }

  function utilityCard(id, title, description, meta) {
    return `<button class="utility-card" data-open="${id}" aria-label="打开${title}">
      <span class="app-art compact ${id === "files" ? "teal" : "amber"}">${icon(appMeta(id).icon)}</span>
      <span>
        <strong>${title}</strong>
        <small>${description}</small>
        <em>${meta}</em>
      </span>
      ${icon("arrow")}
    </button>`;
  }

  function homeView() {
    const space = currentSpace();
    const context = current();
    const data = catalog[state.space];

    const circleEntry = state.space === "personal" && visibleCircles().length
      ? `<button class="home-context-link home-context-secondary" data-home-view="circles">
          ${icon("circle")}
          <span>
            <strong>我的圈子</strong>
            <small>${visibleCircles().length} 个圈子</small>
          </span>
          ${icon("arrow")}
        </button>`
      : "";

    const commonApps = `<div class="card-grid home-app-grid">
      ${assistantHomeCard()}
      ${context.added.map(id => appCard(id)).join("")}
    </div>`;

    const commonAppsAction = `<button class="section-link home-section-action" data-home-view="catalog">
      全部 Apps
    </button>`;

    const utilities = `<div class="utility-grid">
      ${utilityCard(
        "files",
        "文件",
        "查看最近文件",
        `${state.scene === "home-empty" ? 0 : 3} 个最近文件`
      )}
      ${utilityCard(
        "tasks",
        "任务与结果",
        "查看执行与结果",
        `${activeExecutions().length} 项运行中`
      )}
    </div>`;

    return `<section class="home-hero">
        <div>
          <h1>早上好，林然</h1>
          <p>继续 <strong>${space.name}</strong> 的工作</p>
        </div>
        ${circleEntry}
      </section>
      ${section(
        "常用 Apps",
        `打开常用 Apps`,
        commonApps,
        commonAppsAction
      )}
      ${section(
        "系统工具",
        "查看文件与执行结果",
        utilities
      )}`;
  }

  function matchesCatalogQuery(id, query, extra = []) {
    if (!query) return true;
    const item = apps[id];
    return [item.name, item.description, item.source, item.version, ...extra].some(value => value.toLowerCase().includes(query));
  }

  function catalogSearchToolbar(visibleCount, totalCount) {
    return `<div class="circle-browser-toolbar app-catalog-toolbar"><label><span>搜索当前空间的 App</span><input id="app-catalog-search" type="search" value="${escapeHtml(current().catalogQuery)}" placeholder="搜索 App 名称、功能或来源"></label><span>显示 <strong>${visibleCount}</strong> / ${totalCount} 个 Apps</span></div>`;
  }

  function catalogView() {
    const context = current();
    const data = catalog[state.space];
    const query = context.catalogQuery.trim().toLowerCase();
    const homeSection = section("首页快捷入口", `管理 ${context.added.length} / 5 个工作 App`, `<div class="card-grid">${assistantManagementCard()}${context.added.map(id => appCard(id, "manage")).join("")}</div>`);
    if (state.space === "personal") {
      const circles = visibleCircles();
      const appCount = circles.reduce((total, circle) => total + circle.apps.length, 0);
      const matchedGroups = circles.map(circle => ({ circle, ids: circle.apps.filter(id => matchesCatalogQuery(id, query, [circle.name, circle.creator])) })).filter(group => group.ids.length);
      const visibleCount = matchedGroups.reduce((total, group) => total + group.ids.length, 0);
      const groups = matchedGroups.map(group => circleAppGroup(group.circle, group.ids)).join("") || `<div class="empty-note">换个名称或来源搜索</div>`;
      const circleSection = section("当前空间的全部 Apps", `按 ${circles.length} 个圈子查看 ${appCount} 个 Apps`, `${catalogSearchToolbar(visibleCount, appCount)}<div class="circle-app-list">${groups}</div>`, `<button class="section-link" data-home-view="circles">我的圈子</button>`);
      return `${subpageHeader("全部 Apps", "搜索、打开或加入首页")}${homeSection}${circleSection}`;
    }
    const allIds = state.scene === "ent-catalog-empty" ? [] : [...new Set([...data.added, ...data.available])];
    const visibleIds = allIds.filter(id => matchesCatalogQuery(id, query, [currentSpace().name, "企业目录"]));
    const directorySection = section("企业目录 Apps", `查看 ${allIds.length} 个企业 Apps`, `${catalogSearchToolbar(visibleIds.length, allIds.length)}<div class="circle-browser-grid enterprise-app-grid">${visibleIds.map(id => enterpriseDirectoryCard(id)).join("") || `<div class="empty-note">换个名称或来源搜索</div>`}</div>`, `<button class="section-link" data-action="enterprise-admin">企业目录来源</button>`);
    return `${subpageHeader("全部 Apps", "搜索、打开或加入首页")}${homeSection}${directorySection}`;
  }

  function enterpriseDirectoryCard(id) {
    const item = apps[id];
    const available = availability(item);
    const running = executionFor(id);
    const onHome = current().added.includes(id);
    const atLimit = current().added.length >= 5;
    const homeAction = onHome
      ? `<button class="button" data-remove="${id}">移出首页</button>`
      : atLimit
        ? `<button class="button" disabled title="请先从上方移出一个工作 App">首页已满</button>`
        : `<button class="button" data-add="${id}">显示在首页</button>`;
    const openAction = item.availability === "available" ? `<button class="button primary" data-open="${id}">打开</button>` : `<button class="button" data-explain="${id}">查看原因</button>`;
    return `<article class="circle-browser-card"><div class="circle-browser-heading"><span class="app-art ${item.availability === "blocked" ? "ink" : item.update ? "amber" : "teal"}">${icon(item.icon)}</span><div><h3>${item.name}</h3><span class="circle-source-pill">北辰智能科技企业目录</span></div></div><p>${item.description}</p><small>${item.version}</small><div class="circle-browser-status"><span class="status ${available.tone}">${available.label}</span>${running ? `<span class="status info">${statusLabel(running.status)}</span>` : ""}<span class="home-placement ${onHome ? "on" : ""}">${onHome ? "已在首页" : "未在首页"}</span></div><div class="circle-browser-actions">${homeAction}${openAction}</div></article>`;
  }

  function circlesView() {
    if (state.space !== "personal") return `${subpageHeader("我的圈子", "切换到我的空间查看")}<div class="empty-state"><h2>请切换到我的空间</h2></div>`;
    const selected = circleById(current().selectedCircle);
    if (selected && current().circleMemberships[selected.id] !== "left") return circleDetailView(selected);
    const circles = visibleCircles();
    const entries = circles.flatMap(circle => circle.apps.map(id => ({ id, circle })));
    const query = current().circleQuery.trim().toLowerCase();
    const visibleEntries = entries.filter(({ id, circle }) => {
      if (current().circleFilter !== "all" && circle.id !== current().circleFilter) return false;
      if (!query) return true;
      const item = apps[id];
      return [item.name, item.description, item.source, item.version, circle.name, circle.creator].some(value => value.toLowerCase().includes(query));
    });
    const filters = `<div class="circle-filter-row" aria-label="按圈子筛选"><button class="circle-filter ${current().circleFilter === "all" ? "active" : ""}" data-circle-filter="all" aria-pressed="${current().circleFilter === "all"}">全部圈子 <span>${entries.length}</span></button>${circles.map(circle => `<button class="circle-filter ${current().circleFilter === circle.id ? "active" : ""}" data-circle-filter="${circle.id}" aria-pressed="${current().circleFilter === circle.id}">${circle.name} <span>${circle.apps.length}</span></button>`).join("")}</div>`;
    const browser = circles.length
      ? `${section("全部圈子 Apps", "搜索或按圈子筛选", `<div class="circle-browser-toolbar"><label><span>搜索圈子 App</span><input id="circle-app-search" type="search" value="${escapeHtml(current().circleQuery)}" placeholder="搜索名称、功能或圈子"></label><span>显示 <strong>${visibleEntries.length}</strong> / ${entries.length} 个 Apps</span></div>${filters}<div class="circle-browser-grid">${visibleEntries.map(({ id, circle }) => circleBrowserCard(id, circle)).join("") || `<div class="empty-note">换个名称或圈子搜索</div>`}</div>`, `<button class="section-link" data-home-view="catalog">全部 Apps</button>`)}`
      : `<div class="empty-state"><h2>还没有加入圈子</h2><p>使用邀请链接加入圈子</p></div>`;
    const memberships = circles.length ? section("已加入的圈子", "查看 Apps、Skills 与成员资格", `<div class="circle-list">${circles.map(circle => circleListCard(circle)).join("")}</div>`) : "";
    return `${subpageHeader("我的圈子", `浏览 ${circles.length} 个圈子的 Apps`)}${browser}${memberships}`;
  }

  function circleBrowserCard(id, circle) {
    const item = apps[id];
    const available = availability(item);
    const running = executionFor(id);
    const onHome = current().added.includes(id);
    const atLimit = current().added.length >= 5;
    const openAction = item.availability === "available"
      ? `<button class="button primary" data-open="${id}">打开</button>`
      : `<button class="button" data-explain="${id}">查看原因</button>`;
    const homeAction = onHome
      ? `<button class="button" data-manage-circle-app="${id}" data-circle-source="${circle.id}">管理首页位置</button>`
      : atLimit
        ? `<button class="button" data-manage-circle-app="${id}" data-circle-source="${circle.id}">首页已满 · 去管理</button>`
        : `<button class="button" data-add="${id}">显示在首页</button>`;
    return `<article class="circle-browser-card"><div class="circle-browser-heading"><span class="app-art ${item.availability === "blocked" ? "ink" : item.update ? "amber" : "teal"}">${icon(item.icon)}</span><div><h3>${item.name}</h3><span class="circle-source-pill">来自 ${circle.name}</span></div></div><p>${item.description}</p><small>${circle.creator} · ${item.version}</small><div class="circle-browser-status"><span class="status ${available.tone}">${available.label}</span>${running ? `<span class="status info">${statusLabel(running.status)}</span>` : ""}<span class="home-placement ${onHome ? "on" : ""}">${onHome ? "已在首页" : "未在首页"}</span></div><div class="circle-browser-actions">${homeAction}${openAction}</div></article>`;
  }

  function circleListCard(circle) {
    const membership = circleMembership(circle);
    return `<article class="circle-card"><span class="circle-avatar">${circle.initials}</span><div class="circle-card-copy"><div class="circle-card-title"><div><h2>${circle.name}</h2><p>${circle.creator}</p></div><span class="status ${membership.tone}">${membership.label}</span></div><p class="circle-update">${circle.update}</p><div class="circle-stats"><span><b>${circle.apps.length}</b> Apps</span><span><b>${circle.skills.length}</b> Skills</span><span>${circle.price}</span><span>${membership.renewal}</span></div></div><button class="button" data-circle="${circle.id}">查看圈子${icon("arrow")}</button></article>`;
  }

  function circleAppRow(id, circle) {
    const item = apps[id];
    const available = availability(item);
    const onHome = current().added.includes(id);
    const atLimit = current().added.length >= 5;
    const sourceNote = `来自 ${circle.name}`;
    const placementAction = onHome
      ? `<button class="button" data-remove="${id}">移出首页</button>`
      : atLimit
        ? `<button class="button" data-manage-circle-app="${id}" data-circle-source="${circle.id}">首页已满 · 去管理</button>`
        : `<button class="button" data-add="${id}">显示在首页</button>`;
    const actions = item.availability !== "available"
      ? `<button class="button" data-explain="${id}">查看原因</button>${placementAction}`
      : `<button class="button" data-open="${id}">打开</button>${placementAction}`;
    return `<article class="circle-work-row"><span class="app-art ${item.update ? "amber" : "teal"}">${icon(item.icon)}</span><div><h3>${item.name}</h3><p>${item.description}</p><small>${item.source} · ${item.version}</small><em>${sourceNote}</em></div><span class="status ${available.tone}">${available.label}</span><div class="circle-work-actions">${actions}</div></article>`;
  }

  function circleSkillRow(id) {
    const skill = catalog.personal.skills.find(item => item.id === id);
    if (!skill) return "";
    const enabled = Boolean(current().skillEnabled[id]);
    return `<article class="circle-work-row"><span class="app-art teal">${icon("spark")}</span><div><h3>${skill.name}</h3><p>${skill.description}</p><small>${skill.source}</small><em>在 Polo 助手中运行</em></div><span class="status ${enabled ? "good" : "neutral"}">${enabled ? "已启用" : "未启用"}</span><div class="circle-work-actions"><button class="button ${enabled ? "" : "primary"}" data-open-assistant-skill="${id}">在助手中管理</button></div></article>`;
  }

  function circleDetailView(circle) {
    const membership = circleMembership(circle);
    const priceLabel = circle.price === "免费" ? "免费" : circle.price;
    const renewalLabel = membership.renewal === "长期有效" || membership.renewal.startsWith("可用至") ? membership.renewal : `下次续费 ${membership.renewal}`;
    return `<div class="subpage-heading circle-detail-heading"><button class="back-button" data-circle-list>${icon("left")}返回我的圈子</button><div><p class="eyebrow">我的空间 · 认证创作者圈子</p><h1>${circle.name}</h1><p>${circle.creator} · ${circle.apps.length} 个 Apps · ${circle.skills.length} 个 Skills</p></div><div class="circle-heading-meta"><span class="status ${membership.tone}">${membership.label}</span><small>${priceLabel} · ${renewalLabel}</small><button class="button quiet" data-circle-membership="${circle.id}">管理成员资格</button></div></div>${section("这个圈子的 Apps", "打开或加入首页", `<div class="circle-work-list">${circle.apps.map(id => circleAppRow(id, circle)).join("")}</div>`, `<button class="section-link" data-home-view="catalog">查看全部 Apps</button>`)}${section("这个圈子的 Skills", "在助手中管理 Skills", `<div class="circle-work-list">${circle.skills.map(id => circleSkillRow(id)).join("") || `<div class="empty-note">当前没有 Skill</div>`}</div>`, `<button class="section-link" data-open-assistant-skills>打开助手 Skills</button>`)}`;
  }

  function subpageHeader(title, description, action = "") {
    return `<div class="subpage-heading"><button class="back-button" data-home-view="home">${icon("left")}返回首页</button><div><p class="eyebrow">${currentSpace().name}</p><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
  }

  const flowSceneDefinitions = {
    "circle-invite": { eyebrow: "圈子邀请", title: "桥见圈子邀请你加入", description: "确认圈子与可用内容", facts: [["创作者", "桥见创作室"], ["加入方式", "邀请链接"], ["可获得", "3 个 Apps · 2 个 Skills"], ["加入后", "进入我的空间"]], actions: `<button class="button" data-scene-link="my-circles">暂不加入</button><button class="button primary" data-scene-link="join-free-confirm">继续</button>` },
    "join-free-confirm": { eyebrow: "免费加入", title: "确认加入桥见圈子", description: "加入后查看可用作品", facts: [["内容价格", "免费"], ["续费规则", "无需续费"], ["首页", "加入后自行配置"], ["Skills", "在助手中启用"]], actions: `<button class="button" data-scene-link="circle-invite">返回</button><button class="button primary" data-scene-link="join-success-detail">确认加入</button>` },
    "join-invite-pending": { eyebrow: "等待审批", title: "加入申请已经提交", description: "等待创作者审批", facts: [["申请状态", "等待审批"], ["当前空间", "保持不变"]], actions: `<button class="button primary" data-scene-link="my-circles">返回我的圈子</button>` },
    "join-paid-confirm": { eyebrow: "付费圈子", title: "增长顾问圈 · ¥59 / 月", description: "确认价格与续费规则", facts: [["订阅价格", "¥59 / 月"], ["续费规则", "每月自动续费，可随时取消"], ["可获得", "增长顾问 App"], ["支付位置", "系统浏览器"]], actions: `<button class="button" data-scene-link="circle-invite">返回</button><button class="button primary" data-external-flow="circle-checkout">在浏览器继续</button>` },
    "pay-processing": { eyebrow: "支付状态确认中", title: "暂时无法确认支付结果", description: "稍后检查订单", facts: [["订单状态", "处理中"], ["成员资格", "尚未生效"], ["支付", "请勿重复操作"]], actions: `<button class="button" data-scene-link="my-circles">稍后查看</button><button class="button primary" data-scene-link="join-success-detail">重新检查状态</button>` },
    "price-changed-reconfirm": { eyebrow: "价格已变化", title: "需要按新价格重新确认", description: "确认新价格", facts: [["原价格", "¥49 / 月"], ["新价格", "¥59 / 月"], ["当前状态", "尚未扣款"]], actions: `<button class="button" data-scene-link="my-circles">取消</button><button class="button primary" data-scene-link="join-paid-confirm">查看新价格</button>` },
    "refund-processing": { eyebrow: "退款处理中", title: "退款结果尚未完成", description: "查看退款进度", facts: [["退款状态", "处理中"], ["当前权益", "保持现状"], ["查看位置", "系统浏览器"]], actions: `<button class="button" data-scene-link="my-circles">返回我的圈子</button><button class="button primary" data-external-flow="billing-help">在浏览器查看订单</button>` },
    "circle-join-closed": { tone: "bad", eyebrow: "无法加入", title: "这个加入链接已经失效", description: "请求新的加入链接", facts: [["圈子", "桥见圈子"], ["成员关系", "未创建"], ["我的空间", "保持不变"]], actions: `<button class="button primary" data-scene-link="my-circles">返回我的圈子</button>` },
    "landing-reference": { eyebrow: "系统浏览器", title: "北辰智能科技邀请你加入", description: "完成验证后打开 Polo", facts: [["企业", "北辰智能科技"], ["默认角色", "Member"], ["完成后", "打开 Polo"]], actions: `<button class="button primary" data-scene-link="handoff-open-client">确认加入</button>` },
    "handoff-open-client": { eyebrow: "加入成功", title: "北辰智能科技已经加入你的账号", description: "打开 Polo 切换企业", facts: [["成员身份", "Member"], ["当前设备", "我的空间"], ["下一步", "打开 Polo"]], actions: `<button class="button primary" data-scene-link="client-space-appears">打开 Polo</button>` },
    "already-member": { eyebrow: "企业邀请", title: "你已经是北辰智能科技的成员", description: "打开现有企业空间", facts: [["成员状态", "已加入"], ["角色", "Member"]], actions: `<button class="button primary" data-scene-link="client-space-appears">打开现有企业空间</button>` },
    "pending-approval": { eyebrow: "企业邀请", title: "加入申请等待审批", description: "等待企业审批", facts: [["申请状态", "等待 Owner/Manager 审批"], ["我的空间", "可以使用"], ["企业空间", "尚不可见"]], actions: `<button class="button primary" data-scene-link="home-normal">进入我的空间</button>` },
    "invite-mismatch": { tone: "bad", eyebrow: "账号不匹配", title: "请使用收到邀请的账号", description: "切换到受邀账号", facts: [["当前账号", "138••••8000"], ["受邀账号", "linran@example.com"], ["企业空间", "未添加"]], actions: `<button class="button" data-scene-link="home-normal">返回</button><button class="button primary" data-action="logout">切换账号</button>` },
    "create-enterprise-handoff": { eyebrow: "创建企业", title: "在企业组织管理端继续", description: "打开浏览器创建企业", facts: [["当前账号", "林然"], ["完成后", "刷新空间列表"]], actions: `<button class="button" data-scene-link="home-normal">取消</button><button class="button primary" data-external-flow="create-enterprise">打开企业组织管理端</button>` },
    "handoff-refresh-failed": { tone: "bad", eyebrow: "刷新失败", title: "企业已经加入，但目录暂时无法加载", description: "重新加载企业目录", facts: [["成员关系", "已生效"], ["目录状态", "加载失败"], ["当前页面", "我的空间"]], actions: `<button class="button" data-scene-link="home-normal">暂时留在我的空间</button><button class="button primary" data-scene-link="client-space-appears">重新加载</button>` },
    "terminate-cancelled": { eyebrow: "切换已取消", title: "仍停留在我的空间", description: "继续原空间任务", facts: [["当前空间", "我的空间"], ["运行项", "继续运行"], ["目标空间", "未加载"]], actions: `<button class="button primary" data-scene-link="switcher-normal">重新选择空间</button>` },
    "member-out-of-scope": { tone: "bad", eyebrow: "企业目录", title: "你没有访问这个 App 的权限", description: "联系管理员获取权限", facts: [["当前空间", "北辰智能科技"], ["当前身份", "Member"], ["作品状态", "未向你分发"]], actions: `<button class="button" data-home-view="catalog">返回全部 Apps</button><button class="button primary" data-contact-enterprise>联系企业管理员</button>` },
    "work-tombstone": { tone: "bad", eyebrow: "作品不可用", title: "增长顾问已停止分发", description: "查看已保存结果", facts: [["来源", "增长顾问圈"], ["失效原因", "创作者停止分发"], ["新执行", "不可用"], ["历史结果", "继续保留"]], actions: `<button class="button" data-open="tasks">查看已保存结果</button><button class="button primary" data-home-view="catalog">返回全部 Apps</button>` },
    "work-revoked": { tone: "bad", eyebrow: "授权已撤销", title: "客户访谈整理当前不可用", description: "查看已保存结果", facts: [["来源", "北极星共创社"], ["新执行", "已阻止"], ["已保存结果", "继续保留"]], actions: `<button class="button" data-open="tasks">查看结果</button><button class="button primary" data-home-view="catalog">返回全部 Apps</button>` },
    "version-blocked": { tone: "bad", eyebrow: "安全阻断", title: "合规审阅 v2.0.3 已被阻断", description: "查看历史结果", facts: [["版本", "v2.0.3"], ["运行状态", "已终止"], ["新执行", "不可用"], ["历史结果", "保留版本信息"]], actions: `<button class="button" data-open="tasks">查看历史结果</button><button class="button primary" data-home-view="catalog">返回全部 Apps</button>` }
  };

  function flowStateView(definition) {
    const facts = definition.facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
    return `<section class="flow-state-page"><span class="state-icon ${definition.tone === "bad" ? "bad" : "info"}">${icon(definition.tone === "bad" ? "shield" : "info")}</span><p class="eyebrow">${definition.eyebrow}</p><h1>${definition.title}</h1><p class="state-description">${definition.description}</p><dl class="state-facts">${facts}</dl><div class="state-actions">${definition.actions}</div></section>`;
  }

  function settingsView() {
    const creatorSuspended = state.scene === "admin-entry-creator-suspended";
    const deletionBlocked = state.scene === "deletion-blocked";
    const owner = state.scene === "admin-entry-owner";
    const creator = state.scene === "admin-entry-creator-active" || creatorSuspended;
    const identityStatus = creatorSuspended ? "创作者资格已暂停" : owner ? "北辰智能科技 Owner" : creator ? "有效创作者" : "普通业务账号";
    const blocker = deletionBlocked ? `<div class="inline-alert bad"><i></i><div><strong>暂时不能注销账号</strong><div class="blocker-checks"><span>转让企业 Owner</span><span>处理 Creator Owner</span><span>完成未结订单</span></div></div></div>` : "";
    const managementRows = `${owner ? `<div class="settings-row"><span><strong>企业组织管理端</strong><small>成员、目录、企业账单和 Owner 责任</small></span><button class="button" data-action="enterprise-admin">在浏览器打开</button></div>` : ""}${creator ? `<div class="settings-row"><span><strong>创作者工作台</strong><small>${creatorSuspended ? "只读责任处理入口" : "作品、圈子和收入"}</small></span><button class="button" data-action="creator-workbench">在浏览器打开</button></div>` : ""}`;
    const managementSection = managementRows ? section("管理入口", "打开管理工具", managementRows) : "";
    return `${subpageHeader("账号与偏好", "管理账号与客户端偏好", `<span class="status ${creatorSuspended ? "bad" : "good"}">${creatorSuspended ? "部分受限" : "账号正常"}</span>`)}${blocker}<div class="settings-layout"><section class="settings-nav-card"><button class="active">账号概览</button><button>安全</button><button>外观与通知</button><button>本机存储</button><button>授权记录</button></section><div class="settings-content">${section("账号概览", "查看账号与身份", `<div class="permission-summary"><span><b>账号</b>林然 · 138••••8000</span><span><b>账号状态</b>正常</span><span><b>身份摘要</b>${identityStatus}</span><span><b>当前设备</b>这台 Mac · 已验证</span></div>`)}${section("客户端偏好", "设置当前设备", `<div class="settings-row"><span><strong>外观与通知</strong><small>${state.theme === "dark" ? "深色" : "浅色"}主题 · 重要通知已开启</small></span><button class="button" data-action="theme">切换主题</button></div><div class="settings-row"><span><strong>本机存储</strong><small>查看文件索引与下载位置</small></span><button class="button" data-external-flow="local-storage">查看</button></div><div class="settings-row"><span><strong>App 与 Skill 授权记录</strong><small>查看当前空间授权</small></span><button class="button" data-external-flow="authorization-records">查看</button></div>`)}${managementSection}${section("账号操作", "检查注销条件", `<div class="settings-row danger-row"><span><strong>注销账号</strong><small>处理 Owner 与未结责任</small></span><button class="button danger" data-scene-link="deletion-blocked">检查注销条件</button></div>`)}</div></div>`;
  }

  function assistantView() {
    const context = current();
    const enabledSkills = currentSkills().filter(skill => context.skillEnabled[skill.id]);
    const chatActive = context.assistantPanel === "chat";
    return `<div class="prototype-boundary-note" role="note"><strong>界面示意</strong></div><div class="assistant-shell"><aside class="assistant-sidebar" aria-label="Polo 助手导航"><button class="assistant-new-session" data-action="new-chat">${icon("plus")}新建对话</button><nav class="assistant-nav"><button class="assistant-nav-item ${chatActive ? "active" : ""}" data-assistant-panel="chat">${icon("app")}<span>全部对话</span></button><div class="assistant-nav-nested"><button class="assistant-nav-item muted">${icon("info")}<span>已标记</span></button><button class="assistant-nav-item muted">${icon("folder")}<span>已归档</span></button></div><div class="assistant-nav-divider"></div><button class="assistant-nav-item">${icon("folder")}<span>资料源</span></button><button class="assistant-nav-item ${context.assistantPanel === "skills" ? "active" : ""}" data-assistant-panel="skills">${icon("spark")}<span>Skills</span></button><button class="assistant-nav-item">${icon("task")}<span>自动化</span></button></nav><div class="sidebar-foot"><span>${currentSpace().name}</span><small>使用当前空间内容</small></div></aside><section class="assistant-navigator" aria-label="对话列表"><header><div><strong>对话</strong><span>${currentSpace().name}</span></div><button class="icon-button" data-action="new-chat" aria-label="新建对话">${icon("plus")}</button></header><p class="assistant-list-label">最近对话</p><button class="session-row active"><strong>8 月项目复盘</strong><span>刚刚</span></button><button class="session-row"><strong>整理客户访谈</strong><span>昨天</span></button><button class="session-row"><strong>品牌语气分析</strong><span>周一</span></button><p class="assistant-list-label">已保存视图</p><button class="session-row muted"><strong>已标记</strong><span>2 个对话</span></button><button class="session-row muted"><strong>已归档</strong><span>5 个对话</span></button></section><section class="assistant-main"><header class="assistant-header"><div><h1>${context.assistantPanel === "skills" ? "Skills" : "8 月项目复盘"}${context.assistantPanel === "chat" ? icon("arrow") : ""}</h1><p>${currentSpace().name} · ${enabledSkills.length} 个 Skill 已启用</p></div><div class="assistant-header-actions"><button class="icon-button" aria-label="分享对话">${icon("external")}</button><button class="button quiet" data-permissions="assistant">${icon("shield")}权限</button></div></header>${context.assistantPanel === "skills" ? skillsPanel() : chatPanel(enabledSkills)}</section></div>`;
  }

  function skillsPanel() {
    const context = current();
    const skills = currentSkills();
    const list = skills.length ? skills.map(skill => { const enabled = Boolean(context.skillEnabled[skill.id]); return `<article class="skill-row ${context.highlightedSkill === skill.id ? "highlighted-card" : ""}"><span class="app-art compact ${enabled ? "teal" : ""}">${icon("spark")}</span><div><h3>${skill.name}</h3><p>${skill.description}</p><small>${skill.source}</small></div><div class="skill-permission"><span>${skill.permissions}</span><button class="button ${enabled ? "" : "primary"}" data-skill-toggle="${skill.id}" ${state.online ? "" : "disabled"}>${state.online ? enabled ? "停用" : "启用" : "等待网络"}</button></div></article>`; }).join("") : `<div class="empty-state"><h2>当前空间没有可用 Skill</h2><p>获取当前空间 Skills</p></div>`;
    return `<div class="skills-panel"><div class="panel-intro"><div><h2>当前空间可用 Skills</h2><p>管理当前空间 Skills</p></div><span class="status ${skills.length ? "good" : "neutral"}">${skills.filter(skill => context.skillEnabled[skill.id]).length} 个已启用</span></div><div class="skill-list">${list}</div></div>`;
  }

  function chatPanel(enabledSkills) {
    const context = current();
    const messages = context.messages.map(message => `<div class="message ${message.role}"><span class="message-avatar">${message.role === "assistant" ? "P" : "林"}</span><div><small>${message.role === "assistant" ? "Polo 助手" : "林然"}</small><p>${escapeHtml(message.text)}</p>${message.call ? skillCallView(message.call) : ""}</div></div>`).join("");
    return `<div class="chat-panel"><div class="message-list">${messages}</div><div class="composer-wrap"><div class="composer-mode"><button type="button" class="assistant-mode-badge">${icon("info")}Ask ${icon("arrow")}</button><span>${currentSpace().name}</span></div><form class="chat-composer ${state.online ? "" : "offline"}" id="chat-form"><textarea id="chat-input" rows="3" placeholder="${state.online ? "你想让 Polo 助手做什么？" : "离线时无法发送"}" ${state.online ? "" : "disabled"}></textarea><div class="composer-footer"><button type="button" class="composer-tool" data-action="attach-file" ${state.online ? "" : "disabled"}>${icon("plus")}添加文件</button><label class="composer-tool">${icon("spark")}<select id="skill-select" ${state.online ? "" : "disabled"}><option value="none">不调用 Skill</option>${enabledSkills.map(skill => `<option value="${skill.id}">${skill.name} · ${skill.source}</option>`).join("")}</select></label><span></span><button class="composer-send" type="submit" aria-label="发送消息" ${state.online ? "" : "disabled"}>${icon("arrow")}</button></div></form></div></div>`;
  }

  function skillCallView(call) {
    const skill = catalog[state.space].skills.find(item => item.id === call.skillId);
    if (!skill) return "";
    if (call.stage === "permission") return `<div class="tool-call permission-call">${icon("shield")}<span><strong>确认调用：${skill.name} · ${skill.source}</strong><small>${skill.permissions}</small></span><div class="tool-actions"><button class="button" data-cancel-skill-call="${call.id}">取消</button><button class="button primary" data-confirm-skill-call="${call.id}">确认权限并运行</button></div></div>`;
    if (call.stage === "running") return `<div class="tool-call">${icon("spark")}<span><strong>${skill.name} · ${skill.source}</strong><small>读取材料并生成结果</small></span><span class="status info">运行中</span></div>`;
    if (call.stage === "cancelled") return `<div class="tool-call">${icon("shield")}<span><strong>${skill.name} · ${skill.source}</strong><small>未读取文件，未开始执行</small></span><span class="status neutral">已取消</span></div>`;
    return `<div class="tool-call">${icon("check")}<span><strong>${skill.name} · ${skill.source}</strong><small>已保存到${currentSpace().name}</small></span><span class="status good">已完成</span></div>`;
  }

  function filesView() {
    const space = currentSpace();
    const rows = state.scene === "home-empty" ? [] : state.space === "personal"
      ? [
          { name: "Q3 用户访谈记录.pdf", source: "Polo 助手 · 附件导入", location: "~/Documents/Polo/我的空间/附件", modified: "今天 09:42", size: "24.6 MB" },
          { name: "客户访谈洞察.docx", source: "客户访谈整理 · App 导出", location: "~/Documents/Polo/我的空间/导出", modified: "昨天 18:21", size: "4.2 MB" },
          { name: "品牌语气分析.zip", source: "Polo 助手 · AI 生成", location: "~/Documents/Polo/我的空间/生成", modified: "周一 14:08", size: "18.4 MB" }
        ]
      : [
          { name: "季度交付摘要.pdf", source: "项目交付看板 · App 导出", location: "~/Documents/Polo/北辰智能科技/导出", modified: "今天 10:12", size: "8.6 MB" },
          { name: "销售周报材料.xlsx", source: "销售周报助手 · 附件导入", location: "~/Documents/Polo/北辰智能科技/附件", modified: "昨天 17:32", size: "2.1 MB" },
          { name: "合规知识库索引.json", source: "企业知识检索 · AI 生成", location: "~/Documents/Polo/北辰智能科技/生成", modified: "周一 11:06", size: "912 KB" }
        ];
    const query = current().fileQuery.trim().toLowerCase();
    const visibleRows = rows.filter(row => !query || Object.values(row).some(value => value.toLowerCase().includes(query)));
    return `<div class="app-page-heading"><div><p class="eyebrow">系统工具 · Polo 内置</p><h1>文件</h1><p>查找${space.name}最近处理的文件</p></div><div class="heading-actions"><button class="button quiet" data-permissions="files">${icon("shield")}权限</button></div></div><div class="file-toolbar"><label>搜索最近文件<input id="file-search" type="search" value="${escapeHtml(current().fileQuery)}" placeholder="搜索文件名、来源或本机位置"></label><span>${visibleRows.length} 个最近文件</span></div><div class="table-card"><table><thead><tr><th>名称</th><th>处理来源</th><th>本机位置</th><th>最近处理</th><th>大小</th><th></th></tr></thead><tbody>${visibleRows.map(row => `<tr><td><button type="button" class="file-name" data-open-local-file="${escapeHtml(row.name)}" data-file-location="${escapeHtml(row.location)}" aria-label="使用系统默认应用打开 ${escapeHtml(row.name)}">${icon("file")}<strong>${row.name}</strong></button></td><td>${row.source}</td><td><button type="button" class="local-path" data-open-local-folder="${escapeHtml(row.location)}" title="${escapeHtml(row.location)}" aria-label="打开 ${escapeHtml(row.name)} 所在目录：${escapeHtml(row.location)}">${row.location}</button></td><td>${row.modified}</td><td>${row.size}</td><td><button class="icon-button" data-file-details="${escapeHtml(row.name)}" data-file-source="${escapeHtml(row.source)}" data-file-location="${escapeHtml(row.location)}" aria-label="查看 ${row.name} 详情">${icon("more")}</button></td></tr>`).join("") || `<tr><td colspan="6"><div class="empty-note">换个文件名或来源搜索</div></td></tr>`}</tbody></table></div>`;
  }

  function tasksView() {
    const executions = activeExecutions();
    const recentExecutions = finishedExecutions();
    const results = catalog[state.space].results;
    const activeRows = executions.map(item => `<article class="task-row"><span class="app-art compact amber">${icon(appMeta(item.appId).icon)}</span><div><h3>${item.name}</h3><p>${item.detail}</p><small>${currentSpace().name} · ${item.background ? "后台运行" : "前台运行"}</small></div><span class="status info">${statusLabel(item.status)}</span><button class="button" data-open="${item.appId}">打开</button><button class="button" data-stop-execution="${item.id}">${icon("stop")}终止</button></article>`).join("");
    const recentRows = recentExecutions.map(item => `<article class="task-row finished"><span class="app-art compact">${icon(appMeta(item.appId).icon)}</span><div><h3>${item.name}</h3><p>${item.detail}</p><small>${currentSpace().name} · 记录保留 · 结果不变</small></div><span class="status ${item.status === "failed" ? "bad" : item.status === "completed" ? "good" : "neutral"}">${statusLabel(item.status)}</span><button class="button" data-open="${item.appId}">打开 App</button></article>`).join("");
    return `<div class="app-page-heading"><div><p class="eyebrow">系统工具 · Polo 内置</p><h1>任务与结果</h1><p>查看${currentSpace().name}的执行与结果</p></div><div class="heading-actions"><span class="status ${executions.length ? "info" : "good"}">${executions.length ? `${executions.length} 项活动执行` : "当前无活动执行"}</span><button class="button quiet" data-permissions="tasks">${icon("shield")}权限</button></div></div>${section("当前执行", "查看或终止执行", `<div class="task-list">${activeRows || `<div class="empty-state"><h2>当前没有运行项</h2><p>启动 App 或助手任务</p></div>`}</div>`)}${recentRows ? section("最近执行", "查看终止与失败记录", `<div class="task-list">${recentRows}</div>`) : ""}${section("已保存结果", "打开已保存结果", `<div class="results-grid">${results.map(result => `<article class="result-card"><h3>${result.title}</h3><p>${result.description}</p><div class="result-foot"><span>${result.meta}</span><button class="text-button" data-result="${escapeHtml(result.title)}">查看</button></div></article>`).join("")}</div>`)}`;
  }

  function appView(id) {
    const item = apps[id];
    const execution = executionFor(id);
    const failedExecution = current().executions.find(entry => entry.appId === id && entry.status === "failed");
    const available = availability(item);
    const stateItem = execution || failedExecution;
    const workspaceTitle = execution ? execution.detail : failedExecution ? failedExecution.detail : state.online ? "开始新的工作" : "等待网络";
    const workspaceCopy = execution ? `使用 ${item.version} · 切换 Tab 不中断` : failedExecution ? "查看记录后重试" : item.update ? `下次执行使用 ${item.version}` : state.online ? "验证空间、授权与版本" : "恢复网络后再启动";
    const actions = execution ? `<button class="button" data-open="tasks">查看执行</button><button class="button" data-stop-execution="${execution.id}">${icon("stop")}终止执行</button>` : failedExecution ? `<button class="button" data-open="tasks">查看失败记录</button><button class="button primary" data-retry-app="${id}">${icon("refresh")}重试</button>` : `<button class="button primary" data-start-app="${id}" ${state.online ? "" : "disabled"}>${icon("play")}${state.online ? "开始使用" : "等待网络"}</button>`;
    return `<div class="app-page-heading"><div><p class="eyebrow">工作 App</p><h1>${item.name}</h1><p class="page-meta">${item.source} · ${item.version}</p><p>${item.description}</p></div><div class="heading-actions"><span class="status ${failedExecution ? "bad" : execution ? "info" : available.tone}">${stateItem ? statusLabel(stateItem.status) : available.label}</span><button class="button quiet" data-permissions="${id}">${icon("shield")}权限</button></div></div><div class="app-workspace"><div class="app-workspace-icon">${icon(item.icon)}</div><p class="eyebrow">${currentSpace().name} · App 工作区</p><h2>${workspaceTitle}</h2><p>${workspaceCopy}</p><div class="app-actions">${actions}</div></div>`;
  }

  function catalogFailureView() {
    return `<div class="app-page-heading"><div><p class="eyebrow">我的空间</p><h1>目录暂时无法加载</h1><p>重新加载目录</p></div></div><section class="recovery-card"><span class="state-icon bad">${icon("info")}</span><h2>暂时无法启动 Apps</h2><p>文件与结果继续保留</p><div class="state-actions"><button class="button primary" data-retry-catalog>${icon("refresh")}重新加载目录</button></div></section>`;
  }

  function enterpriseRestrictionView() {
    const owner = state.enterpriseRestriction === "ent-restricted-owner";
    const manager = state.enterpriseRestriction === "ent-restricted-manager";
    const closing = state.enterpriseRestriction === "ent-closing";
    const role = owner ? "Owner" : manager ? "Manager" : "Member";
    const title = closing ? "企业空间正在关闭" : "企业空间当前受限";
    const description = closing ? "查看关闭进度" : "联系管理员恢复使用";
    return `<section class="restricted-workspace"><span class="state-icon bad">${icon("shield")}</span><p class="eyebrow">北辰智能科技 · ${role}</p><h1>${title}</h1><p>${description}</p><dl class="state-facts"><div><dt>当前角色</dt><dd>${role}</dd></div><div><dt>任务</dt><dd>已终止</dd></div><div><dt>文件与结果</dt><dd>继续保留</dd></div></dl><div class="state-actions"><button class="button" data-return-personal>返回我的空间</button>${owner ? `<button class="button primary" data-action="enterprise-admin">打开企业组织管理端</button>` : `<button class="button primary" data-contact-enterprise>${manager ? "联系企业 Owner" : "联系企业管理员"}</button>`}</div></section>`;
  }

  function renderMain() {
    const context = current();
    const flowDefinition = flowSceneDefinitions[state.scene];
    main.classList.toggle("assistant-mode", context.activeTab === "assistant" && !state.settingsOpen && !flowDefinition);
    if (state.settingsOpen) main.innerHTML = settingsView();
    else if (flowDefinition) main.innerHTML = flowStateView(flowDefinition);
    else if (state.enterpriseRestriction && state.space === "enterprise") main.innerHTML = enterpriseRestrictionView();
    else if (state.catalogFailed && context.activeTab === "home") main.innerHTML = catalogFailureView();
    else if (context.activeTab === "home") main.innerHTML = context.homeView === "circles" ? circlesView() : context.homeView === "catalog" ? catalogView() : homeView();
    else if (context.activeTab === "assistant") main.innerHTML = assistantView();
    else if (context.activeTab === "files") main.innerHTML = filesView();
    else if (context.activeTab === "tasks") main.innerHTML = tasksView();
    else main.innerHTML = appView(context.activeTab);
  }

  function render() {
    if (renderSystemScreen()) return;
    renderChrome();
    renderConnectionBanner();
    renderMain();
    if (state.accessLoss && $("#modal-layer").hidden) showAccessLossDialog();
  }

  function openTab(id) {
    const valid = builtIns[id] || apps[id];
    if (!valid) return;
    if (apps[id] && apps[id].availability !== "available") { explainUnavailable(id); return; }
    const context = current();
    if (!context.tabs.includes(id)) context.tabs.push(id);
    const execution = executionFor(id);
    if (execution) execution.background = false;
    context.activeTab = id;
    context.homeView = "home";
    state.openMenu = null;
    state.runtimeOpen = false;
    state.notificationOpen = false;
    render();
  }

  function closeTabNow(id) {
    const context = current();
    context.tabs = context.tabs.filter(tab => tab !== id);
    if (context.activeTab === id) context.activeTab = "home";
    render();
  }

  function requestCloseTab(id) {
    const execution = executionFor(id);
    if (!execution) { closeTabNow(id); return; }
    showModal(dialog(`关闭 ${appMeta(id).name}`, "选择后台继续或终止", `<div class="impact-card">${icon("clock")}<span><strong>${execution.detail}</strong><small>${currentSpace().name} · ${statusLabel(execution.status)}</small></span></div>`, `<button class="button" data-close-modal>取消</button><button class="button" data-background-close="${id}">后台继续</button><button class="button danger" data-stop-close="${id}">终止并关闭</button>`));
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function dialog(title, description, body, footer) {
    return `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><div><h2 id="dialog-title">${title}</h2><p>${description}</p></div><button class="close-button" data-close-modal aria-label="关闭">${icon("close")}</button></div><div class="dialog-body">${body}</div><div class="dialog-footer">${footer}</div></section>`;
  }

  function showModal(content) {
    const layer = $("#modal-layer");
    layer.innerHTML = content;
    layer.hidden = false;
    layer.querySelector(".dialog")?.focus();
  }

  function closeModal() { $("#modal-layer").hidden = true; $("#modal-layer").innerHTML = ""; }

  function showAccessLossDialog() {
    const suspended = state.accessLoss === "member-suspended";
    const enterpriseExecutions = activeExecutions("enterprise");
    enterpriseExecutions.forEach(item => { item.status = "stopped"; });
    const layer = $("#modal-layer");
    layer.innerHTML = `<section class="dialog access-loss-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><div><p class="eyebrow">企业访问权已失效</p><h2 id="dialog-title">${suspended ? "你的企业成员资格已被暂停" : "你已被移出北辰智能科技"}</h2><p>联系管理员或返回我的空间</p></div></div><div class="dialog-body"><div class="permission-summary"><span><b>当前企业</b>北辰智能科技</span><span><b>任务</b>${enterpriseExecutions.length ? `${enterpriseExecutions.length} 项已终止` : "当前无任务"}</span><span><b>文件与结果</b>继续留在企业空间</span></div></div><div class="dialog-footer"><button class="button" data-contact-enterprise>联系企业管理员</button><button class="button primary" data-return-personal>返回我的空间</button></div></section>`;
    layer.hidden = false;
    layer.querySelector(".dialog")?.focus();
  }

  function openRuntime() {
    state.openMenu = null;
    state.runtimeOpen = true;
    renderChrome();
    const executions = activeExecutions();
    showModal(dialog("运行中心", "查看当前空间执行", executions.length ? `<div class="dialog-list">${executions.map(item => `<div class="dialog-row"><span class="app-art compact amber">${icon(appMeta(item.appId).icon)}</span><span class="row-copy"><strong>${item.name}</strong><small>${item.detail} · ${item.background ? "后台" : "前台"}</small></span><span class="row-state">${statusLabel(item.status)}</span></div>`).join("")}</div>` : `<div class="empty-note">当前没有活动执行</div>`, `<button class="button" data-close-modal>关闭</button><button class="button primary" data-action="view-runtime">查看任务与结果</button>`));
  }

  function openNotifications() {
    state.openMenu = null;
    state.runtimeOpen = false;
    state.notificationOpen = true;
    renderChrome();
    showModal(dialog("通知中心", "查看各空间通知", `<div class="notice-list"><button class="notice" data-notice-space="enterprise"><span class="notice-mark"></span><span><strong>销售周报助手正在准备材料</strong><p>进入北辰智能科技查看</p><small>北辰智能科技 · 6 分钟前</small></span></button><button class="notice success" data-notice-space="personal"><span class="notice-mark"></span><span><strong>客户访谈整理已保存结果</strong><p>查看 4 条洞察</p><small>我的空间 · 12 分钟前</small></span></button></div>`, `<button class="button" data-close-modal>关闭</button>`));
  }

  function explainUnavailable(id) {
    const item = apps[id];
    showModal(dialog(item.availability === "blocked" ? `${item.name}已被阻断` : `${item.name}当前不可用`, item.reason, `<div class="impact-card">${icon("info")}<span><strong>查看已保存结果</strong><small>暂时无法开始新执行</small></span></div>`, `<button class="button primary" data-close-modal>我知道了</button>`));
  }

  function addToHome(id) {
    const context = current();
    const item = apps[id];
    const authorizedIds = state.space === "personal" ? authorizedCircleAppIds() : [...new Set([...catalog.enterprise.added, ...catalog.enterprise.available])];
    if (!item || !authorizedIds.includes(id)) return;
    if (context.added.length >= 5) { showToast("首页已满，请先移出 App"); return; }
    if (!context.added.includes(id)) context.added.unshift(id);
    render();
    showToast(`“${item.name}”已添加到首页`);
  }

  function removeFromHome(id) {
    const context = current();
    context.added = context.added.filter(item => item !== id);
    render();
    showToast(`“${apps[id].name}”已移出首页`);
  }

  function startApp(id) {
    const item = apps[id];
    if (!state.online) { showToast("恢复网络后再启动 App"); return; }
    if (state.enterpriseRestriction) { showToast("联系管理员恢复使用"); return; }
    if (executionFor(id)) return;
    current().executions.push({ id: `exec-${id}-${Date.now()}`, appId: id, name: item.name, detail: "正在准备本次执行", status: "preparing", background: false });
    render();
    showToast(`“${item.name}”正在准备本次执行。`);
  }

  function stopExecution(executionId) {
    const item = current().executions.find(execution => execution.id === executionId);
    if (!item) return;
    item.status = "stopped";
    render();
    showToast(`已终止“${item.name}”`);
  }

  function requestSpace(next) {
    if (next === state.space) { state.openMenu = null; render(); return; }
    state.openMenu = null;
    const executions = activeExecutions();
    if (state.scene === "target-access-lost" && next === "enterprise") { showTargetSwitchFailure(next, "access"); return; }
    if (!executions.length) {
      if (state.scene === "target-load-failed") { showTargetSwitchFailure(next, "load"); return; }
      commitSpaceSwitch(next);
      return;
    }
    state.pendingSwitch = { next, originTab: current().activeTab, failedOnce: false, executionIds: executions.map(item => item.id) };
    showModal(dialog(`切换到${spaces[next].name}`, `终止 ${executions.length} 项任务后切换`, `<div class="dialog-list">${executions.map(item => `<div class="dialog-row"><span class="app-art compact amber">${icon(appMeta(item.appId).icon)}</span><span class="row-copy"><strong>${item.name}</strong><small>${item.detail} · ${item.background ? "后台" : "前台"}</small></span><span class="row-state">${statusLabel(item.status)}</span></div>`).join("")}</div><p class="dialog-note">终止失败则留在${currentSpace().name}</p>`, `<button class="button" data-cancel-switch>取消切换</button><button class="button danger" data-stop-switch="${next}">终止全部并切换</button>`));
  }

  function renderSwitchProgress() {
    const pending = state.pendingSwitch;
    if (!pending) return;
    const executions = current().executions.filter(item => pending.executionIds.includes(item.id));
    const stopped = executions.filter(item => item.status === "stopped").length;
    const failed = executions.filter(item => item.status === "failed").length;
    const percent = Math.round((stopped / Math.max(1, executions.length)) * 100);
    const failureBody = failed ? `<div class="inline-alert bad"><i></i><span>${failed} 项未能终止，请重试</span></div>` : "";
    const rows = executions.map(item => `<div class="dialog-row"><span class="app-art compact amber">${icon(appMeta(item.appId).icon)}</span><span class="row-copy"><strong>${item.name}</strong><small>${item.status === "failed" ? "未能终止，请重试" : item.status === "stopped" ? "结果继续保留" : "等待终止"}</small></span><span class="row-state ${item.status === "failed" ? "bad" : item.status === "stopped" ? "good" : "stopping"}">${item.status === "stopping" ? `<i class="spinner"></i>` : ""}${item.status === "failed" ? "终止失败" : statusLabel(item.status)}</span></div>`).join("");
    const footer = failed ? `<button class="button" data-cancel-switch>取消切换</button><button class="button primary" data-retry-switch>重试失败项</button>` : `<button class="button danger" disabled>正在终止…</button>`;
    $("#modal-layer").innerHTML = `<section class="dialog switch-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><div><h2 id="dialog-title">${failed ? "未能切换空间" : "正在终止运行项"}</h2><p>${failed ? "重试失败项或取消切换" : `等待后切换到${spaces[pending.next].name}`}</p></div></div><div class="dialog-body">${failureBody}<div class="switch-progress-summary"><span>已终止 ${stopped} / ${executions.length}</span><strong>${percent}%</strong></div><div class="progress-track"><span style="width:${percent}%"></span></div><div class="dialog-list">${rows}</div><p class="dialog-note">当前仍在${currentSpace().name}</p></div><div class="dialog-footer">${footer}</div></section>`;
  }

  function beginSwitchTermination(retry = false) {
    const pending = state.pendingSwitch;
    if (!pending) return;
    const candidates = retry
      ? current().executions.filter(item => pending.executionIds.includes(item.id) && item.status === "failed")
      : current().executions.filter(item => pending.executionIds.includes(item.id));
    candidates.forEach(item => { item.status = "stopping"; item.detail = "正在安全终止并保留已保存结果"; });
    renderChrome();
    renderSwitchProgress();
    setTimeout(() => {
      const shouldFail = state.scene === "terminate-failed" && !pending.failedOnce;
      candidates.forEach((item, index) => { item.status = shouldFail && index === candidates.length - 1 ? "failed" : "stopped"; });
      pending.failedOnce = pending.failedOnce || shouldFail;
      if (shouldFail) { renderChrome(); renderSwitchProgress(); return; }
      if (state.scene === "target-load-failed") { showTargetSwitchFailure(pending.next, "load"); return; }
      commitSpaceSwitch(pending.next, pending.originTab);
    }, 650);
  }

  function showTargetSwitchFailure(next, kind) {
    if (kind === "access") {
      state.unavailableSpaces.add(next);
      renderChrome();
    }
    const title = kind === "access" ? `无法进入${spaces[next].name}` : `未能加载${spaces[next].name}`;
    const description = kind === "access" ? "联系管理员恢复访问" : "重试加载目标空间";
    showModal(dialog(title, description, `<div class="impact-card">${icon("shield")}<span><strong>${kind === "access" ? "已从切换器移除" : "目录与权限加载失败"}</strong><small>${kind === "access" ? `继续使用${currentSpace().name}` : "重试或留在原空间"}</small></span></div>`, `<button class="button" data-cancel-switch>留在${currentSpace().name}</button>${kind === "load" ? `<button class="button primary" data-retry-target-load="${next}">重试加载</button>` : ""}`));
  }

  function commitSpaceSwitch(next, originTab = current().activeTab) {
    closeModal();
    state.pendingSwitch = null;
    state.space = next;
    if (originTab === "assistant") {
      if (!current().tabs.includes("assistant")) current().tabs.push("assistant");
      current().activeTab = "assistant";
      current().assistantPanel = "chat";
      current().messages = [{ role: "assistant", text: `这是${spaces[next].name}中的新对话。` }];
    } else current().activeTab = "home";
    current().homeView = "home";
    state.runtimeOpen = false;
    state.notificationOpen = false;
    render();
    showToast(`已进入${spaces[next].name}`);
  }

  function toggleSkill(id) {
    const context = current();
    const skill = currentSkills().find(item => item.id === id);
    if (!skill) return;
    if (!state.online) { showToast("恢复网络后管理 Skill"); return; }
    if (context.skillEnabled[id]) {
      context.skillEnabled[id] = false;
      render();
      showToast(`已在${currentSpace().name}停用“${skill.name}”。`);
      return;
    }
    showModal(dialog(`启用 ${skill.name}`, "确认来源与读取范围", `<div class="permission-summary"><span><b>来源</b>${skill.source}</span><span><b>读取范围</b>${skill.permissions}</span><span><b>使用位置</b>Polo 助手</span><span><b>当前空间</b>${currentSpace().name}</span></div>`, `<button class="button" data-close-modal>取消</button><button class="button primary" data-confirm-skill="${id}">确认启用</button>`));
  }

  function openCircleMembership(id) {
    const circle = circleById(id);
    if (!circle || current().circleMemberships[id] === "left") return;
    const membership = circleMembership(circle);
    const renewalAction = current().circleMemberships[id] === "cancelled"
      ? `<button class="button" data-resume-circle-renewal="${id}">恢复续费</button>`
      : circle.price === "免费" ? "" : `<button class="button" data-cancel-circle-renewal="${id}">取消续费</button>`;
    showModal(dialog(`管理 ${circle.name}`, "管理成员资格", `<div class="permission-summary"><span><b>当前状态</b>${membership.label}</span><span><b>圈子内容费</b>${circle.price}</span><span><b>续费或有效期</b>${membership.renewal}</span></div>`, `<button class="button" data-close-modal>关闭</button>${renewalAction}<button class="button danger" data-leave-circle="${id}">立即退出</button>`));
  }

  function confirmLeaveCircle(id) {
    const circle = circleById(id);
    if (!circle) return;
    showModal(dialog(`立即退出 ${circle.name}`, "确认撤销该圈子授权", `<div class="permission-summary"><span><b>将失去</b>${circle.apps.map(appId => `${apps[appId].name}（${circle.name}）`).join("、")}</span><span><b>其他圈子</b>继续保留</span><span><b>Skills</b>${circle.skills.length ? `${circle.skills.length} 个来源将失效` : "无"}</span><span><b>历史结果</b>继续保留</span></div>`, `<button class="button" data-circle-membership="${id}">返回</button><button class="button danger" data-confirm-leave-circle="${id}">确认立即退出</button>`));
  }

  function leaveCircle(id) {
    const context = current();
    context.circleMemberships[id] = "left";
    if (context.circleFilter === id) context.circleFilter = "all";
    const authorizedApps = new Set(authorizedCircleAppIds());
    const authorizedSkills = new Set(currentSkills().map(skill => skill.id));
    context.added = context.added.filter(appId => authorizedApps.has(appId));
    context.executions.forEach(item => { if (apps[item.appId] && !authorizedApps.has(item.appId) && ["preparing", "running", "waiting_for_network", "stopping"].includes(item.status)) item.status = "stopped"; });
    context.tabs = context.tabs.filter(tabId => builtIns[tabId] || authorizedApps.has(tabId));
    Object.keys(context.skillEnabled).forEach(skillId => { if (!authorizedSkills.has(skillId)) context.skillEnabled[skillId] = false; });
    if (!builtIns[context.activeTab] && context.activeTab !== "home" && !authorizedApps.has(context.activeTab)) context.activeTab = "home";
    context.selectedCircle = null;
    context.homeView = "circles";
    closeModal();
    render();
    showToast(`已退出“${circleById(id).name}”`);
  }

  function openLogin(reason = "login") {
    closeModal();
    state.openMenu = null;
    state.systemPhase = reason;
    state.authMode = "phone";
    state.authError = "";
    state.newAccountJourney = false;
    render();
  }

  function advanceFirstLogin() {
    if (state.newAccountJourney) {
      state.spaces.personal.added = [];
      state.spaces.personal.executions = [];
      state.spaces.personal.circleMemberships = { bridge: "left", north: "left", growth: "left" };
      state.spaces.personal.skillEnabled = {};
      catalog.personal.results = [];
    }
    state.systemPhase = "preparing";
    render();
    setTimeout(() => {
      if (state.systemPhase !== "preparing") return;
      state.systemPhase = "home-loading";
      render();
      setTimeout(() => {
        if (state.systemPhase !== "home-loading") return;
        state.systemPhase = null;
        state.scene = state.newAccountJourney ? "home-empty" : "home-normal";
        render();
        showToast("我的空间已就绪");
      }, 700);
    }, 700);
  }

  function reconnectNetwork() {
    if (state.reconnecting) return;
    state.reconnecting = true;
    render();
    setTimeout(() => {
      state.online = true;
      state.reconnecting = false;
      const waiting = current().executions.filter(item => item.status === "waiting_for_network");
      waiting.forEach(item => {
        if (state.scene === "unknown-not-success") {
          item.status = "unknown";
          item.detail = "结果仍待确认";
        } else {
          item.status = "running";
          item.detail = "验证通过，继续执行";
        }
      });
      render();
      showToast(state.scene === "unknown-not-success" ? "网络已恢复，结果待确认" : "网络已恢复，验证通过");
    }, 850);
  }

  function returnToPersonal() {
    closeModal();
    state.accessLoss = null;
    state.enterpriseRestriction = null;
    state.space = "personal";
    current().activeTab = "home";
    current().homeView = "home";
    render();
    showToast("已返回我的空间");
  }

  document.addEventListener("click", event => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.matches("[data-scene-link]")) {
      const url = new URL(window.location.href);
      url.searchParams.set("scene", target.dataset.sceneLink);
      window.location.href = url.toString();
      return;
    }
    if (target.matches("[data-external-flow]")) {
      const flow = target.dataset.externalFlow;
      const labels = {
        "circle-checkout": ["在浏览器确认支付", "完成后返回 Polo"],
        "billing-help": ["在浏览器查看订单", "查看订单与退款进度"],
        "create-enterprise": ["在浏览器创建企业", "完成后刷新空间列表"],
        "local-storage": ["本机存储", "查看缓存与下载位置"],
        "authorization-records": ["授权记录", "查看 App 与 Skill 授权"]
      };
      const [title, description] = labels[flow] || ["在系统浏览器继续", "完成后返回 Polo"];
      const footer = flow === "circle-checkout"
        ? `<button class="button" data-close-modal>取消</button><button class="button primary" data-scene-link="pay-processing">支付完成后返回 Polo</button>`
        : `<button class="button primary" data-close-modal>我知道了</button>`;
      showModal(dialog(title, description, `<div class="impact-card">${icon("external")}<span><strong>继续使用浏览器</strong><small>完成后返回 Polo</small></span></div>`, footer));
      return;
    }
    if (target.dataset.action === "logout") { openLogin("login"); return; }
    if (target.matches("[data-auth-method]")) { state.systemPhase = "login"; state.authMode = target.dataset.authMethod; state.authError = ""; render(); return; }
    if (target.matches("[data-system-help]")) { state.systemHelpOpen = !state.systemHelpOpen; render(); return; }
    if (target.matches("[data-start-upgrade]")) { state.upgradeStage = "updating"; render(); setTimeout(() => { if (state.upgradeStage === "updating") { state.upgradeStage = "rebuild"; render(); } }, 900); return; }
    if (target.matches("[data-complete-upgrade]")) { state.upgradeStage = "available"; state.systemPhase = "preparing"; state.scene = "post-upgrade-rebuild"; advanceFirstLogin(); return; }
    if (target.matches("[data-retry-preparing]")) { state.systemPhase = "home-loading"; render(); return; }
    if (target.matches("[data-complete-home-loading]")) { state.systemPhase = null; state.scene = "home-normal"; render(); return; }
    if (target.matches("[data-retry-personal-space]")) { state.systemPhase = "home-loading"; state.space = "personal"; render(); return; }
    if (target.matches("[data-retry-catalog]")) { state.catalogFailed = false; render(); showToast("目录和授权已经重新加载。"); return; }
    if (target.matches("[data-reconnect]")) { reconnectNetwork(); return; }
    if (target.matches("[data-return-personal]")) { returnToPersonal(); return; }
    if (target.matches("[data-contact-enterprise]")) { showToast("已打开管理员联系方式"); return; }
    if (target.matches("[data-cancel-switch]")) { current().executions.forEach(item => { if (item.status === "failed") { item.status = "running"; item.detail = "终止失败，执行仍留在原空间"; } }); state.pendingSwitch = null; closeModal(); render(); showToast(`已取消切换，仍位于${currentSpace().name}。`); return; }
    if (target.matches("[data-retry-switch]")) { beginSwitchTermination(true); return; }
    if (target.matches("[data-retry-target-load]")) { const next = target.dataset.retryTargetLoad; state.scene = "switch-success"; commitSpaceSwitch(next, state.pendingSwitch?.originTab); return; }
    if (target.matches("[data-close-modal]")) { closeModal(); state.runtimeOpen = false; state.notificationOpen = false; renderChrome(); return; }
    if (target.id === "space-trigger") { state.openMenu = state.openMenu === "space" ? null : "space"; renderChrome(); return; }
    if (target.id === "account-button") { state.openMenu = state.openMenu === "account" ? null : "account"; renderChrome(); return; }
    if (target.id === "runtime-button") { if (state.runtimeOpen) { closeModal(); state.runtimeOpen = false; renderChrome(); } else openRuntime(); return; }
    if (target.id === "notification-button") { if (state.notificationOpen) { closeModal(); state.notificationOpen = false; renderChrome(); } else openNotifications(); return; }
    if (target.matches("[data-space]")) { requestSpace(target.dataset.space); return; }
    if (target.matches("[data-tab]")) { current().activeTab = target.dataset.tab; current().homeView = "home"; if (target.dataset.tab === "home") { current().highlightedApp = null; current().highlightedCircle = null; } state.openMenu = null; render(); return; }
    if (target.matches("[data-close]")) { event.stopPropagation(); requestCloseTab(target.dataset.close); return; }
    if (target.matches("[data-open]")) { openTab(target.dataset.open); return; }
    if (target.matches("[data-add]")) { addToHome(target.dataset.add); return; }
    if (target.matches("[data-remove]")) { removeFromHome(target.dataset.remove); return; }
    if (target.matches("[data-explain]")) { explainUnavailable(target.dataset.explain); return; }
    if (target.matches("[data-circle]")) { current().selectedCircle = target.dataset.circle; current().activeTab = "home"; current().homeView = "circles"; render(); return; }
    if (target.matches("[data-circle-list]")) { current().selectedCircle = null; current().activeTab = "home"; current().homeView = "circles"; render(); return; }
    if (target.matches("[data-circle-filter]")) { current().circleFilter = target.dataset.circleFilter; renderMain(); return; }
    if (target.matches("[data-manage-circle-app]")) { current().highlightedApp = target.dataset.manageCircleApp; current().highlightedCircle = target.dataset.circleSource || null; current().activeTab = "home"; current().homeView = "catalog"; render(); return; }
    if (target.matches("[data-open-assistant-skill]")) { current().highlightedSkill = target.dataset.openAssistantSkill; current().assistantPanel = "skills"; openTab("assistant"); return; }
    if (target.matches("[data-home-view]")) {
      const nextHomeView = target.dataset.homeView;
      state.settingsOpen = false;
      current().activeTab = "home";
      current().homeView = nextHomeView;
      if (nextHomeView === "circles") current().selectedCircle = null;
      current().highlightedApp = null;
      current().highlightedCircle = null;
      render();
      if (nextHomeView === "catalog") $("#app-catalog-search")?.focus();
      return;
    }
    if (target.matches("[data-open-assistant-skills]")) { current().assistantPanel = "skills"; openTab("assistant"); return; }
    if (target.matches("[data-assistant-panel]")) { current().assistantPanel = target.dataset.assistantPanel; render(); return; }
    if (target.matches("[data-skill-toggle]")) { toggleSkill(target.dataset.skillToggle); return; }
    if (target.matches("[data-confirm-skill]")) { const id = target.dataset.confirmSkill; current().skillEnabled[id] = true; closeModal(); render(); showToast("Skill 已启用"); return; }
    if (target.matches("[data-circle-membership]")) { closeModal(); openCircleMembership(target.dataset.circleMembership); return; }
    if (target.matches("[data-cancel-circle-renewal]")) { const id = target.dataset.cancelCircleRenewal; current().circleMemberships[id] = "cancelled"; closeModal(); render(); showToast(`已取消“${circleById(id).name}”续费，当前周期内仍可使用。`); return; }
    if (target.matches("[data-resume-circle-renewal]")) { const id = target.dataset.resumeCircleRenewal; current().circleMemberships[id] = "active"; closeModal(); render(); showToast(`已恢复“${circleById(id).name}”续费。`); return; }
    if (target.matches("[data-leave-circle]")) { confirmLeaveCircle(target.dataset.leaveCircle); return; }
    if (target.matches("[data-confirm-leave-circle]")) { leaveCircle(target.dataset.confirmLeaveCircle); return; }
    if (target.matches("[data-cancel-skill-call]")) { const message = current().messages.find(item => item.call?.id === target.dataset.cancelSkillCall); if (message) message.call.stage = "cancelled"; render(); return; }
    if (target.matches("[data-confirm-skill-call]")) {
      if (!state.online) { showToast("当前离线，不能开始新的 Skill 调用。"); return; }
      const spaceId = state.space;
      const message = current().messages.find(item => item.call?.id === target.dataset.confirmSkillCall);
      if (!message || message.call.stage !== "permission") return;
      const skill = catalog[spaceId].skills.find(item => item.id === message.call.skillId);
      const executionId = `exec-skill-${message.call.id}`;
      message.call.stage = "running";
      current().executions.push({ id: executionId, appId: "assistant", name: skill.name, detail: `Polo 助手正在调用 ${skill.name}`, status: "running", background: false });
      render();
      setTimeout(() => {
        const spaceState = state.spaces[spaceId];
        const pendingMessage = spaceState.messages.find(item => item.call?.id === message.call.id);
        const execution = spaceState.executions.find(item => item.id === executionId);
        if (!pendingMessage || pendingMessage.call.stage !== "running" || !execution || execution.status !== "running") return;
        pendingMessage.call.stage = "result";
        execution.status = "completed";
        execution.detail = `${skill.name} 已生成并保存结果`;
        if (state.space === spaceId) render();
      }, 900);
      return;
    }
    if (target.matches("[data-start-app]")) { startApp(target.dataset.startApp); return; }
    if (target.matches("[data-retry-app]")) {
      const id = target.dataset.retryApp;
      current().executions = current().executions.filter(item => !(item.appId === id && item.status === "failed"));
      startApp(id);
      return;
    }
    if (target.matches("[data-stop-execution]")) { stopExecution(target.dataset.stopExecution); return; }
    if (target.matches("[data-background-close]")) { const id = target.dataset.backgroundClose; const execution = executionFor(id); if (execution) execution.background = true; closeModal(); closeTabNow(id); showToast(`“${appMeta(id).name}”继续在${currentSpace().name}后台运行。`); return; }
    if (target.matches("[data-stop-close]")) { const id = target.dataset.stopClose; const execution = executionFor(id); if (execution) execution.status = "stopped"; closeModal(); closeTabNow(id); showToast(`已终止并关闭“${appMeta(id).name}”。`); return; }
    if (target.matches("[data-stop-switch]")) { beginSwitchTermination(); return; }
    if (target.matches("[data-notice-space]")) { const next = target.dataset.noticeSpace; closeModal(); state.notificationOpen = false; if (next === state.space) { render(); showToast("已位于该通知所属空间。"); } else requestSpace(next); return; }
    if (target.dataset.action === "view-runtime") { closeModal(); state.runtimeOpen = false; openTab("tasks"); return; }
    if (target.dataset.action === "theme") { state.theme = state.theme === "dark" ? "light" : "dark"; state.openMenu = null; localStorage.setItem("polo-g4-theme", state.theme); render(); showToast(`已切换到${state.theme === "dark" ? "深色" : "浅色"}主题。`); return; }
    if (target.dataset.action === "settings") { state.openMenu = null; state.settingsOpen = true; current().activeTab = "home"; render(); return; }
    if (["enterprise-admin", "creator-workbench"].includes(target.dataset.action)) { state.openMenu = null; render(); showToast("正在打开浏览器"); return; }
    if (target.matches("[data-permissions]")) { const id = target.dataset.permissions; const meta = appMeta(id); const scope = permissionScopes[id]?.(currentSpace()) || `使用${currentSpace().name}已授权的数据`; showModal(dialog(`${meta.name}权限`, "查看访问范围", `<div class="permission-summary"><span><b>空间</b>${currentSpace().name}</span><span><b>来源与版本</b>${meta.source} · ${meta.version}</span><span><b>允许范围</b>${scope}</span><span><b>保存到</b>${currentSpace().dataOwner}</span></div>`, `<button class="button primary" data-close-modal>关闭</button>`)); return; }
    if (target.dataset.action === "attach-file") { showToast(state.online ? `选择${currentSpace().name}中的文件` : "恢复网络后添加附件"); return; }
    if (target.matches("[data-open-local-file]")) { const name = target.dataset.openLocalFile; closeModal(); showToast(`正在打开“${name}”`); return; }
    if (target.matches("[data-open-local-folder]")) { const location = target.dataset.openLocalFolder; closeModal(); showToast(`正在打开“${location}”`); return; }
    if (target.matches("[data-file-details]")) { const name = target.dataset.fileDetails; const source = target.dataset.fileSource; const location = target.dataset.fileLocation; showModal(dialog(name, "打开文件或所在目录", `<div class="permission-summary"><span><b>所在空间</b>${currentSpace().name}</span><span><b>处理来源</b>${source}</span><span><b>本机位置</b><code>${location}</code></span></div>`, `<button class="button" data-close-modal>关闭</button><button class="button" data-open-local-folder="${escapeHtml(location)}">打开所在目录</button><button class="button primary" data-open-local-file="${escapeHtml(name)}" data-file-location="${escapeHtml(location)}">使用默认应用打开</button>`)); return; }
    if (target.dataset.action === "new-chat") { current().messages = [{ role: "assistant", text: `这是${currentSpace().name}中的新对话。` }]; render(); return; }
    if (target.dataset.result) { event.preventDefault(); showToast(`已打开“${target.dataset.result}”。`); }
  });

  document.addEventListener("submit", event => {
    if (event.target.id === "auth-form") {
      event.preventDefault();
      state.authError = "";
      if (state.authMode === "phone") {
        const phone = $("#auth-phone")?.value.trim() || "";
        if (!/^1\d{10}$/.test(phone)) { state.authPhone = phone; state.authError = "请输入有效的 11 位手机号。"; render(); return; }
        state.authPhone = phone;
        state.authMode = "code";
        render();
        return;
      }
      if (state.authMode === "code") {
        const code = $("#auth-code")?.value.trim() || "";
        if (!/^\d{6}$/.test(code)) { state.authError = "请输入收到的 6 位验证码。"; render(); return; }
        advanceFirstLogin();
        return;
      }
      const phone = $("#auth-phone")?.value.trim() || "";
      const password = $("#auth-password")?.value || "";
      if (!/^1\d{10}$/.test(phone) || password.length < 6) { state.authPhone = phone; state.authError = "请输入有效手机号和至少 6 位密码。"; render(); return; }
      state.authPhone = phone;
      advanceFirstLogin();
      return;
    }
    if (event.target.id !== "chat-form") return;
    event.preventDefault();
    if (!state.online) { showToast("离线时无法发送或调用 Skill"); return; }
    const input = $("#chat-input");
    const select = $("#skill-select");
    const text = input.value.trim();
    if (!text) return;
    const skillId = select.value === "none" ? "" : select.value;
    const skill = catalog[state.space].skills.find(item => item.id === skillId && current().skillEnabled[item.id]);
    current().messages.push({ role: "user", text });
    current().messages.push(skill
      ? { role: "assistant", text: `确认“${skill.name}”的读取范围`, call: { id: `call-${Date.now()}`, skillId: skill.id, stage: "permission" } }
      : { role: "assistant", text: "使用助手基础能力" });
    render();
  });

  document.addEventListener("input", event => {
    if (!["file-search", "circle-app-search", "app-catalog-search"].includes(event.target.id)) return;
    const inputId = event.target.id;
    if (inputId === "file-search") current().fileQuery = event.target.value;
    else if (inputId === "circle-app-search") current().circleQuery = event.target.value;
    else current().catalogQuery = event.target.value;
    renderMain();
    const input = $(`#${inputId}`);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (state.accessLoss || (state.pendingSwitch && current().executions.some(item => item.status === "stopping"))) return;
    if (!$("#modal-layer").hidden) { closeModal(); state.runtimeOpen = false; state.notificationOpen = false; renderChrome(); }
    else if (state.openMenu) { state.openMenu = null; renderChrome(); }
  });

  window.addEventListener("resize", () => { $("#window-guard").hidden = window.innerWidth > 640; });
  $("#window-guard").hidden = window.innerWidth > 640;
  render();

  function bootstrapInitialScene() {
    if (initialScene === "preparing") { advanceFirstLogin(); return; }
    if (initialScene === "switch-success") { current().executions.forEach(item => { item.status = "stopped"; }); commitSpaceSwitch("enterprise"); return; }
    if (initialScene === "target-access-lost") { requestSpace("enterprise"); return; }
    if (initialScene === "target-load-failed") {
      current().executions.forEach(item => { item.status = "stopped"; });
      requestSpace("enterprise");
      return;
    }
    if (["switch-running-confirm", "terminating-progress", "terminate-failed", "assistant-switch"].includes(initialScene)) {
      requestSpace("enterprise");
      if (["terminating-progress", "terminate-failed"].includes(initialScene)) setTimeout(() => beginSwitchTermination(), 80);
    }
  }

  bootstrapInitialScene();
})();
