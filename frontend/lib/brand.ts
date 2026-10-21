function normalizeBrandValue(value: string | undefined, fallback: string) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : fallback;
}

export const BRAND_PREFIX = normalizeBrandValue(process.env.NEXT_PUBLIC_BRAND_PREFIX, 'CredX');
export const BRAND_ACRONYM = normalizeBrandValue(process.env.NEXT_PUBLIC_BRAND_ACRONYM, '');
export const BRAND_EXPANSION = normalizeBrandValue(
  process.env.NEXT_PUBLIC_BRAND_EXPANSION,
  "Private investment workspace",
);
export const BRAND_TITLE = [BRAND_PREFIX, BRAND_ACRONYM].filter(Boolean).join(' ');

export function getBrandExpansionLines() {
  const words = BRAND_EXPANSION.split(/\s+/).filter(Boolean);

  if (words.length <= 1) {
    return {
      primary: BRAND_EXPANSION,
      secondary: '',
    };
  }

  return {
    primary: words[0],
    secondary: words.slice(1).join(' '),
  };
}
