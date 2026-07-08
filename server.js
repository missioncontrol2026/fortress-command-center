// Fortress Command Center dashboard server.
// Serves static HTML/CSS/JS and proxies data calls to backend services
// (Salesforce proxy, Call Tools proxy, scraper) with API keys kept server-side.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;

const BACKENDS = {
  sf: process.env.SF_PROXY_URL || 'https://fortress-sf-proxy.onrender.com',
  calltools: process.env.CALLTOOLS_PROXY_URL || 'https://fortress-calltools-proxy.onrender.com',
  scraper: process.env.SCRAPER_URL || 'https://fortress-cre-scraper.onrender.com',
};

const KEYS = {
  sf: process.env.SF_PROXY_KEY || '',
  calltools: process.env.CALLTOOLS_PROXY_KEY || '',
  scraper: process.env.SCRAPER_API_KEY || '',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  if (typeof body === 'string' || Buffer.isBuffer(body)) return res.end(body);
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const p = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(__dirname, 'public', p.replace(/\?.*$/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.zip': 'application/zip', '.png': 'image/png' }[ext] || 'application/octet-stream';
    send(res, 200, data, type);
  });
}

// Proxy: POST or GET a JSON body to a backend service, return JSON.
function proxy(target, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const u = new URL(target.url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${target.key}`,
      },
      timeout: 30000,
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body && method !== 'GET') req.write(JSON.stringify(body));
    req.end();
  });
}

// SOQL query via SF proxy — returns Salesforce query result.
async function sfQuery(soql) {
  return proxy(
    { url: `${BACKENDS.sf}/services/data/v58.0/query/?q=${encodeURIComponent(soql)}`, key: KEYS.sf },
    null,
    'GET'
  );
}

async function callToolsRecent(limit = 20) {
  return proxy(
    { url: `${BACKENDS.calltools}/api/calls/?page=1&page_size=${limit}&ordering=-created`, key: KEYS.calltools },
    null,
    'GET'
  );
}

const _agentNameCache = {};
async function resolveAgentName(uuid) {
  if (!uuid || uuid === 'unknown') return uuid;
  if (_agentNameCache[uuid]) return _agentNameCache[uuid];
  try {
    const r = await proxy(
      { url: `${BACKENDS.calltools}/api/users/${uuid}/`, key: KEYS.calltools },
      null,
      'GET'
    );
    const u = r.body || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || u.email || uuid.slice(0, 8);
    _agentNameCache[uuid] = name;
    return name;
  } catch { return uuid.slice(0, 8); }
}

async function callToolsSummary() {
  return proxy(
    { url: `${BACKENDS.calltools}/api/calls/?page=1&page_size=1&ordering=-created`, key: KEYS.calltools },
    null,
    'GET'
  );
}

async function scraperHealth() {
  return new Promise((resolve) => {
    const u = new URL(`${BACKENDS.scraper}/health`);
    const r = https.get(u, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    r.on('error', () => resolve({ status: 0, body: 'down' }));
    r.on('timeout', () => resolve({ status: 0, body: 'timeout' }));
    r.setTimeout(5000);
  });
}

// Convert SF Opportunity records into a bench-friendly shape.
function shapeOpps(records = []) {
  return records.map((r) => ({
    id: r.Id,
    name: r.Name,
    stage: r.StageName,
    amount: r.Amount,
    close: r.CloseDate,
    owner: r.Owner?.Name,
    property: r.Property_Address__c || r.Name,
    type: r.Left_Main__Property_Type__c,
    size: r.Left_Main__Square_Footage__c,
  }));
}

// Route table.
async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    // Bridge status
    if (p === '/api/bridge') {
      const h = await scraperHealth();
      return send(res, 200, { connected: h.status === 200, backend: BACKENDS.scraper });
    }

    // KPI cards (per company) + Q3 quarterly goals in one call.
    // Property filter was too strict — falling back to unfiltered so dashboard reflects real SF data.
    // TODO: once we confirm the actual field name (Property_Type__c vs Left_Main__Property_Type__c)
    // and its actual values in the org, we can add per-company filtering back.
    if (p === '/api/kpis') {
      const [
        oppsWeek, psaSentWeek, psaSignedWeek, pipelineSum, pipelineCount,
        oppsQtr, psaSentQtr, closedWonQtr, leadsQtr,
      ] = await Promise.all([
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE CreatedDate = THIS_WEEK`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE StageName LIKE '%PSA%' AND LastModifiedDate = THIS_WEEK`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE (StageName LIKE '%Signed%' OR StageName LIKE '%Contract%' OR IsWon = TRUE) AND LastModifiedDate = THIS_WEEK`),
        sfQuery(`SELECT SUM(Amount) FROM Opportunity WHERE IsClosed = FALSE`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE IsClosed = FALSE`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE CreatedDate = THIS_QUARTER`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE StageName LIKE '%PSA%' AND LastModifiedDate = THIS_QUARTER`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE IsWon = TRUE AND CloseDate = THIS_QUARTER`),
        sfQuery(`SELECT COUNT() FROM Lead WHERE CreatedDate = THIS_QUARTER`),
      ]);
      return send(res, 200, {
        opps_this_week: oppsWeek.body?.totalSize || 0,
        psas_sent_this_week: psaSentWeek.body?.totalSize || 0,
        psas_signed_this_week: psaSignedWeek.body?.totalSize || 0,
        pipeline_value: pipelineSum.body?.records?.[0]?.expr0 || 0,
        pipeline_count: pipelineCount.body?.totalSize || 0,
        quarter: {
          opps: oppsQtr.body?.totalSize || 0,
          psas_sent: psaSentQtr.body?.totalSize || 0,
          closed_won: closedWonQtr.body?.totalSize || 0,
          new_leads: leadsQtr.body?.totalSize || 0,
        },
        _debug: {
          oppsWeek_status: oppsWeek.status,
          pipelineSum_status: pipelineSum.status, pipelineCount_status: pipelineCount.status,
        },
      });
    }

    // Open opportunities table — filter dropped until we confirm actual property-type field name.
    if (p === '/api/opportunities') {
      const r = await sfQuery(`SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name FROM Opportunity WHERE IsClosed = FALSE ORDER BY Amount DESC NULLS LAST LIMIT 50`);
      return send(res, 200, { opportunities: shapeOpps(r.body?.records || []), _debug: {status: r.status} });
    }

    // Lead bench (Awaiting action, sorted by recency).
    if (p === '/api/leads') {
      const r = await sfQuery(`SELECT Id, Name, Status, Company, LastModifiedDate, City, State FROM Lead WHERE IsConverted = FALSE ORDER BY LastModifiedDate DESC NULLS LAST LIMIT 25`);
      return send(res, 200, { leads: (r.body?.records || []).map((l) => ({
        id: l.Id,
        name: l.Name,
        property_type: l.Left_Main__Property_Type__c,
        size: l.Left_Main__Square_Footage__c,
        city: l.City,
        state: l.State,
        stage: l.Status,
        value: l.Left_Main__Asking_Price__c,
      })) });
    }

    // Legacy raw calls passthrough
    if (p === '/api/calls') {
      const r = await callToolsRecent(200);
      return send(res, 200, r.body);
    }

    // Frontend uses this endpoint for the leaderboard (dashboard's Fortress Holdings section)
    if (p === '/api/calls/summary') {
      const r = await callToolsRecent(200);
      const results = r.body?.results || [];
      const byAgent = {};
      for (const call of results) {
        const key = call.app_user || call.clicker_agent_id || 'unknown';
        if (!byAgent[key]) byAgent[key] = { agent: key, calls: 0, inbound: 0, outbound: 0, over3min: 0, duration: 0 };
        const row = byAgent[key];
        row.calls += 1;
        if (call.inbound) row.inbound += 1; else row.outbound += 1;
        const dur = Number(call.duration) || 0;
        row.duration += dur;
        if (dur >= 180) row.over3min += 1;
      }
      const sorted = Object.values(byAgent).sort((a, b) => b.calls - a.calls);
      const names = await Promise.all(sorted.slice(0, 20).map(row => resolveAgentName(row.agent)));
      const leaderboard = sorted.map((row, i) => ({
        rank: i + 1,
        agent: names[i] || row.agent,
        calls: row.calls,
        inbound: row.inbound,
        outbound: row.outbound,
        plus_3min: row.over3min,
        duration_seconds: row.duration,
        score: row.calls + row.over3min * 2,
      }));
      const totalDials = results.length;
      const totalConnects = results.filter(cc => (Number(cc.duration) || 0) > 0).length;
      const avgDur = totalConnects ? Math.round(results.reduce((a, cc) => a + (Number(cc.duration) || 0), 0) / totalConnects) : 0;
      const today = { dials: totalDials, connects: totalConnects, avg_duration: avgDur };
      return send(res, 200, { leaderboard, today, agents: leaderboard, total_calls: results.length, _debug: { upstream: r.status } });
    }

    // Fallback: static files
    return serveStatic(req, res);
  } catch (err) {
    console.error(p, err.message);
    return send(res, 500, { error: 'server_error', message: err.message });
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log(`fortress-command-center listening on ${PORT}`);
});
