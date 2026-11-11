export interface RegionInfo { name: string; code?: string; emoji?: string }

const places: { name: string; code: string; emoji: string; aliases: string[] }[] = [
  { name: '大阪', code: 'JP', emoji: '🇯🇵', aliases: ['大阪', 'osaka'] },
  { name: '东京', code: 'JP', emoji: '🇯🇵', aliases: ['东京', '東京', 'tokyo'] },
  { name: '香港', code: 'HK', emoji: '🇭🇰', aliases: ['香港', 'hong kong', 'hongkong', 'hk', 'hkg', '🇭🇰'] },
  { name: '日本', code: 'JP', emoji: '🇯🇵', aliases: ['日本', 'japan', 'jp', 'jpn', '🇯🇵'] },
];

export function detectRegion(input: string): RegionInfo | undefined {
  const matches = places.flatMap(place => place.aliases.flatMap(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const latin = /^[a-z ]+$/i.test(alias);
    const match = new RegExp(latin ? `(?<![a-z])${escaped}(?![a-z])` : escaped, 'i').exec(input);
    return match ? [{ place, index: match.index }] : [];
  }));
  if (new Set(matches.map(match => match.place.code)).size !== 1) return undefined;
  const specific = matches.filter(match => match.place.name !== '日本');
  return (specific.length ? specific : matches).sort((a, b) => a.index - b.index)[0]?.place;
}
