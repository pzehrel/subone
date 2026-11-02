export class UnsupportedProxyGroupError extends Error {
  constructor(client: string, groupName: string) {
    super(`${client} 不支持链式代理策略组「${groupName}」，请移除该策略组后重试。`);
    this.name = 'UnsupportedProxyGroupError';
  }
}
