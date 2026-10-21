begin;

-- 1. Scope key on sources: git:<host>/<owner>/<repo> for Git (branch removed), source_key for uploads
alter table public.sources add column if not exists scope_key text;
update public.sources
   set scope_key = case when type = 'git'
                        then regexp_replace(source_key, '@[^@]*$', '')
                        else source_key end
 where scope_key is null;
alter table public.sources alter column scope_key set not null;
create index if not exists idx_sources_scope on public.sources(scope_key);

-- 2. Membership: which source (branch / upload collection) contains which document version
create table if not exists public.source_documents (
  source_id    uuid not null references public.sources(id) on delete cascade,
  -- RESTRICT: a document still used by any branch can never be deleted by the orphan clean-up
  document_id  uuid not null references public.documents(id) on delete restrict,
  path         text not null,                  -- same as documents.path; kept for fast per-source lookups
  created_at   timestamptz not null default now(),
  primary key (source_id, path)
);
create index if not exists idx_source_documents_document on public.source_documents(document_id);

-- 3. Move existing rows to the new layout (only while documents.source_id still exists)
alter table public.documents add column if not exists scope_key text;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documents' and column_name = 'source_id') then

    update public.documents d
       set scope_key = s.scope_key
      from public.sources s
     where s.id = d.source_id and d.scope_key is null;

    insert into public.source_documents (source_id, document_id, path)
    select d.source_id, d.id, d.path from public.documents d
    on conflict (source_id, path) do nothing;

    -- Merge identical document versions inside a scope (same path + file hash + settings).
    -- Keep one (prefer a non-failed one), point every branch to it, delete the rest (chunks cascade).
    create temporary table doc_keep on commit drop as
    select id,
           first_value(id) over (
             partition by scope_key, path, file_hash, chunking_version, coalesce(embedding_model, '')
             order by (status = 'failed'), created_at, id) as keeper
      from public.documents;

    update public.source_documents sd
       set document_id = k.keeper
      from doc_keep k
     where sd.document_id = k.id and k.id <> k.keeper;

    delete from public.documents d
     using doc_keep k
     where d.id = k.id and k.id <> k.keeper;

    -- Dropping the column also drops unique(source_id, path) and idx_documents_source.
    alter table public.documents drop column source_id;
  end if;
end;
$$;

alter table public.documents alter column scope_key set not null;

-- One row per document version inside a scope
create unique index if not exists uq_documents_version on public.documents
  (scope_key, path, file_hash, chunking_version, embedding_model) nulls not distinct;
create index if not exists idx_documents_scope on public.documents(scope_key);

-- 4. Chunks belong to a (shared) document only; the source comes from source_documents.
--    Must drop the old search function first: it references chunks.source_id.
drop function if exists public.hybrid_search(extensions.vector, text, integer, uuid[], integer);
alter table public.chunks drop column if exists source_id;   -- also drops idx_chunks_source

-- 5. Hybrid search: vector + full-text (RRF), one row per chunk, with the branches it appears in.
--    `filter_source_ids` limits the search to those sources (e.g. one branch); null = all sources.
create or replace function public.hybrid_search(
  query_embedding   extensions.vector(1536),
  query_text        text,
  match_count       integer default 8,
  filter_source_ids uuid[] default null,
  rrf_k             integer default 60
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
  vector_similarity double precision,
  branches          text[],
  source_ids        uuid[]
)
language sql
stable
set search_path = public, extensions
as $$
  with allowed as (
    select distinct sd.document_id
    from public.source_documents sd
    where filter_source_ids is null or sd.source_id = any(filter_source_ids)
  ),
  vec as (
    select t.id, 1 - t.dist as sim, row_number() over (order by t.dist) as rnk
    from (
      select c.id, c.embedding <=> query_embedding as dist
      from public.chunks c
      where c.document_id in (select a.document_id from allowed a)
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
        and c.document_id in (select a.document_id from allowed a)
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
  ),
  top_hits as (
    select f.id, f.score, f.sim
    from fused f
    order by f.score desc
    limit match_count
  )
  select c.id, rep.id, rep.name, rep.type, rep.repo_url, rep.branch, rep.last_commit_sha,
         d.id, d.path, c.content, c.metadata,
         t.score::double precision, t.sim::double precision,
         tags.branches, tags.source_ids
  from top_hits t
  join public.chunks c    on c.id = t.id
  join public.documents d on d.id = c.document_id
  -- Representative source for the label/deep link: prefer main/master, then the latest indexed.
  -- Any member is correct for the link: every member has this exact file version.
  cross join lateral (
    select s.id, s.name, s.type, s.repo_url, s.branch, s.last_commit_sha
    from public.source_documents sd
    join public.sources s on s.id = sd.source_id
    where sd.document_id = d.id
      and (filter_source_ids is null or s.id = any(filter_source_ids))
    order by (s.branch in ('main', 'master')) desc nulls last, s.last_indexed_at desc nulls last, s.id
    limit 1
  ) rep
  cross join lateral (
    select coalesce(array_agg(s.branch order by s.branch) filter (where s.branch is not null), '{}') as branches,
           array_agg(s.id order by s.branch nulls last, s.id) as source_ids
    from public.source_documents sd
    join public.sources s on s.id = sd.source_id
    where sd.document_id = d.id
      and (filter_source_ids is null or s.id = any(filter_source_ids))
  ) tags
  order by t.score desc;
$$;

-- 6. Security (same model as 001: backend role only)
alter table public.source_documents enable row level security;
revoke all on public.source_documents from anon, authenticated;
revoke execute on function public.hybrid_search(extensions.vector, text, integer, uuid[], integer)
  from public, anon, authenticated;

commit;
