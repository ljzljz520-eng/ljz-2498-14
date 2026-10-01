-- Event-sourced review threads for the Catalpa document service.
-- PostgreSQL 14+; JSONB stores node ranges, contexts, and provenance without
-- forcing a rigid shape across document model migrations.

CREATE TABLE IF NOT EXISTS documents (
  document_id UUID PRIMARY KEY,
  current_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  author_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  baseline_version BIGINT,
  merge_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version),
  UNIQUE (document_id, content_hash)
);

CREATE TABLE IF NOT EXISTS review_threads (
  thread_id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  review_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'needs_review', 'candidate', 'detached', 'conflict')),
  current_anchor JSONB,
  pending_relocation JSONB,
  resolved_content_hash TEXT,
  anchor_epoch INTEGER NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_threads_document ON review_threads(document_id, status);

-- Every reply/resolve/reopen/migration/conflict is an immutable fact. Current
-- thread state is a projection, never a row that overwrites history.
CREATE TABLE IF NOT EXISTS review_events (
  event_id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES review_threads(thread_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'thread.created', 'thread.reply', 'thread.resolved', 'thread.reopened',
      'review.requested', 'anchor.migrated', 'anchor.candidate',
      'anchor.attached', 'anchor.detached', 'thread.concurrent-conflict'
    )
  ),
  actor_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- Source-anchored payload: source range, split node ranges, exact quote,
  -- normalized quote, surrounding context and original document baseline.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  clock JSONB NOT NULL,
  parent_event_id UUID REFERENCES review_events(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_events_thread_time
  ON review_events(thread_id, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_review_events_clock
  ON review_events USING GIN (clock jsonb_path_ops);

CREATE TABLE IF NOT EXISTS anchor_candidates (
  candidate_id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES review_threads(thread_id) ON DELETE CASCADE,
  from_version BIGINT NOT NULL,
  to_version BIGINT NOT NULL,
  source_range JSONB NOT NULL,
  node_ranges JSONB NOT NULL,
  quote TEXT NOT NULL,
  locator_source TEXT NOT NULL CHECK (
    locator_source IN ('version-diff-exact', 'version-diff-partial', 'quote-exact', 'quote-fuzzy', 'block-move', 'manual')
  ),
  confidence NUMERIC(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision TEXT NOT NULL DEFAULT 'proposed' CHECK (decision IN ('proposed', 'accepted', 'rejected', 'auto_accepted')),
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_anchor_candidates_thread
  ON anchor_candidates(thread_id, to_version, confidence DESC);

CREATE TABLE IF NOT EXISTS offline_operations (
  operation_id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  baseline_version BIGINT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('document_edit', 'review_event')),
  payload JSONB NOT NULL,
  vector_clock JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_offline_operations_unsynced
  ON offline_operations(document_id, actor_id, created_at)
  WHERE synced_at IS NULL;
