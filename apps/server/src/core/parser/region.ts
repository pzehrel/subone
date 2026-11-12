export interface RegionInfo { name: string; code?: string; emoji?: string }
interface Place extends RegionInfo { aliases: string[]; specific: boolean }
const places: Place[] = [];
function country(name: string, code: string, emoji: string, aliases: string[], cities: [string, string[]][] = []) {
  places.push({ name, code, emoji, aliases: [name, code, emoji, ...aliases], specific: false });
  for (const [city, aliases] of cities) places.push({ name: city, code, emoji, aliases: [city, ...aliases], specific: true });
}

// Keep country fields separate from canonical place names: cities share a country,
// while numbering remains per place. Latin aliases match whole tokens, never fragments.
country('香港', 'HK', '🇭🇰', ['港', 'hkg', 'hong kong', 'hongkong']);
country('澳门', 'MO', '🇲🇴', ['澳門', 'macao', 'macau']);
country('台湾', 'TW', '🇹🇼', ['台灣', 'taiwan', 'tai wan', 'twn'], [
  ['台北', ['臺北', 'taipei', 'tpe']], ['台中', ['臺中', 'taichung']], ['高雄', ['kaohsiung']],
]);
country('日本', 'JP', '🇯🇵', ['japan', 'jpn'], [
  ['大阪', ['osaka', 'kix']], ['东京', ['東京', 'tokyo', 'nrt', 'hnd']], ['埼玉', ['saitama']],
]);
country('新加坡', 'SG', '🇸🇬', ['狮城', '獅城', 'singapore', 'sgp', 'sin']);
country('美国', 'US', '🇺🇸', ['美國', 'usa', 'america', 'united states'], [
  ['波特兰', ['波特蘭', 'portland', 'pdx']], ['洛杉矶', ['洛杉磯', 'los angeles', 'lax']],
  ['硅谷', ['矽谷', 'silicon valley']], ['西雅图', ['西雅圖', 'seattle', 'sea']],
  ['达拉斯', ['達拉斯', 'dallas', 'dfw']], ['芝加哥', ['chicago', 'ord']],
  ['圣何塞', ['聖何塞', 'san jose', 'sjc']], ['凤凰城', ['鳳凰城', 'phoenix', 'phx']],
]);
country('韩国', 'KR', '🇰🇷', ['韓國', 'korea', 'south korea'], [['首尔', ['首爾', 'seoul', 'icn']]]);
country('英国', 'UK', '🇬🇧', ['英國', 'gb', 'united kingdom', 'great britain', 'britain'], [['伦敦', ['倫敦', 'london', 'lhr']]]);
country('德国', 'DE', '🇩🇪', ['德國', 'germany', 'deutschland'], [['法兰克福', ['法蘭克福', 'frankfurt', 'fra']]]);
country('法国', 'FR', '🇫🇷', ['法國', 'france'], [['巴黎', ['paris']]]);
country('加拿大', 'CA', '🇨🇦', ['加', 'canada'], [['温哥华', ['溫哥華', 'vancouver', 'yvr']], ['多伦多', ['多倫多', 'toronto', 'yyz']]]);
country('澳大利亚', 'AU', '🇦🇺', ['澳大利亞', '澳洲', 'australia'], [['悉尼', ['sydney', 'syd']], ['墨尔本', ['墨爾本', 'melbourne', 'mel']]]);
country('中国', 'CN', '🇨🇳', ['中國', 'china']);
country('哥斯达黎加', 'CR', '🇨🇷', ['哥斯達黎加', 'costa rica'], [['圣何塞', ['聖何塞', 'san jose']]]);

const aliases = places.flatMap(place => place.aliases.map(alias => {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
  let expression = escaped;
  if (/^[a-z ]+$/i.test(alias)) expression = `(?<![a-z])${escaped}(?![a-z])`;
  if (/^\p{Script=Han}$/u.test(alias)) expression = `(?<!\\p{Script=Han})${escaped}(?!\\p{Script=Han})`;
  return { place, pattern: new RegExp(expression, 'giu') };
}));

export function detectRegion(input: string): RegionInfo | undefined {
  const found = aliases.flatMap(({ place, pattern }) =>
    [...input.matchAll(pattern)].map(match => ({ place, index: match.index, end: match.index + match[0].length })));
  // A longer known alias owns its span (e.g. 新加坡 must not also mean 加拿大).
  let matches = found.filter(match => !found.some(other => other.index <= match.index && other.end >= match.end && other.end - other.index > match.end - match.index));
  // 中国香港/中国澳门 describe the independently identified region, not a conflict.
  if (matches.some(match => ['HK', 'MO'].includes(match.place.code!))) matches = matches.filter(match => match.place.code !== 'CN');
  // Older Taiwan groups used 🇨🇳 in their display label; an explicit Taiwan place
  // still identifies its region. Other country evidence continues to participate.
  if (matches.some(match => match.place.code === 'TW')) matches = matches.filter(match => input.slice(match.index, match.end) !== '🇨🇳');
  if (!matches.length) return undefined;
  const spans = new Map<string, Set<string>>();
  for (const match of matches) {
    const key = `${match.index}:${match.end}`;
    const codes = spans.get(key) || new Set<string>();
    codes.add(match.place.code!); spans.set(key, codes);
  }
  // Ambiguous city names require compatible country/place evidence in the input.
  const codes = [...spans.values()].reduce((codes, next) => new Set([...codes].filter(code => next.has(code))));
  if (codes.size !== 1) return undefined;
  const code = [...codes][0];
  const compatible = matches.filter(match => match.place.code === code);
  const specific = compatible.filter(match => match.place.specific);
  const selected = (specific.length ? specific : compatible).sort((a, b) => a.index - b.index)[0].place;
  return { name: selected.name, code: selected.code, emoji: selected.emoji };
}
