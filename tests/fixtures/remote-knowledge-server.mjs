/**
 * Minimal zero-dependency mock of an external "remote knowledge service".
 *
 * Implements the wire contract documented in `docs/remote-knowledge-service-api.md`:
 *   GET  /v1/health
 *   GET  /v1/knowledge/bases
 *   POST /v1/knowledge/search
 *   POST /v1/knowledge/read
 * plus the shared error model {"error":{"code","message"}}.
 *
 * Usage (manual end-to-end smoke test):
 *   node tests/fixtures/remote-knowledge-server.mjs
 * then configure the app's remote-knowledge settings with
 *   http://127.0.0.1:24390
 *
 * Environment:
 *   PORT        listen port; default 24390 (avoids 24333/19790), 0 = pick a free
 *               port and print the actual one on stdout.
 *   AUTH_TOKEN  when set, requests must send `Authorization: Bearer <token>`;
 *               mismatches get 401 unauthorized.
 *   ?delay=ms   any request with this query param sleeps that long before
 *               answering (timeout testing).
 */
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 24390)
const AUTH_TOKEN = process.env.AUTH_TOKEN

// In-memory corpus: 3 bases / 6 chunks. `text` is split on `\f` (form feed) into
// read-pages so kb_read can demonstrate pagination (total_chars/truncated).
const BASES = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    description: 'Onboarding guides',
    documents: [
      {
        document_id: 'doc-quickstart',
        title: 'Quickstart',
        pages: [
          'Welcome to the mock remote knowledge service.\fThis corpus exists so the desktop client can be exercised end to end without a real backend.',
          'Step one: configure this service in settings.\fStep two: pick a base in the composer.\fStep three: ask a question and get citations.'
        ]
      }
    ]
  },
  {
    id: 'recipes',
    name: 'Recipes',
    description: 'Cooking recipes',
    documents: [
      {
        document_id: 'doc-pancakes',
        title: 'Pancakes',
        pages: ['Mix flour, eggs and milk.\fCook on medium heat until bubbles form.\fFlip once and serve with syrup.']
      },
      {
        document_id: 'doc-ramen',
        title: 'Ramen',
        pages: ['Simmer broth for at least four hours.\fCook noodles separately and combine just before serving.']
      }
    ]
  },
  {
    id: 'faq',
    name: 'FAQ',
    description: 'Frequently asked questions',
    documents: [
      {
        document_id: 'doc-limits',
        title: 'Limits',
        pages: [
          'Search accepts at most 32 base ids and 50 results per call.\fScores are normalized to [0,1].'
        ]
      },
      {
        document_id: 'doc-auth',
        title: 'Authentication',
        pages: ['Send either Authorization: Bearer <token> or X-API-Key: <key>. Only one is required.']
      }
    ]
  }
]

const CHUNKS = BASES.flatMap((base) =>
  base.documents.flatMap((doc) =>
    doc.pages.flatMap((pageText, pageIndex) =>
      pageText.split('\f').map((chunkText, chunkIndex) => ({
        chunk_id: `${doc.document_id}-p${pageIndex}-c${chunkIndex}`,
        base_id: base.id,
        document_id: doc.document_id,
        title: doc.title,
        content: chunkText,
        keywords: chunkText.toLowerCase()
      }))
    )
  )
)

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}

function authorize(req, res) {
  if (!AUTH_TOKEN) return true
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${AUTH_TOKEN}`) return true
  sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token')
  return false
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1)
}

// Deterministic keyword scoring normalized to [0,1]: overlap ratio of query
// terms found in the chunk, falling back to a small base score for empty queries.
function scoreChunk(queryTokens, chunk) {
  if (queryTokens.length === 0) return 0.1
  const hits = queryTokens.filter((token) => chunk.keywords.includes(token)).length
  return hits === 0 ? 0 : Number((hits / queryTokens.length).toFixed(4))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  // Delay before answering: `?delay=ms` on any request, or an `X-Test-Delay`
  // header (handy when the delay must not leak into URL building on the client).
  const delayMs = Number(url.searchParams.get('delay') ?? req.headers['x-test-delay'] ?? 0)
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  if (!authorize(req, res)) return

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return sendJson(res, 200, { status: 'ok' })
  }

  if (req.method === 'GET' && url.pathname === '/v1/knowledge/bases') {
    return sendJson(res, 200, {
      bases: BASES.map(({ id, name, description }) => ({ id, name, description }))
    })
  }

  if (req.method === 'POST' && url.pathname === '/v1/knowledge/search') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendError(res, 400, 'invalid_request', 'Body must be valid JSON')
    }

    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const baseIds = Array.isArray(body.base_ids) ? body.base_ids : null
    const topK = typeof body.top_k === 'number' ? Math.floor(body.top_k) : 8

    if (!query) return sendError(res, 400, 'invalid_request', 'query is required')
    if (!baseIds || baseIds.length === 0 || baseIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return sendError(res, 400, 'invalid_request', 'base_ids must be a non-empty array of strings')
    }
    if (baseIds.length > 32) return sendError(res, 400, 'invalid_request', 'base_ids accepts at most 32 ids')
    if (topK > 50) return sendError(res, 400, 'invalid_request', 'top_k accepts at most 50')

    const unknownBase = baseIds.find((id) => !BASES.some((base) => base.id === id))
    if (unknownBase) return sendError(res, 404, 'not_found', `Unknown base_id: ${unknownBase}`)

    const queryTokens = tokenize(query)
    const chunks = CHUNKS.filter((chunk) => baseIds.includes(chunk.base_id))
      .map((chunk) => ({ ...chunk, score: scoreChunk(queryTokens, chunk) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
      .slice(0, topK)
      .map(({ chunk_id, base_id, document_id, title, content, score }) => ({
        chunk_id,
        base_id,
        document_id,
        title,
        content,
        score
      }))

    return sendJson(res, 200, { chunks })
  }

  if (req.method === 'POST' && url.pathname === '/v1/knowledge/read') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendError(res, 400, 'invalid_request', 'Body must be valid JSON')
    }

    const { base_id: baseId, document_id: documentId, chunk_id: chunkId } = body ?? {}
    if (typeof baseId !== 'string' || typeof documentId !== 'string') {
      return sendError(res, 400, 'invalid_request', 'base_id and document_id are required')
    }

    const base = BASES.find((candidate) => candidate.id === baseId)
    const doc = base?.documents.find((candidate) => candidate.document_id === documentId)
    if (!base || !doc) return sendError(res, 404, 'not_found', `Unknown document: ${baseId}/${documentId}`)

    // Full-document read (all pages joined); a `p<N>-c<M>` chunk_id narrows to
    // the split that carries its index (chunks are emitted in split order).
    const content = doc.pages.join('\f')
    const parts = content.split('\f')
    const index = chunkId ? Number(chunkId.split('-c').pop()) : NaN
    const finalContent = Number.isInteger(index) && parts[index] ? parts[index] : content
    const totalChars = content.length

    return sendJson(res, 200, {
      document_id: doc.document_id,
      title: doc.title,
      content: finalContent,
      total_chars: totalChars,
      truncated: finalContent.length < totalChars
    })
  }

  return sendError(res, 404, 'not_found', `No route: ${req.method} ${url.pathname}`)
})

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : PORT
  console.log(`remote-knowledge mock server listening on http://127.0.0.1:${actualPort}`)
  if (AUTH_TOKEN) console.log('auth: bearer token required (AUTH_TOKEN)')
})
