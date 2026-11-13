require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // local only: nobody else on the venue wifi can spend your API credits
const MAX_PROMPT_CHARS = 20000;
const JSON_KINDS = new Set(['gate', 'extract', 'brief']);

const SYSTEM = {
  json: 'Output ONLY a single raw JSON object. No markdown, no backticks, no commentary.',
  text: 'Write only the next SMS text message for the persona described in the user message. 1 to 2 short sentences. No quotation marks and no speaker labels.'
};

// Prefer the explicit `kind` from the page; fall back to sniffing the prompt for older clients.
function kindOf(body) {
  if (['gate', 'extract', 'brief', 'dorothy'].includes(body.kind)) return body.kind;
  const p = body.prompt;
  if (p.includes('scam-triage classifier')) return 'gate';
  if (p.includes('extraction tool')) return 'extract';
  if (p.includes('fraud analyst assistant')) return 'brief';
  return 'dorothy';
}

// Join every text block. Newer models can put a thinking block first, so content[0].text is not safe.
function textOf(response) {
  return (response.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text || '')
    .join('')
    .trim();
}

function jsonOf(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : cleaned;
  try { JSON.parse(candidate); return candidate; } catch { return null; }
}

class ChatError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}

async function callClaude(client, kind, prompt) {
  const wantsJson = JSON_KINDS.has(kind);
  let last = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: attempt === 1 ? 1024 : 2048,
      system: wantsJson ? SYSTEM.json : SYSTEM.text,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = textOf(response);
    const blocks = (response.content || []).map(b => b.type).join(',') || 'none';
    last = { stop_reason: response.stop_reason, blocks };
    console.log(`[${kind}] attempt ${attempt} stop=${response.stop_reason} blocks=${blocks} chars=${text.length}`);
    if (response.stop_reason === 'refusal') throw new ChatError('declined', 'Claude declined this request.', last);
    if (!text) continue;
    if (!wantsJson) return text;
    const json = jsonOf(text);
    if (json) return json;
  }
  // No made-up replies: a canned "Dorothy" line or a fake classifier verdict would be a lie in the demo.
  throw new ChatError(wantsJson ? 'invalid_json' : 'empty', 'Claude returned no usable reply.', last);
}

function createApp(client) {
  const app = express();
  app.use(cors({
    origin: (origin, cb) => {
      // same-origin pages send no Origin; a page opened from disk sends the string "null"
      if (!origin || origin === 'null' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'));
    }
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, 'public'))); // only /public is served, never server.js or .env

  app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL }));

  app.post('/api/chat', async (req, res) => {
    const body = req.body || {};
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: 'prompt must be a non-empty string under 20,000 characters', code: 'bad_request' });
    }
    const kind = kindOf(body);
    try {
      const text = await callClaude(client, kind, body.prompt);
      res.json({ text });
    } catch (e) {
      if (e instanceof ChatError) {
        console.error(`[${kind}] ${e.code}`, e.detail);
        return res.status(502).json({ error: e.message, code: e.code, detail: e.detail });
      }
      const status = e && e.status;
      console.error(`[${kind}] API error:`, status, e && e.message);
      const code = status === 401 ? 'auth' : status === 404 ? 'model' : status === 429 ? 'rate_limited' : 'upstream';
      res.status(status === 429 ? 429 : 502).json({ error: e && e.message || 'Upstream error', code });
    }
  });

  return app;
}

module.exports = { createApp, callClaude, textOf, jsonOf };

if (require.main === module) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.');
    process.exit(1);
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  createApp(client).listen(PORT, HOST, () => console.log(`PhishHook server on http://localhost:${PORT} (model ${MODEL})`));
}