drop function if exists public.hybrid_search(extensions.vector, text, integer, uuid[], integer);
drop table if exists public.jobs cascade;
drop table if exists public.chunks cascade;
drop table if exists public.embedding_cache cascade;
drop table if exists public.documents cascade;
drop table if exists public.sources cascade;
drop function if exists public.set_updated_at();
