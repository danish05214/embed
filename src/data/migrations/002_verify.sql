-- Optional: run after 001_init.sql and 003_branch_dedup.sql to confirm the setup.
-- Expect: pgvector row, 6 tables, hybrid_search function, RLS = true on every table.

select extname, extversion from pg_extension where extname in ('vector', 'pgcrypto');

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('sources', 'documents', 'source_documents', 'chunks', 'embedding_cache', 'jobs')
order by tablename;

select proname from pg_proc where proname = 'hybrid_search';

select indexname from pg_indexes where tablename = 'chunks' order by indexname;
