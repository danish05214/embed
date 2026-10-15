-- =====================================================================
-- CS Embed -- initial schema for Supabase (Postgres + pgvector)
-- Run once in: Supabase Dashboard > SQL Editor > New query > paste > Run
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
--
-- IMPORTANT: vector(1536) must match EMBEDDING_DIMENSIONS in .env
-- (text-embedding-3-small = 1536, text-embedding-3-large = 3072 or reduced).
-- =====================================================================

-- 1. Extensions --------------------------------------------------------
create extension if not exists vector with schema extensions;  -- pgvector
-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+), no extra extension needed.

-- 2. Shared updated_at trigger ----------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 3. Sources: one row per Git repo+branch or per upload collection -------
create table if not exists public.sources (
  id               uuid primary key default gen_random_uuid(),
  source_key       text not null unique,          -- e.g. git:github.com/org/repo@main | upload:my-docs
  type             text not null check (type in ('git', 'upload')),
  name             text not null,
  repo_url         text,                          -- clean URL, never contains credentials
  branch           text,
  last_commit_sha  text,                          -- last indexed commit (git)
  manifest_hash    text,                          -- hash of path+file-hash list (uploads)
  status           text not null default 'pending'
                   check (status in ('pending', 'indexing', 'ready', 'failed')),
  error            text,
  file_count       integer not null default 0,
  chunk_count      integer not null default 0,
  last_indexed_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists trg_sources_updated_at on public.sources;
create trigger trg_sources_updated_at before update on public.sources
  for each row execute function public.set_updated_at();

-- 4. Documents: one row per file inside a source ----------------------
create table if not exists public.documents (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references public.sources(id) on delete cascade,
  path              text not null,                -- relative path, used for citations
  file_hash         text not null,                -- SHA-256 of file bytes
  file_type         text not null,                -- extension, e.g. ts, pdf, docx
  size_bytes        bigint not null default 0,
  chunk_count       integer not null default 0,
  chunking_version  integer not null default 1,   -- bump to force re-chunking
  embedding_model   text,
  status            text not null default 'indexed'
                    check (status in ('indexed', 'failed', 'empty')),
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_id, path)
);

create index if not exists idx_documents_source on public.documents(source_id);

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at before update on public.documents
  for each row execute function public.set_updated_at();

-- 5. Chunks: the searchable units with their embeddings ----------------
create table if not exists public.chunks (
  id               text primary key,              -- stable ID: sha256(document_id:chunk_hash:occurrence)
  document_id      uuid not null references public.documents(id) on delete cascade,
  source_id        uuid not null references public.sources(id) on delete cascade,
  chunk_index      integer not null,
  chunk_hash       text not null,                 -- SHA-256 of normalised chunk text
  embed_hash       text not null,                 -- SHA-256 of text sent to the embedding model
  content          text not null,
  metadata         jsonb not null default '{}'::jsonb,  -- kind, language, label, startLine, endLine
  token_count      integer not null default 0,
  embedding        extensions.vector(1536) not null,
  embedding_model  text not null,
  fts              tsvector generated always as (to_tsvector('english', content)) stored,
  created_at       timestamptz not null default now()
);

create index if not exists idx_chunks_source   on public.chunks(source_id);
create index if not exists idx_chunks_document on public.chunks(document_id);
create index if not exists idx_chunks_fts      on public.chunks using gin(fts);
-- Approximate nearest-neighbour index for cosine similarity
create index if not exists idx_chunks_embedding on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- 6. Embedding cache: reuse vectors for identical text across files/sources
create table if not exists public.embedding_cache (
  embed_hash   text not null,
  model        text not null,
  embedding    extensions.vector(1536) not null,
  created_at   timestamptz not null default now(),
  primary key (embed_hash, model)
);

-- 7. Jobs: background indexing progress --------------------------------
create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references public.sources(id) on delete cascade,
  kind         text not null check (kind in ('git_sync', 'upload')),
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'succeeded', 'failed')),
  progress     jsonb not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create index if not exists idx_jobs_source on public.jobs(source_id, created_at desc);

-- 8. Hybrid search: vector similarity + full-text, merged with Reciprocal Rank Fusion
create or replace function public.hybrid_search(
  query_embedding extensions.vector(1536),
  query_text      text,
  match_count     integer default 8,
  filter_source_ids uuid[] default null,
  rrf_k           integer default 60
)
returns table (
  chunk_id          text,
  source_id         uuid,
  source_name       text,
  source_type       text,
  repo_url          text,
  branch            text,
  commit_sha        text,
  document_id       uuid,
  path              text,
  content           text,
  metadata          jsonb,
  score             double precision,
  vector_similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  -- Inner ORDER BY ... LIMIT lets Postgres use the HNSW index; ranks are numbered afterwards.
  with vec as (
    select t.id, 1 - t.dist as sim, row_number() over (order by t.dist) as rnk
    from (
      select c.id, c.embedding <=> query_embedding as dist
      from public.chunks c
      where filter_source_ids is null or c.source_id = any(filter_source_ids)
      order by c.embedding <=> query_embedding
      limit match_count * 4
    ) t
  ),
  kw as (
    select t.id, row_number() over (order by t.rank desc) as rnk
    from (
      select c.id, ts_rank_cd(c.fts, q) as rank
      from public.chunks c,
           websearch_to_tsquery('english', coalesce(query_text, '')) q
      where c.fts @@ q
        and (filter_source_ids is null or c.source_id = any(filter_source_ids))
      order by rank desc
      limit match_count * 4
    ) t
  ),
  fused as (
    select coalesce(vec.id, kw.id) as id,
           coalesce(1.0 / (rrf_k + vec.rnk), 0) + coalesce(1.0 / (rrf_k + kw.rnk), 0) as score,
           vec.sim
    from vec
    full outer join kw on vec.id = kw.id
  )
  select c.id, s.id, s.name, s.type, s.repo_url, s.branch, s.last_commit_sha,
         d.id, d.path, c.content, c.metadata,
         f.score::double precision, f.sim::double precision
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  join public.sources s   on s.id = c.source_id
  order by f.score desc
  limit match_count;
$$;

-- 9. Security --------------------------------------------------------
-- The backend connects with the database role directly (bypasses RLS).
-- Enabling RLS with NO policies blocks access through Supabase's public
-- REST API (anon / authenticated keys), so data is only reachable via this backend.
alter table public.sources         enable row level security;
alter table public.documents       enable row level security;
alter table public.chunks          enable row level security;
alter table public.embedding_cache enable row level security;
alter table public.jobs            enable row level security;

revoke all on public.sources, public.documents, public.chunks, public.embedding_cache, public.jobs
  from anon, authenticated;
revoke execute on function public.hybrid_search(extensions.vector, text, integer, uuid[], integer)
  from public, anon, authenticated;
