// Fortress Command Center dashboard server.
// Serves static HTML/CSS/JS and proxies data calls to backend services
// (Salesforce proxy, Call Tools proxy, scraper) with API keys kept server-side.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 10000;

// ----- LibreChat MongoDB (for chat-usage endpoint) -----
const MONGO_URI = process.env.MONGO_URI || '';
const AGENT_IDS = {
  fortress: process.env.FORTRESS_AGENT_ID || 'agent_vtcyFwjsIFG6UuQdD_Vv8',
  apex: process.env.APEX_AGENT_ID || 'agent_R6if1iS8zKsnETs8C1zVn',
};
// Reverse lookup: agent_id → company name
const AGENT_COMPANY = {};
for (const [co, aid] of Object.entries(AGENT_IDS)) AGENT_COMPANY[aid] = co;

let _mongoClient = null;
async function getMongoDb() {
  if (!MONGO_URI) throw new Error('MONGO_URI not configured');
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, {
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
    });
    await _mongoClient.connect();
  }
  return _mongoClient.db(); // uses DB name from URI (LibreChat)
}

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

    // ----- LibreChat usage report -----
    if (p === '/api/chat-usage') {
      const db = await getMongoDb();
      const days = Math.min(parseInt(u.searchParams.get('days') || '1', 10), 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const agentFilter = u.searchParams.get('agent'); // 'fortress', 'apex', or omit for both

      // Determine which agent_ids to include
      let agentIds;
      if (agentFilter && AGENT_IDS[agentFilter]) {
        agentIds = [AGENT_IDS[agentFilter]];
      } else {
        agentIds = Object.values(AGENT_IDS);
      }

      // 1. Find conversations with these agents updated since cutoff
      const convos = await db.collection('conversations').find({
        agent_id: { $in: agentIds },
        updatedAt: { $gte: since },
      }).project({
        conversationId: 1, title: 1, user: 1, agent_id: 1,
        createdAt: 1, updatedAt: 1,
      }).toArray();

      if (!convos.length) {
        return send(res, 200, {
          period: { days, since: since.toISOString() },
          summary: { total_conversations: 0, total_messages: 0 },
          agents: {},
          conversations: [],
        });
      }

      const convoIds = convos.map(c => c.conversationId);
      const convoMap = {};
      for (const c of convos) convoMap[c.conversationId] = c;

      // 2. Get all messages in those conversations from the period
      const messages = await db.collection('messages').find({
        conversationId: { $in: convoIds },
        createdAt: { $gte: since },
      }).project({
        messageId: 1, conversationId: 1, user: 1, sender: 1,
        text: 1, isCreatedByUser: 1, error: 1, unfinished: 1,
        finish_reason: 1, model: 1, createdAt: 1,
      }).sort({ createdAt: 1 }).toArray();

      // 3. Resolve user IDs → names from users collection
      const userIds = [...new Set(convos.map(c => c.user).filter(Boolean))];
      const users = userIds.length
        ? await db.collection('users').find(
            { _id: { $in: userIds.map(id => {
              try { return new (require('mongodb').ObjectId)(id); } catch { return id; }
            }) } },
            { projection: { name: 1, username: 1, email: 1 } }
          ).toArray()
        : [];
      const userMap = {};
      for (const u2 of users) userMap[u2._id.toString()] = u2.name || u2.username || u2.email || 'Unknown';

      // 4. Build per-conversation summaries
      const convoSummaries = [];
      const agentStats = {};

      for (const convo of convos) {
        const agentName = AGENT_COMPANY[convo.agent_id] || convo.agent_id;
        if (!agentStats[agentName]) {
          agentStats[agentName] = {
            conversations: 0, user_messages: 0, agent_messages: 0,
            errors: 0, unfinished: 0, unique_users: new Set(),
          };
        }
        const stats = agentStats[agentName];
        stats.conversations += 1;

        const convoMsgs = messages.filter(m => m.conversationId === convo.conversationId);
        const userMsgs = convoMsgs.filter(m => m.isCreatedByUser);
        const agentMsgs = convoMsgs.filter(m => !m.isCreatedByUser);
        const errors = agentMsgs.filter(m => m.error);
        const incomplete = agentMsgs.filter(m => m.unfinished);

        stats.user_messages += userMsgs.length;
        stats.agent_messages += agentMsgs.length;
        stats.errors += errors.length;
        stats.unfinished += incomplete.length;
        if (convo.user) stats.unique_users.add(convo.user);

        const userName = userMap[convo.user] || convo.user || 'Unknown';

        // Build Q&A pairs
        const qaPairs = [];
        for (let i = 0; i < convoMsgs.length; i++) {
          const msg = convoMsgs[i];
          if (msg.isCreatedByUser) {
            const answer = convoMsgs[i + 1] && !convoMsgs[i + 1].isCreatedByUser
              ? convoMsgs[i + 1] : null;
            qaPairs.push({
              question: (msg.text || '').slice(0, 500),
              answer_preview: answer ? (answer.text || '').slice(0, 300) : null,
              had_error: answer ? !!answer.error : false,
              was_unfinished: answer ? !!answer.unfinished : false,
              timestamp: msg.createdAt,
            });
          }
        }

        convoSummaries.push({
          conversation_id: convo.conversationId,
          title: convo.title || 'Untitled',
          agent: agentName,
          user: userName,
          started: convo.createdAt,
          last_activity: convo.updatedAt,
          total_messages: convoMsgs.length,
          user_messages: userMsgs.length,
          agent_messages: agentMsgs.length,
          errors: errors.length,
          unfinished: incomplete.length,
          qa_pairs: qaPairs,
        });
      }

      // Convert Sets to counts for JSON
      const agentSummary = {};
      for (const [name, stats] of Object.entries(agentStats)) {
        agentSummary[name] = {
          conversations: stats.conversations,
          user_messages: stats.user_messages,
          agent_messages: stats.agent_messages,
          errors: stats.errors,
          unfinished: stats.unfinished,
          unique_users: stats.unique_users.size,
        };
      }

      return send(res, 200, {
        period: { days, since: since.toISOString(), generated: new Date().toISOString() },
        summary: {
          total_conversations: convos.length,
          total_user_messages: messages.filter(m => m.isCreatedByUser).length,
          total_agent_messages: messages.filter(m => !m.isCreatedByUser).length,
          total_errors: messages.filter(m => m.error).length,
        },
        agents: agentSummary,
        conversations: convoSummaries.sort((a, b) =>
          new Date(b.last_activity) - new Date(a.last_activity)
        ),
      });
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
