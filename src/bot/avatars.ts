export interface AvatarOption {
  code: string;
  emoji: string;
  label: string;
}

export const AVATARS: AvatarOption[] = [
  { code: "cat", emoji: "😺", label: "گربه" },
  { code: "fox", emoji: "🦊", label: "روباه" },
  { code: "panda", emoji: "🐼", label: "پاندا" },
  { code: "koala", emoji: "🐨", label: "کوالا" },
  { code: "lion", emoji: "🦁", label: "شیر" },
  { code: "tiger", emoji: "🐯", label: "ببر" },
  { code: "wolf", emoji: "🐺", label: "گرگ" },
  { code: "eagle", emoji: "🦅", label: "عقاب" },
  { code: "owl", emoji: "🦉", label: "جغد" },
  { code: "unicorn", emoji: "🦄", label: "تک‌شاخ" },
  { code: "dragon", emoji: "🐉", label: "اژدها" },
  { code: "dino", emoji: "🦖", label: "دایناسور" },
  { code: "robot", emoji: "🤖", label: "ربات" },
  { code: "alien", emoji: "👽", label: "فضایی" },
  { code: "ninja", emoji: "🥷", label: "نینجا" },
  { code: "ghost", emoji: "👻", label: "روح" },
  { code: "detective", emoji: "🕵️‍♂️", label: "کارآگاه" },
  { code: "astronaut", emoji: "👩‍🚀", label: "فضانورد" },
  { code: "scientist", emoji: "👨‍🔬", label: "دانشمند" },
  { code: "wizard", emoji: "🧙‍♂️", label: "جادوگر" }
];

const LEGACY_AVATAR_EMOJI: Record<string, string> = {
  dog: "🐶",
  bear: "🐻",
  rabbit: "🐰",
  frog: "🐸",
  penguin: "🐧",
  monkey: "🐵",
  horse: "🐴",
  bee: "🐝",
  butterfly: "🦋",
  shark: "🦈",
  whale: "🐋",
  turtle: "🐢",
  octopus: "🐙"
};

const EMOJI_BY_CODE: Record<string, string> = { ...LEGACY_AVATAR_EMOJI };
for (const avatar of AVATARS) {
  EMOJI_BY_CODE[avatar.code] = avatar.emoji;
}

export function getAvatarEmoji(code: string | null | undefined): string {
  if (!code) return "👤";
  return EMOJI_BY_CODE[code] || "👤";
}

export function getAvatarLabel(code: string | null | undefined): string {
  if (!code) return "انتخاب نشده";
  const found = AVATARS.find((a) => a.code === code);
  return found ? found.label : "نامشخص";
}
