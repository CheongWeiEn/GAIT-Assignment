import { GoogleGenAI, Type, Modality } from "@google/genai";
import { HeroDetails, StoryResponse, Companion, Mood, QuizData } from "../types";
import { VOICE_MAP } from "../constants";

// Always initialize using the direct environment variable as per guidelines
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Creates a simple deterministic hash for caching keys
 */
const hashString = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
};

/**
 * Retry helper for API calls
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err.status || 0;
      if (status === 500 || status === 503 || status === 429) {
        const backoff = Math.pow(2, i) * 1000;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const generateConsistencyId = (hero: HeroDetails, topic: string): string => {
  const str = `${hero.name}-${hero.gender}-${hero.skinTone}-${hero.hairStyle}-${hero.hairColor}-${topic}`;
  return hashString(str);
};

export const generateStory = async (
  topic: string,
  hero: HeroDetails,
  mood: Mood,
  companions: Companion[]
): Promise<StoryResponse> => {
  const consistencyId = generateConsistencyId(hero, topic);
  const companionInfo = companions.length > 0
    ? companions.map(c => `${c.name} (${c.emoji}) - ${c.personality}`).join(', ')
    : "No companion selected for this journey.";

  const prompt = `
    USER_TOPIC: "${topic}"
    CHILD_AGE: ${hero.age}
    MOOD_SELECTION: "${mood}"
    CONSISTENCY_ID: "${consistencyId}"
    HERO_DETAILS:
    - Name: ${hero.name}
    - Gender: ${hero.gender}
    - Skin tone: ${hero.skinTone}
    - Hair style: ${hero.hairStyle}
    - Hair color: ${hero.hairColor}
    - Prop: ${hero.prop}
    COMPANIONS: ${companionInfo}

    STORY GUIDELINES:
    - Generate a 5-page educational journey.
    - VISUAL BIBLE: Create a "character_bible" string that explicitly defines the hero's appearance (exact hair length/shade, skin undertones, eye color, specific clothing style, and size) to ensure every image generation follows the same blueprint.
    - Each page should specify a "voice_id" which is one of: 'nature', 'adventure', 'whimsical'.
    - NARRATION: Focus on storytelling quality.

    Generate the story using the provided JSON schema.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          story_title: { type: Type.STRING },
          tricky_words: { type: Type.ARRAY, items: { type: Type.STRING } },
          character_bible: { type: Type.STRING },
          pages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                page: { type: Type.NUMBER },
                text: { type: Type.STRING },
                image_prompt: { type: Type.STRING },
                magic_sound_prompt: { type: Type.STRING },
                voice_id: { type: Type.STRING }
              },
              required: ["page", "text", "image_prompt", "magic_sound_prompt", "voice_id"]
            }
          },
          character_question: {
            type: Type.OBJECT,
            properties: {
              characterName: { type: Type.STRING },
              question: { type: Type.STRING }
            },
            required: ["characterName", "question"]
          },
          magic_sticker: { type: Type.STRING },
          costume_reward: { type: Type.STRING },
          secret_mission: { type: Type.STRING },
          spark_points_earned: { type: Type.INTEGER }
        },
        required: ["story_title", "tricky_words", "pages", "character_bible", "character_question", "magic_sticker", "costume_reward", "secret_mission", "spark_points_earned"]
      }
    }
  });

  const parsed = JSON.parse(response.text || '{}') as StoryResponse;
  parsed.consistency_id = consistencyId;
  return parsed;
};

export const generateStoryImage = async (
  pagePrompt: string, 
  bible: string, 
  consistencyId: string
): Promise<string> => {
  const cacheKey = `img_${consistencyId}_${hashString(pagePrompt)}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return cached;

  const fullPrompt = `
    [CHARACTER_BIBLE]: ${bible}
    [SCENE]: ${pagePrompt}
    [CONSISTENCY_RULES]: CONSISTENCY_ID: ${consistencyId}. Do not change the hero's gender, age, face, skin tone, hair style, or hair color. The hero must look exactly the same as described in the bible.
    [STYLE]: Digital 3D illustration style, Pixar-like, soft volumetric lighting, vibrant colors, child-friendly, professional book art.
    [NEGATIVE_PROMPT]: different face, changed hair, changed skin tone, adult features, scary, blurry, low resolution.
  `;

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: fullPrompt }] },
      config: { imageConfig: { aspectRatio: "4:3" } }
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if ((part as any).inlineData) {
        const base64 = `data:image/png;base64,${(part as any).inlineData.data}`;
        try { sessionStorage.setItem(cacheKey, base64); } catch {}
        return base64;
      }
    }
    throw new Error("No image data");
  });
};

export const generateAllPageImages = async (
  response: StoryResponse, 
  onProgress: (current: number, total: number) => void
): Promise<StoryResponse> => {
  const total = response.pages.length;
  const concurrency = 2;
  const results = [...response.pages];

  for (let i = 0; i < total; i += concurrency) {
    const chunk = results.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (page, index) => {
      const realIdx = i + index;
      const url = await generateStoryImage(page.image_prompt, response.character_bible, response.consistency_id);
      results[realIdx].image_url = url;
      onProgress(Math.min(realIdx + 1, total), total);
    }));
  }

  return { ...response, pages: results };
};

export const cleanTextForTTS = (text: string): string => {
  return text.replace(/\[.*?\]/g, '').trim();
};

export async function generateNarrationBase64(text: string, voiceName: string, consistencyId: string, pageIdx: number): Promise<string | null> {
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) return null;

  const cacheKey = `aud:${consistencyId}:${pageIdx}:${hashString(cleanedText)}:${voiceName}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return cached;

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: cleanedText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } }
        }
      }
    });

    const part: any = response.candidates?.[0]?.content?.parts.find((p: any) => p.inlineData?.data);
    const base64 = part?.inlineData?.data;
    if (base64) {
      try { sessionStorage.setItem(cacheKey, base64); } catch {}
      return base64;
    }
    return null;
  });
}

export async function generateAllPageAudio(
  story: StoryResponse,
  hero: HeroDetails,
  mood: Mood,
  onProgress: (current: number, total: number) => void
): Promise<Record<number, string | null>> {
  const total = story.pages.length;
  const concurrency = 2;
  const audioMap: Record<number, string | null> = {};

  // Deterministic voice selection for "single" mode
  let singleVoiceName = VOICE_MAP.adventure;
  if (mood === 'Bedtime') singleVoiceName = VOICE_MAP.nature;
  if (mood === 'Silly') singleVoiceName = VOICE_MAP.whimsical;

  for (let i = 0; i < total; i += concurrency) {
    const count = Math.min(concurrency, total - i);
    const batch = Array.from({ length: count }, (_, k) => i + k);
    
    await Promise.all(batch.map(async (idx) => {
      const page = story.pages[idx];
      const voiceKey = hero.narrationMode === 'single' ? null : (page.voice_id as keyof typeof VOICE_MAP);
      const voiceName = voiceKey ? (VOICE_MAP[voiceKey] || VOICE_MAP.adventure) : singleVoiceName;
      
      const b64 = await generateNarrationBase64(page.text, voiceName, story.consistency_id, idx);
      audioMap[idx] = b64;
      onProgress(Math.min(idx + 1, total), total);
    }));
  }

  return audioMap;
}

export const generateQuiz = async (trickyWords: string[]): Promise<QuizData> => {
  const prompt = `
    VOCABULARY WORDS LEARNED: ${JSON.stringify(trickyWords)}
    Create a short vocabulary recap and quiz. Simple for kids. 
    JSON SCHEMA:
    {
      "vocab_recap": [{"word": string, "definition": string, "example_sentence": string}],
      "quiz": [{"question": string, "type": "mcq", "options": string[], "correct_answer": string}],
      "bonus_spark_points": number
    }
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
    config: { responseMimeType: 'application/json' }
  });

  return JSON.parse(response.text || '{}') as QuizData;
};

export function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function pcm16ToAudioBuffer(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number
): AudioBuffer {
  const trimmed = data.byteLength % 2 === 0 ? data : data.slice(0, data.byteLength - 1);
  const dataInt16 = new Int16Array(trimmed.buffer, trimmed.byteOffset, trimmed.byteLength / 2);
  const frameCount = Math.floor(dataInt16.length / numChannels);
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}
