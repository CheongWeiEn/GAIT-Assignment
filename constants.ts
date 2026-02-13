
import { Companion } from './types';

export const SKIN_TONES = ['Porcelain', 'Honey', 'Bronze', 'Caramel', 'Ebony'];
export const HAIR_COLORS = ['Black', 'Blonde', 'Brown', 'Red', 'White'];
export const HAIR_STYLES = ['Curly', 'Long', 'Short', 'Spiky', 'Fade', 'Space Buns', 'Braids', 'Bob Cut'];
export const PROPS = ['None', 'Smart Glasses', 'Hero Cape', 'Shiny Crown', 'Star Wand', 'Explorer Bag', 'Magic Camera'];

export const COMPANIONS: Companion[] = [
  { id: '1', name: 'Pip', emoji: '🐹', personality: 'Tiny, brave, and loves cheese', unlockThreshold: 0 },
  { id: '2', name: 'Luna', emoji: '🦉', personality: 'Wise owl who knows all the stars', unlockThreshold: 0 },
  { id: '3', name: 'Sparky', emoji: '🦖', personality: 'Excitable robot who makes popcorn', unlockThreshold: 0 },
  { id: '4', name: 'Flora', emoji: '🌸', personality: 'A gentle fairy who speaks to flowers', unlockThreshold: 300 },
  { id: '5', name: 'Bouncer', emoji: '🦘', personality: 'A kangaroo with a pouch full of maps', unlockThreshold: 700 }
];

export const VOICE_MAP = {
  nature: 'Puck',
  whimsical: 'Kore',
  adventure: 'Zephyr'
};

export const MOODS = ['Silly', 'Adventurous', 'Bedtime', 'Mysterious'];

export const INSPIRATION_TOPICS = [
  "A garden where the flowers sing songs",
  "Building a rocket ship out of cardboard boxes",
  "Helping a lost robot find its way home",
  "An underwater city made of giant bubbles",
  "A library where books come to life at night",
  "Exploring a planet made of colorful candy",
  "Learning how honeybees make their sweet treats",
  "A dinosaur who wants to be a chef",
  "The secret life of my favorite toy",
  "A journey to the center of a giant rainbow"
];
