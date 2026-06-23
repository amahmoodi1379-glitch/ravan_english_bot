/**
 * Simple Gregorian-to-Jalali (Shamsi) date converter.
 * No external dependencies.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

function toPersianDigits(n: number | string): string {
  return String(n).replace(/\d/g, (d) => PERSIAN_DIGITS[parseInt(d)]);
}

const JALALI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد',
  'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر',
  'دی', 'بهمن', 'اسفند'
];

function gregorianToJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let gy2 = (gm > 2) ? gy + 1 : gy;
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
  let jy = -1595 + (33 * Math.floor(days / 12053));
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm: number;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    const jd = 1 + (days % 31);
    return [jy, jm, jd];
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    const jd = 1 + ((days - 186) % 30);
    return [jy, jm, jd];
  }
}

/**
 * Convert a Date to its Jalali (Shamsi) parts [year, month, day].
 * Uses the local Gregorian fields of the Date (so the caller controls the timezone
 * by constructing the Date appropriately).
 * @param date - The Date to convert
 * @returns A tuple [jy, jm, jd] (month is 1-12, day is 1-31)
 */
export function toJalaliParts(date: Date): [number, number, number] {
  return gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/**
 * Convert an ISO date string (or Date) to a formatted Jalali date string.
 * @param dateInput - The date to convert (ISO string or Date object)
 * @param format - Output format: 'short' for "۱۴۰۳/۰۹/۱۵" or 'long' for "۱۵ آذر ۱۴۰۳" (defaults to 'long')
 * @returns The formatted Jalali date string, or '-' if the date is invalid
 */
export function toJalaliString(dateInput: string | Date, format: 'short' | 'long' = 'long'): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '-';

  const [jy, jm, jd] = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());

  if (format === 'short') {
    const mm = jm < 10 ? `0${jm}` : `${jm}`;
    const dd = jd < 10 ? `0${jd}` : `${jd}`;
    return toPersianDigits(`${jy}/${mm}/${dd}`);
  }

  return `${toPersianDigits(jd)} ${JALALI_MONTHS[jm - 1]} ${toPersianDigits(jy)}`;
}
