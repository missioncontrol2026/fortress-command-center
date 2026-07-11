// Fortress Command Center — frontend state.
const state = {
  company: 'fortress',
  view: 'command',
};

const COMPANY_LABELS = {
  fortress: 'Fortress Holdings',
  apex: 'Apex Capital',
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

// Update all branding text to reflect the selected company.
function updateBranding() {
  const label = COMPANY_LABELS[state.company] || 'Fortress Holdings';
  const isApex = state.company === 'apex';

  // Command center header
  const cmdHead = document.querySelector('#view-command .section-head h1');
  if (cmdHead) cmdHead.innerHTML = `${label} <span class="gold">Command Center</span>`;

  // Daily view header
  const dailyHead = document.querySelector('#view-daily .section-head h1');
  if (dailyHead) dailyHead.innerHTML = `${label} <span class="gold">Mission Control</span>`;

  // Leaderboard title
  const lbTitle = document.querySelector('.leaderboard-title');
  if (lbTitle) lbTitle.innerHTML = `${label} — <span class="metric-tag">Leaderboard</span> <span class="metric-tag-sub" id="calls-sub">Recent Calls · Live from Call Tools</span>`;

  // Top bar brand
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.innerHTML = isApex
      ? '<span class="brand-dark">Apex Capital</span> <span class="brand-gold">Mission Control</span>'
      : '<span class="brand-dark">Fortress Holdings</span> <span class="brand-gold">Mission Control</span>';
  }
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
    document.getElementById('kpi-psas').textContent = fmtInt(k.offers_sent_this_week || 0);
    document.getElementById('kpi-signed').textContent = fmtInt(k.closed_won_this_week || 0);
    document.getElementById('kpi-pipeline').textContent = fmt$(k.pipeline_value);
    document.getElementById('kpi-pipeline-sub').textContent = `${fmtInt(k.pipeline_count)} open opps · live from SF`;
    renderGoals(k);
  } catch (e) {
    console.error('kpis', e);
  }
}

// Q3 pacing: quarter runs 7/1 - 9/30 (92 days).
function q3PacePct() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 6, 1);
  const end = new Date(now.getFullYear(), 8, 30);
  const total = end - start;
  const done = Math.max(0, Math.min(total, now - start));
  return Math.round((done / total) * 100);
}

function renderGoals(k) {
  const q = k.quarter || {};
  const label = state.company === 'apex' ? 'Apex multifamily' : 'Fortress industrial';
  const targets = [
    { name: 'Q3 2026 New Opportunities', actual: q.opps || 0, target: 20 },
    { name: 'Q3 2026 Offers Sent', actual: q.offers_sent || 0, target: 5 },
    { name: 'Q3 2026 Closed Won', actual: q.closed_won || 0, target: 2 },
    { name: `Net new ${label} leads`, actual: q.new_leads || 0, target: 200 },
  ];
  const paceExpected = q3PacePct();
  const tbody = document.getElementById('goals-body');
  tbody.innerHTML = targets.map((t) => {
    const pct = t.target ? Math.min(100, Math.round((t.actual / t.target) * 100)) : 0;
    const paceDelta = pct - paceExpected;
    const paceClass = paceDelta >= 0 ? 'pace-ahead' : 'pace-behind';
    const paceText = paceDelta >= 0 ? `Ahead of pace (${pct}% vs ${paceExpected}%)` : `Behind pace (${pct}% vs ${paceExpected}%)`;
    return `<tr>
      <td>${t.name}</td>
      <td>${fmtInt(t.actual)}</td>
      <td>${fmtInt(t.target)}</td>
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
    document.getElementById('opps-body').innerHTML = opps.map((o) => {
      const loc = [o.city, o.state].filter(Boolean).join(', ') || '—';
      const typeSize = [o.type, o.size ? Math.round(o.size / 1000) + 'k SF' : ''].filter(Boolean).join(' · ');
      return `
      <tr>
        <td><strong>${typeSize || 'Property'}</strong><br><span style="color:var(--muted)">${o.name || ''}</span></td>
        <td>${o.property || loc}</td>
        <td><span class="stage-pill">${o.stage || '—'}</span></td>
        <td>${o.owner || '—'} · <span class="money">${fmt$(o.amount)}</span></td>
        <td><a href="https://webbco.my.salesforce.com/${o.id}" target="_blank" style="color:var(--gold);text-decoration:none;">Open →</a></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="loading">No open opportunities</td></tr>';
  } catch (e) { console.error('opps', e); }
}

async function loadCalls() {
  try {
    const summary = await fetchJSON('/api/calls/summary?period=' + (window.__leaderboardPeriod || 'today'));
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
    `Dials: ${t.dials || 0} · Connects: ${t.connects || 0} · Avg duration: ${fmtDur(t.avg_duration)}`;
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
    document.getElementById('lead-bench-body').innerHTML = leads.map((l) => {
      const propInfo = [l.property_type, l.size ? Math.round(l.size / 1000) + 'k SF' : ''].filter(Boolean).join(' · ');
      return `
      <tr>
        <td><strong>${l.name || '—'}</strong><br><span style="color:var(--muted)">${propInfo}</span></td>
        <td>${[l.city, l.state].filter(Boolean).join(', ') || '—'}</td>
        <td><span class="stage-pill">${l.stage || '—'}</span></td>
        <td class="money">${fmt$(l.value)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="loading">No open leads</td></tr>';
    document.getElementById('d-open-leads').textContent = fmtInt(leads.length);
    const groups = {};
    for (const l of leads) groups[l.stage] = (groups[l.stage] || 0) + 1;
    const parts = Object.entries(groups).slice(0, 4).map(([s, n]) => `${n} ${s}`);
    document.getElementById('d-open-leads-sub').textContent = parts.join(' · ') || '—';

    // Active opps card on daily view
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

  updateBranding();
  await Promise.all([loadBridge(), loadKPIs(), loadOpportunities(), loadCalls(), loadLeads()]);
}

// ---- Capabilities catalog ----
const CAPABILITIES = {
  fortress: [
    { title: 'Morning briefing', desc: 'Ranked top acquisition, disposition, operational actions across SF, Drive, Gmail, Call Tools.',
      prompts: ['Give me today\'s morning briefing.', 'What\'s on my plate this morning?', 'Rank the top 10 acquisition actions I need to take today.'] },
    { title: 'Buyer research (CoStar-first)', desc: 'Pulls active industrial buyers from CoStar, cross-references SF for NDA-on-file flags. Never leads with SF or web.',
      prompts: ['Find 20 industrial buyers with 100K+ SF portfolios in the Southeast.', 'Who owns 1200 Antioch Pike?', 'Pull recent industrial buyers active in Middle TN.'] },
    { title: 'Off-market property lists', desc: 'Reonomy saved-search lookups for industrial warehouses. Just pass the saved-search UUID.',
      prompts: ['Pull the industrial saved search from Reonomy.', 'Give me 25 off-market warehouses in Nashville MSA from Reonomy.'] },
    { title: 'Salesforce ops (safe writes)', desc: 'Read/write SF Leads, Opps, Tasks, Notes. Cross-references before insert.',
      prompts: ['Show open industrial opps sorted by amount.', 'Create a follow-up Task on lead X for tomorrow.', 'Merge these two duplicate Contacts.'] },
    { title: 'Lead enrichment', desc: 'Take a Lead or address, pull property record + owner + comps, score against Mason\'s qualification criteria.',
      prompts: ['Enrich lead Bob Smith.', 'Tell me everything about the property at 2400 White Bridge Rd.'] },
    { title: 'Call QA + coaching', desc: 'Score Call Tools recordings against the 10-item Fortress rubric. Per-agent coaching reports.',
      prompts: ['Score the calls this week.', 'How is Hunter doing this week?', 'Give me a coaching report for Paul and Lewis.'] },
    { title: 'Stale lead surfacing', desc: 'Industrial leads untouched 30+ days, sorted oldest-first.',
      prompts: ['Show stale leads.', 'What haven\'t I touched in 45+ days?'] },
    { title: 'PSA / Seller package', desc: 'Fills the PSA template (25 blanks), drafts the seller cover email at 1% earnest, auto-saves to Google Drive.',
      prompts: ['Prep the PSA for the Dickson opp.', 'Draft the offer for 500 Industrial Blvd.'] },
    { title: 'Deal package / Buyer OM', desc: 'Pre-NDA email + NDA (if buyer isn\'t on file) + full 15-section OM, auto-saved to Drive.',
      prompts: ['Get the Dickson opp ready to shop.', 'Draft the OM + pre-NDA email for opp X.'] },
    { title: 'Gmail / Drive / Calendar / Docusign', desc: 'Draft emails, upload docs to Drive, create calendar events, send Docusign envelopes.',
      prompts: ['Draft a follow-up email to seller X.', 'Upload the OM to Drive.', 'Send the PSA via Docusign.'] },
  ],
  apex: [
    { title: 'Daily stale-leads batch (5 AM CT)', desc: 'Fires stale-leads pass for each broker: Andrew (5-30 unit), Jarrett (31-100), Brent (101+).',
      prompts: ['Send today\'s stale leads.', 'Preview the stale-leads batch before it goes.'] },
    { title: 'Buyer research (CoStar-first)', desc: 'Multifamily buyer lookups via CoStar first, then Reonomy, then SF Contacts.',
      prompts: ['Find active multifamily buyers with 500+ units in Middle TN.', 'Who owns the 200-unit deal on Nolensville Pike?'] },
    { title: 'Off-market multifamily lists (Reonomy)', desc: 'Pass a Reonomy saved-search UUID; get back the property list.',
      prompts: ['Pull the Reonomy multifamily saved search.', 'Give me 50 off-market properties matching the saved search.'] },
    { title: 'Broker segmentation', desc: 'Every lead output includes unit-count band + responsible broker (Andrew / Jarrett / Brent).',
      prompts: ['Stale leads for Andrew.', 'What\'s Brent\'s pipeline look like this week?', 'What did Jarrett touch this week?'] },
    { title: 'Salesforce ops (multifamily-scoped)', desc: 'Same SF ops as Fortress, filtered to multifamily property types.',
      prompts: ['Show all multifamily opps by unit count.', 'Create a Task on lead Y for tomorrow.'] },
    { title: 'Call QA + coaching', desc: 'Score Apex call recordings when the Apex campaign ID is configured.',
      prompts: ['Score the Apex callers this week.'] },
    { title: 'Gmail / Drive / Calendar / Docusign', desc: 'Zapier bridge sends from info@theapexcap.com when that account is added to Zapier.',
      prompts: ['Draft an email to seller X.', 'Send a calendar invite to Alex for tomorrow at 3pm.'] },
  ],
};

function renderCapabilities() {
  const build = (list) => list.map((c) => `
    <div class="cap-card">
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="cap-prompts">
        <div class="cap-prompts-label">Try:</div>
        ${c.prompts.map((p) => `<button class="cap-prompt" data-prompt="${p.replace(/"/g,'&quot;')}">${p}</button>`).join('')}
      </div>
    </div>`).join('');
  document.getElementById('cap-fortress').innerHTML = build(CAPABILITIES.fortress);
  document.getElementById('cap-apex').innerHTML = build(CAPABILITIES.apex);
  document.querySelectorAll('.cap-prompt').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.prompt);
      const old = b.textContent;
      b.textContent = 'Copied — paste into LibreChat';
      setTimeout(() => (b.textContent = old), 1400);
    });
  });
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
renderCapabilities();
setInterval(refresh, 60000);

// Period toggle wiring
window.__leaderboardPeriod = 'today';
function wirePeriodToggle() {
  const btns = document.querySelectorAll('[data-period]');
  btns.forEach(b => {
    b.onclick = () => {
      window.__leaderboardPeriod = b.dataset.period;
      btns.forEach(x => x.classList.toggle('active', x === b));
      if (typeof refresh === 'function') refresh();
    };
  });
  const el = document.getElementById('leaderboard-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
}
document.addEventListener('DOMContentLoaded', wirePeriodToggle);
if (document.readyState !== 'loading') wirePeriodToggle();
