/* =========================================================
   Liquid Tasks — ตรรกะของแอป (ไม่ใช้ไลบรารีภายนอก)
   ข้อมูลหลักเก็บบน Neon Postgres ผ่าน /api/tasks
   localStorage ใช้เป็นแคช + โหมดสำรองเมื่อเชื่อมต่อคลาวด์ไม่ได้
   ========================================================= */
(() => {
  'use strict';

  const STORAGE_KEY = 'liquid-tasks:v1';     // แคชรายการงานในเครื่อง
  const PREFS_KEY = 'liquid-tasks:prefs';
  const BOARD_KEY = 'liquid-tasks:board';    // รหัสบอร์ด (กุญแจเข้าถึงข้อมูลบนคลาวด์)
  const BOARD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
  const API_BASE = '/api/tasks';
  const TOAST_MS = 6000;

  const PRIORITIES = {
    1: { label: 'ต่ำมาก' },
    2: { label: 'ต่ำ' },
    3: { label: 'ปานกลาง' },
    4: { label: 'สูง' },
    5: { label: 'เร่งด่วน' },
  };
  const DEFAULT_PRIORITY = 3;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    todayLabel: $('#today-label'),
    progressLabel: $('#progress-label'),
    progressRatio: $('#progress-ratio'),
    progressBar: $('#progress-bar'),
    progressFill: $('#progress-fill'),

    sidebar: $('#sidebar'),
    addSection: $('#add-section'),
    addSheet: $('#add-sheet'),
    sheetClose: $('#sheet-close'),
    fab: $('#fab'),

    form: $('#task-form'),
    title: $('#task-title'),
    titleError: $('#title-error'),
    note: $('#task-note'),
    due: $('#task-due'),
    priorityPicker: $('#priority-picker'),

    statTotal: $('#stat-total'),
    statPending: $('#stat-pending'),
    statDone: $('#stat-done'),
    statOverdue: $('#stat-overdue'),
    prioStats: $('#prio-stats'),

    search: $('#search'),
    statusFilter: $('#status-filter'),
    countAll: $('#count-all'),
    countPending: $('#count-pending'),
    countDone: $('#count-done'),
    priorityFilter: $('#priority-filter'),
    sort: $('#sort'),
    clearDone: $('#clear-done'),

    list: $('#task-list'),
    empty: $('#empty-state'),
    emptyTitle: $('#empty-title'),
    emptyText: $('#empty-text'),
    template: $('#task-template'),

    editDialog: $('#edit-dialog'),
    editForm: $('#edit-form'),
    editTitle: $('#edit-title'),
    editTitleError: $('#edit-title-error'),
    editNote: $('#edit-note'),
    editDue: $('#edit-due'),
    editPriorityPicker: $('#edit-priority-picker'),
    editClose: $('#edit-close'),
    editCancel: $('#edit-cancel'),

    toast: $('#toast'),
    toastText: $('#toast-text'),
    toastUndo: $('#toast-undo'),

    sync: $('#sync-status'),
    syncText: $('#sync-text'),
    shareBtn: $('#share-btn'),
    shareDialog: $('#share-dialog'),
    shareClose: $('#share-close'),
    shareUrl: $('#share-url'),
    shareCopy: $('#share-copy'),
    shareBoard: $('#share-board'),
    shareOffline: $('#share-offline'),
  };

  const state = {
    tasks: [],
    status: 'all',      // all | pending | done
    priority: 'all',    // all | 1..5
    query: '',
    sort: 'priority',   // priority | due | newest | oldest | title
    editingId: null,
    flashId: null,      // งานที่เพิ่งเพิ่ม (ใช้เล่นแอนิเมชัน)
    firstRender: true,
    toast: null,        // { timer, onUndo }
    mode: 'local',      // remote = ซิงก์กับฐานข้อมูล | local = บันทึกในเครื่องเท่านั้น
    loading: false,     // กำลังโหลดข้อมูลครั้งแรกจากคลาวด์
    pending: 0,         // จำนวนคำขอบันทึกที่ค้างอยู่
    boardId: null,
  };

  /* ---------- วันที่ ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => toISODate(new Date());

  function parseISODate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(iso, days) {
    const d = parseISODate(iso);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }
  function daysUntil(iso) {
    return Math.round((parseISODate(iso) - parseISODate(todayISO())) / 86400000);
  }

  const dateFmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  const longDateFmt = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const stampFmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /* ---------- เครื่องมือทั่วไป ---------- */
  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function clampPriority(p) {
    const n = Number(p);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : DEFAULT_PRIORITY;
  }
  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string') return null;
    const title = raw.title.trim().slice(0, 120);
    if (!title) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      title,
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : '',
      priority: clampPriority(raw.priority),
      due: /^\d{4}-\d{2}-\d{2}$/.test(raw.due || '') ? raw.due : '',
      done: Boolean(raw.done),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    };
  }

  /* ---------- แคชในเครื่อง (localStorage) ---------- */
  function loadCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null; // ยังไม่เคยใช้งานบนเครื่องนี้
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.map(normalizeTask).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  function cacheTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
    } catch (err) {
      console.warn('ไม่สามารถบันทึกแคชได้', err);
    }
  }

  /* ---------- รหัสบอร์ด ----------
     แต่ละเบราว์เซอร์จะได้รหัสบอร์ดแบบสุ่ม (เดาไม่ได้) ใช้เป็นกุญแจเข้าถึงงานบนคลาวด์
     เปิดลิงก์ ?board=<รหัส> บนอุปกรณ์อื่นเพื่อใช้บอร์ดเดียวกัน */
  function resolveBoardId() {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('board');
    let stored = null;
    try { stored = localStorage.getItem(BOARD_KEY); } catch { /* ไม่เป็นไร */ }

    let id = null;
    let source = 'stored';
    if (fromUrl && BOARD_ID_RE.test(fromUrl)) {
      id = fromUrl;
      source = 'url';
    } else if (stored && BOARD_ID_RE.test(stored)) {
      id = stored;
    } else {
      id = uid();
      source = 'new';
    }
    try { localStorage.setItem(BOARD_KEY, id); } catch { /* ไม่เป็นไร */ }

    if (fromUrl) {
      // ซ่อนรหัสออกจากแถบที่อยู่หลังรับค่าแล้ว
      url.searchParams.delete('board');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return { id, source, changed: source === 'url' && stored !== id };
  }

  function shareUrl() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('board', state.boardId);
    return url.toString();
  }

  /* ---------- API (Neon Postgres ผ่าน Vercel Functions) ---------- */
  const api = {
    async request(method, path = '', body) {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Board-Id': state.boardId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { /* ไม่มี body */ }
      if (!res.ok) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
    list: () => api.request('GET'),
    create: (tasks) => api.request('POST', '', tasks),
    update: (id, patch) => api.request('PATCH', `/${encodeURIComponent(id)}`, patch),
    remove: (id) => api.request('DELETE', `/${encodeURIComponent(id)}`),
    removeDone: () => api.request('DELETE', '?done=true'),
  };

  /* ---------- สถานะการซิงก์ ---------- */
  function setSyncStatus(status) {
    const labels = {
      syncing: 'กำลังซิงก์…',
      online: 'ซิงก์กับคลาวด์แล้ว',
      offline: 'ออฟไลน์ · บันทึกในเครื่อง',
    };
    els.sync.classList.remove('is-syncing', 'is-online', 'is-offline');
    els.sync.classList.add(`is-${status}`);
    els.syncText.textContent = labels[status] || '';
    els.sync.title = status === 'offline'
      ? 'เชื่อมต่อฐานข้อมูลไม่ได้ ข้อมูลจะถูกเก็บไว้ในเบราว์เซอร์นี้เท่านั้น'
      : 'ข้อมูลของคุณถูกบันทึกบน Neon Postgres';
  }
  function settleSyncStatus() {
    if (state.pending > 0) return;
    setSyncStatus(state.mode === 'remote' ? 'online' : 'offline');
  }

  /** บันทึกแคชเสมอ และถ้าอยู่ในโหมดคลาวด์ให้ส่งการเปลี่ยนแปลงขึ้นเซิร์ฟเวอร์
      คำขอจะถูกส่งทีละรายการตามลำดับ เพื่อไม่ให้ "ลบ" กับ "เลิกทำ" แซงกัน */
  let syncQueue = Promise.resolve();
  function persist(action) {
    cacheTasks();
    if (state.mode !== 'remote' || typeof action !== 'function') return syncQueue;
    state.pending += 1;
    setSyncStatus('syncing');
    syncQueue = syncQueue
      .then(() => action())
      .catch(async (err) => {
        console.error('บันทึกขึ้นคลาวด์ไม่สำเร็จ', err);
        showToast('บันทึกขึ้นคลาวด์ไม่สำเร็จ กำลังโหลดข้อมูลล่าสุด…');
        await refreshFromServer();
      })
      .finally(() => {
        state.pending -= 1;
        settleSyncStatus();
      });
    return syncQueue;
  }

  /** ดึงข้อมูลล่าสุดจากเซิร์ฟเวอร์มาแทนที่ (ใช้เมื่อซิงก์พลาด) */
  async function refreshFromServer() {
    try {
      const { tasks } = await api.list();
      state.tasks = tasks.map(normalizeTask).filter(Boolean);
      cacheTasks();
      render();
    } catch (err) {
      console.error('โหลดข้อมูลจากคลาวด์ไม่สำเร็จ', err);
      state.mode = 'local';
      showToast('เชื่อมต่อคลาวด์ไม่ได้ สลับเป็นโหมดบันทึกในเครื่อง');
    }
  }
  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (typeof prefs.sort === 'string' && SORTERS[prefs.sort]) state.sort = prefs.sort;
    } catch { /* ไม่เป็นไร ใช้ค่าเริ่มต้น */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: state.sort }));
    } catch { /* ไม่เป็นไร */ }
  }

  function sampleTasks() {
    const today = todayISO();
    const now = Date.now();
    const make = (title, note, priority, due, done, minutesAgo) => ({
      id: uid(), title, note, priority, due, done,
      createdAt: new Date(now - minutesAgo * 60000).toISOString(),
      completedAt: done ? new Date(now - minutesAgo * 30000).toISOString() : null,
    });
    return [
      make('ส่งรายงานสรุปประจำเดือน', 'รวบรวมตัวเลขจากทีมขายและทีมการตลาดก่อนส่งผู้จัดการ', 5, addDays(today, 1), false, 300),
      make('เตรียมสไลด์นำเสนอลูกค้า', '', 4, addDays(today, 3), false, 240),
      make('ตอบอีเมลที่ค้างอยู่', 'เน้นอีเมลจากฝ่ายบัญชีก่อน', 3, today, false, 180),
      make('อ่านบทความเรื่อง UX Design', 'เก็บไว้อ่านตอนว่าง', 2, '', false, 120),
      make('จัดโต๊ะทำงาน', '', 1, '', true, 60),
    ];
  }

  /* ---------- ตัวเลือกระดับความสำคัญ ---------- */
  function renderPriorityPicker(container, name, selected = DEFAULT_PRIORITY) {
    container.innerHTML = '';
    for (let p = 1; p <= 5; p++) {
      const label = document.createElement('label');
      label.className = `prio prio-${p}${p === selected ? ' is-checked' : ''}`;
      label.title = `ระดับ ${p} · ${PRIORITIES[p].label}`;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = String(p);
      input.defaultChecked = p === selected;
      input.checked = p === selected;
      input.setAttribute('aria-label', `ระดับ ${p} ${PRIORITIES[p].label}`);

      const dot = document.createElement('span');
      dot.className = 'prio-dot';
      const num = document.createElement('span');
      num.className = 'prio-num';
      num.textContent = String(p);
      const text = document.createElement('span');
      text.className = 'prio-label';
      text.textContent = PRIORITIES[p].label;

      label.append(input, dot, num, text);
      container.appendChild(label);
    }
  }
  function syncPicker(container) {
    $$('.prio', container).forEach((label) => {
      label.classList.toggle('is-checked', label.querySelector('input').checked);
    });
  }
  function getPickerValue(container) {
    const checked = container.querySelector('input:checked');
    return checked ? clampPriority(checked.value) : DEFAULT_PRIORITY;
  }
  function setPickerValue(container, value) {
    const input = container.querySelector(`input[value="${clampPriority(value)}"]`);
    if (input) input.checked = true;
    syncPicker(container);
  }

  /* ---------- กรอง / เรียงลำดับ ---------- */
  const collator = new Intl.Collator('th');
  function compareDue(a, b) {
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  }
  function compareCreated(a, b) {
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  }
  const SORTERS = {
    priority: (a, b) => b.priority - a.priority || compareDue(a, b) || compareCreated(b, a),
    due: (a, b) => compareDue(a, b) || b.priority - a.priority,
    newest: (a, b) => compareCreated(b, a),
    oldest: (a, b) => compareCreated(a, b),
    title: (a, b) => collator.compare(a.title, b.title),
  };

  function matchesFilters(task) {
    if (state.status === 'pending' && task.done) return false;
    if (state.status === 'done' && !task.done) return false;
    if (state.priority !== 'all' && task.priority !== Number(state.priority)) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      if (!task.title.toLowerCase().includes(q) && !task.note.toLowerCase().includes(q)) return false;
    }
    return true;
  }
  function visibleTasks() {
    const sorter = SORTERS[state.sort] || SORTERS.priority;
    return state.tasks.filter(matchesFilters).sort((a, b) => {
      // เมื่อดู "ทั้งหมด" ให้งานที่เสร็จแล้วไปอยู่ท้ายรายการ
      if (state.status === 'all' && a.done !== b.done) return a.done ? 1 : -1;
      return sorter(a, b);
    });
  }

  /* ---------- กำหนดส่ง ---------- */
  function describeDue(task) {
    if (!task.due) return null;
    const dateText = dateFmt.format(parseISODate(task.due));
    if (task.done) return { text: dateText, state: 'done' };
    const diff = daysUntil(task.due);
    if (diff < 0) return { text: `เลยกำหนด ${Math.abs(diff)} วัน · ${dateText}`, state: 'overdue' };
    if (diff === 0) return { text: `วันนี้ · ${dateText}`, state: 'today' };
    if (diff === 1) return { text: `พรุ่งนี้ · ${dateText}`, state: 'soon' };
    if (diff <= 7) return { text: `อีก ${diff} วัน · ${dateText}`, state: 'soon' };
    return { text: dateText, state: 'later' };
  }
  function isOverdue(task) {
    return !task.done && Boolean(task.due) && daysUntil(task.due) < 0;
  }

  /* ---------- การแสดงผล ---------- */
  function render() {
    renderList();
    renderStats();
  }

  function renderList() {
    const tasks = visibleTasks();
    els.list.innerHTML = '';

    if (tasks.length === 0) {
      showEmptyState();
      state.firstRender = false;
      state.flashId = null;
      return;
    }

    els.empty.hidden = true;
    const frag = document.createDocumentFragment();
    tasks.forEach((task, i) => {
      const animate = state.firstRender || task.id === state.flashId;
      frag.appendChild(buildTaskNode(task, i, animate));
    });
    els.list.appendChild(frag);
    state.firstRender = false;
    state.flashId = null;
  }

  function showEmptyState() {
    let title = 'ยังไม่มีงาน';
    let text = 'เพิ่มงานแรกของคุณได้เลย';
    if (state.loading) {
      title = 'กำลังโหลดข้อมูล…';
      text = 'กำลังดึงรายการงานจากคลาวด์';
    } else if (state.tasks.length > 0) {
      if (state.query) {
        title = 'ไม่พบงานที่ค้นหา';
        text = `ไม่มีงานที่ตรงกับ "${state.query}"`;
      } else if (state.status === 'done') {
        title = 'ยังไม่มีงานที่เสร็จ';
        text = 'ติ๊กถูกหน้างานเมื่อทำเสร็จแล้ว';
      } else if (state.status === 'pending') {
        title = 'เยี่ยม! ไม่มีงานค้าง';
        text = state.priority === 'all' ? 'งานทั้งหมดเสร็จเรียบร้อยแล้ว' : 'ไม่มีงานค้างในระดับความสำคัญนี้';
      } else {
        title = 'ไม่พบงาน';
        text = 'ลองเปลี่ยนตัวกรองดู';
      }
    }
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = text;
    els.empty.hidden = false;
  }

  function buildTaskNode(task, index, animate) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;
    node.dataset.priority = String(task.priority);
    node.classList.toggle('is-done', task.done);
    if (animate) {
      node.classList.add('is-new');
      node.style.animationDelay = `${Math.min(index, 8) * 30}ms`;
    }

    const checkbox = $('.check-input', node);
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', `${task.done ? 'ทำเครื่องหมายว่ายังไม่เสร็จ' : 'ทำเครื่องหมายว่าเสร็จแล้ว'}: ${task.title}`);

    $('.task-title', node).textContent = task.title;
    $('.badge', node).textContent = `${task.priority} · ${PRIORITIES[task.priority].label}`;
    $('.task-note', node).textContent = task.note;

    const due = $('.due', node);
    const info = describeDue(task);
    if (info) {
      $('.due-text', due).textContent = info.text;
      due.classList.add(`is-${info.state}`);
    } else {
      due.hidden = true;
    }

    $('.created', node).textContent = task.done && task.completedAt
      ? `เสร็จเมื่อ ${stampFmt.format(new Date(task.completedAt))}`
      : `สร้างเมื่อ ${stampFmt.format(new Date(task.createdAt))}`;

    return node;
  }

  function renderStats() {
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.done).length;
    const pending = total - done;
    const overdue = state.tasks.filter(isOverdue).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    els.statTotal.textContent = total;
    els.statPending.textContent = pending;
    els.statDone.textContent = done;
    els.statOverdue.textContent = overdue;
    els.countAll.textContent = total;
    els.countPending.textContent = pending;
    els.countDone.textContent = done;

    els.progressFill.style.width = `${pct}%`;
    els.progressBar.setAttribute('aria-valuenow', String(pct));
    els.progressRatio.textContent = `${done} / ${total}`;
    els.progressLabel.textContent = total === 0
      ? 'ยังไม่มีงาน'
      : pct === 100 ? 'เสร็จครบทุกงานแล้ว' : `เสร็จแล้ว ${pct}%`;

    els.clearDone.disabled = done === 0;

    // งานค้างแยกตามระดับความสำคัญ
    const counts = {};
    for (let p = 1; p <= 5; p++) counts[p] = state.tasks.filter((t) => !t.done && t.priority === p).length;
    const max = Math.max(1, ...Object.values(counts));

    els.prioStats.innerHTML = '';
    for (let p = 5; p >= 1; p--) {
      const li = document.createElement('li');
      li.className = `prio-${p}`;

      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${p} · ${PRIORITIES[p].label}`;
      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${(counts[p] / max) * 100}%`;
      bar.appendChild(fill);
      const count = document.createElement('strong');
      count.textContent = String(counts[p]);

      li.append(dot, label, bar, count);
      els.prioStats.appendChild(li);
    }
  }

  /* ---------- การจัดการงาน ----------
     ทุกการเปลี่ยนแปลงจะอัปเดตหน้าจอทันที (optimistic) แล้วค่อยส่งขึ้นคลาวด์ผ่าน persist() */
  function addTask(fields) {
    const task = normalizeTask({ ...fields, id: uid(), done: false, createdAt: new Date().toISOString() });
    if (!task) return null;
    state.tasks.unshift(task);
    state.flashId = task.id;
    render();
    persist(() => api.create(task));
    return task;
  }
  function updateTask(id, patch) {
    const index = state.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    const updated = normalizeTask({ ...state.tasks[index], ...patch });
    if (!updated) return;
    state.tasks[index] = updated;
    render();
    persist(() => api.update(id, {
      title: updated.title,
      note: updated.note,
      priority: updated.priority,
      due: updated.due,
    }));
  }
  function toggleTask(id, done) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.done = done;
    task.completedAt = done ? new Date().toISOString() : null;
    render();
    persist(() => api.update(id, { done, completedAt: task.completedAt }));
  }
  function deleteTask(id) {
    const index = state.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    const [task] = state.tasks.splice(index, 1);
    render();
    persist(() => api.remove(id));
    showToast(`ลบ "${truncate(task.title, 28)}" แล้ว`, () => {
      state.tasks.splice(Math.min(index, state.tasks.length), 0, task);
      render();
      persist(() => api.create(task)); // สร้างกลับด้วย id เดิม
    });
  }
  function clearDoneTasks() {
    const removed = state.tasks.filter((t) => t.done);
    if (removed.length === 0) return;
    const snapshot = state.tasks.slice();
    state.tasks = state.tasks.filter((t) => !t.done);
    render();
    persist(() => api.removeDone());
    showToast(`ล้างงานที่เสร็จแล้ว ${removed.length} รายการ`, () => {
      state.tasks = snapshot;
      render();
      persist(() => api.create(removed));
    });
  }

  /* ---------- Toast ---------- */
  function showToast(message, onUndo = null) {
    hideToast();
    els.toastText.textContent = message;
    els.toastUndo.hidden = !onUndo;
    els.toast.hidden = false;
    state.toast = { onUndo, timer: setTimeout(hideToast, TOAST_MS) };
  }
  function hideToast() {
    if (state.toast) clearTimeout(state.toast.timer);
    state.toast = null;
    els.toast.hidden = true;
  }

  /* ---------- Dialog ---------- */
  function openDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    document.documentElement.classList.add('has-modal');
  }
  function closeDialog(dialog) {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }
  function setupDialog(dialog) {
    dialog.addEventListener('close', () => {
      if (!$$('dialog[open]').length) document.documentElement.classList.remove('has-modal');
    });
    // คลิกที่พื้นหลัง (นอกกล่อง) เพื่อปิด
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeDialog(dialog);
    });
  }

  /* ---------- ฟอร์มเพิ่มงาน ---------- */
  function setFieldInvalid(input, errorEl, invalid) {
    input.closest('.field').classList.toggle('is-invalid', invalid);
    errorEl.hidden = !invalid;
    input.setAttribute('aria-invalid', String(invalid));
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = els.title.value.trim();
    if (!title) {
      setFieldInvalid(els.title, els.titleError, true);
      els.title.focus();
      return;
    }
    setFieldInvalid(els.title, els.titleError, false);

    addTask({
      title,
      note: els.note.value,
      priority: getPickerValue(els.priorityPicker),
      due: els.due.value,
    });

    els.form.reset();
    setPickerValue(els.priorityPicker, DEFAULT_PRIORITY);

    if (els.addSheet.open) {
      closeDialog(els.addSheet);
      showToast(`เพิ่ม "${truncate(title, 28)}" แล้ว`);
    } else {
      els.title.focus();
    }
  });
  els.title.addEventListener('input', () => {
    if (els.title.value.trim()) setFieldInvalid(els.title, els.titleError, false);
  });
  els.priorityPicker.addEventListener('change', () => syncPicker(els.priorityPicker));

  /* ---------- รายการงาน (event delegation) ---------- */
  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = btn.closest('.task');
    if (!item) return;
    if (btn.dataset.action === 'edit') openEdit(item.dataset.id);
    else if (btn.dataset.action === 'delete') deleteTask(item.dataset.id);
  });
  els.list.addEventListener('change', (e) => {
    if (!e.target.matches('.check-input')) return;
    const item = e.target.closest('.task');
    if (item) toggleTask(item.dataset.id, e.target.checked);
  });

  /* ---------- ตัวกรอง / ค้นหา / เรียง ---------- */
  els.search.addEventListener('input', () => {
    state.query = els.search.value.trim();
    renderList();
  });
  els.statusFilter.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    $$('.chip', els.statusFilter).forEach((c) => {
      const active = c === chip;
      c.classList.toggle('is-active', active);
      c.setAttribute('aria-pressed', String(active));
    });
    renderList();
  });
  els.priorityFilter.addEventListener('change', () => {
    state.priority = els.priorityFilter.value;
    renderList();
  });
  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    savePrefs();
    renderList();
  });
  els.clearDone.addEventListener('click', clearDoneTasks);

  /* ---------- แก้ไขงาน ---------- */
  function openEdit(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    state.editingId = id;
    els.editTitle.value = task.title;
    els.editNote.value = task.note;
    els.editDue.value = task.due;
    setPickerValue(els.editPriorityPicker, task.priority);
    setFieldInvalid(els.editTitle, els.editTitleError, false);
    openDialog(els.editDialog);
    requestAnimationFrame(() => els.editTitle.focus());
  }
  els.editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = els.editTitle.value.trim();
    if (!title) {
      setFieldInvalid(els.editTitle, els.editTitleError, true);
      els.editTitle.focus();
      return;
    }
    updateTask(state.editingId, {
      title,
      note: els.editNote.value,
      priority: getPickerValue(els.editPriorityPicker),
      due: els.editDue.value,
    });
    state.editingId = null;
    closeDialog(els.editDialog);
  });
  els.editTitle.addEventListener('input', () => {
    if (els.editTitle.value.trim()) setFieldInvalid(els.editTitle, els.editTitleError, false);
  });
  els.editPriorityPicker.addEventListener('change', () => syncPicker(els.editPriorityPicker));
  els.editClose.addEventListener('click', () => closeDialog(els.editDialog));
  els.editCancel.addEventListener('click', () => closeDialog(els.editDialog));

  /* ---------- Toast: เลิกทำ ---------- */
  els.toastUndo.addEventListener('click', () => {
    const current = state.toast;
    hideToast();
    if (current && current.onUndo) current.onUndo();
  });

  /* ---------- Responsive: ย้ายฟอร์มเข้า/ออก bottom sheet ---------- */
  const compactMq = window.matchMedia('(max-width: 959px)');
  function placeAddSection(compact) {
    if (compact) {
      if (els.addSection.parentElement !== els.addSheet) els.addSheet.appendChild(els.addSection);
    } else {
      if (els.addSheet.open) closeDialog(els.addSheet);
      if (els.addSection.parentElement !== els.sidebar) els.sidebar.prepend(els.addSection);
    }
  }
  if (typeof compactMq.addEventListener === 'function') {
    compactMq.addEventListener('change', (e) => placeAddSection(e.matches));
  } else if (typeof compactMq.addListener === 'function') {
    compactMq.addListener((e) => placeAddSection(e.matches));
  }
  els.fab.addEventListener('click', () => {
    openDialog(els.addSheet);
    requestAnimationFrame(() => els.title.focus({ preventScroll: true }));
  });
  els.sheetClose.addEventListener('click', () => closeDialog(els.addSheet));

  /* ---------- ใช้งานบนอุปกรณ์อื่น (แชร์ลิงก์บอร์ด) ---------- */
  function openShareDialog() {
    els.shareUrl.value = shareUrl();
    els.shareBoard.textContent = state.boardId;
    els.shareOffline.hidden = state.mode === 'remote';
    openDialog(els.shareDialog);
  }
  async function copyShareUrl() {
    const text = els.shareUrl.value;
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch { /* ใช้วิธีสำรองด้านล่าง */ }
    if (!copied) {
      els.shareUrl.focus();
      els.shareUrl.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
    }
    showToast(copied ? 'คัดลอกลิงก์แล้ว นำไปเปิดบนอุปกรณ์อื่นได้เลย' : 'คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกลิงก์ด้วยตนเอง');
  }
  els.shareBtn.addEventListener('click', openShareDialog);
  els.shareClose.addEventListener('click', () => closeDialog(els.shareDialog));
  els.shareCopy.addEventListener('click', copyShareUrl);
  els.shareUrl.addEventListener('focus', () => els.shareUrl.select());

  /* ---------- ซิงก์ข้ามแท็บ + รีเฟรชตอนเที่ยงคืน ---------- */
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    state.tasks = loadCache() || [];
    render();
  });
  // กลับมาที่แท็บนี้อีกครั้ง → ดึงข้อมูลล่าสุดจากคลาวด์ (เผื่อแก้จากอุปกรณ์อื่น)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.mode === 'remote' && state.pending === 0) {
      refreshFromServer();
    }
  });
  function updateTodayLabel() {
    els.todayLabel.textContent = longDateFmt.format(new Date());
  }
  function scheduleMidnightRefresh() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    setTimeout(() => {
      updateTodayLabel();
      render();
      scheduleMidnightRefresh();
    }, next - now + 1000);
  }

  /* ---------- เริ่มต้น ---------- */
  async function init() {
    loadPrefs();
    els.sort.value = state.sort;

    renderPriorityPicker(els.priorityPicker, 'priority', DEFAULT_PRIORITY);
    renderPriorityPicker(els.editPriorityPicker, 'edit-priority', DEFAULT_PRIORITY);
    setupDialog(els.addSheet);
    setupDialog(els.editDialog);
    setupDialog(els.shareDialog);
    placeAddSection(compactMq.matches);
    updateTodayLabel();
    scheduleMidnightRefresh();

    // 1) รหัสบอร์ด + แคชในเครื่อง → แสดงผลทันที
    const board = resolveBoardId();
    state.boardId = board.id;
    const cached = board.changed ? null : loadCache(); // เปลี่ยนบอร์ดจากลิงก์ → ไม่ใช้แคชของบอร์ดเก่า
    state.tasks = cached || [];
    state.loading = true;
    setSyncStatus('syncing');
    render();

    // 2) โหลดจากคลาวด์
    try {
      const { tasks } = await api.list();
      let remote = tasks.map(normalizeTask).filter(Boolean);

      // ครั้งแรกที่เครื่องนี้ใช้งานคลาวด์: ถ้าบอร์ดยังว่างแต่มีงานในเครื่องอยู่แล้ว ให้ย้ายขึ้นคลาวด์
      if (board.source === 'new' && remote.length === 0 && cached && cached.length > 0) {
        const created = await api.create(cached);
        remote = created.tasks.map(normalizeTask).filter(Boolean);
        showToast(`ย้ายงาน ${remote.length} รายการจากเครื่องขึ้นคลาวด์แล้ว`);
      }

      state.mode = 'remote';
      state.tasks = remote;
      cacheTasks();
    } catch (err) {
      // ใช้ไม่ได้ (เช่น ยังไม่ได้ตั้งค่า DATABASE_URL หรือออฟไลน์) → โหมดบันทึกในเครื่อง
      console.warn('ใช้โหมดบันทึกในเครื่อง:', err.message);
      state.mode = 'local';
      if (cached === null) {
        state.tasks = sampleTasks();
        cacheTasks();
      }
      showToast(err.status === 503
        ? 'ยังไม่ได้ตั้งค่าฐานข้อมูล · ข้อมูลจะบันทึกในเครื่องนี้'
        : 'เชื่อมต่อคลาวด์ไม่ได้ · ข้อมูลจะบันทึกในเครื่องนี้');
    } finally {
      state.loading = false;
      settleSyncStatus();
      render();
    }
  }

  init();
})();
