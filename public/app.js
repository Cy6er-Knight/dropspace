/* Dropspace web app. Plain JavaScript, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /** Tiny element builder. Text is always set as text, never as HTML. */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const button = (label, onClick, cls = 'btn btn--secondary btn--small') => h('button', { class: cls, type: 'button', onclick: onClick }, label);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('dropspace.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('dropspace.' + key, JSON.stringify(value));
      } catch {
        /* private mode: fine, just not remembered */
      }
    },
  };

  function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function guessDeviceName() {
    const ua = navigator.userAgent;
    const device = /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
        : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
          : /CrOS/.test(ua) ? 'Chromebook'
            : /Mac/.test(ua) ? 'Mac'
              : /Win/.test(ua) ? 'Windows PC'
                : /Linux/.test(ua) ? 'Linux PC' : 'Computer';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? `${device} (${browser})` : device;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function timeAgo(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function listNames(names) {
    if (names.length <= 1) return names[0] || '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  /* ------------------------------------------------------------------ state */

  const state = {
    deviceId: store.get('deviceId', ''),
    local: false,
    hostName: '',
    host: null, // full host info, only on the host computer
    items: new Map(),
    cards: new Map(),
    pending: new Map(),
    devices: [],
    seenDevices: new Set(),
    es: null,
    started: false,
    unread: 0, // shown in the tab title while the page is in the background
    spaces: [],
    current: store.get('space', ''),
    spaceUnread: new Map(), // folder id -> new items from other devices
    dropSpace: null, // folder under the pointer while dragging over the sidebar
    query: '', // search text
    dialogSpace: null, // the folder whose options are open
    sidebarCollapsed: store.get('sidebarCollapsed', false),
    hostAddress: null, // the host's permanent address, e.g. http://dropspace.local
    autoSave: store.get('autoSave', false),
    draggingOut: false,
    hostSecure: null, // { port, only } when the host offers a secure (https) address
    version: '',
    author: '',
    selecting: false, // choosing several items to download or delete together
    selected: new Set(),
    lastPicked: null, // for Shift-click ranges
  };
  if (!state.deviceId) {
    state.deviceId = randomId();
    store.set('deviceId', state.deviceId);
  }
  const myName = () => store.get('name', '') || (state.local ? state.hostName : guessDeviceName());
  // On the main Mac, things sent from Finder or the clipboard shortcut count as yours too.
  const isMine = (item) => !!item.from && (item.from.id === state.deviceId || (state.local && item.from.host));
  const IS_MAC_DESKTOP = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
  const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const others = () => state.devices.filter((d) => d.id !== state.deviceId);
  const fileUrl = (id, name) => `/api/file/${id}/${enc(name)}`;
  const spaceById = (id) => state.spaces.find((sp) => sp.id === id);
  const currentSpace = () => spaceById(state.current) || state.spaces[0] || { id: '', name: 'General' };

  /** Static icon markup only; never used with user text. */
  function icon(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  }
  const MORE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="6.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="17.5" cy="12" r="1.5"/></g></svg>';
  const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M3.5 7.25c0-1.1.9-2 2-2h3.6c.5 0 .98.19 1.35.52l1.3 1.23h6.75c1.1 0 2 .9 2 2v8.75c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2z"/><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3.5 10h17"/></svg>';

  async function api(method, url, body) {
    const headers = { 'X-Dropspace': '1', 'X-Device-Id': state.deviceId, 'X-Device-Name': enc(myName()) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------------ screens */

  const screens = ['loading', 'offline', 'secure', 'pair', 'app'];
  function show(name) {
    for (const s of screens) $(s).hidden = s !== name;
  }

  function toast(message, isError = false, action = null) {
    const t = h('div', { class: 'toast' + (isError ? ' toast--error' : '') }, h('span', null, message));
    if (action) {
      t.append(h('button', {
        class: 'toast__action',
        type: 'button',
        onclick: () => {
          t.remove();
          action.onClick();
        },
      }, action.label));
    }
    $('toasts').append(t);
    setTimeout(() => t.remove(), isError ? 6000 : action ? 5000 : 2800);
  }

  /** Resolves true if this device can load something from `origin` (for https: only if it trusts the certificate). */
  function canReach(origin, timeout = 2500) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => done(false), timeout);
      function done(ok) {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(ok);
      }
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = `${origin}/icon-192.png?check=${Date.now()}`;
    });
  }

  const secureOriginFor = (port) => `https://${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}${port === 443 ? '' : `:${port}`}`;

  /** The settings a device brings along when it moves to another address. */
  function carryParams(token) {
    const carry = new URLSearchParams({ pair: token, space: state.current || store.get('space', '') });
    if (store.get('name', '')) carry.set('name', store.get('name', ''));
    if (store.get('autoSave', false)) carry.set('auto', '1');
    return carry;
  }

  /**
   * On the plain address, a device that trusts Dropspace's certificate (another Mac after Install
   * Dropspace, or a phone with the profile) moves to the secure address and stays paired.
   */
  async function upgradeToSecure(who) {
    if (location.protocol !== 'http:' || who.local || !who.httpsPort) return false;
    const target = secureOriginFor(who.httpsPort);
    if (!(await canReach(target))) {
      if (!who.secureOnly) return false;
      showSecure(who);
      return true;
    }
    let hash = location.hash;
    if (who.paired && !who.secureOnly && !new URLSearchParams(hash.slice(1)).get('pair')) {
      try {
        const { token } = await api('POST', '/api/move-token');
        hash = `#${carryParams(token)}`;
      } catch {
        /* the pairing usually comes along anyway */
      }
    }
    location.replace(`${target}/${hash}`);
    return true;
  }

  /** "Secure connections only" is on and this device doesn't trust the certificate yet. */
  function showSecure(who) {
    show('secure');
    $('secureHost').textContent = who.hostName || 'The host computer';
    $('secureSteps').replaceChildren(h('div', { class: 'group' }, secureSetupSteps(`Come back here and ${IS_IOS ? 'tap' : 'click'} Try Again.`)));
  }
  $('secureRetryButton').addEventListener('click', () => {
    show('loading');
    boot();
  });

  async function boot() {
    let who;
    try {
      who = await api('GET', '/api/whoami');
    } catch {
      show('offline');
      return;
    }
    if (await upgradeToSecure(who)) return;

    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('pair');
    if (token) {
      history.replaceState(null, '', location.pathname);
      // Moving from an old address: bring this device's settings along.
      if (hash.get('name') && !store.get('name', '')) store.set('name', hash.get('name'));
      if (hash.get('space') && !store.get('space', '')) {
        store.set('space', hash.get('space'));
        state.current = hash.get('space');
      }
      if (hash.get('auto') === '1') {
        store.set('autoSave', true);
        state.autoSave = true;
      }
    }

    state.local = who.local;
    state.hostName = who.hostName;

    if (!who.paired && token) {
      try {
        await api('POST', '/api/pair', { token });
        who.paired = true;
      } catch (e) {
        showPair(e.message);
        return;
      }
    }
    if (!who.paired) return showPair();
    startMain();
  }

  /* ------------------------------------------------------------------ pairing */

  function showPair(message = '') {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    show('pair');
    $('pairHost').textContent = state.hostName || 'the host computer';
    $('pairError').textContent = message;
    $('pinInput').value = '';
    renderCode();
    $('pinInput').focus();
  }

  /** The real input is invisible; these six boxes show what's typed. */
  function renderCode() {
    const input = $('pinInput');
    const digits = input.value;
    const box = $('codeBoxes');
    const cells = box.querySelectorAll('.code__cell');
    cells.forEach((cell, i) => {
      cell.textContent = digits[i] || '';
      cell.classList.toggle('code__cell--active', i === Math.min(digits.length, cells.length - 1));
    });
    box.classList.toggle('code--focused', document.activeElement === input);
  }

  $('pinInput').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    e.target.value = digits;
    $('pairError').textContent = '';
    $('codeBoxes').classList.remove('code--error');
    renderCode();
    if (digits.length === 6) $('pairForm').requestSubmit();
  });
  $('pinInput').addEventListener('focus', renderCode);
  $('pinInput').addEventListener('blur', renderCode);

  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pinInput').value.replace(/\D/g, '');
    if (pin.length !== 6) {
      $('pairError').textContent = 'The code has 6 digits.';
      return;
    }
    $('pairButton').disabled = true;
    try {
      await api('POST', '/api/pair', { pin });
      startMain();
    } catch (err) {
      $('pairError').textContent = err.message;
      $('codeBoxes').classList.add('code--error');
      const form = $('pairForm');
      form.classList.remove('pair--shake');
      void form.offsetWidth;
      form.classList.add('pair--shake');
      $('pinInput').value = '';
      renderCode();
      $('pinInput').focus();
    } finally {
      $('pairButton').disabled = false;
    }
  });

  $('retryButton').addEventListener('click', () => {
    show('loading');
    boot();
  });

  /* ------------------------------------------------------------------ live connection */

  function startMain() {
    show('app');
    state.started = true;
    connect();
  }

  let reconnectTimer = null;
  let statusTimer = null;

  function setConnected(ok) {
    clearTimeout(statusTimer);
    if (ok) $('status').hidden = true;
    else statusTimer = setTimeout(() => ($('status').hidden = false), 1500);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (state.es) state.es.close();
    const qs = new URLSearchParams({ device: state.deviceId, name: myName() });
    const es = new EventSource('/api/events?' + qs);
    state.es = es;
    const on = (event, fn) => es.addEventListener(event, (e) => fn(JSON.parse(e.data)));

    on('hello', onHello);
    on('item', (item) => {
      const fresh = !state.items.has(item.id);
      upsertItem(item, { animate: !isMine(item) });
      if (fresh && !isMine(item)) {
        maybeAutoSave(item);
        const sp = spaceById(item.space);
        if (sp && item.space !== state.current) {
          state.spaceUnread.set(sp.id, (state.spaceUnread.get(sp.id) || 0) + 1);
          renderSpaces();
          const what = item.type === 'text' ? 'a note' : item.type === 'folder' ? `the ${item.name} folder` : item.name;
          toast(`${(item.from && item.from.name) || 'Another device'} added ${what} to ${sp.name}`, false,
            { label: 'View', onClick: () => switchSpace(sp.id) });
        }
        if (document.hidden) {
          state.unread++;
          document.title = `(${state.unread}) Dropspace`;
        }
      }
    });
    on('remove', ({ id, ids }) => {
      for (const one of ids || [id]) removeCard(one, { quiet: true });
      renderSpaces();
      updateBoardChrome();
      updateSelectionUi();
    });
    on('clear', ({ space }) => {
      for (const [id, item] of [...state.items]) if (!space || item.space === space) removeCard(id);
    });
    on('spaces', ({ spaces }) => setSpaces(spaces));
    on('presence', ({ devices }) => setDevices(devices));
    on('host', (info) => {
      state.host = state.local ? info : null;
      state.hostName = info.name;
      state.hostAddress = info.address || null;
      state.hostSecure = info.secure || null;
      applyRole();
      refreshConnectPanels();
      updateAddressNotice();
      if ($('settingsDialog').open) {
        fillShareSection();
        fillSecureSection();
      }
    });
    on('paired', () => {
      qr.token = null; // the QR code may have just been used; make a fresh one
      refreshConnectPanels();
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      if (es.readyState === EventSource.CLOSED) recover();
    };
  }

  /** The stream closed for good: either Dropspace stopped or this device was unpaired. */
  async function recover() {
    try {
      const who = await api('GET', '/api/whoami');
      if (who.secureOnly && !who.local && location.protocol === 'http:') {
        show('loading');
        return boot();
      }
      if (!who.paired) return showPair('This device was disconnected. Enter the new code to connect again.');
    } catch {
      /* host unreachable: keep trying */
    }
    reconnectTimer = setTimeout(connect, 2500);
  }

  function onHello(data) {
    state.local = data.you.local;
    state.hostName = data.host.name;
    state.host = state.local ? data.host : null;
    state.hostAddress = data.host.address || null;
    state.hostSecure = data.host.secure || null;
    state.version = data.version || '';
    state.author = data.author || '';

    state.items.clear();
    for (const id of [...state.selected]) if (!data.items.some((it) => it.id === id)) state.selected.delete(id);
    for (const item of data.items) state.items.set(item.id, item);

    applyRole();
    renderMe();
    setSpaces(data.spaces, true);
    reportFocus();
    setDevices(data.devices, true);
    setConnected(true);
    updateAddressNotice();
  }

  /* ------------------------------------------------------------------ folders */

  function setSpaces(spaces, initial = false) {
    const before = currentSpace();
    state.spaces = spaces;
    for (const id of [...state.spaceUnread.keys()]) if (!spaceById(id)) state.spaceUnread.delete(id);
    let moved = false;
    if (!spaceById(state.current)) {
      moved = !initial && !!before.id;
      state.current = spaces[0].id;
      store.set('space', state.current);
    }
    renderSpaces();
    renderFolderHeader();
    if (initial || moved) renderFeed();
    else updateBoardChrome();
    if (moved) toast(`${before.name} was deleted. You're now in ${currentSpace().name}.`);
    if ($('folderDialog').open) {
      if (!spaceById(state.dialogSpace)) $('folderDialog').close();
      else fillFolderDialog();
    }
  }

  /** Folders are listed like chats: the one used most recently comes first. */
  function renderSpaces() {
    const counts = new Map();
    const latest = new Map();
    for (const it of state.items.values()) {
      counts.set(it.space, (counts.get(it.space) || 0) + 1);
      latest.set(it.space, Math.max(latest.get(it.space) || 0, it.at || 0));
    }
    const activity = (sp) => Math.max(latest.get(sp.id) || 0, sp.created || 0);
    const ordered = [...state.spaces].sort((a, b) => activity(b) - activity(a));
    $('folders').replaceChildren(...ordered.map((sp) => {
      const active = sp.id === state.current;
      const fresh = state.spaceUnread.get(sp.id) || 0;
      const count = counts.get(sp.id) || 0;
      return h('li', {
        class: 'folder-row' + (active ? ' folder-row--active' : '') + (state.dropSpace === sp.id ? ' folder-row--drop' : ''),
        'data-space': sp.id,
      },
      h('button', {
        class: 'folder-item',
        type: 'button',
        'aria-current': active ? 'page' : null,
        onclick: () => {
          switchSpace(sp.id);
          closeDrawer();
        },
      },
      h('span', { class: 'folder-item__name' }, sp.name),
      fresh
        ? h('span', { class: 'folder-item__badge', 'aria-label': `${fresh} new` }, fresh > 99 ? '99+' : fresh)
        : h('span', { class: 'folder-item__count', 'aria-label': `${count} items` }, count || '')),
      h('button', {
        class: 'folder-row__more',
        type: 'button',
        'aria-label': `Options for ${sp.name}`,
        title: 'Rename, change where it saves, or delete',
        onclick: () => openFolderDialog(sp.id),
      }, icon(MORE_ICON)));
    }));
    updateUnreadDots();
  }

  function updateUnreadDots() {
    const any = [...state.spaceUnread.values()].some((n) => n > 0);
    $('railDot').hidden = !any;
    $('drawerDot').hidden = !any;
  }

  /* ------------------------------------------------------------------ side panel: show, hide, drawer on phones */

  const narrowQuery = window.matchMedia('(max-width: 860px)');
  const isNarrow = () => narrowQuery.matches;

  function applySidebar() {
    const app = $('app');
    app.classList.toggle('app--collapsed', !isNarrow() && state.sidebarCollapsed);
    if (!isNarrow()) app.classList.remove('app--drawer');
    $('scrim').hidden = !app.classList.contains('app--drawer');
    const label = isNarrow() ? 'Close folders' : 'Hide sidebar';
    $('sidebarToggle').setAttribute('aria-label', label);
    $('sidebarToggle').title = isNarrow() ? 'Close' : 'Hide sidebar (⌘\\)';
    $('drawerButton').setAttribute('aria-expanded', String(app.classList.contains('app--drawer')));
  }

  function openDrawer() {
    $('app').classList.add('app--drawer');
    applySidebar();
    const active = document.querySelector('.folder-row--active .folder-item') || document.querySelector('.folder-item');
    if (active) active.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (!$('app').classList.contains('app--drawer')) return;
    $('app').classList.remove('app--drawer');
    applySidebar();
  }

  function toggleSidebar() {
    if (isNarrow()) {
      if ($('app').classList.contains('app--drawer')) closeDrawer();
      else openDrawer();
      return;
    }
    state.sidebarCollapsed = !state.sidebarCollapsed;
    store.set('sidebarCollapsed', state.sidebarCollapsed);
    $('app').classList.toggle('app--open-sidebar', !state.sidebarCollapsed);
    applySidebar();
    (state.sidebarCollapsed ? $('railOpen') : $('sidebarToggle')).focus({ preventScroll: true });
  }

  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('railOpen').addEventListener('click', toggleSidebar);
  $('drawerButton').addEventListener('click', openDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  narrowQuery.addEventListener('change', applySidebar);
  document.addEventListener('keydown', (e) => {
    if ($('app').hidden || document.querySelector('dialog[open]')) return;
    if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === 'Escape' && $('app').classList.contains('app--drawer')) {
      closeDrawer();
      $('drawerButton').focus();
    }
  });
  applySidebar();

  /** The bottom of the side panel shows this device, like an account. */
  function renderMe() {
    const name = myName();
    const initials = name.replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('') || '•';
    $('meName').textContent = name;
    $('meAvatar').textContent = initials;
    $('railSettings').textContent = initials;
  }

  function renderFolderHeader() {
    $('folderTitle').textContent = searching() ? 'Search' : currentSpace().name;
  }

  /* search: every word must appear in the name, text, file names inside a folder, or sender */
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const searchTerms = () => fold(state.query).split(/\s+/).filter(Boolean);
  const searching = () => searchTerms().length > 0;
  function matchesSearch(item, terms) {
    const inside = item.type === 'folder' ? item.files.map((f) => f.rel).join(' ') : '';
    const hay = fold(`${item.name || ''} ${item.text || ''} ${inside} ${(item.from && item.from.name) || ''}`);
    return terms.every((t) => hay.includes(t));
  }

  /** What the feed shows right now, newest first: the open folder, or search results from every folder. */
  function visibleItems() {
    const terms = searchTerms();
    const all = [...state.items.values()].reverse();
    return terms.length ? all.filter((it) => matchesSearch(it, terms)) : all.filter((it) => it.space === state.current);
  }

  function renderFeed() {
    const isSearch = searching();
    document.body.classList.toggle('is-searching', isSearch);
    const feed = $('feed');
    feed.replaceChildren();
    state.cards.clear();
    const frag = document.createDocumentFragment();
    if (!isSearch) for (const p of [...state.pending.values()].reverse()) if (p.space === state.current) frag.append(p.el);
    const items = visibleItems();
    for (const item of items) {
      const card = renderItem(item);
      state.cards.set(item.id, card);
      frag.append(card);
    }
    feed.append(frag);
    $('feedTitle').textContent = isSearch ? `${items.length} ${items.length === 1 ? 'result' : 'results'}` : 'Recent';
    $('feedEmpty').hidden = !(isSearch && !items.length);
    if (isSearch && !items.length) $('feedEmpty').textContent = `Nothing matches “${state.query.trim()}” in any folder.`;
    renderFolderHeader();
    updateBoardChrome();
    updateSelectionUi();
  }

  function clearSearch() {
    if (!state.query) return;
    state.query = '';
    $('searchInput').value = '';
    renderFeed();
  }

  function switchSpace(id) {
    if (!spaceById(id)) return;
    const wasSearching = searching();
    if (wasSearching) {
      state.query = '';
      $('searchInput').value = '';
    }
    const changed = id !== state.current || wasSearching;
    if (changed) exitSelect();
    state.current = id;
    store.set('space', id);
    reportFocus();
    state.spaceUnread.delete(id);
    renderSpaces();
    renderFolderHeader();
    if (changed) {
      renderFeed();
      window.scrollTo({ top: 0 });
    }
  }

  /** Native-style confirmation. Resolves true when the person confirms. */
  function askConfirm({ title, text, confirm, danger = true }) {
    const d = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = confirm;
    $('confirmOk').classList.toggle('alert__btn--danger', danger);
    d.returnValue = '';
    d.showModal();
    $('confirmOk').focus();
    return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
  }

  const dialogSpace = () => spaceById(state.dialogSpace) || currentSpace();

  function openFolderDialog(id) {
    state.dialogSpace = id;
    fillFolderDialog();
    $('folderDialog').showModal();
  }

  function fillFolderDialog() {
    const sp = dialogSpace();
    $('folderDialogTitle').textContent = sp.name;
    if (document.activeElement !== $('folderNameInput')) $('folderNameInput').value = sp.name;
    $('folderForm').hidden = !state.local;
    if (state.local && document.activeElement !== $('folderInput')) $('folderInput').value = sp.folderDisplay || '';
    $('openFolderButton').textContent = revealLabel();
    const only = state.spaces.length <= 1;
    $('deleteFolderButton').disabled = only;
    $('deleteFolderNote').textContent = only
      ? 'This is your only folder. Make another one before deleting this one.'
      : `Removes this folder and everything in it from Dropspace on every device. Files already saved stay on ${state.local ? 'this computer' : state.hostName}.`;
  }

  function setDevices(devices, initial = false) {
    state.devices = devices;
    for (const d of devices) {
      if (!state.seenDevices.has(d.id)) {
        state.seenDevices.add(d.id);
        if (!initial && d.id !== state.deviceId) toast(`${d.name} connected`);
      }
    }
    const list = $('devices');
    list.replaceChildren(
      ...devices.map((d) =>
        h('li', { class: 'device', title: d.local ? 'Running Dropspace' : '' },
          h('span', { class: 'device__dot', 'aria-hidden': 'true' }),
          h('span', { class: 'device__name' }, d.name),
          d.id === state.deviceId ? h('span', { class: 'device__you' }, 'you') : null)),
    );
    updateBoardChrome();
  }

  /* ------------------------------------------------------------------ board chrome */

  // Phones and tablets can't drag between apps the same way, so word the slot for tapping.
  const TOUCH_ONLY = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (TOUCH_ONLY) {
    $('slotTitle').textContent = 'Send anything';
    $('pickButton').textContent = 'Choose Photos or Files';
  }

  /** Tell Dropspace which folder this device has open, so Finder's Send to Dropspace and the clipboard shortcut use it. */
  function reportFocus() {
    if (state.current) api('POST', '/api/focus', { space: state.current }).catch(() => {});
  }

  // The main Mac reads its own clipboard. Any other device can when its connection is secure,
  // because browsers only allow reading the clipboard on secure pages.
  const clipboardWorks = () => !!((state.local && state.host && state.host.platform === 'darwin')
    || (window.isSecureContext && navigator.clipboard && (navigator.clipboard.read || navigator.clipboard.readText)));

  function applyRole() {
    $('clipboardButton').hidden = !clipboardWorks();
    $('connectButton').hidden = !state.local;
    $('forgetField').hidden = !state.local;
    $('autoSaveField').hidden = state.local;
    $('appField').hidden = state.local;
    $('pasteHint').textContent = IS_APPLE ? 'or paste with ⌘V' : 'or paste with Ctrl+V';
  }

  function updateBoardChrome() {
    const names = others().map((d) => d.name);
    const waiting = state.local && names.length === 0;
    const hasItems = state.cards.size > 0 || (!searching() && [...state.pending.values()].some((p) => p.space === state.current));
    const folder = currentSpace().name;

    let hint;
    if (names.length) hint = `Files, photos, folders or text go into ${folder} and appear on ${listNames(names)} instantly.`;
    else if (state.local) hint = 'Files, photos, folders or text. Connect another device to start sending.';
    else hint = `Files, photos, folders or text go into ${folder} on ${state.hostName} instantly.`;
    $('slotHint').textContent = hint;

    $('slot').classList.toggle('dropzone--waiting', waiting);
    $('slot').classList.toggle('dropzone--compact', hasItems && !waiting);
    $('connectButton').hidden = !state.local || waiting;
    $('feedHead').hidden = !hasItems;
    if (!state.cards.size && state.selecting) exitSelect();

    const inline = $('connectInline');
    if (waiting && state.host) {
      if (inline.hidden || !inline.firstChild) {
        inline.replaceChildren(connectPanel());
        inline.hidden = false;
      }
    } else if (!inline.hidden) {
      inline.hidden = true;
      inline.replaceChildren();
    }

    updateOverlay();
  }

  function updateOverlay() {
    const names = others().map((d) => d.name);
    const target = spaceById(state.dropSpace) || currentSpace();
    $('dropOverlayText').textContent = `Drop into ${target.name}`;
    $('dropOverlaySub').textContent = names.length ? `It appears on ${listNames(names)} instantly.` : '';
  }

  /* ------------------------------------------------------------------ connect panel + QR */

  const qr = { token: null, at: 0 };

  async function qrToken() {
    if (!qr.token || Date.now() - qr.at > 5 * 60 * 1000) {
      const r = await api('POST', '/api/pair-token');
      qr.token = r.token;
      qr.at = Date.now();
    }
    return qr.token;
  }

  async function drawQr(canvas, baseUrl) {
    const wrap = canvas.closest('.connect__qr');
    if (typeof window.qrcode !== 'function') return wrap && wrap.remove();
    try {
      const code = window.qrcode(0, 'M');
      code.addData(`${baseUrl}/#pair=${await qrToken()}`);
      code.make();
      const n = code.getModuleCount();
      const quietZone = 3;
      const scale = 4;
      const size = (n + quietZone * 2) * scale;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#13201a';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (code.isDark(r, c)) ctx.fillRect((c + quietZone) * scale, (r + quietZone) * scale, scale, scale);
        }
      }
    } catch {
      if (wrap) wrap.remove();
    }
  }

  function codeDisplay(pin) {
    const cells = pin.split('').map((d) => h('span', { class: 'code__cell' }, d));
    return h('div', { class: 'code code--display', role: 'img', 'aria-label': `Code ${pin.split('').join(' ')}` },
      cells.slice(0, 3), h('span', { class: 'code__gap', 'aria-hidden': 'true' }), cells.slice(3));
  }

  function connectPanel() {
    const info = state.host;
    const root = h('div', { class: 'connect' });
    if (!info) return root;
    const a = info.addresses;
    if (!a.primary) {
      root.append(h('p', { class: 'connect__label' }, "This computer isn't on a network. Connect it to Wi-Fi, then restart Dropspace."));
      return root;
    }
    const step = (n, label, ...content) => h('li', { class: 'connect__step' },
      h('span', { class: 'connect__num', 'aria-hidden': 'true' }, n),
      h('div', { class: 'connect__body' }, h('p', { class: 'connect__label' }, label), content));
    root.append(h('ol', { class: 'connect__steps' },
      step('1', a.primary === a.stable
        ? 'On your other device, open this address in a browser. It never changes, so you can bookmark it.'
        : 'On your other device, open this address in a browser.',
      h('div', { class: 'connect__row' },
        h('span', { class: 'connect__url' }, a.primary),
        button('Copy', () => copyText(a.primary).then(() => toast('Address copied'), (e) => toast(e.message, true))))),
      step('2', 'Then enter this code.', codeDisplay(info.pin))));
    const alternatives = a.others || [];
    if (alternatives.length) {
      root.append(h('details', { class: 'connect__more' },
        h('summary', null, 'Address not working?'),
        h('ul', null, alternatives.map((u) => h('li', null, u)))));
    }
    const canvas = h('canvas', { width: '1', height: '1', role: 'img', 'aria-label': 'QR code for connecting a phone' });
    root.append(h('div', { class: 'connect__qr' }, canvas,
      h('p', null, 'Connecting a phone? Point its camera here. No code needed.')));
    root.append(h('p', { class: 'connect__note' }, 'Both devices need to be on the same Wi-Fi network.'));
    drawQr(canvas, a.qr || a.primary);
    return root;
  }

  function refreshConnectPanels() {
    const inline = $('connectInline');
    if (!inline.hidden) inline.replaceChildren(connectPanel());
    if ($('connectDialog').open) $('connectDialogBody').replaceChildren(connectPanel());
    if ($('settingsDialog').open && state.host) $('folderInput').value = state.host.folderDisplay;
  }
  setInterval(() => {
    if (!$('connectInline').hidden || $('connectDialog').open) refreshConnectPanels();
  }, 4 * 60 * 1000);

  /* ------------------------------------------------------------------ cards */

  function metaLine(item, extras = []) {
    const who = isMine(item) ? 'Sent by you' : `From ${(item.from && item.from.name) || 'another device'}`;
    const folder = searching() ? spaceById(item.space) : null;
    return h('p', { class: 'card__meta' },
      h('span', null, who),
      h('time', { datetime: new Date(item.at).toISOString(), 'data-at': String(item.at) }, timeAgo(item.at)),
      extras.filter(Boolean).map((t) => h('span', null, t)),
      folder ? h('button', { class: 'card__folder', type: 'button', onclick: () => switchSpace(folder.id) }, `In ${folder.name}`) : null);
  }

  function openOnHost(id) {
    api('POST', '/api/open', { id }).catch((e) => toast(e.message, true));
  }

  function badge(name, folder = false) {
    if (folder) return h('div', { class: 'folder-icon', 'aria-hidden': 'true' });
    const ext = name.includes('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : '';
    return h('div', { class: 'file-icon', 'aria-hidden': 'true' }, ext);
  }

  function linkify(target, text) {
    const re = /\bhttps?:\/\/[^\s<>"']+/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      let url = m[0];
      const trail = /[.,;:!?)\]]+$/.exec(url);
      if (trail) url = url.slice(0, -trail[0].length);
      target.append(text.slice(last, m.index));
      target.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = m.index + url.length;
    }
    target.append(text.slice(last));
  }

  function revealLabel() {
    const p = state.host && state.host.platform;
    return p === 'darwin' ? 'Show in Finder' : p === 'win32' ? 'Show in Explorer' : 'Show in Folder';
  }

  function reveal(id) {
    api('POST', '/api/reveal', { id }).catch((e) => toast(e.message, true));
  }

  function downloadLink(file, label = 'Download') {
    return h('a', { class: 'btn btn--tinted btn--small', href: fileUrl(file.id, file.name) + '?dl=1', download: file.name }, label);
  }

  function textCard(item) {
    const text = h('p', { class: 'card__text' });
    linkify(text, item.text);
    const actions = h('div', { class: 'card__actions' },
      button('Copy', () => copyText(item.text).then(() => toast('Copied'), (e) => toast(e.message, true)), 'btn btn--tinted btn--small'));
    const only = item.text.trim();
    if (/^https?:\/\/\S+$/i.test(only)) {
      actions.append(h('a', { class: 'btn btn--secondary btn--small', href: only, target: '_blank', rel: 'noopener noreferrer' }, 'Open Link'));
    }
    if (item.text.split('\n').length > 12 || item.text.length > 700) {
      actions.append(button('Show More', (e) => {
        const open = text.classList.toggle('card__text--open');
        e.currentTarget.textContent = open ? 'Show Less' : 'Show More';
      }));
    }
    return h('article', { class: 'card card--text' }, h('div', { class: 'card__body' }, text, metaLine(item)), actions);
  }

  function fileCard(item) {
    const url = fileUrl(item.id, item.name);
    const media = h('div', { class: 'card__media' });
    const fallback = () => {
      media.replaceChildren(badge(item.name));
      media.setAttribute('draggable', 'true');
    };
    if (item.kind === 'image') {
      const img = h('img', { src: url, alt: '', loading: 'lazy' });
      media.classList.add('card__media--image');
      img.addEventListener('error', () => {
        media.classList.remove('card__media--image');
        fallback();
      }, { once: true });
      media.append(h('button', { class: 'card__preview', type: 'button', 'aria-label': `Preview ${item.name}`, title: 'Preview', onclick: () => openViewer(item.id) }, img));
    } else if (item.kind === 'video') {
      const video = h('video', { src: url, controls: true, preload: 'metadata', playsinline: true });
      video.addEventListener('error', fallback, { once: true });
      media.append(video);
    } else if (item.kind === 'audio') {
      const audio = h('audio', { src: url, controls: true, preload: 'metadata' });
      audio.addEventListener('error', fallback, { once: true });
      media.append(audio);
    } else {
      fallback();
    }

    const actions = h('div', { class: 'card__actions' });
    if (state.local) {
      actions.append(button('Open', () => openOnHost(item.id), 'btn btn--tinted btn--small'));
      actions.append(button(revealLabel(), () => reveal(item.id)));
    } else {
      actions.append(downloadLink(item));
    }
    return h('article', { class: 'card card--file' }, media,
      h('div', { class: 'card__body' }, h('p', { class: 'card__name' }, item.name), metaLine(item, [fmtBytes(item.size)])),
      actions);
  }

  function folderCard(item) {
    const list = h('ul', null, item.files.map((f) =>
      h('li', null,
        state.local ? h('span', null, f.rel) : h('span', null, h('a', { href: fileUrl(f.id, f.name) + '?dl=1', download: f.name }, f.rel)),
        h('span', null, fmtBytes(f.size)))));
    if (item.more) list.append(h('li', null, h('span', null, `and ${item.more} more`)));

    const actions = h('div', { class: 'card__actions' });
    if (state.local) actions.append(button(revealLabel(), () => reveal(item.id), 'btn btn--tinted btn--small'));
    else {
      // One zip keeps the folder's structure, and the browser doesn't ask about multiple downloads.
      actions.append(button('Download', () => downloadZip([item.id]).catch((e) => toast(e.message, true)), 'btn btn--tinted btn--small'));
    }
    return h('article', { class: 'card card--folder' },
      h('div', { class: 'card__media' }, badge(item.name, true)),
      h('div', { class: 'card__body' },
        h('p', { class: 'card__name' }, item.name),
        metaLine(item, [`${item.count} ${item.count === 1 ? 'file' : 'files'}`, fmtBytes(item.size)])),
      h('details', { class: 'card__files' }, h('summary', null, 'Show Files'), list),
      actions);
  }

  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="m6.5 12.5 3.5 3.5 7.5-8"/></svg>';

  function renderItem(item, { animate = false } = {}) {
    const card = item.type === 'text' ? textCard(item) : item.type === 'folder' ? folderCard(item) : fileCard(item);
    card.dataset.id = item.id;
    // In select mode the whole card is one big toggle.
    const picked = state.selected.has(item.id);
    card.append(h('button', {
      class: 'card__select',
      type: 'button',
      'aria-pressed': String(picked),
      'aria-label': `Select ${item.type === 'text' ? 'note' : item.name}`,
      onclick: (e) => toggleSelect(item.id, e.shiftKey),
    }, h('span', { class: 'card__check' }, icon(CHECK_ICON))));
    if (picked) card.classList.add('card--selected');
    card.append(h('button', {
      class: 'card__remove',
      type: 'button',
      'aria-label': 'Remove',
      title: 'Remove from Dropspace (saved files stay)',
      onclick: () => api('DELETE', `/api/items/${item.id}`).catch((e) => toast(e.message, true)),
    }, '×'));
    if (animate) {
      card.classList.add('card--arrived');
      setTimeout(() => card.classList.remove('card--arrived'), 1800);
    }
    return card;
  }

  function upsertItem(item, { animate = false } = {}) {
    if (!item || state.items.has(item.id)) return;
    state.items.set(item.id, item);
    const pending = item.clientKey && state.pending.get(item.clientKey);
    if (pending) state.pending.delete(item.clientKey);
    if (searching()) {
      if (pending) pending.el.remove();
      renderSpaces();
      renderFeed();
      return;
    }
    if (item.space === state.current) {
      const card = renderItem(item, { animate });
      state.cards.set(item.id, card);
      if (pending && pending.el.isConnected) pending.el.replaceWith(card);
      else $('feed').prepend(card);
    } else if (pending) {
      pending.el.remove();
    }
    renderSpaces();
    updateBoardChrome();
  }

  function removeCard(id, { quiet = false } = {}) {
    const card = state.cards.get(id);
    if (card) card.remove();
    state.cards.delete(id);
    state.items.delete(id);
    state.selected.delete(id);
    if (quiet) return;
    renderSpaces();
    updateBoardChrome();
    updateSelectionUi();
  }

  /* ------------------------------------------------------------------ select several: download as a zip, or delete */

  const selectableIds = () => visibleItems().map((it) => it.id);

  function enterSelect() {
    state.selecting = true;
    state.selected.clear();
    state.lastPicked = null;
    document.body.classList.add('is-selecting');
    updateSelectionUi();
  }

  function exitSelect() {
    if (!state.selecting && !state.selected.size) return;
    state.selecting = false;
    state.selected.clear();
    document.body.classList.remove('is-selecting');
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const visible = selectableIds();
    const shown = new Set(visible);
    for (const id of [...state.selected]) if (!shown.has(id)) state.selected.delete(id);
    const n = state.selected.size;
    $('selectionBar').hidden = !state.selecting;
    $('selectButton').hidden = state.selecting;
    $('clearButton').hidden = state.selecting;
    $('selectAllButton').hidden = !state.selecting;
    $('selectDoneButton').hidden = !state.selecting;
    $('selectAllButton').textContent = visible.length && n === visible.length ? 'Deselect All' : 'Select All';
    $('selectionCount').textContent = n ? `${n} Selected` : 'Select Items';
    $('zipButton').disabled = !n;
    $('deleteSelectedButton').disabled = !n;
    const only = n === 1 ? state.items.get([...state.selected][0]) : null;
    $('zipButton').title = only && only.type === 'file' ? `Download ${only.name}` : 'Download as one zip file';
    for (const [id, card] of state.cards) {
      const on = state.selected.has(id);
      card.classList.toggle('card--selected', on);
      const b = card.querySelector('.card__select');
      if (b) b.setAttribute('aria-pressed', String(on));
    }
  }

  function toggleSelect(id, range = false) {
    if (!state.selecting) return;
    const ids = selectableIds();
    const from = ids.indexOf(state.lastPicked);
    const to = ids.indexOf(id);
    if (range && from >= 0 && to >= 0 && from !== to) {
      // Shift-click: everything between the last one picked and this one.
      const [a, b] = from < to ? [from, to] : [to, from];
      for (const x of ids.slice(a, b + 1)) state.selected.add(x);
    } else if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      state.selected.add(id);
    }
    state.lastPicked = id;
    updateSelectionUi();
  }

  async function downloadZip(ids) {
    const r = await api('POST', '/api/zip', { ids });
    const a = h('a', { href: r.url, download: r.name });
    document.body.append(a);
    a.click();
    a.remove();
    toast(`Downloading ${r.name}`);
  }

  async function downloadSelected() {
    const ids = selectableIds().filter((id) => state.selected.has(id));
    if (!ids.length) return;
    const only = ids.length === 1 ? state.items.get(ids[0]) : null;
    if (only && only.type === 'file') return triggerDownload(only);
    $('zipButton').disabled = true;
    try {
      await downloadZip(ids);
    } catch (e) {
      toast(e.message, true);
    } finally {
      updateSelectionUi();
    }
  }

  async function deleteSelected() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const ok = await askConfirm({
      title: ids.length === 1 ? 'Delete 1 item?' : `Delete ${ids.length} items?`,
      text: `They're removed from Dropspace on every device. Files already saved on ${state.local ? 'this computer' : state.hostName} stay where they are.`,
      confirm: 'Delete',
    });
    if (!ok) return;
    try {
      await api('POST', '/api/items/delete', { ids });
      exitSelect();
    } catch (e) {
      toast(e.message, true);
    }
  }

  $('selectButton').addEventListener('click', enterSelect);
  $('selectDoneButton').addEventListener('click', exitSelect);
  $('selectAllButton').addEventListener('click', () => {
    const ids = selectableIds();
    if (ids.length && ids.every((id) => state.selected.has(id))) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    updateSelectionUi();
  });
  $('zipButton').addEventListener('click', downloadSelected);
  $('deleteSelectedButton').addEventListener('click', deleteSelected);
  document.addEventListener('keydown', (e) => {
    if (!state.selecting || $('app').hidden || document.querySelector('dialog[open]')) return;
    const typing = e.target.closest && e.target.closest('input, textarea');
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelect();
    } else if (!typing && e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      selectableIds().forEach((id) => state.selected.add(id));
      updateSelectionUi();
    } else if (!typing && (e.key === 'Backspace' || e.key === 'Delete') && state.selected.size) {
      e.preventDefault();
      deleteSelected();
    }
  });

  setInterval(() => {
    for (const t of document.querySelectorAll('time[data-at]')) t.textContent = timeAgo(Number(t.dataset.at));
  }, 30 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.unread) {
      state.unread = 0;
      document.title = 'Dropspace';
    }
  });

  /* ------------------------------------------------------------------ clipboard + downloads */

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        /* fall through to the old way */
      }
    }
    // Over plain http on the network, browsers hide the modern clipboard API. Selecting the text and
    // copying still works on a click, including in Safari on an iPhone.
    const holder = h('span', { 'aria-hidden': 'true' });
    holder.textContent = text;
    Object.assign(holder.style, { position: 'fixed', top: '0', left: '-9999px', whiteSpace: 'pre', userSelect: 'text', webkitUserSelect: 'text' });
    document.body.append(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    sel.removeAllRanges();
    holder.remove();
    if (!ok) throw new Error("Couldn't copy. Select the text and copy it yourself.");
  }

  async function toPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('convert failed'))), 'image/png'));
  }

  async function copyImage(item) {
    try {
      // Safari needs the ClipboardItem created right away, with the image arriving as a promise.
      const png = fetch(fileUrl(item.id, item.name)).then((r) => r.blob()).then(toPng);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast('Image copied');
    } catch {
      toast("This image can't be copied. Use the file instead.", true);
    }
  }

  function triggerDownload(file) {
    const a = h('a', { href: fileUrl(file.id, file.name) + '?dl=1', download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function maybeAutoSave(item) {
    if (state.local || !state.autoSave) return;
    if (item.type === 'file') triggerDownload(item);
    if (item.type === 'folder') item.files.forEach((f, i) => setTimeout(() => triggerDownload(f), i * 350));
  }

  /* ------------------------------------------------------------------ sending */

  const queue = [];
  let active = 0;
  function enqueue(task) {
    queue.push(task);
    pump();
  }
  function pump() {
    while (active < 2 && queue.length) {
      const task = queue.shift();
      active++;
      task().finally(() => {
        active--;
        pump();
      });
    }
  }

  function pendingCard(name, total, status, space) {
    const key = randomId();
    const bar = h('div', { class: 'progress__bar' });
    const meta = h('p', { class: 'card__meta' }, status);
    let onAction = () => {
      p.cancelled = true;
      if (p.xhr) p.xhr.abort();
      p.remove();
    };
    const actionBtn = button('Cancel', () => onAction(), 'btn btn--link btn--small');
    const el = h('article', { class: 'card card--pending' },
      h('div', { class: 'card__body' },
        h('p', { class: 'card__name' }, name),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': `Sending ${name}` }, bar),
        meta),
      h('div', { class: 'card__actions' }, actionBtn));
    let startedAt = 0;
    const p = {
      key,
      el,
      space,
      xhr: null,
      cancelled: false,
      setTotal(bytes, count) {
        total = bytes;
        meta.textContent = `${count} files, ${fmtBytes(bytes)}. Waiting…`;
      },
      progress(loaded) {
        if (!startedAt) startedAt = performance.now();
        bar.style.width = `${total ? Math.min(100, (loaded / total) * 100) : 100}%`;
        const secs = (performance.now() - startedAt) / 1000;
        const rate = secs > 0.6 ? loaded / secs : 0;
        meta.textContent = `${fmtBytes(loaded)} of ${fmtBytes(total)}${rate ? `, ${fmtBytes(rate)}/s` : ''}`;
      },
      fail(message) {
        el.classList.add('card--failed');
        meta.textContent = message;
        actionBtn.textContent = 'Dismiss';
        onAction = () => p.remove();
      },
      remove() {
        el.remove();
        state.pending.delete(key);
        updateBoardChrome();
      },
    };
    state.pending.set(key, p);
    if (space === state.current) $('feed').prepend(el);
    updateBoardChrome();
    return p;
  }

  function xhrUpload(file, headers, onProgress, handle) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      handle.xhr = xhr;
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Dropspace', '1');
      xhr.setRequestHeader('X-Device-Id', state.deviceId);
      xhr.setRequestHeader('X-Device-Name', enc(myName()));
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Lost the connection. Check that both devices are on the same Wi-Fi."));
      xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      xhr.send(file);
    });
  }

  function sendFile(file, space = state.current) {
    const p = pendingCard(file.name, file.size, 'Waiting…', space);
    enqueue(async () => {
      if (p.cancelled) return;
      try {
        p.progress(0);
        const headers = { 'X-Filename': enc(file.name), 'X-Client-Key': p.key, 'X-Space': space };
        const data = await xhrUpload(file, headers, (n) => p.progress(n), p);
        upsertItem(data && data.item);
      } catch (e) {
        if (!e.cancelled) p.fail(e.message);
      }
    });
  }

  function readEntries(dir) {
    const reader = dir.createReader();
    const all = [];
    return new Promise((resolve, reject) => {
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
      next();
    });
  }

  async function walk(entry, relDir, out) {
    if (entry.isFile) {
      if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(entry.name)) return;
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel: relDir });
    } else if (entry.isDirectory) {
      const sub = relDir ? `${relDir}/${entry.name}` : entry.name;
      for (const child of await readEntries(entry)) await walk(child, sub, out);
    }
  }

  async function sendFolder(entry, space = state.current) {
    const p = pendingCard(`${entry.name} folder`, 0, 'Reading folder…', space);
    let files = [];
    try {
      for (const child of await readEntries(entry)) await walk(child, '', files);
    } catch {
      return p.fail("Couldn't read that folder.");
    }
    if (!files.length) return p.fail('That folder is empty.');
    const total = files.reduce((sum, f) => sum + f.file.size, 0);
    p.setTotal(total, files.length);
    enqueue(async () => {
      if (p.cancelled) return;
      try {
        const { batchId } = await api('POST', '/api/batch', { name: entry.name, space });
        let done = 0;
        for (const f of files) {
          if (p.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          await xhrUpload(f.file, { 'X-Filename': enc(f.file.name), 'X-Batch': batchId, 'X-Relpath': enc(f.rel) }, (n) => p.progress(done + n), p);
          done += f.file.size;
        }
        const { item } = await api('POST', `/api/batch/${batchId}/done`, { clientKey: p.key });
        if (item) upsertItem(item);
        else p.remove();
      } catch (e) {
        if (!e.cancelled) p.fail(e.message);
      }
    });
    files = null;
  }

  async function sendText(text, space = state.current) {
    try {
      const { item } = await api('POST', '/api/text', { text, space, clientKey: randomId() });
      upsertItem(item);
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  /** Screenshots pasted from the clipboard arrive as "image.png". Give them a useful name. */
  function namePasted(file) {
    if (file.name && !/^image\.(png|jpe?g|gif|webp|tiff?|bmp)$/i.test(file.name)) return file;
    const ext = ((file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'));
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    return new File([file], `Pasted image ${stamp}.${ext}`, { type: file.type });
  }

  function takeDataTransfer(dt, space = state.current) {
    // Entries must be read now: the browser empties the drop data as soon as this event ends.
    const folders = [];
    const files = [];
    if (dt.items && dt.items.length) {
      for (const it of dt.items) {
        if (it.kind !== 'file') continue;
        const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) folders.push(entry);
        else {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
    } else if (dt.files) {
      files.push(...dt.files);
    }
    if (files.length || folders.length) {
      files.forEach((f) => sendFile(f, space));
      folders.forEach((entry) => sendFolder(entry, space));
      return true;
    }
    const text = dt.getData('text/plain') || dt.getData('text/uri-list').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).join('\n');
    if (text && text.trim()) {
      sendText(text, space);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ drag in, drag out, paste */

  let overlayTimer = null;
  const setDropSpace = (id) => {
    if (state.dropSpace === id) return;
    state.dropSpace = id;
    for (const el of document.querySelectorAll('.folder-row')) el.classList.toggle('folder-row--drop', el.dataset.space === id);
    updateOverlay();
  };
  const setDragging = (on) => {
    document.body.classList.toggle('is-dragging', on);
    if (!on) setDropSpace(null);
  };
  const folderUnder = (target) => {
    const el = target && target.closest && target.closest('.folder-row');
    return el && spaceById(el.dataset.space) ? el.dataset.space : null;
  };
  const canAccept = (dt) => {
    const types = Array.from(dt.types || []);
    return types.includes('Files') || types.includes('text/plain') || types.includes('text/uri-list');
  };

  document.addEventListener('dragstart', () => {
    state.draggingOut = true;
  });
  document.addEventListener('dragend', () => {
    state.draggingOut = false;
  });

  document.addEventListener('dragover', (e) => {
    if ($('app').hidden || state.draggingOut || !canAccept(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
    setDropSpace(folderUnder(e.target));
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => setDragging(false), 150);
  });

  document.addEventListener('drop', (e) => {
    if ($('app').hidden) return;
    e.preventDefault();
    clearTimeout(overlayTimer);
    const target = folderUnder(e.target) || state.current;
    setDragging(false);
    if (state.draggingOut) return;
    if (takeDataTransfer(e.dataTransfer, target) && target !== state.current) {
      const sp = spaceById(target);
      toast(`Sending to ${sp.name}`, false, { label: 'View', onClick: () => switchSpace(sp.id) });
    }
  });

  // Drag a card out to the desktop or Finder (Chrome and Edge save it as a file).
  $('feed').addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    const item = card && state.items.get(card.dataset.id);
    if (!item || item.type !== 'file') return;
    const href = new URL(fileUrl(item.id, item.name) + '?dl=1', location.href).href;
    try {
      e.dataTransfer.setData('DownloadURL', `${(item.mime || 'application/octet-stream').split(';')[0]}:${item.name}:${href}`);
    } catch {
      /* not supported in this browser */
    }
    e.dataTransfer.setData('text/uri-list', href);
    e.dataTransfer.effectAllowed = 'copy';
  });

  document.addEventListener('paste', (e) => {
    if ($('app').hidden || !e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) {
      e.preventDefault();
      files.map(namePasted).forEach((f) => sendFile(f));
      return;
    }
    if (e.target.closest && e.target.closest('textarea, input')) return;
    const text = e.clipboardData.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      sendText(text);
    }
  });

  $('pickButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    Array.from(e.target.files || []).forEach((f) => sendFile(f));
    e.target.value = '';
  });

  const note = $('noteInput');
  const growNote = () => {
    note.style.height = 'auto';
    note.style.height = `${note.scrollHeight}px`;
    $('sendButton').disabled = !note.value.trim();
  };
  note.addEventListener('input', growNote);
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = note.value;
    if (!text.trim()) return note.focus();
    $('sendButton').disabled = true;
    if (await sendText(text)) {
      note.value = '';
      growNote();
    }
    growNote();
    note.focus();
  });

  /* ------------------------------------------------------------------ dialogs + settings */

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || (e.target.closest && e.target.closest('[data-close]'))) dialog.close();
    });
  }

  $('connectButton').addEventListener('click', () => {
    $('connectDialogBody').replaceChildren(connectPanel());
    $('connectDialog').showModal();
  });

  $('settingsButton').addEventListener('click', () => {
    $('nameInput').value = myName();
    $('autoSaveInput').checked = state.autoSave;
    $('appSteps').textContent = appInstallSteps();
    $('appFooter').textContent = `It opens ${location.host} in its own window, like any other app.`;
    const theme = store.get('theme', 'auto');
    for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === theme;
    $('aboutVersion').textContent = state.version ? `Version ${state.version}` : '';
    if (state.author) $('aboutAuthor').textContent = state.author;
    fillShareSection();
    fillSecureSection();
    $('settingsDialog').showModal();
  });

  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      store.set('theme', r.value);
      if (window.DropspaceTheme) window.DropspaceTheme.apply(r.value);
    });
  }
  // Another tab on this device changed it.
  window.addEventListener('storage', (e) => {
    if (e.key === 'dropspace.theme' && window.DropspaceTheme) window.DropspaceTheme.apply(store.get('theme', 'auto'));
  });

  const saveName = () => {
    const name = $('nameInput').value.trim();
    if (name === (store.get('name', '') || '') || (!name && !store.get('name', ''))) {
      $('nameInput').value = myName();
      return;
    }
    store.set('name', name);
    $('nameInput').value = myName();
    renderMe();
    connect(); // so other devices see the new name
    toast('Name saved');
  };
  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveName();
    $('nameInput').blur();
  });
  $('nameInput').addEventListener('change', saveName);

  $('autoSaveInput').addEventListener('change', (e) => {
    state.autoSave = e.target.checked;
    store.set('autoSave', state.autoSave);
  });

  /* folder options */

  $('folderMenuButton').addEventListener('click', () => openFolderDialog(state.current));

  const renameFolder = async () => {
    const sp = dialogSpace();
    const name = $('folderNameInput').value.trim();
    if (!name || name === sp.name) {
      $('folderNameInput').value = sp.name;
      return;
    }
    try {
      await api('PATCH', `/api/spaces/${sp.id}`, { name });
    } catch (err) {
      toast(err.message, true);
      $('folderNameInput').value = sp.name;
    }
  };
  $('folderNameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('folderNameInput').blur();
  });
  $('folderNameInput').addEventListener('change', renameFolder);

  $('folderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sp = dialogSpace();
    try {
      const r = await api('POST', `/api/spaces/${sp.id}/location`, { folder: $('folderInput').value });
      $('folderInput').value = r.space.folderDisplay;
      $('folderInput').blur();
      toast(`${sp.name} now saves to ${r.space.folderDisplay}`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('openFolderButton').addEventListener('click', () => {
    api('POST', `/api/spaces/${dialogSpace().id}/reveal`).catch((e) => toast(e.message, true));
  });

  $('deleteFolderButton').addEventListener('click', async () => {
    const sp = dialogSpace();
    const ok = await askConfirm({
      title: `Delete “${sp.name}”?`,
      text: 'It disappears from Dropspace on every device. Files already saved stay where they are.',
      confirm: 'Delete',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/spaces/${sp.id}`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  /* new folder */

  const startNewFolder = () => {
    closeDrawer();
    $('newFolderInput').value = '';
    $('newFolderError').textContent = '';
    $('newFolderDialog').showModal();
    $('newFolderInput').focus();
  };
  $('newFolderButton').addEventListener('click', startNewFolder);
  $('railNewFolder').addEventListener('click', startNewFolder);
  $('newFolderInput').addEventListener('input', () => {
    $('newFolderError').textContent = '';
  });
  $('newFolderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('newFolderInput').value.trim();
    if (!name) {
      $('newFolderError').textContent = 'Enter a name.';
      return $('newFolderInput').focus();
    }
    $('newFolderCreate').disabled = true;
    try {
      const { space } = await api('POST', '/api/spaces', { name });
      if (!spaceById(space.id)) state.spaces = [...state.spaces, space];
      $('newFolderDialog').close();
      switchSpace(space.id);
    } catch (err) {
      $('newFolderError').textContent = err.message;
      $('newFolderInput').select();
    } finally {
      $('newFolderCreate').disabled = false;
    }
  });

  $('forgetButton').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Forget all devices?',
      text: 'Every other device will need the new code to connect again.',
      confirm: 'Forget',
    });
    if (!ok) return;
    try {
      await api('POST', '/api/forget-devices');
      toast('All devices forgotten. There is a new code.');
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('clearButton').addEventListener('click', async () => {
    const sp = currentSpace();
    const ok = await askConfirm({
      title: `Clear “${sp.name}”?`,
      text: 'Everything in this folder is removed from Dropspace on every device. Files already received stay saved.',
      confirm: 'Clear',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/items?space=${enc(sp.id)}`);
    } catch (e) {
      toast(e.message, true);
    }
  });

  /* ------------------------------------------------------------------ search */

  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const was = searching();
      state.query = e.target.value;
      renderFeed();
      if (was !== searching()) window.scrollTo({ top: 0 });
    }, 60);
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
      e.target.blur();
    }
  });

  /* ------------------------------------------------------------------ preview (like Quick Look) */

  const viewer = { list: [], index: 0, touchX: null };
  const previewable = (item) => item && item.type === 'file' && (item.kind === 'image' || item.kind === 'video');

  function openViewer(id) {
    viewer.list = visibleItems().filter(previewable).map((it) => it.id);
    viewer.index = Math.max(0, viewer.list.indexOf(id));
    showViewerItem();
    if (!$('viewer').open) $('viewer').showModal();
  }

  function showViewerItem() {
    const item = state.items.get(viewer.list[viewer.index]);
    if (!item) {
      if ($('viewer').open) $('viewer').close();
      return;
    }
    const url = fileUrl(item.id, item.name);
    const media = item.kind === 'video'
      ? h('video', { src: url, controls: true, autoplay: true, playsinline: true })
      : h('img', { src: url, alt: item.name });
    $('viewerStage').replaceChildren(media);
    $('viewerName').textContent = item.name;
    const who = isMine(item) ? 'Sent by you' : `From ${(item.from && item.from.name) || 'another device'}`;
    const count = viewer.list.length > 1 ? `${viewer.index + 1} of ${viewer.list.length}` : null;
    $('viewerMeta').replaceChildren(...[who, fmtBytes(item.size), count].filter(Boolean).map((t) => h('span', null, t)));
    const actions = [];
    if (state.local) {
      actions.push(button('Open', () => openOnHost(item.id), 'btn btn--viewer btn--small'));
      actions.push(button(revealLabel(), () => reveal(item.id), 'btn btn--viewer btn--small'));
    } else {
      actions.push(h('a', { class: 'btn btn--viewer btn--small', href: `${url}?dl=1`, download: item.name }, 'Download'));
    }
    if (item.kind === 'image' && window.isSecureContext && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      actions.push(button('Copy Image', () => copyImage(item), 'btn btn--viewer btn--small'));
    }
    $('viewerActions').replaceChildren(...actions);
    const many = viewer.list.length > 1;
    $('viewerPrev').hidden = !many;
    $('viewerNext').hidden = !many;
  }

  function stepViewer(delta) {
    if (viewer.list.length < 2) return;
    viewer.index = (viewer.index + delta + viewer.list.length) % viewer.list.length;
    showViewerItem();
  }

  $('viewerPrev').addEventListener('click', () => stepViewer(-1));
  $('viewerNext').addEventListener('click', () => stepViewer(1));
  $('viewer').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepViewer(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepViewer(1);
    } else if (e.key === ' ' && e.target === $('viewer')) {
      e.preventDefault();
      $('viewer').close();
    }
  });
  $('viewerStage').addEventListener('click', (e) => {
    if (e.target === $('viewerStage')) $('viewer').close();
  });
  $('viewerStage').addEventListener('touchstart', (e) => {
    viewer.touchX = e.touches.length === 1 ? e.touches[0].clientX : null;
  }, { passive: true });
  $('viewerStage').addEventListener('touchend', (e) => {
    if (viewer.touchX === null) return;
    const dx = e.changedTouches[0].clientX - viewer.touchX;
    viewer.touchX = null;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
  });
  $('viewer').addEventListener('close', () => $('viewerStage').replaceChildren());

  /* ------------------------------------------------------------------ permanent address */

  const isIpHost = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');

  /** The permanent address, kept secure if this page is: https://dropspace.local rather than http://. */
  function permanentOrigin() {
    let u;
    try {
      u = state.hostAddress ? new URL(state.hostAddress) : null;
    } catch {
      u = null;
    }
    if (!u) return null;
    if (location.protocol !== 'https:') return u.origin;
    if (!state.hostSecure) return null;
    return `https://${u.hostname}${state.hostSecure.port === 443 ? '' : `:${state.hostSecure.port}`}`;
  }

  /** Devices still using a numbered address get a one-click move to the address that never changes. */
  function updateAddressNotice() {
    const notice = $('addressNotice');
    const origin = permanentOrigin();
    const offer = !state.local && origin && origin !== location.origin && isIpHost(location.hostname)
      && !store.get(`notice:${origin}`, false);
    if (!offer) {
      notice.hidden = true;
      return;
    }
    // Only offer it if this device can actually reach the permanent address.
    const probe = new Image();
    probe.onload = () => {
      $('noticeAddress').textContent = origin.replace(/^https?:\/\//, '');
      notice.hidden = false;
    };
    probe.onerror = () => {
      notice.hidden = true;
    };
    probe.src = `${origin}/icon-192.png?check=${Date.now()}`;
  }

  $('switchAddressButton').addEventListener('click', async () => {
    try {
      const { token } = await api('POST', '/api/move-token');
      location.href = `${permanentOrigin()}/#${carryParams(token)}`;
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('dismissNoticeButton').addEventListener('click', () => {
    const origin = permanentOrigin();
    if (origin) store.set(`notice:${origin}`, true);
    $('addressNotice').hidden = true;
  });

  /* ------------------------------------------------------------------ open like an app */

  function appInstallSteps() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (ios) return 'In Safari, tap the Share button, then Add to Home Screen.';
    if (/Android/.test(ua)) return 'In Chrome, open the ⋮ menu, then tap Add to Home screen.';
    if (/Edg\//.test(ua)) return 'Open the ⋯ menu, choose Apps, then Install this site as an app.';
    if (/OPR\/|Firefox\//.test(ua)) return 'Bookmark this page, or drag the address from the address bar onto your desktop.';
    if (/Chrome\//.test(ua)) return 'Open the ⋮ menu, choose Cast, save, and share, then Install page as app. If you only see Create shortcut, choose that and tick Open as window.';
    if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'In Safari, choose File, then Add to Dock.';
    return 'Bookmark this page so it’s one click away.';
  }

  /* ------------------------------------------------------------------ send clipboard */

  async function sendClipboardFromBrowser(space) {
    // Not a Mac: read the clipboard in the browser (allowed on this computer's own page).
    let sent = false;
    if (navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType) {
          sendFile(namePasted(new File([await item.getType(imageType)], 'image.png', { type: imageType })), space);
          sent = true;
        } else if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          if (text.trim()) sent = await sendText(text, space);
        }
      }
    } else {
      const text = await navigator.clipboard.readText();
      if (text.trim()) sent = await sendText(text, space);
    }
    if (!sent) toast('The clipboard is empty. Copy something first.', true);
  }

  $('clipboardButton').addEventListener('click', async () => {
    const btn = $('clipboardButton');
    btn.disabled = true;
    try {
      if (state.host && state.host.platform === 'darwin') {
        // The Mac reads its own clipboard: copied files from Finder, images and text all work, with no permission pop-up.
        const r = await api('POST', '/api/clipboard', { space: state.current });
        for (const item of r.items) upsertItem(item);
      } else {
        await sendClipboardFromBrowser(state.current);
      }
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Allow clipboard access in your browser, then try again.' : e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  function fillAnywhereSection() {
    const field = $('anywhereField');
    const rows = $('anywhereRows');
    const row = (text) => h('p', { class: 'row row--text' }, text);
    if (state.local && state.host && state.host.platform === 'darwin') {
      field.hidden = false;
      if (state.host.quickActions) {
        rows.replaceChildren(
          row('Right-click files or folders in Finder, then choose Quick Actions, then Send to Dropspace.'),
          row('Press Control-Option-Command-V (⌃⌥⌘V) in any app to send whatever you copied.'));
        $('anywhereFooter').textContent = 'Both go into the folder you have open here. To send from your other Mac too, double-click Install Dropspace on that Mac.';
      } else {
        rows.replaceChildren(row('Double-click Install Dropspace in the Dropspace folder you downloaded. It adds Send to Dropspace to Finder’s right-click menu, and Control-Option-Command-V (⌃⌥⌘V) to send whatever you copied.'));
        $('anywhereFooter').textContent = '';
      }
    } else if (!state.local && IS_MAC_DESKTOP) {
      field.hidden = false;
      rows.replaceChildren(row(`Double-click Install Dropspace on this Mac too. It adds Send to Dropspace to Finder’s right-click menu, and Control-Option-Command-V (⌃⌥⌘V) to send whatever you copied, straight to ${state.hostName || 'your main Mac'}.`));
      $('anywhereFooter').textContent = 'Things you send that way go into the folder you have open here.';
    } else {
      field.hidden = true;
    }
  }
  $('settingsButton').addEventListener('click', fillAnywhereSection);
  $('railSettings').addEventListener('click', () => $('settingsButton').click());

  /* ------------------------------------------------------------------ the Share button on an iPhone */

  const b = (text) => h('strong', null, text);

  /** The address the phone's shortcut should use: the permanent one if this phone can reach it. */
  async function preferredBase() {
    if (location.protocol === 'https:' || !state.hostAddress) return location.origin;
    let stable = null;
    try {
      stable = new URL(state.hostAddress).origin;
    } catch {
      return location.origin;
    }
    if (stable === location.origin) return stable;
    return (await canReach(stable)) ? stable : location.origin;
  }

  function fillShareSection() {
    const field = $('shareField');
    const rows = $('shareRows');
    if (state.local) {
      const keys = (state.host && state.host.shareKeys) || [];
      field.hidden = false;
      if (!keys.length) {
        rows.replaceChildren(h('p', { class: 'row row--text' },
          'Send photos and files from an iPhone or iPad’s Share button. On the phone, open Dropspace, then Settings, then Set Up Share Button.'));
      } else {
        rows.replaceChildren(...keys.map((k) => h('div', { class: 'row' },
          h('span', { class: 'row__main' }, k.name,
            h('span', { class: 'row__sub' }, k.lastUsed ? `Last used ${timeAgo(k.lastUsed)}` : `Set up ${timeAgo(k.created)}. Not used yet.`)),
          button('Remove', async () => {
            const ok = await askConfirm({ title: `Remove the Share button on ${k.name}?`, text: 'Its Send to Dropspace shortcut stops working.', confirm: 'Remove' });
            if (ok) api('DELETE', `/api/share-keys/${k.id}`).catch((e) => toast(e.message, true));
          }))));
      }
      $('shareFooter').textContent = 'Things shared from a phone go into the folder you have open here.';
      return;
    }
    if (!IS_IOS) {
      field.hidden = true;
      return;
    }
    field.hidden = false;
    const mine = store.get('shareKeyId', '');
    rows.replaceChildren(h('button', { class: 'row row--button', type: 'button', onclick: openShareSetup }, mine ? 'Set Up Share Button Again' : 'Set Up Share Button'));
    if (mine) rows.append(h('button', { class: 'row row--button row--danger', type: 'button', onclick: turnOffShare }, 'Turn Off Share Button'));
    $('shareFooter').textContent = `Send photos, videos and files to ${state.hostName || 'Dropspace'} from the Share button in Photos, Files and other apps, without opening this page.`;
  }

  async function turnOffShare() {
    const id = store.get('shareKeyId', '');
    try {
      if (id) await api('DELETE', `/api/share-keys/${id}`);
      store.set('shareKeyId', '');
      toast('Share button turned off. You can delete the shortcut in the Shortcuts app.');
      fillShareSection();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function openShareSetup() {
    const body = $('shareDialogBody');
    body.replaceChildren(h('div', { class: 'hero-action' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Preparing' }), h('p', null, 'Preparing your shortcut…')));
    $('shareDialog').showModal();
    try {
      const r = await api('POST', '/api/share-keys', { name: myName(), base: await preferredBase() });
      const old = store.get('shareKeyId', '');
      if (old && old !== r.key.id) api('DELETE', `/api/share-keys/${old}`).catch(() => {});
      store.set('shareKeyId', r.key.id);
      renderShareSetup(r);
      fillShareSection();
    } catch (e) {
      body.replaceChildren(h('p', { class: 'feed__empty' }, e.message));
    }
  }

  function renderShareSetup(r) {
    const host = state.hostName || 'your computer';
    const copyButton = button('Copy Address', () => copyText(r.url).then(() => toast('Address copied'), (e) => toast(e.message, true)));
    const manual = h('ol', { class: 'steps' },
      h('li', null, 'Open the ', b('Shortcuts'), ' app and tap ', b('+'), '.'),
      h('li', null, 'Tap the name at the top, choose ', b('Rename'), ' and call it ', b('Send to Dropspace'), '. Then tap the name again, choose ', b('Details'), ', turn on ', b('Show in Share Sheet'), ' and tap Done.'),
      h('li', null, 'Tap ', b('Search Actions'), ', find ', b('Repeat with Each'), ' and tap it. If it doesn’t already say Shortcut Input, tap ', b('Items'), ' and choose ', b('Shortcut Input'), '.'),
      h('li', null, 'Search for ', b('Get Contents of URL'), ' and tap it. If it lands below End Repeat, drag it up between Repeat and End Repeat. Tap ', b('URL'), ' and paste this address:',
        h('code', { class: 'copy-field' }, r.url), copyButton),
      h('li', null, 'Tap the arrow on that action to show more. Set ', b('Method'), ' to ', b('POST'), ' and ', b('Request Body'), ' to ', b('Form'), '. Tap ', b('Add new field'), ', choose ', b('File'), ', type ', b('file'), ' as the key, and tap the value to pick ', b('Repeat Item'), '.'),
      h('li', null, 'Tap ', b('Done'), '.'));
    const parts = [];
    if (r.download) {
      parts.push(h('div', { class: 'section' },
        h('div', { class: 'group' }, h('div', { class: 'hero-action' },
          h('a', { class: 'btn btn--primary btn--large', href: r.download }, 'Add Shortcut'),
          h('p', null, 'Safari downloads it. Tap the downloads button in the address bar, tap Send to Dropspace, then tap Add Shortcut in the Shortcuts app.'))),
        h('details', { class: 'section__footer connect__more' }, h('summary', null, 'Make it yourself instead'), h('div', { class: 'group' }, manual))));
    } else {
      parts.push(h('div', { class: 'section' },
        h('h3', { class: 'section__title' }, 'Make the shortcut (about 2 minutes)'),
        h('div', { class: 'group' }, manual),
        h('p', { class: 'section__footer' }, 'The address includes a key just for this phone. Keep it to yourself.')));
    }
    parts.push(h('div', { class: 'section' },
      h('h3', { class: 'section__title' }, 'Using it'),
      h('div', { class: 'group' }, h('ol', { class: 'steps' },
        h('li', null, 'In Photos, Files or any app, select what you want to send and tap the Share button.'),
        h('li', null, 'Tap ', b('Send to Dropspace'), '. If it isn’t listed, tap ', b('Edit Actions'), ' at the bottom to add it.'),
        h('li', null, 'The first time, tap ', b('Allow'), ' so it can connect to ', host, '.'))),
      h('p', { class: 'section__footer' }, `It lands in the folder you have open on ${host}. Your phone needs to be on the same Wi-Fi.`)));
    $('shareDialogBody').replaceChildren(...parts);
  }

  /* ------------------------------------------------------------------ secure connection */

  const LOCK_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-7A1.5 1.5 0 0 1 6.5 10Zm2 0h6V8a3 3 0 0 0-6 0Z"/></svg>';

  function secureSetupSteps(last) {
    const steps = IS_IOS
      ? [
        ['Tap ', h('a', { href: '/dropspace.mobileconfig' }, 'Download Profile'), ', then Allow.'],
        ['Open the Settings app, tap ', b('Profile Downloaded'), ', then Install.'],
        ['In Settings, go to General, About, Certificate Trust Settings, and turn on ', b('Dropspace Local CA'), '.'],
      ]
      : IS_MAC_DESKTOP
        ? [['Double-click ', b('Install Dropspace'), ' on this Mac (it’s in the Dropspace download). It sets this up for you, and asks for your password once.']]
        : [[h('a', { href: '/dropspace-ca.crt' }, 'Download the certificate'), ' and install it as a trusted root certificate.']];
    return h('ol', { class: 'steps' }, [...steps, [last]].map((s) => h('li', null, s)));
  }

  function fillSecureSection() {
    const field = $('secureField');
    const rows = $('secureRows');
    const sec = state.local ? state.host && state.host.secure : state.hostSecure;
    if (!sec) {
      field.hidden = true;
      return;
    }
    field.hidden = false;
    if (state.local) {
      const input = h('input', { type: 'checkbox', class: 'switch', id: 'secureOnlyInput' });
      input.checked = !!sec.only;
      input.addEventListener('change', async () => {
        if (input.checked) {
          const ok = await askConfirm({
            title: 'Allow only secure connections?',
            text: 'Devices that aren’t set up for it yet disconnect until they are. Other Macs keep working once Install Dropspace has run on them.',
            confirm: 'Turn On',
            danger: false,
          });
          if (!ok) {
            input.checked = false;
            return;
          }
        }
        try {
          await api('POST', '/api/settings', { secureOnly: input.checked });
          toast(input.checked ? 'Only secure connections are allowed now' : 'All paired devices can connect again');
        } catch (e) {
          input.checked = !input.checked;
          toast(e.message, true);
        }
      });
      rows.replaceChildren(
        h('label', { class: 'row' }, h('span', { class: 'row__label' }, 'Secure connections only'), input),
        h('p', { class: 'row row--text' }, 'Your other Macs connect securely once you double-click Install Dropspace on them. An iPhone or iPad can too: open Dropspace on it, then Settings, then Secure Connection.'));
      $('secureFooter').textContent = 'At home you can leave this off. On school or other Wi-Fi you don’t trust, turn it on so nothing you send travels unencrypted.';
    } else if (location.protocol === 'https:') {
      rows.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'row__label' }, 'This device connects securely'), h('span', { class: 'lock' }, icon(LOCK_ICON))));
      $('secureFooter').textContent = `Everything between this device and ${state.hostName} is encrypted.`;
    } else {
      rows.replaceChildren(secureSetupSteps('Then open Dropspace again. It switches to the secure address by itself.'));
      $('secureFooter').textContent = 'Until then, what this device sends isn’t encrypted on the Wi-Fi. That’s fine at home, but avoid school or public Wi-Fi.';
    }
  }

  boot();
})();
