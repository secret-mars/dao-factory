-- DAO Factory schema

CREATE TABLE IF NOT EXISTS daos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  creator TEXT NOT NULL,
  creator_name TEXT,
  approval_threshold INTEGER NOT NULL DEFAULT 51,
  spend_limit_sats INTEGER DEFAULT 0,
  treasury_sats INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 1,
  proposal_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL REFERENCES daos(id),
  btc_address TEXT NOT NULL,
  stx_address TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dao_id, btc_address)
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL REFERENCES daos(id),
  proposer TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  action_type TEXT NOT NULL DEFAULT 'general',
  amount_sats INTEGER DEFAULT 0,
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  votes_for INTEGER NOT NULL DEFAULT 0,
  votes_against INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  dao_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proposal_id, voter)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL REFERENCES daos(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_dao ON members(dao_id);
CREATE INDEX IF NOT EXISTS idx_members_addr ON members(btc_address);
CREATE INDEX IF NOT EXISTS idx_proposals_dao ON proposals(dao_id);
CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_activity_dao ON activity(dao_id);
