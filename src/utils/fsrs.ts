/**
 * FSRS-5 (Free Spaced Repetition Scheduler) Implementation
 * Based on the DSR (Difficulty, Stability, Retrievability) memory model.
 * Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
 */

// --- Types ---

export enum Rating {
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}

export enum CardState {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3,
}

export interface FsrsCard {
  stability: number;
  difficulty: number;
  state: CardState;
  lastReview: string | null; // ISO date string
  reps: number;
  lapses: number;
}

export interface FsrsSchedulingResult {
  stability: number;
  difficulty: number;
  interval: number; // days
  state: CardState;
  reps: number;
  lapses: number;
}

// --- Default FSRS-5 Parameters (w0..w18) ---
// These are the default optimized parameters from the FSRS-5 paper.
const W: number[] = [
  0.40255,  // w0: initial stability for Again
  1.18385,  // w1: initial stability for Hard
  3.173,    // w2: initial stability for Good
  15.69105, // w3: initial stability for Easy
  7.1949,   // w4: initial difficulty base
  0.5345,   // w5: initial difficulty grade factor
  1.4604,   // w6: difficulty update grade factor
  0.0046,   // w7: difficulty mean reversion weight
  1.54575,  // w8: stability success curve shape
  0.1192,   // w9: stability success - current stability exponent
  1.01925,  // w10: stability success - retrievability factor
  1.9395,   // w11: stability failure base factor
  0.11,     // w12: stability failure - difficulty exponent
  0.29605,  // w13: stability failure - stability exponent
  2.2698,   // w14: stability failure - retrievability factor
  0.2315,   // w15: hard penalty
  2.9898,   // w16: easy bonus
  0.51655,  // w17: short-term stability factor (FSRS-5)
  0.6621,   // w18: short-term stability exponent (FSRS-5)
];

// --- Constants ---
const FACTOR = 19.0 / 81.0;
const DECAY = -0.5;

// Desired retention (probability of recall at review time) — 90%
const DESIRED_RETENTION = 0.9;

// --- Core Functions ---

/**
 * Calculate retrievability (probability of recall) at time t days after last review.
 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  if (elapsedDays <= 0) return 1;
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY);
}

/**
 * Calculate the optimal review interval given desired retention and stability.
 */
export function nextInterval(stability: number, requestedRetention: number = DESIRED_RETENTION): number {
  if (stability <= 0) return 1;
  const interval = (stability / FACTOR) * (Math.pow(requestedRetention, 1.0 / DECAY) - 1.0);
  return Math.max(1, Math.round(interval));
}

/**
 * Get initial stability for a given grade (first review of a card).
 */
function initialStability(rating: Rating): number {
  switch (rating) {
    case Rating.Again: return W[0];
    case Rating.Hard: return W[1];
    case Rating.Good: return W[2];
    case Rating.Easy: return W[3];
  }
}

/**
 * Get initial difficulty for a given grade (first review of a card).
 */
function initialDifficulty(rating: Rating): number {
  const g = rating as number;
  return clampDifficulty(W[4] - Math.exp(W[5] * (g - 1)) + 1);
}

/**
 * Calculate new stability after a successful recall (rating >= Hard).
 */
function stabilityOnSuccess(d: number, s: number, r: number, rating: Rating): number {
  const t_d = 11 - d;
  const t_s = Math.pow(s, -W[9]);
  const t_r = Math.exp(W[10] * (1 - r)) - 1;
  const h = rating === Rating.Hard ? W[15] : 1.0;
  const b = rating === Rating.Easy ? W[16] : 1.0;
  const c = Math.exp(W[8]);
  const alpha = 1 + t_d * t_s * t_r * h * b * c;
  return s * alpha;
}

/**
 * Calculate new stability after a lapse (forgot / Again).
 */
function stabilityOnFail(d: number, s: number, r: number): number {
  const d_f = Math.pow(d, -W[12]);
  const s_f = Math.pow(s + 1, W[13]) - 1;
  const r_f = Math.exp(W[14] * (1 - r));
  const newS = W[11] * d_f * s_f * r_f;
  return Math.min(newS, s); // cannot exceed previous stability
}

/**
 * Update stability based on rating and current state.
 */
function updateStability(d: number, s: number, r: number, rating: Rating): number {
  if (rating === Rating.Again) {
    return stabilityOnFail(d, s, r);
  }
  return stabilityOnSuccess(d, s, r, rating);
}

/**
 * Update difficulty based on rating.
 */
function updateDifficulty(d: number, rating: Rating): number {
  const g = rating as number;
  const deltaD = -W[6] * (g - 3);
  const newD = d + deltaD * ((10 - d) / 9);
  // Mean reversion toward initial Easy difficulty
  const reverted = W[7] * initialDifficulty(Rating.Easy) + (1 - W[7]) * newD;
  return clampDifficulty(reverted);
}

function clampDifficulty(d: number): number {
  return Math.max(1, Math.min(10, d));
}

// --- Public API ---

/**
 * Schedule the next review for a card given the user's rating.
 * This is the main entry point for the FSRS algorithm.
 */
export function schedule(card: FsrsCard, rating: Rating, now: Date = new Date()): FsrsSchedulingResult {
  // First review (new card)
  if (card.state === CardState.New || card.reps === 0) {
    const stability = initialStability(rating);
    const difficulty = initialDifficulty(rating);
    const interval = rating === Rating.Again ? 1 : nextInterval(stability);
    const newState = rating === Rating.Again ? CardState.Learning : CardState.Review;

    return {
      stability,
      difficulty,
      interval,
      state: newState,
      reps: 1,
      lapses: rating === Rating.Again ? 1 : 0,
    };
  }

  // Calculate elapsed days since last review
  let elapsedDays = 1;
  if (card.lastReview) {
    const lastDate = new Date(card.lastReview);
    const diffMs = now.getTime() - lastDate.getTime();
    elapsedDays = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  }

  // Calculate current retrievability
  const r = retrievability(elapsedDays, card.stability);

  // Update stability and difficulty
  const newStability = updateStability(card.difficulty, card.stability, r, rating);
  const newDifficulty = updateDifficulty(card.difficulty, rating);

  // Calculate next interval
  let interval: number;
  if (rating === Rating.Again) {
    // For lapses: use short-term stability calculation
    // FSRS-5 short-term: S' = S * e^(w17 * (rating - 3 + w18))
    // For Again (rating=1): S' is already calculated by stabilityOnFail, use minimum 1 day
    interval = Math.max(1, nextInterval(newStability));
    // Cap lapse interval to be reasonable (don't go too far)
    interval = Math.min(interval, 3);
  } else {
    interval = nextInterval(newStability);
  }

  // Determine new state
  let newState: CardState;
  let lapses = card.lapses;

  if (rating === Rating.Again) {
    newState = CardState.Relearning;
    lapses += 1;
  } else if (card.state === CardState.Learning || card.state === CardState.Relearning) {
    newState = CardState.Review;
  } else {
    newState = CardState.Review;
  }

  return {
    stability: newStability,
    difficulty: newDifficulty,
    interval,
    state: newState,
    reps: card.reps + 1,
    lapses,
  };
}

/**
 * Create a new (blank) card state.
 */
export function createNewCard(): FsrsCard {
  return {
    stability: 0,
    difficulty: 0,
    state: CardState.New,
    lastReview: null,
    reps: 0,
    lapses: 0,
  };
}

/**
 * Convert a rating to its Persian label for display.
 */
export function ratingLabel(rating: Rating): string {
  switch (rating) {
    case Rating.Again: return "اصلاً یادم نبود";
    case Rating.Hard: return "سخت بود";
    case Rating.Good: return "خوب بود";
    case Rating.Easy: return "کاملاً بلد بودم";
  }
}

/**
 * Get the emoji for a rating.
 */
export function ratingEmoji(rating: Rating): string {
  switch (rating) {
    case Rating.Again: return "🔴";
    case Rating.Hard: return "🟠";
    case Rating.Good: return "🟢";
    case Rating.Easy: return "⭐";
  }
}
