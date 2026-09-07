const $ = (id) => document.getElementById(id);

const state = {
  plan: null,
  steps: [],
  activeStep: null,
  cancelled: false,
};
let activeController = null;

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

function hideAllViews() {
  for (const id of ['plan-view', 'options-view', 'progress-view', 'done-view', 'error-view']) {
    $(id).hidden = true;
  }
}

function badge(status) {
  const label = {
    ok: 'OK',
    missing: 'Missing',
    old: 'Outdated',
    optional: 'Optional',
    pending: 'Waiting',
    error: 'Error',
  }[status] ?? status;
  return `<span class="badge ${status}">${label}</span>`;
}

function renderDep(item) {
  return `<div class="dep"><div class="row"><span class="name">${item.label}</span>${badge(item.status)}</div><span class="detail">${item.detail ?? ''}</span>${item.note ? `<p class="note">${item.note}</p>` : ''}</div>`;
}

function renderPlan(plan) {
  $('header-meta').textContent =
    `v${plan.installerVersion} · ${plan.platform}-${plan.arch} · Node ${plan.nodeVersion ?? '?'}`;
  $('deps').innerHTML = plan.deps.map(renderDep).join('');
  const reach = $('reach');
  const reachability = {
    ok: 'Reachable — ready to download',
    'need-token': 'Private repo — add a GitHub token below',
    missing: 'Repo isn\u2019t reachable (public)',
    error: 'Could not reach the repo right now',
    untested: 'Reachability not yet confirmed',
  }[plan.reachability] ?? plan.reachability;
  reach.className = `reach ${plan.reachability}`;
  reach.innerHTML = `Source: <b>${plan.manifest.owner}/${plan.manifest.repo}</b> (${plan.manifest.repoIsPrivate ? 'private' : 'public'}) · ${reachability}`;

  $('install-dir').value = plan.defaults.installDir;
  const needToken = plan.manifest.repoIsPrivate && plan.reachability !== 'ok';
  $('token-field').hidden = !needToken;

  buildSteps(plan.steps);
  $('start-btn').disabled = false;
}

function buildSteps(stepsMeta) {
  const list = $('steps');
  list.innerHTML = '';
  state.steps = stepsMeta.map((meta) => {
    const li = document.createElement('li');
    li.dataset.id = meta.id;
    li.innerHTML = `
      <span class="marker"></span>
      <div>
        <div class="step-name">${meta.label}</div>
        <div class="step-desc">${meta.description}</div>
      </div>`;
    list.appendChild(li);
    return { id: meta.id, li };
  });
}

function setStepState(id, kind) {
  const step = state.steps.find((s) => s.id === id);
  if (!step) return;
  step.li.classList.remove('active', 'done', 'failed');
  if (kind) step.li.classList.add(kind);
  state.activeStep = kind === 'active' ? id : null;
}

function logText(level, text) {
  const el = document.createElement('div');
  if (level === 'warn') el.className = 'log-warn';
  if (level === 'error') el.className = 'log-error';
  el.textContent = text;
  const box = $('log');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function setProgress(received, total) {
  const fill = $('progress-fill');
  if (total > 0) {
    fill.style.width = `${Math.min(100, (received / total) * 100).toFixed(1)}%`;
  } else {
    fill.style.width = '30%';
  }
}

function clearProgress() {
  $('progress-fill').style.width = '0%';
}

function handleEvent(event) {
  switch (event.type) {
    case 'step':
      setStepState(event.id, event.state === 'active' ? 'active' : event.state);
      if (event.state === 'done') setStepState(event.id, 'done');
      break;
    case 'progress':
      setProgress(event.received ?? 0, event.total ?? 0);
      break;
    case 'log':
      logText(event.level ?? 'info', event.text ?? '');
      break;
    case 'error':
      showError(event.code, event.message);
      break;
    case 'done':
    case 'end':
      if (event.summary) showDone(event.summary);
      break;
    default:
      break;
  }
}

async function loadPlan() {
  try {
    const res = await fetch('/api/plan', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Installer returned HTTP ${res.status}`);
    state.plan = await res.json();
    renderPlan(state.plan);
  } catch (err) {
    $('header-meta').textContent = `Failed to contact installer: ${err.message}`;
    showError('PLAN', err.message);
  }
}

async function install() {
  state.cancelled = false;
  hideAllViews();
  $('progress-view').hidden = false;
  $('log').textContent = '';
  $('cancel-btn').hidden = false;
  $('start-btn').disabled = true;
  clearProgress();
  for (const step of state.steps) setStepState(step.id, null);

  const body = {
    token: $('token').value.trim(),
    installDir: $('install-dir').value.trim(),
    mode: (document.querySelector('input[name="mode"]:checked') || {}).value ?? 'production',
    bundleNode: $('opt-bundle').checked,
    shortcut: $('opt-shortcut').checked,
    build: $('opt-build').checked,
  };

  try {
    const controller = new AbortController();
    activeController = controller;
    const res = await fetch('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          logText('warn', line.slice(0, 200));
        }
      }
    }
  } catch (err) {
    if (state.cancelled) {
      logText('warn', 'Installation cancelled.');
      setStepState(state.activeStep, '');
      $('cancel-btn').hidden = true;
      $('start-btn').disabled = false;
    } else {
      showError('STREAM', err.message === 'This operation was aborted' || err.name === 'AbortError' && !state.cancelled ? 'Interrupted' : err.message);
    }
  } finally {
    activeController = null;
  }
}

function showDone(summary) {
  $('cancel-btn').hidden = true;
  setProgress(100, 100);
  const rows = [
    ['Install folder', summary.installDir],
    ['App', summary.appDir],
    ['Node runtime', summary.node === 'bundled' ? 'Bundled' : 'System'],
    ['Mode', summary.mode],
    ['Open in', `http://127.0.0.1:${summary.appPort}/`],
  ];
  $('done-summary').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  hideAllViews();
  $('done-view').hidden = false;
}

function showError(code, message) {
  $('cancel-btn').hidden = true;
  $('error-code').textContent = code || '';
  $('error-message').textContent = message || 'Unknown error';
  hideAllViews();
  $('error-view').hidden = false;
}

async function launch() {
  const installDir = $('install-dir').value.trim() || state.plan?.defaults.installDir;
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installDir }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }
    logText('info', 'Launched. Open the browser at http://127.0.0.1:4173/ (the app opens it for you).');
  } catch (err) {
    showError('LAUNCH', err.message);
  }
}

$('start-btn').addEventListener('click', install);
$('cancel-btn').addEventListener('click', () => {
  state.cancelled = true;
  if (activeController) activeController.abort();
});
$('launch-btn').addEventListener('click', launch);
$('retry-btn').addEventListener('click', () => {
  hideAllViews();
  $('options-view').hidden = false;
  $('plan-view').hidden = false;
  $('start-btn').disabled = false;
});
$('again-btn').addEventListener('click', () => {
  hideAllViews();
  $('options-view').hidden = false;
  $('plan-view').hidden = false;
  $('start-btn').disabled = false;
});

loadPlan();