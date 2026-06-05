export interface Sm2State {
  interval: number;
  repetition: number;
  ef: number;
}

export interface Sm2Result {
  interval: number;
  repetition: number;
  ef: number;
}

export function sm2(prev: Sm2State, quality: number, maxInterval = 180): Sm2Result {
  let { interval, repetition, ef } = prev;

  if (quality < 0) quality = 0;
  if (quality > 5) quality = 5;

  if (quality >= 3) {
    if (repetition === 0) {
      interval = 1;
    } else if (repetition === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * ef);
      if (interval < 1) interval = 1;
    }
    repetition = repetition + 1;
  } else {
    repetition = 0;
    interval = 1;
  }

  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) {
    ef = 1.3;
  }

  if (interval > maxInterval) {
    interval = maxInterval;
  }

  return { interval, repetition, ef };
}
