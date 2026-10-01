-- Event-sourced document review threads.
-- Threads are projections; review_thread_events is the source of truth.

CREATE TABLE IF NOT EXISTS document_revisions (
  document_id       uuid NOT NULL,
  revision          bigint NOT NULL,
  parent_revision   bigint,
  content_hash      text NOT NULL,
  content           text NOT NULL,
  merged_from_base  bigint,
  merged_from_local bigint,
  merged_from_head  bigint,
  merge_conflicts   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision),
  FOREIGN KEY (document_id, parent_revision)
    REFERENCES document_revisions(document_id, revision),
  CONSTRAINT revision_parent_chain CHECK (
    parent_revision IS NULL OR parent_revision = revision - 1
  )
);

CREATE TABLE IF NOT EXISTS review_threads (
  document_id        uuid NOT NULL,
  thread_id          uuid NOT NULL,
  current_status     text NOT NULL CHECK (
                       current_status IN ('open','resolved','dangling','status-conflict')
                     ),
  current_anchor     jsonb,
  original_anchor    jsonb,
  quote              text NOT NULL,
  latest_revision    bigint NOT NULL,
  anchor_schema_version integer NOT NULL DEFAULT 2,
  anchor_migrated_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, thread_id),
  FOREIGN KEY (document_id, latest_revision)
    REFERENCES document_revisions(document_id, revision)
);

CREATE TABLE IF NOT EXISTS review_thread_events (
  event_id             uuid NOT NULL PRIMARY KEY,
  document_id          uuid NOT NULL,
  thread_id            uuid NOT NULL,
  seq                  bigint NOT NULL,
  client_event_id      uuid NOT NULL,
  actor_id             text NOT NULL,
  type                 text NOT NULL CHECK (type IN (
                         'thread.created',
                         'thread.replied',
                         'thread.resolved',
                         'thread.reopened',
                         'thread.review_requested',
                         'thread.anchor_migrated',
                         'thread.anchor_dangling',
                         'thread.anchor_reanchored',
                         'thread.status_conflict'
                       )),
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_revision        bigint,
  revision             bigint NOT NULL,
  provisional          boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, thread_id, seq),
  UNIQUE (document_id, client_event_id),
  FOREIGN KEY (document_id, thread_id)
    REFERENCES review_threads(document_id, thread_id),
  FOREIGN KEY (document_id, revision)
    REFERENCES document_revisions(document_id, revision)
);

CREATE INDEX IF NOT EXISTS review_events_thread_time
  ON review_thread_events(document_id, thread_id, seq, created_at);
CREATE INDEX IF NOT EXISTS review_threads_status
  ON review_threads(document_id, current_status);

-- Anchor payload shape:
-- {
--   "schemaVersion": 2,
--   "baselineRevision": 7,
--   "ranges": [
--     {"start": 102, "end": 128, "startOffset": 90, "endOffset": 180, "text": "..."}
--   ],
--   "nodeRanges": [
--     {"nodePath":["paragraph",3],"start":12,"end":38,"text":"..."}
--   ],
--   "quote": "visible selected text",
--   "context": {"before": "...", "after": "..."}
-- }

CREATE TABLE IF NOT EXISTS review_anchor_candidates (
  document_id      uuid NOT NULL,
  thread_id        uuid NOT NULL,
  candidate_number integer NOT NULL,
  event_id         uuid,
  source           text NOT NULL,
  confidence       numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  auto_accepted    boolean NOT NULL DEFAULT false,
  note             text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_anchor  jsonb NOT NULL,
  decided_at       timestamptz,
  decided_by       text,
  decision         text CHECK (decision IN ('accepted','rejected')),
  PRIMARY KEY (document_id, thread_id, candidate_number),
  FOREIGN KEY (document_id, thread_id)
    REFERENCES review_threads(document_id, thread_id),
  FOREIGN KEY (event_id) REFERENCES review_thread_events(event_id)
);

-- Historical resolution records are retained even when a rewritten paragraph is
-- later reopened or sent back for review.
CREATE TABLE IF NOT EXISTS review_resolutions (
  document_id        uuid NOT NULL,
  thread_id          uuid NOT NULL,
  resolution_id      uuid NOT NULL,
  event_id           uuid NOT NULL,
  anchor_fingerprint text NOT NULL,
  quote              text NOT NULL,
  note               text NOT NULL DEFAULT '',
  resolved_by        text NOT NULL,
  resolved_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz,
  PRIMARY KEY (document_id, thread_id, resolution_id),
  FOREIGN KEY (event_id) REFERENCES review_thread_events(event_id)
);

CREATE INDEX IF NOT EXISTS review_resolutions_thread
  ON review_resolutions(document_id, thread_id, resolved_at DESC);

-- Server-side append contract.  The trigger assigns a per-thread sequence and
-- must reject a client attempting to attach pre-v2 coordinates after migration.
CREATE OR REPLACE FUNCTION review_event_append_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.provisional
     AND NEW.type IN ('thread.anchor_migrated', 'thread.anchor_reanchored')
     AND COALESCE(NEW.payload->'anchor'->>'schemaVersion', '1')::integer < 2 THEN
    RAISE EXCEPTION 'stale client cannot force a pre-v2 anchor after migration';
  END IF;

  IF NEW.provisional
     AND NEW.type = 'thread.anchor_reanchored'
     AND EXISTS (
       SELECT 1
       FROM review_threads t
       WHERE t.document_id = NEW.document_id
         AND t.thread_id = NEW.thread_id
         AND t.anchor_migrated_at IS NOT NULL
         AND COALESCE(t.current_anchor->>'schemaVersion', '1')::integer >= 2
     ) THEN
    RAISE EXCEPTION 'stale client cannot replace a server-migrated v2 anchor';
  END IF;

  NEW.seq := COALESCE(
    NEW.seq,
    (SELECT count(*) + 1
       FROM review_thread_events
      WHERE document_id = NEW.document_id AND thread_id = NEW.thread_id)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_event_append_guard ON review_thread_events;
CREATE TRIGGER trg_review_event_append_guard
BEFORE INSERT ON review_thread_events
FOR EACH ROW EXECUTE FUNCTION review_event_append_guard();
