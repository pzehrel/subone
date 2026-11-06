/** Go net/url decodes the entire Fragment before Mihomo splits it at ampersands. */
export function mihomoDnsFragment(value: string): { route?: string; parameters: string[] } {
  const hash = value.indexOf('#');
  if (hash < 0) return { parameters: [] };
  const parts = decodeURIComponent(value.slice(hash + 1)).split('&');
  return { route: parts.filter(part => !part.includes('=')).at(-1) || undefined, parameters: parts.filter(part => part.includes('=')) };
}
export function safeMihomoDnsRoute(name: string): boolean { return !!name && !/[&=\u0000-\u001f\u007f]/.test(name); }
export function withMihomoDnsRoute(value: string, route: string): string {
  const parameters = mihomoDnsFragment(value).parameters.map(part => {
    const index = part.indexOf('='); return encodeURIComponent(part.slice(0, index)) + '=' + encodeURIComponent(part.slice(index + 1));
  });
  return value.split('#')[0] + '#' + [...parameters, encodeURIComponent(route)].join('&');
}
