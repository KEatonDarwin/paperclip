import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { processMessage } from '../agent.js';

const VOICE_TOKEN = process.env.JARVIS_VOICE_TOKEN;
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (Whisper API limit)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE },
});

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey });
}

export function createVoiceRouter() {
  const router = express.Router();

  router.post('/intake/voice', upload.single('audio'), async (req, res) => {
    if (!VOICE_TOKEN) {
      res.status(503).json({ error: 'Voice intake not configured (JARVIS_VOICE_TOKEN missing)' });
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${VOICE_TOKEN}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No audio file provided. Send multipart/form-data with field "audio".' });
      return;
    }

    const startTime = Date.now();
    console.log(`[voice] Received ${req.file.size} bytes (${req.file.mimetype ?? req.file.originalname})`);

    try {
      const openai = getOpenAIClient();

      const ext = extFromMime(req.file.mimetype) ?? 'm4a';
      const file = new File([new Uint8Array(req.file.buffer)], `voice.${ext}`, { type: req.file.mimetype });

      const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
      });

      const transcript = transcription.text.trim();
      if (!transcript) {
        res.json({ transcript: '', response: 'I didn\'t catch anything — try again?', conversationId: null });
        return;
      }

      console.log(`[voice] Transcribed in ${Date.now() - startTime}ms: "${transcript}"`);

      const conversationId = `voice:${Date.now()}`;
      const response = await processMessage(transcript, conversationId);

      console.log(`[voice] Total round-trip: ${Date.now() - startTime}ms`);

      res.json({ transcript, response, conversationId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[voice] Error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

function extFromMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
  };
  return map[mime] ?? null;
}
