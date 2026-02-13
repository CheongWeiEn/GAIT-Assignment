export interface StoryPage {
  page: number;
  text: string;
  image_prompt: string;
  magic_sound_prompt: string;
  voice_id: string; // The suggested narrator category (e.g., 'nature', 'adventure', 'whimsical')
  image_url?: string;
}

export interface StoryResponse {
  story_title: string;
  tricky_words: string[];
  pages: StoryPage[];
  character_bible: string; // Detailed visual description of the hero and companions
  consistency_id: string; // Deterministic hash/ID for stable generation
  character_question: {
    characterName: string;
    question: string;
  };
  magic_sticker: string;
  costume_reward: string;
  secret_mission: string;
  spark_points_earned: number;
}

export interface VocabRecapItem {
  word: string;
  definition: string;
  example_sentence: string;
}

export interface QuizQuestion {
  question: string;
  type: "mcq" | "fill_blank" | "true_false";
  options: string[];
  correct_answer: string;
}

export interface QuizData {
  vocab_recap: VocabRecapItem[];
  quiz: QuizQuestion[];
  bonus_spark_points: number;
}

export interface HeroDetails {
  name: string;
  age: number;
  gender: 'Boy' | 'Girl' | 'Explorer';
  skinTone: string;
  hairStyle: string;
  hairColor: string;
  prop: string;
  narrationMode: 'single' | 'magical';
}

export interface Companion {
  name: string;
  emoji: string;
  personality: string;
  id: string;
  unlockThreshold?: number; // Spark Points needed to meet this friend
}

export interface StoryHistoryItem {
  id: string;
  title: string;
  topic: string;
  date: string;
  sticker: string;
}

export type Mood = 'Silly' | 'Adventurous' | 'Bedtime' | 'Mysterious';

export enum AppStep {
  HERO_SETUP,
  COMPANION_SELECTION,
  GENERATING,
  STORY_READER,
  QUIZ,
  REWARDS,
  DASHBOARD
}