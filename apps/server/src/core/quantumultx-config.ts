/** Native fields documented by crossutility/Quantumult-X/sample.conf. DNS is deliberately opaque. */
export interface QuantumultXDocument { quantumultxLines: string[] }
export interface QuantumultXEntry { section: string; index: number; parts: string[] }
export interface QuantumultXReference { slot: string; literal: string; owner: string; write(value: string): void }
export function quantumultXEntries(document: QuantumultXDocument): QuantumultXEntry[] {
  let section = '';
  return document.quantumultxLines.flatMap((line, index) => {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) { section = trimmed.slice(1, -1).toLowerCase(); return []; }
    if (!trimmed || /^(#|;|\/\/)/.test(trimmed)) return [];
    return [{ section, index, parts: line.split(',') }];
  });
}
const assignment = (part: string): [string, string] => { const index = part.indexOf('='); return index < 0 ? ['', part.trim()] : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()]; };
export function quantumultXOwnedNames(document: QuantumultXDocument): Set<string> {
  const names = new Set<string>();
  for (const { section, parts } of quantumultXEntries(document)) {
    if (section === 'policy') names.add(assignment(parts[0])[1]);
    if (section === 'server_local' || (section === 'server_remote' && parts.some(part => assignment(part)[0] === 'as-policy'))) {
      const tag = parts.find(part => assignment(part)[0] === 'tag');
      if (tag) names.add(assignment(tag)[1]);
    }
  }
  return names;
}
export function quantumultXReferences(document: QuantumultXDocument): QuantumultXReference[] {
  const references: QuantumultXReference[] = [];
  const occurrences = new Map<string, number>();
  for (const entry of quantumultXEntries(document)) {
    const { section, parts, index } = entry;
    const add = (member: number, identity: unknown[], prefix = '') => {
      const raw = parts[member]; if (typeof raw !== 'string') return;
      const literal = raw.trim().slice(prefix.length).trim(); if (!literal) return;
      const key = JSON.stringify(['quantumultx', ...identity]); const occurrence = occurrences.get(key) || 0; occurrences.set(key, occurrence + 1);
      references.push({ slot: JSON.stringify([key, occurrence]), literal, owner: parts[0].trim(), write(value) {
        const offset = raw.indexOf(literal, raw.indexOf(prefix) + prefix.length);
        parts[member] = raw.slice(0, offset) + value + raw.slice(offset + literal.length);
        document.quantumultxLines[index] = parts.join(',');
      } });
    };
    if (section === 'policy') {
      const [type, name] = assignment(parts[0]);
      for (let member = 1; member < parts.length; member++) {
        if (parts[member].includes('=')) continue;
        const value = parts[member].trim();
        const prefix = type === 'ssid' && /^LINK_[^:]+:/.test(value) ? value.slice(0, value.indexOf(':') + 1) : '';
        add(member, ['policy', name, member], prefix);
      }
    } else if (section === 'filter_local') {
      const isFinal = /^final\s*(?:=|$)/i.test(parts[0].trim());
      if (isFinal && parts[0].includes('=')) add(0, ['final'], parts[0].slice(0, parts[0].indexOf('=') + 1).trim());
      else add(isFinal ? 1 : 2, ['filter_local', ...parts.map((part, member) => member === (isFinal ? 1 : 2) ? '$outbound' : part.trim())]);
    } else if (section === 'filter_remote') {
      const member = parts.findIndex(part => assignment(part)[0] === 'force-policy');
      if (member >= 0) add(member, ['filter_remote', parts[0].trim()], parts[member].trim().slice(0, parts[member].trim().indexOf('=') + 1));
    } else if (section === 'general' && assignment(parts[0])[0] === 'fallback_udp_policy') {
      add(0, ['general', 'fallback_udp_policy'], parts[0].trim().slice(0, parts[0].trim().indexOf('=') + 1));
    }
  }
  return references;
}
