import express from 'express';
import { processMessage } from '../agent.js';
import { handlePaperclipWebhook } from './paperclip-webhook.js';

export function createWebhookRouter() {
  const router = express.Router();

  router.use(express.json());

  router.post('/paperclip-webhook', async (req, res) => {
    try {
      const result = await handlePaperclipWebhook(req.body);
      res.json(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[paperclip-webhook] Error:', errMsg);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post('/intake', async (req, res) => {
    const { text, source = 'webhook', sessionId } = req.body as {
      text?: string;
      source?: string;
      sessionId?: string;
    };

    if (!text?.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const conversationId = sessionId ? `webhook:${sessionId}` : `webhook:${Date.now()}`;

    try {
      const response = await processMessage(text.trim(), conversationId);
      res.json({ response, conversationId, source });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: errMsg });
    }
  });

  router.post('/intake/reply', async (req, res) => {
    const { text, conversationId } = req.body as {
      text?: string;
      conversationId?: string;
    };

    if (!text?.trim() || !conversationId) {
      res.status(400).json({ error: 'text and conversationId are required' });
      return;
    }

    try {
      const response = await processMessage(text.trim(), conversationId);
      res.json({ response, conversationId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: errMsg });
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  return router;
}
