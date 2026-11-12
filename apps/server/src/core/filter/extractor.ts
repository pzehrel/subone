import { ExtractionRule, ProxyNode } from '../../types/index';

export function applyExtractionRules(
  allNodes: ProxyNode[],
  rules: ExtractionRule[]
): ProxyNode[] {
  allNodes = allNodes.filter(node => node.enabled !== false);
  const activeRules = rules.filter(r => r.enabled);

  // If no active rules, return all nodes with deduplication and name sanitization
  if (activeRules.length === 0) {
    return deduplicateNodes(allNodes);
  }

  const selectedNodes: ProxyNode[] = [];
  const processedKeys = new Set<string>();

  for (const rule of activeRules) {
    // 1. Source filter
    const sourceMatchedNodes = allNodes.filter(node => {
      if (!rule.sourceIds || rule.sourceIds.length === 0) return true;
      return node.sourceId && rule.sourceIds.includes(node.sourceId);
    });

    for (const node of sourceMatchedNodes) {
      const nodeKey = `${node.id || ''}#${node.name}#${node.server}:${node.port}`;
      if (processedKeys.has(nodeKey)) continue;

      // 2. Country filter
      if (rule.targetCountries && rule.targetCountries.length > 0) {
        if (!node.countryCode || !rule.targetCountries.includes(node.countryCode)) {
          continue;
        }
      }

      // 3. Keyword include filter
      if (rule.includeKeywords && rule.includeKeywords.length > 0) {
        const matchesAnyInclude = rule.includeKeywords.some(kw =>
          node.name.toLowerCase().includes(kw.toLowerCase())
        );
        if (!matchesAnyInclude) continue;
      }

      // 4. Keyword exclude filter
      if (rule.excludeKeywords && rule.excludeKeywords.length > 0) {
        const matchesAnyExclude = rule.excludeKeywords.some(kw =>
          node.name.toLowerCase().includes(kw.toLowerCase())
        );
        if (matchesAnyExclude) continue;
      }

      // 5. Regex include filter
      if (rule.includeRegex) {
        try {
          const clean = rule.includeRegex.trim().replace(/^\(\?i\)/i, '').replace(/\(\?i\)/gi, '');
          const reg = new RegExp(clean, 'i');
          if (!reg.test(node.name)) continue;
        } catch (e) {
          console.error(`Invalid includeRegex: ${rule.includeRegex}`);
        }
      }

      // 6. Regex exclude filter
      if (rule.excludeRegex) {
        try {
          const clean = rule.excludeRegex.trim().replace(/^\(\?i\)/i, '').replace(/\(\?i\)/gi, '');
          const reg = new RegExp(clean, 'i');
          if (reg.test(node.name)) continue;
        } catch (e) {
          console.error(`Invalid excludeRegex: ${rule.excludeRegex}`);
        }
      }

      selectedNodes.push({ ...node });
      processedKeys.add(nodeKey);
    }
  }

  return deduplicateNodes(selectedNodes);
}

export function deduplicateNodes(nodes: ProxyNode[]): ProxyNode[] {
  nodes = nodes.filter(node => node.enabled !== false);
  // First pass: physical deduplication
  // Nodes are only treated as identical if both their connection config AND name match
  const seenKeys = new Set<string>();
  const physicalUnique: ProxyNode[] = [];
  for (const node of nodes) {
    const sig = `${node.type}:${node.server}:${node.port}:${node.name}:${node.uuid || node.password || ''}:${node.sni || ''}:${node.wsPath || ''}`;
    const key = node.id ? `${node.id}#${sig}` : sig;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      physicalUnique.push(node);
    }
  }

  return physicalUnique.map(node => ({ ...node }));
}
