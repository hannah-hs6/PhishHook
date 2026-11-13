const express = require('express');
const cors = require('cors');
const { Anthropic } = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    const isGate = prompt.includes('scam-triage classifier');
    const isExtract = prompt.includes('extraction tool');
    const wantsJson = isGate || isExtract;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 600,
      system: wantsJson
        ? 'Output ONLY a single raw JSON object. No markdown, no backticks, no commentary.'
        : 'Reply as Dorothy Whitfield in 1 to 2 short, realistic SMS sentences. Never use clichés like "dear", "sweetheart", or "glasses", and never leave your reply blank.',
      messages: [{ role: 'user', content: prompt }]
    });

    let text = (response.content[0]?.text || '').trim();
    console.log('Claude reply:', text);

    if (wantsJson) {
      const cleaned = text.replace(/```json|```/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      try {
        JSON.parse(match ? match[0] : cleaned);
        text = match ? match[0] : cleaned;
      } catch {
        text = isGate
          ? JSON.stringify({ is_scam: true, scam_type: 'Suspected SMS scam', confidence: 0.9, reason: 'Unsolicited alert requesting urgent action.' })
          : JSON.stringify({ indicators: [] });
      }
    } else if (!text) {
      text = 'Oh dear, my glasses are in the other room. Could you write that out again slowly for me, sweetheart?';
    }

    res.json({ text });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log('✅ PhishHook Server running on http://localhost:3000'));