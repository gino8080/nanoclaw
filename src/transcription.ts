import OpenAI from 'openai';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function transcribeAudio(
  buffer: Buffer,
  mimeType = 'audio/ogg',
  filename = 'voice.ogg',
): Promise<string | null> {
  const { OPENAI_API_KEY } = readEnvFile(['OPENAI_API_KEY']);
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set, skipping voice transcription');
    return null;
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const file = new File([buffer], filename, { type: mimeType });
    const result = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });
    return result.text || null;
  } catch (err) {
    logger.error({ err }, 'Voice transcription failed');
    return null;
  }
}
