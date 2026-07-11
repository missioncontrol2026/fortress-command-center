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

// ----- Company → Property Type mapping -----
// Fortress Holdings = industrial CRE
// Apex Capital = multifamily CRE
const COMPANY_TYPES = {
  fortress: ['Industrial', 'Warehouse', 'Small Bay', 'Flex'],
  apex: ['Multi-Family', 'Condo/Townhouse', 'Duplex', 'Triplex', 'Quadplex'],
};

// Build a SOQL WHERE fragment: Left_Main__Property_Type__c IN ('A','B')
function companyFilter(company, prefix) {
  const types = COMPANY_TYPES[company];
  if (!types) return ''; // no filter when company is unknown or 'all'
  const quoted = types.map((t) => `'${t}'`).join(',');
  const clause = `Left_Main__Property_Type__c IN (${quoted})`;
  return prefix ? ` ${prefix} ${clause}` : clause;
}

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

// SOQL query via SF proxy.
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

// Convert SF Opportunity records into a dashboard-friendly shape.
// Actual SF field names (verified against org):
//   Left_Main__Property_Type__c, Left_Main__Square_footage__c,
//   Left_Main__Address_1__c, Left_Main__City__c, Left_Main__State__c,
//   Left_Main__Asking_Price__c
function shapeOpps(records = []) {
  return records.map((r) => ({
    id: r.Id,
    name: r.Name,
    stage: r.StageName,
    amount: r.Amount,
    close: r.CloseDate,
    owner: r.Owner?.Name,
    property: r.Left_Main__Address_1__c || r.Name,
    city: r.Left_Main__City__c,
    state: r.Left_Main__State__c,
    type: r.Left_Main__Property_Type__c,
    size: r.Left_Main__Square_footage__c,
    asking: r.Left_Main__Asking_Price__c,
  }));
}

// Route table.
async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const company = u.searchParams.get('company') || '';

  try {
    // Bridge status
    if (p === '/api/bridge') {
      const h = await scraperHealth();
      return send(res, 200, { connected: h.status === 200, backend: BACKENDS.scraper });
    }

    // KPI cards — filtered by company via Property Type.
    // SF stages in this org:
    //   Appointment Set, Follow-up, Long Term Followup, Negotiation,
    //   Offer Sent, Contract Signed (closed-won), Closed Lost
    if (p === '/api/kpis') {
      const cf = companyFilter(company, 'AND');

      const [
        oppsWeek, offerSentWeek, closedWonWeek, pipelineSum, pipelineCount,
        oppsQtr, offerSentQtr, closedWonQtr, leadsQtr,
      ] = await Promise.all([
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE CreatedDate = THIS_WEEK ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE StageName = 'Offer Sent' AND LastModifiedDate = THIS_WEEK ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE IsWon = TRUE AND LastModifiedDate = THIS_WEEK ${cf}`),
        sfQuery(`SELECT SUM(Amount) total FROM Opportunity WHERE IsClosed = FALSE ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE IsClosed = FALSE ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE CreatedDate = THIS_QUARTER ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE StageName = 'Offer Sent' AND LastModifiedDate = THIS_QUARTER ${cf}`),
        sfQuery(`SELECT COUNT() FROM Opportunity WHERE IsWon = TRUE AND CloseDate = THIS_QUARTER ${cf}`),
        sfQuery(`SELECT COUNT() FROM Lead WHERE CreatedDate = THIS_QUARTER ${cf}`),
      ]);

      return send(res, 200, {
        company: company || 'all',
        opps_this_week: oppsWeek.body?.totalSize || 0,
        offers_sent_this_week: offerSentWeek.body?.totalSize || 0,
        closed_won_this_week: closedWonWeek.body?.totalSize || 0,
        pipeline_value: pipelineSum.body?.records?.[0]?.total || pipelineSum.body?.records?.[0]?.expr0 || 0,
        pipeline_count: pipelineCount.body?.totalSize || 0,
        quarter: {
          opps: oppsQtr.body?.totalSize || 0,
          offers_sent: offerSentQtr.body?.totalSize || 0,
          closed_won: closedWonQtr.body?.totalSize || 0,
          new_leads: leadsQtr.body?.totalSize || 0,
        },
      });
    }

    // Open opportunities table — with company filter + all needed fields.
    if (p === '/api/opportunities') {
      const cf = companyFilter(company, 'AND');
      const r = await sfQuery(
        `SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name,
                Left_Main__Property_Type__c, Left_Main__Square_footage__c,
                Left_Main__Address_1__c, Left_Main__City__c, Left_Main__State__c,
                Left_Main__Asking_Price__c
         FROM Opportunity
         WHERE IsClosed = FALSE ${cf}
         ORDER BY Amount DESC NULLS LAST LIMIT 50`
      );
      return send(res, 200, { company: company || 'all', opportunities: shapeOpps(r.body?.records || []) });
    }

    // Lead bench — with company filter + all needed fields.
    if (p === '/api/leads') {
      const cf = companyFilter(company, 'AND');
      const r = await sfQuery(
        `SELECT Id, Name, Status, Company, LastModifiedDate, City, State,
                Left_Main__Property_Type__c, Left_Main__Square_footage__c,
                Left_Main__Asking_Price__c
         FROM Lead
         WHERE IsConverted = FALSE ${cf}
         ORDER BY LastModifiedDate DESC NULLS LAST LIMIT 25`
      );
      return send(res, 200, {
        company: company || 'all',
        leads: (r.body?.records || []).map((l) => ({
          id: l.Id,
          name: l.Name,
          company: l.Company,
          property_type: l.Left_Main__Property_Type__c,
          size: l.Left_Main__Square_footage__c,
          city: l.City,
          state: l.State,
          stage: l.Status,
          value: l.Left_Main__Asking_Price__c,
        })),
      });
    }

    // Legacy raw calls passthrough
    if (p === '/api/calls') {
      const r = await callToolsRecent(200);
      return send(res, 200, r.body);
    }

    // Leaderboard + call summary
    if (p === '/api/calls/summary') {
      const period = u.searchParams.get('period') || 'today';
      const pageSize = period === 'week' ? 500 : 200;
      const r = await callToolsRecent(pageSize);
      const rawResults = r.body?.results || [];
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);
      const results = rawResults.filter(cc => {
        if (period === 'all') return true;
        const d = new Date(cc.start || cc.created_on);
        if (isNaN(d.getTime())) return period === 'all';
        return period === 'today' ? d >= todayStart : d >= weekAgo;
      });
      const byAgent = {};
      for (const call of results) {
        const key = call.clicker_agent_id || call.app_user || 'unknown';
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
      const dateLabel = todayStart.toISOString().slice(0, 10);
      return send(res, 200, { leaderboard, today, agents: leaderboard, period, date: dateLabel, total_calls: results.length });
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
