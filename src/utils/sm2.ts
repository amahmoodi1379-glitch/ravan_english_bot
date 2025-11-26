// پیاده‌سازی ساده الگوریتم SM-2
// quality باید بین 0 تا 5 باشد (ما بعداً از 2 برای غلط و 5 برای درست استفاده می‌کنیم)

export interface Sm2State {
  interval: number;    // فاصله فعلی (روز)
  repetition: number;  // تعداد تکرارهای موفق پشت‌سرهم
  ef: number;          // ease factor
}

export interface Sm2Result {
  interval: number;
  repetition: number;
  ef: number;
}

export function sm2(prev: Sm2State, quality: number): Sm2Result {
  let { interval, repetition, ef } = prev;

  // محدود کردن quality بین 0 و 5
  if (quality < 0) quality = 0;
  if (quality > 5) quality = 5;

  if (quality >= 3) {
    // پاسخ قابل قبول (درست)
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
    // پاسخ ضعیف (غلط)
    repetition = 0;
    interval = 1;
  }

  // به‌روزرسانی EF طبق فرمول SM-2
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) {
    ef = 1.3;
  }

  return { interval, repetition, ef };
}
