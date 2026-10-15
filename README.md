# CS Embed – Backend

Node.js + TypeScript service that indexes **Git repositories** and **uploaded documents** into
**Supabase Postgres (pgvector)** using **Azure OpenAI embeddings**, and answers questions with
**cited sources** using **gpt-4.1**.

## 1. Supabase setup (run once)

1. Supabase Dashboard → **SQL Editor** → **New query**.
2. Paste the whole of `src/data/migrations/001_init.sql` → **Run**.
3. (Optional) Run `src/data/migrations/002_verify.sql`. You should see `vector`, 5 tables with
   `rowsecurity = true`, the `hybrid_search` function, and the chunk indexes.

`999_reset_DANGER.sql` drops everything. Use it only in development.

> `vector(1536)` in the SQL must match `EMBEDDING_DIMENSIONS` (text-embedding-3-small = 1536).

## 2. Configure

Copy `.env.example` to `.env` (a `.env` is already provided) and check:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Full Supabase connection string, **including password and host** (Project Settings → Database → Connection string → URI) |
| `PGSSL` | `true` for Supabase. Set `PG_SSL_CA_PATH` to Supabase's CA cert for full certificate verification |
| `AZURE_OPENAI_ENDPOINT` | v1 base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_*_DEPLOYMENT` | Deployment names (not model names) |
| `CORS_ORIGIN` | Your React dev URL(s), comma-separated |

## 3. Run

Requires Node 20+ and **git** installed on the machine (used for cloning repos).

```bash
npm install
npm run dev        # development (auto-reload)
npm run build && npm start   # production
```

API base: `http://localhost:4000/api`

## 4. API (for the React app)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server + DB check |
| POST | `/api/sources/git` | Index a Git repo |
| POST | `/api/sources/upload` | Upload files or a folder (multipart) |
| POST | `/api/sources/:id/sync` | Re-sync a Git repo (only changed files) |
| GET | `/api/sources` | List indexed sources |
| GET | `/api/sources/:id` | Source details + latest job |
| DELETE | `/api/sources/:id` | Remove a source and all its chunks |
| GET | `/api/jobs/:id` | Indexing progress (poll every 1–2 s) |
| POST | `/api/query` | Ask a question |

### Index a Git repo

```http
POST /api/sources/git
{ "repoUrl": "https://github.com/org/repo", "branch": "main", "token": "github_pat_..." }
```

- `branch` optional (default branch is used), `token` optional for public repos.
- Response `202` → `{ status: "queued", source, job }`. Poll `GET /api/jobs/{job.id}`.
- Same commit already indexed → `200 { status: "up_to_date" }`. Already indexing → `already_running`.
- The **token is never stored** or logged; it is used in memory for that request/job only.
  Re-sync of a private repo therefore needs the token again.

### Upload files / a folder

`multipart/form-data`, field **`files`** (repeat per file). Optional fields:
`name` (collection name – re-uploading with the same name updates it) and
`mode` = `merge` (default, add/update) or `replace` (also removes files not in this upload).

For folder uploads keep the relative path as the file name:

```ts
const fd = new FormData();
for (const file of input.files) fd.append("files", file, file.webkitRelativePath || file.name);
fd.append("name", "KT Docs");
await fetch(`${API}/sources/upload`, { method: "POST", body: fd });
```

The response includes `skipped` (unsupported, too large, or secret files such as `.env`).

### Ask a question

```http
POST /api/query
{ "question": "How is member eligibility validated?", "sourceIds": ["<optional uuid>"], "topK": 8 }
```

Response:

```json
{
  "answer": "… [1] …",
  "sources": [
    { "ref": 1, "sourceName": "org/repo@main", "path": "src/validator.ts",
      "startLine": 10, "endLine": 42, "url": "https://github.com/…#L10-L42",
      "score": 0.03, "snippet": "…" }
  ]
}
```

`[n]` in the answer refers to `sources[n-1].ref`.

Errors always look like `{ "error": { "code": "...", "message": "..." } }`.

## 5. How it works

```
Git repo / upload ─► filter (ignore rules, secrets, size) ─► file hash changed? ── no ─► skip
                                                               │ yes
                                                               ▼
                        parse (text, PDF, DOCX, XLSX, CSV) ─► chunk (per content type)
                                                               ▼
                    chunk text hash in embedding cache? ── yes ─► reuse vector
                                                               │ no
                                                               ▼
                              Azure OpenAI embeddings (batched) ─► upsert by stable chunk ID
Question ─► embed ─► hybrid search (vector + full-text, RRF) ─► gpt-4.1 answer with citations
```

**Duplicate handling**

- Repo: `git:<host>/<owner>/<repo>@<branch>` key + latest commit SHA (`git ls-remote`, no clone).
- Upload: collection name, or a manifest hash of all file hashes when no name is given.
- File: SHA-256 of the file → unchanged files are skipped.
- Chunk: SHA-256 of the text → only new/changed chunks are embedded (embedding cache).
- Stable chunk IDs + upserts → re-indexing never creates duplicate rows.

**Chunking profiles** (tokens, in `src/config.ts`; bump `chunking.version` after changing them):

| Content | Splitter | Size | Overlap |
|---|---|---|---|
| Code (`.ts .js .py .java .cs .go …`) | LangChain recursive, language-aware | 800 | 0 |
| Markdown / RST | LangChain markdown | 512 | 64 |
| TXT / PDF (per page) / DOCX | LangChain recursive | 512 | 96 |
| XLSX (per sheet) / CSV | Row groups, header repeated | 1000 | 0 |

## 6. Folder structure

```
src/
  app.ts, server.ts, config.ts, db.ts, types.ts
  controllers/   HTTP handlers (validation with zod)
  routes/        Route table
  services/      Business logic (sources, query)
  pipeline/      Git fetch, file filtering, parsers, chunker, indexer, job queue
  repository/    SQL access (sources, documents, chunks, jobs)
  llm/           Azure OpenAI client, embeddings, chat, prompts
  middleware/    Errors, uploads, rate limiting
  utils/         Hashing, tokens, logging (with secret redaction), URL validation
  data/migrations/  SQL to run in Supabase
```

## 7. Known limitations (v1)

- **No user authentication yet.** Anyone who can reach the API can query all sources. Add auth
  (e.g. Supabase Auth or Entra ID) and per-user source access before exposing it beyond your machine.
- Jobs run **in-process** (one at a time). A restart marks running jobs as failed; re-run them.
  For multiple instances use a durable queue (BullMQ/Redis or Azure Service Bus).
- Scanned PDFs (images) have no text layer; add OCR (Azure AI Document Intelligence) if needed.
- PowerPoint is not supported yet (`officeparser` can be added in `pipeline/parsers.ts`).
- Content is sent to Azure OpenAI for embedding/answers. Do not index data (e.g. PHI) unless your
  organisation's policy allows it for this Azure OpenAI deployment.
