// Fortress Command Center — frontend state.
const state = {
  company: 'fortress',
  view: 'command',
  data: {},
};

function fmt$(n) {
  if (n == null) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + n.toLocaleString();
}
function fmtInt(n) { return n == null ? '—' : n.toLocaleString(); }
function fmtDur(s) {
  if (!s) return '—';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function loadBridge() {
  try {
    const b = await fetchJSON('/api/bridge');
    const el = document.getElementById('bridge');
    if (b.connected) {
      el.textContent = 'Bridge: connected'; el.className = 'bridge connected';
    } else {
      el.textContent = 'Bridge: not connected'; el.className = 'bridge disconnected';
    }
  } catch { document.getElementById('bridge').textContent = 'Bridge: unknown'; }
}

async function loadKPIs() {
  try {
    const k = await fetchJSON(`/api/kpis?company=${state.company}`);
    document.getElementById('kpi-opps').textContent = fmtInt(k.opps_this_week);
    document.getElementById('kpi-psas').textContent = fmtInt(k.psas_signed_this_week || 0);
    document.getElementById('kpi-signed').textContent = fmtInt(k.psas_signed_this_week);
    document.getElementById('kpi-pipeline').textContent = fmt$(k.pipeline_value);
    document.getElementById('kpi-pipeline-sub').textContent = `${fmtInt(k.pipeline_count)} open opps · live from SF`;
    renderGoals(k);
  } catch (e) {
    console.error('kpis', e);
  }
}

function renderGoals(k) {
  const targets = [
    { name: 'Q3 2026 Opportunities', actual: k.opps_this_week * 12, target: 20 },
    { name: 'Q3 2026 Signed PSAs', actual: k.psas_signed_this_week, target: 5 },
    { name: 'Q3 2026 Closed Deals', actual: 0, target: 2 },
    { name: 'Net new Fortress leads', actual: 0, target: 200 },
  ];
  const tbody = document.getElementById('goals-body');
  tbody.innerHTML = targets.map((t) => {
    const pct = Math.min(100, Math.round((t.actual / t.target) * 100));
    const paceExpected = new Date().getMonth() >= 6 ? 50 : 25;
    const paceDelta = pct - paceExpected;
    const paceClass = paceDelta >= 0 ? 'pace-ahead' : 'pace-behind';
    const paceText = paceDelta >= 0 ? `Ahead · ${pct}%` : `Behind · ${pct}%`;
    return `<tr>
      <td>${t.name}</td>
      <td>${t.actual}</td>
      <td>${t.target}</td>
      <td><div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div></td>
      <td class="${paceClass}">${paceText}</td>
    </tr>`;
  }).join('');
}

async function loadOpportunities() {
  try {
    const r = await fetchJSON(`/api/opportunities?company=${state.company}`);
    const opps = r.opportunities || [];
    document.getElementById('opps-count').textContent = `· ${opps.length} opps`;
    document.getElementById('opps-body').innerHTML = opps.map((o) => `
      <tr>
        <td><strong>${o.type || 'Property'}${o.size ? ' · ' + Math.round(o.size / 1000) + 'k SF' : ''}</strong><br><span style="color:var(--muted)">${o.name || ''}</span></td>
        <td>${o.property || '—'}</td>
        <td><span class="stage-pill">${o.stage || '—'}</span></td>
        <td>${o.owner || '—'} · <span class="money">${fmt$(o.amount)}</span></td>
        <td><a href="#" style="color:var(--gold);text-decoration:none;">Open →</a></td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="loading">No open opportunities</td></tr>';
  } catch (e) { console.error('opps', e); }
}

async function loadCalls() {
  try {
    const summary = await fetchJSON('/api/calls/summary');
    if (summary?.leaderboard) renderLeaderboard(summary.leaderboard);
    if (summary?.today) renderTodayCalls(summary.today);
  } catch (e) { console.error('calls', e); }
}

function renderLeaderboard(rows) {
  const tbody = document.getElementById('leaderboard-body');
  if (!tbody) return;
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td>${i < 3 ? '<span class="rank-medal">' + (i + 1) + '</span>' : (i + 1)}</td>
      <td><strong>${r.agent}</strong></td>
      <td>${fmtInt(r.calls)}</td>
      <td>${fmtInt(r.inbound)}</td>
      <td>${fmtInt(r.outbound)}</td>
      <td>${fmtInt(r.plus_3min)}</td>
      <td>${fmtDur(r.duration_seconds)}</td>
      <td><strong>${fmtInt(r.score)}</strong></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="loading">No calls yet today</td></tr>';
}

function renderTodayCalls(t) {
  document.getElementById('today-calls-summary').textContent =
    `Dials today: ${t.dials || 0} · Connects: ${t.connects || 0} · Avg duration: ${fmtDur(t.avg_duration)}`;
  document.getElementById('today-calls-body').innerHTML = (t.agents || []).map((a, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${a.agent}</td>
      <td>${fmtInt(a.calls)}</td>
      <td>${fmtInt(a.outbound)}</td>
      <td>${fmtInt(a.plus_3min)}</td>
      <td>${fmtDur(a.duration_seconds)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="loading">No dials logged yet today</td></tr>';
  document.getElementById('d-calls-today').textContent = fmtInt(t.dials || 0);
}

async function loadLeads() {
  try {
    const r = await fetchJSON(`/api/leads?company=${state.company}`);
    const leads = r.leads || [];
    document.getElementById('lead-bench-body').innerHTML = leads.map((l) => `
      <tr>
        <td><strong>${l.name || '—'}</strong><br><span style="color:var(--muted)">${l.property_type || ''}${l.size ? ' · ' + Math.round(l.size / 1000) + 'k SF' : ''}</span></td>
        <td>${[l.city, l.state].filter(Boolean).join(', ') || '—'}</td>
        <td><span class="stage-pill">${l.stage || '—'}</span></td>
        <td class="money">${fmt$(l.value)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="loading">No open leads</td></tr>';
    document.getElementById('d-open-leads').textContent = fmtInt(leads.length);
    // Group leads by stage for the subtitle
    const groups = {};
    for (const l of leads) groups[l.stage] = (groups[l.stage] || 0) + 1;
    const parts = Object.entries(groups).slice(0, 4).map(([s, n]) => `${n} ${s}`);
    document.getElementById('d-open-leads-sub').textContent = parts.join(' · ') || '—';

    // Also compute active opps card
    const oppsResp = await fetchJSON(`/api/opportunities?company=${state.company}`);
    document.getElementById('d-active-opps').textContent = fmtInt(oppsResp.opportunities?.length || 0);
    const oppStages = {};
    for (const o of oppsResp.opportunities || []) oppStages[o.stage] = (oppStages[o.stage] || 0) + 1;
    document.getElementById('d-active-opps-sub').textContent = Object.entries(oppStages).slice(0, 4).map(([s, n]) => `${n} ${s}`).join(' · ') || '—';
  } catch (e) { console.error('leads', e); }
}

async function refresh() {
  const now = new Date();
  const t = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  document.getElementById('refreshed').textContent = `Refreshed at ${t}`;
  document.getElementById('snapshot-time').textContent = `Live snapshot · refreshed at ${t}`;
  document.getElementById('daily-time').textContent = `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${t}`;

  await Promise.all([loadBridge(), loadKPIs(), loadOpportunities(), loadCalls(), loadLeads()]);
}

// Wiring
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    document.getElementById(`view-${state.view}`).classList.add('active');
  });
});
document.querySelectorAll('.company').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.company').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.company = btn.dataset.company;
    refresh();
  });
});
document.getElementById('refresh').addEventListener('click', refresh);

refresh();
setInterval(refresh, 60000); // auto-refresh every 60s
