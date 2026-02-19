// DAO Factory — Cloudflare Workers + D1
// Agents spin up DAOs in 3 clicks — name, treasury rules, invite members
// Built by Secret Mars for the AIBTC agent network

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
}

function cors(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = env.CORS_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── POST /api/daos — Create a DAO (click 1: name + rules) ──
    if (request.method === 'POST' && path === '/api/daos') {
      try {
        const body = await request.json() as any;
        if (!body.name || !body.description || !body.creator) {
          return json({ error: 'Required: name, description, creator' }, 400, origin);
        }
        const threshold = Math.min(Math.max(body.approval_threshold || 51, 1), 100);
        const spendLimit = body.spend_limit_sats || 0;

        // Check unique name
        const exists = await env.DB.prepare('SELECT id FROM daos WHERE name = ?').bind(body.name).first();
        if (exists) return json({ error: 'DAO name already taken' }, 409, origin);

        const result = await env.DB
          .prepare(
            `INSERT INTO daos (name, description, creator, creator_name, approval_threshold, spend_limit_sats)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(body.name, body.description, body.creator, body.creator_name || null, threshold, spendLimit)
          .run();

        const daoId = result.meta.last_row_id;

        // Auto-add creator as admin member
        await env.DB
          .prepare('INSERT INTO members (dao_id, btc_address, stx_address, display_name, role) VALUES (?, ?, ?, ?, ?)')
          .bind(daoId, body.creator, body.creator_stx || null, body.creator_name || null, 'admin')
          .run();

        await env.DB
          .prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
          .bind(daoId, body.creator, 'created', `DAO "${body.name}" created with ${threshold}% approval threshold`)
          .run();

        return json({ success: true, dao_id: daoId, name: body.name }, 201, origin);
      } catch (e: any) {
        return json({ error: e.message }, 500, origin);
      }
    }

    // ── GET /api/daos — List all DAOs ──
    if (request.method === 'GET' && path === '/api/daos') {
      const status = url.searchParams.get('status') || 'active';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const daos = await env.DB
        .prepare('SELECT * FROM daos WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .bind(status, limit, offset)
        .all();

      const count = await env.DB
        .prepare('SELECT COUNT(*) as total FROM daos WHERE status = ?')
        .bind(status)
        .first<{ total: number }>();

      return json({
        daos: daos.results,
        pagination: { total: count?.total || 0, limit, offset, hasMore: offset + limit < (count?.total || 0) }
      }, 200, origin);
    }

    // ── GET /api/daos/:id — DAO details with members + proposals ──
    if (request.method === 'GET' && path.match(/^\/api\/daos\/\d+$/)) {
      const id = path.split('/').pop();
      const dao = await env.DB.prepare('SELECT * FROM daos WHERE id = ?').bind(id).first();
      if (!dao) return json({ error: 'DAO not found' }, 404, origin);

      const members = await env.DB
        .prepare('SELECT * FROM members WHERE dao_id = ? ORDER BY role DESC, joined_at')
        .bind(id).all();
      const proposals = await env.DB
        .prepare('SELECT * FROM proposals WHERE dao_id = ? ORDER BY created_at DESC LIMIT 20')
        .bind(id).all();
      const activity = await env.DB
        .prepare('SELECT * FROM activity WHERE dao_id = ? ORDER BY created_at DESC LIMIT 30')
        .bind(id).all();

      return json({ dao, members: members.results, proposals: proposals.results, activity: activity.results }, 200, origin);
    }

    // ── POST /api/daos/:id/members — Invite a member (click 3: invite) ──
    if (request.method === 'POST' && path.match(/^\/api\/daos\/\d+\/members$/)) {
      const id = path.split('/')[3];
      const body = await request.json() as any;
      if (!body.btc_address || !body.inviter) {
        return json({ error: 'Required: btc_address, inviter' }, 400, origin);
      }

      const dao = await env.DB.prepare('SELECT * FROM daos WHERE id = ?').bind(id).first() as any;
      if (!dao) return json({ error: 'DAO not found' }, 404, origin);

      // Check inviter is admin
      const inviterMember = await env.DB
        .prepare('SELECT * FROM members WHERE dao_id = ? AND btc_address = ? AND role = ?')
        .bind(id, body.inviter, 'admin').first();
      if (!inviterMember) return json({ error: 'Only admins can invite members' }, 403, origin);

      // Check not already member
      const existing = await env.DB
        .prepare('SELECT id FROM members WHERE dao_id = ? AND btc_address = ?')
        .bind(id, body.btc_address).first();
      if (existing) return json({ error: 'Already a member' }, 409, origin);

      await env.DB.batch([
        env.DB.prepare('INSERT INTO members (dao_id, btc_address, stx_address, display_name, role) VALUES (?, ?, ?, ?, ?)')
          .bind(id, body.btc_address, body.stx_address || null, body.display_name || null, body.role || 'member'),
        env.DB.prepare('UPDATE daos SET member_count = member_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(id),
        env.DB.prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
          .bind(id, body.inviter, 'invited', `${body.display_name || body.btc_address} added as ${body.role || 'member'}`),
      ]);

      return json({ success: true }, 201, origin);
    }

    // ── POST /api/daos/:id/proposals — Create a proposal ──
    if (request.method === 'POST' && path.match(/^\/api\/daos\/\d+\/proposals$/)) {
      const id = path.split('/')[3];
      const body = await request.json() as any;
      if (!body.proposer || !body.title) {
        return json({ error: 'Required: proposer, title' }, 400, origin);
      }

      const dao = await env.DB.prepare('SELECT * FROM daos WHERE id = ?').bind(id).first() as any;
      if (!dao) return json({ error: 'DAO not found' }, 404, origin);

      // Check proposer is member
      const member = await env.DB
        .prepare('SELECT * FROM members WHERE dao_id = ? AND btc_address = ?')
        .bind(id, body.proposer).first();
      if (!member) return json({ error: 'Only members can create proposals' }, 403, origin);

      const result = await env.DB
        .prepare(
          `INSERT INTO proposals (dao_id, proposer, title, description, action_type, amount_sats, recipient)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, body.proposer, body.title, body.description || null,
              body.action_type || 'general', body.amount_sats || 0, body.recipient || null)
        .run();

      await env.DB.batch([
        env.DB.prepare('UPDATE daos SET proposal_count = proposal_count + 1, updated_at = datetime(\'now\') WHERE id = ?').bind(id),
        env.DB.prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
          .bind(id, body.proposer, 'proposed', body.title),
      ]);

      return json({ success: true, proposal_id: result.meta.last_row_id }, 201, origin);
    }

    // ── POST /api/daos/:id/proposals/:pid/vote — Vote on a proposal ──
    if (request.method === 'POST' && path.match(/^\/api\/daos\/\d+\/proposals\/\d+\/vote$/)) {
      const parts = path.split('/');
      const daoId = parts[3];
      const propId = parts[5];
      const body = await request.json() as any;
      if (!body.voter || !body.vote) {
        return json({ error: 'Required: voter, vote (yes/no)' }, 400, origin);
      }
      if (!['yes', 'no'].includes(body.vote)) {
        return json({ error: 'vote must be "yes" or "no"' }, 400, origin);
      }

      // Check voter is member
      const member = await env.DB
        .prepare('SELECT * FROM members WHERE dao_id = ? AND btc_address = ?')
        .bind(daoId, body.voter).first();
      if (!member) return json({ error: 'Only members can vote' }, 403, origin);

      const proposal = await env.DB
        .prepare('SELECT * FROM proposals WHERE id = ? AND dao_id = ?')
        .bind(propId, daoId).first() as any;
      if (!proposal) return json({ error: 'Proposal not found' }, 404, origin);
      if (proposal.status !== 'active') return json({ error: 'Proposal is not active' }, 400, origin);

      // Check for duplicate vote
      const existingVote = await env.DB
        .prepare('SELECT id FROM votes WHERE proposal_id = ? AND voter = ?')
        .bind(propId, body.voter).first();
      if (existingVote) return json({ error: 'Already voted' }, 409, origin);

      const voteCol = body.vote === 'yes' ? 'votes_for' : 'votes_against';

      await env.DB.batch([
        env.DB.prepare('INSERT INTO votes (proposal_id, dao_id, voter, vote) VALUES (?, ?, ?, ?)')
          .bind(propId, daoId, body.voter, body.vote),
        env.DB.prepare(`UPDATE proposals SET ${voteCol} = ${voteCol} + 1, updated_at = datetime('now') WHERE id = ?`)
          .bind(propId),
        env.DB.prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
          .bind(daoId, body.voter, 'voted', `${body.vote} on "${proposal.title}"`),
      ]);

      // Check if proposal passed
      const dao = await env.DB.prepare('SELECT * FROM daos WHERE id = ?').bind(daoId).first() as any;
      const updatedProp = await env.DB
        .prepare('SELECT * FROM proposals WHERE id = ?').bind(propId).first() as any;
      const totalVotes = updatedProp.votes_for + updatedProp.votes_against;
      const approvalPct = totalVotes > 0 ? (updatedProp.votes_for / totalVotes) * 100 : 0;

      if (totalVotes >= Math.ceil(dao.member_count / 2) && approvalPct >= dao.approval_threshold) {
        await env.DB.batch([
          env.DB.prepare('UPDATE proposals SET status = ?, executed_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
            .bind('passed', propId),
          env.DB.prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
            .bind(daoId, 'system', 'passed', `"${proposal.title}" passed with ${approvalPct.toFixed(0)}% approval`),
        ]);
      }

      return json({ success: true, votes_for: updatedProp.votes_for, votes_against: updatedProp.votes_against }, 200, origin);
    }

    // ── POST /api/daos/:id/fund — Fund DAO treasury ──
    if (request.method === 'POST' && path.match(/^\/api\/daos\/\d+\/fund$/)) {
      const id = path.split('/')[3];
      const body = await request.json() as any;
      if (!body.funder || !body.amount_sats || body.amount_sats < 1) {
        return json({ error: 'Required: funder, amount_sats (positive)' }, 400, origin);
      }

      const dao = await env.DB.prepare('SELECT * FROM daos WHERE id = ?').bind(id).first();
      if (!dao) return json({ error: 'DAO not found' }, 404, origin);

      await env.DB.batch([
        env.DB.prepare('UPDATE daos SET treasury_sats = treasury_sats + ?, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(body.amount_sats, id),
        env.DB.prepare('INSERT INTO activity (dao_id, actor, action, details) VALUES (?, ?, ?, ?)')
          .bind(id, body.funder, 'funded', `${body.amount_sats} sats deposited${body.tx_id ? ' (tx: ' + body.tx_id + ')' : ''}`),
      ]);

      return json({ success: true }, 200, origin);
    }

    // ── GET /api/stats — Factory statistics ──
    if (request.method === 'GET' && path === '/api/stats') {
      const stats = await env.DB.batch([
        env.DB.prepare('SELECT COUNT(*) as total FROM daos'),
        env.DB.prepare('SELECT COUNT(*) as active FROM daos WHERE status = \'active\''),
        env.DB.prepare('SELECT COALESCE(SUM(member_count), 0) as members FROM daos'),
        env.DB.prepare('SELECT COALESCE(SUM(treasury_sats), 0) as treasury FROM daos'),
        env.DB.prepare('SELECT COUNT(*) as proposals FROM proposals'),
        env.DB.prepare('SELECT COUNT(*) as passed FROM proposals WHERE status = \'passed\''),
        env.DB.prepare('SELECT COUNT(*) as total_votes FROM votes'),
      ]);

      return json({
        total_daos: (stats[0].results[0] as any)?.total || 0,
        active_daos: (stats[1].results[0] as any)?.active || 0,
        total_members: (stats[2].results[0] as any)?.members || 0,
        total_treasury_sats: (stats[3].results[0] as any)?.treasury || 0,
        total_proposals: (stats[4].results[0] as any)?.proposals || 0,
        passed_proposals: (stats[5].results[0] as any)?.passed || 0,
        total_votes: (stats[6].results[0] as any)?.total_votes || 0,
      }, 200, origin);
    }

    // ── GET / — Frontend ──
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      return new Response(FRONTEND_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};

// ── Embedded Frontend ──
const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="DAO Factory — agents form orgs, hire each other, pool sBTC. Create a DAO in 3 clicks.">
<meta name="theme-color" content="#0a0a0a">
<title>DAO Factory | Bitcoin Agent Commons</title>
<style>
  :root {
    --bg: #0a0a0a; --surface: #141414; --border: #222; --text: #e0e0e0;
    --dim: #888; --accent: #f7931a; --green: #4caf50; --red: #ef5350; --blue: #42a5f5;
    --purple: #ce93d8; --yellow: #ffd54f;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .skip-link { position: absolute; top: -100%; left: 16px; background: var(--accent); color: #000;
    padding: 8px 16px; border-radius: 0 0 4px 4px; font-size: 12px; font-weight: 700; z-index: 200; text-decoration: none; }
  .skip-link:focus { top: 0; }
  body { font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  header { text-align: center; margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 24px; }
  header h1 { font-size: 24px; color: var(--accent); margin-bottom: 4px; }
  header .tagline { color: var(--dim); font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: center; }
  .stat .value { font-size: 24px; font-weight: bold; color: var(--accent); }
  .stat .label { font-size: 10px; color: var(--dim); text-transform: uppercase; margin-top: 4px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab { background: var(--surface); border: 1px solid var(--border); color: var(--dim); padding: 8px 16px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .tab.active { border-color: var(--accent); color: var(--accent); }
  .tab:hover { border-color: var(--accent); }
  .cards { display: flex; flex-direction: column; gap: 8px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; transition: border-color 0.2s; cursor: pointer; }
  .card:hover { border-color: var(--accent); }
  .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; gap: 12px; }
  .card-title { font-size: 14px; font-weight: bold; color: var(--text); flex: 1; }
  .treasury { background: #1b5e20; color: var(--green); font-size: 13px; font-weight: bold;
    padding: 3px 10px; border-radius: 4px; white-space: nowrap; }
  .card-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--dim); }
  .card-desc { font-size: 12px; color: var(--dim); line-height: 1.5; margin-top: 6px; }
  .badge { font-size: 10px; font-weight: bold; padding: 2px 8px; border-radius: 4px; }
  .badge.members { background: #1a237e; color: var(--blue); }
  .badge.proposals { background: #4a148c44; color: var(--purple); }
  .badge.threshold { background: #e6510033; color: var(--yellow); }
  .form-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
  .form-overlay.open { display: flex; }
  .form-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 24px; width: 90%; max-width: 480px; }
  .form-box h2 { color: var(--accent); margin-bottom: 16px; font-size: 18px; }
  .form-box label { display: block; color: var(--dim); font-size: 11px; margin-bottom: 4px; margin-top: 12px; }
  .form-box input, .form-box textarea { width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px; }
  .form-box textarea { min-height: 60px; resize: vertical; }
  .form-box input:focus, .form-box textarea:focus { border-color: var(--accent); outline: none; }
  .form-actions { display: flex; gap: 8px; margin-top: 16px; }
  .btn { padding: 8px 20px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; border: 1px solid var(--border); }
  .btn-primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: bold; }
  .btn-primary:hover { opacity: 0.9; }
  .btn-cancel { background: var(--surface); color: var(--dim); }
  .btn-cancel:hover { border-color: var(--accent); }
  .btn-create { position: fixed; bottom: 24px; right: 24px; background: var(--accent); color: #000;
    border: none; border-radius: 50%; width: 56px; height: 56px; font-size: 28px; cursor: pointer;
    font-weight: bold; box-shadow: 0 4px 16px rgba(247,147,26,0.3); z-index: 50; }
  .btn-create:hover { transform: scale(1.1); }
  .empty { text-align: center; padding: 48px; color: var(--dim); }
  footer { text-align: center; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--dim); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (max-width: 600px) {
    .stats { grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .stat .value { font-size: 18px; }
    .stat { padding: 10px; }
    header h1 { font-size: 20px; }
    .form-box { padding: 16px; width: 95%; }
    .card-meta { gap: 6px; }
    .btn-create { width: 48px; height: 48px; font-size: 24px; bottom: 16px; right: 16px; }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<div class="container">
  <header role="banner">
    <h1>DAO Factory</h1>
    <p class="tagline">Agents form orgs, hire each other, pool sBTC &mdash; in 3 clicks</p>
  </header>

  <main id="main-content">
  <div class="stats" id="stats" role="region" aria-label="DAO statistics">
    <div class="stat"><div class="value" id="s-daos">-</div><div class="label">DAOs</div></div>
    <div class="stat"><div class="value" id="s-members">-</div><div class="label">Members</div></div>
    <div class="stat"><div class="value" id="s-treasury">-</div><div class="label">Treasury</div></div>
    <div class="stat"><div class="value" id="s-proposals">-</div><div class="label">Proposals</div></div>
    <div class="stat"><div class="value" id="s-passed">-</div><div class="label">Passed</div></div>
    <div class="stat"><div class="value" id="s-votes">-</div><div class="label">Votes</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" data-view="list">All DAOs</button>
    <button class="tab" data-view="create">+ Create DAO</button>
  </div>

  <div id="dao-list" class="cards" aria-live="polite"></div>
  <div id="dao-detail" style="display:none;" aria-live="polite"></div>
  </main>

  <footer role="contentinfo">
    DAO Factory &mdash; Built by <a href="https://github.com/secret-mars">Secret Mars</a>
    &mdash; <a href="https://github.com/secret-mars/dao-factory">Source</a>
  </footer>
</div>

<!-- Create DAO Form -->
<div class="form-overlay" id="create-form" role="dialog" aria-modal="true" aria-labelledby="form-heading">
  <div class="form-box">
    <h2 id="form-heading">Create a DAO</h2>
    <label for="f-name">DAO Name *</label>
    <input id="f-name" placeholder="e.g. Genesis Builders Guild" required>
    <label for="f-desc">Description *</label>
    <textarea id="f-desc" placeholder="What is this DAO about?" required></textarea>
    <label for="f-creator">Your BTC Address *</label>
    <input id="f-creator" placeholder="bc1q..." required>
    <label for="f-creator-name">Your Display Name</label>
    <input id="f-creator-name" placeholder="e.g. Secret Mars">
    <label for="f-threshold">Approval Threshold (%) &mdash; default 51</label>
    <input id="f-threshold" type="number" value="51" min="1" max="100">
    <label for="f-spend">Spend Limit (sats) &mdash; 0 = unlimited</label>
    <input id="f-spend" type="number" value="0" min="0">
    <div class="form-actions">
      <button class="btn btn-primary" onclick="submitDAO()">Create DAO</button>
      <button class="btn btn-cancel" onclick="closeForm()">Cancel</button>
    </div>
    <div id="f-error" style="color:var(--red);font-size:12px;margin-top:8px;"></div>
  </div>
</div>

<script>
const API = '';

function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function truncAddr(a) { return a ? a.slice(0,8)+'...'+a.slice(-6) : '?'; }
function fmtSats(s) { return s ? s.toLocaleString()+' sats' : '0 sats'; }
function timeAgo(ts) {
  const m = Math.floor((Date.now()-new Date(ts).getTime())/60000);
  if (m<1) return 'just now'; if (m<60) return m+'m ago';
  const h = Math.floor(m/60); if (h<24) return h+'h ago';
  return Math.floor(h/24)+'d ago';
}

async function loadStats() {
  try {
    const r = await fetch(API+'/api/stats'); const d = await r.json();
    document.getElementById('s-daos').textContent = d.total_daos;
    document.getElementById('s-members').textContent = d.total_members;
    document.getElementById('s-treasury').textContent = fmtSats(d.total_treasury_sats);
    document.getElementById('s-proposals').textContent = d.total_proposals;
    document.getElementById('s-passed').textContent = d.passed_proposals;
    document.getElementById('s-votes').textContent = d.total_votes;
  } catch(e) { console.error(e); }
}

async function loadDAOs() {
  const el = document.getElementById('dao-list');
  document.getElementById('dao-detail').style.display='none';
  el.style.display='flex';
  try {
    const r = await fetch(API+'/api/daos'); const d = await r.json();
    if (!d.daos||!d.daos.length) { el.innerHTML='<div class="empty">No DAOs yet. Create the first one.</div>'; return; }
    el.innerHTML = d.daos.map(dao =>
      '<div class="card" onclick="loadDAO('+dao.id+')">'+
        '<div class="card-header">'+
          '<span class="card-title">'+esc(dao.name)+'</span>'+
          (dao.treasury_sats>0?'<span class="treasury">'+fmtSats(dao.treasury_sats)+'</span>':'')+
        '</div>'+
        '<div class="card-desc">'+esc(dao.description).slice(0,200)+'</div>'+
        '<div class="card-meta">'+
          '<span class="badge members">'+dao.member_count+' members</span>'+
          '<span class="badge proposals">'+dao.proposal_count+' proposals</span>'+
          '<span class="badge threshold">'+dao.approval_threshold+'% threshold</span>'+
          '<span>by '+(dao.creator_name||truncAddr(dao.creator))+'</span>'+
          '<span>'+timeAgo(dao.created_at)+'</span>'+
        '</div>'+
      '</div>'
    ).join('');
  } catch(e) { el.innerHTML='<div class="empty">Error loading DAOs</div>'; }
}

async function loadDAO(id) {
  document.getElementById('dao-list').style.display='none';
  const el = document.getElementById('dao-detail');
  el.style.display='block';
  try {
    const r = await fetch(API+'/api/daos/'+id); const d = await r.json();
    const dao = d.dao;
    el.innerHTML =
      '<div style="margin-bottom:16px;">'+
        '<button class="btn btn-cancel" onclick="loadDAOs()" style="margin-bottom:12px;">&larr; Back</button>'+
        '<h2 style="color:var(--accent);font-size:20px;">'+esc(dao.name)+'</h2>'+
        '<p style="color:var(--dim);font-size:13px;margin-top:4px;">'+esc(dao.description)+'</p>'+
        '<div class="card-meta" style="margin-top:8px;">'+
          '<span class="badge members">'+dao.member_count+' members</span>'+
          '<span class="badge proposals">'+dao.proposal_count+' proposals</span>'+
          '<span class="badge threshold">'+dao.approval_threshold+'% threshold</span>'+
          (dao.treasury_sats>0?'<span class="treasury">'+fmtSats(dao.treasury_sats)+'</span>':'')+
        '</div>'+
      '</div>'+
      '<h3 style="color:var(--text);font-size:14px;margin:16px 0 8px;">Members</h3>'+
      '<div class="cards">'+d.members.map(m =>
        '<div class="card" style="padding:10px 16px;cursor:default;">'+
          '<span style="color:var(--accent);">'+(m.display_name||truncAddr(m.btc_address))+'</span>'+
          '<span style="color:var(--dim);font-size:11px;margin-left:8px;">'+m.role+'</span>'+
          '<span style="color:var(--dim);font-size:11px;float:right;">'+timeAgo(m.joined_at)+'</span>'+
        '</div>'
      ).join('')+'</div>'+
      '<h3 style="color:var(--text);font-size:14px;margin:16px 0 8px;">Proposals</h3>'+
      (d.proposals.length?'<div class="cards">'+d.proposals.map(p =>
        '<div class="card" style="cursor:default;">'+
          '<div class="card-header">'+
            '<span class="card-title">'+esc(p.title)+'</span>'+
            '<span class="badge '+(p.status==='passed'?'members':p.status==='active'?'proposals':'threshold')+'">'+p.status+'</span>'+
          '</div>'+
          (p.description?'<div class="card-desc">'+esc(p.description)+'</div>':'')+
          '<div class="card-meta" style="margin-top:8px;">'+
            '<span style="color:var(--green);">'+p.votes_for+' yes</span>'+
            '<span style="color:var(--red);">'+p.votes_against+' no</span>'+
            (p.amount_sats?'<span>'+fmtSats(p.amount_sats)+'</span>':'')+
            '<span>'+timeAgo(p.created_at)+'</span>'+
          '</div>'+
        '</div>'
      ).join('')+'</div>':'<div class="empty" style="padding:24px;">No proposals yet.</div>')+
      '<h3 style="color:var(--text);font-size:14px;margin:16px 0 8px;">Activity</h3>'+
      '<div class="cards">'+d.activity.map(a =>
        '<div style="font-size:11px;color:var(--dim);padding:4px 0;">'+
          '<span style="color:var(--accent);">'+esc(a.action)+'</span> — '+esc(a.details)+' — '+timeAgo(a.created_at)+
        '</div>'
      ).join('')+'</div>';
  } catch(e) { el.innerHTML='<div class="empty">Error loading DAO</div>'; }
}

function openForm() {
  document.getElementById('create-form').classList.add('open');
  document.getElementById('f-name').focus();
}
function closeForm() {
  document.getElementById('create-form').classList.remove('open');
  document.getElementById('f-error').textContent='';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('create-form').classList.contains('open')) closeForm();
});

async function submitDAO() {
  const name = document.getElementById('f-name').value.trim();
  const desc = document.getElementById('f-desc').value.trim();
  const creator = document.getElementById('f-creator').value.trim();
  const creatorName = document.getElementById('f-creator-name').value.trim();
  const threshold = parseInt(document.getElementById('f-threshold').value)||51;
  const spend = parseInt(document.getElementById('f-spend').value)||0;

  if (!name||!desc||!creator) { document.getElementById('f-error').textContent='Fill in all required fields'; return; }

  try {
    const r = await fetch(API+'/api/daos', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name, description:desc, creator, creator_name:creatorName||undefined, approval_threshold:threshold, spend_limit_sats:spend})
    });
    const d = await r.json();
    if (!r.ok) { document.getElementById('f-error').textContent=d.error; return; }
    closeForm();
    loadStats(); loadDAOs();
  } catch(e) { document.getElementById('f-error').textContent='Network error'; }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    if (tab.dataset.view==='create') { openForm(); }
    else { loadDAOs(); }
  });
});

loadStats(); loadDAOs();
</script>
</body>
</html>`;
