-- Credit score snapshots for tenant transparency

CREATE TABLE IF NOT EXISTS credit_score_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  band TEXT NOT NULL CHECK (band IN ('poor', 'fair', 'good', 'excellent')),
  factors JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_score_snapshots_user_id_computed_at
  ON credit_score_snapshots(user_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_score_snapshots_computed_at
  ON credit_score_snapshots(computed_at DESC);

COMMENT ON TABLE credit_score_snapshots IS 'Latest and historical tenant credit score snapshots';
COMMENT ON COLUMN credit_score_snapshots.factors IS 'JSONB array of factor evaluations { name, status, weight, detail }';