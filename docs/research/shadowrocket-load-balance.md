# Shadowrocket 分组负载均衡资料核查

核查日期：2026-11-09。范围：开发者网站、App Store 开发者信息、官方公告，以及配置作者维护的原始文件；未做 Shadowrocket 实机验证。后续工作按用户要求仅关注 Shadowrocket。

- **已证实功能**：[官方公告 318](https://t.me/ShadowrocketNews/318) 于 2020-08-23 宣布 Shadowrocket 2.1.60(1050) 增加分组负载均衡支持。公告未给出配置类型名称、配置行或调度细节，不能据此断言后续所有版本行为相同。[开发者网站](https://shadowlaunch.com/)链接到 [ShadowrocketApp 群组](https://t.me/ShadowrocketApp)，该群组列出 ShadowrocketNews 为公告频道；[App Store 页面](https://apps.apple.com/us/app/shadowrocket/id932747118)列明开发者为 Shadow Launch Technology Limited。
- **补充官方记录**：[公告 381](https://t.me/ShadowrocketNews/381) 在 2.2.8 更新说明中记录了代理组负载均衡 PCC 修复，但没有解释 PCC 或给出配置字段。公告 318 同时提到 Clash YAML 导入，不足以证明支持 Clash 的全部策略组字段。
- **尚未证实配置语法**：所查第一方资料没有完整的 `[Proxy Group]` 中 `名称 = load-balance, ...` 行，也没有明确成员列表、测试 URL、间隔、默认值或参数的必填规则。因此不能将此写法或任何参数组合当作已经官方证实；这不等于客户端不支持该写法。
- **尚未证实策略语义**：上述公告没有定义 `load-balance` 与 `random` 的差别，也没有确认同域名粘性、hash 算法或轮询选项。未找到 Shadowrocket 第一方资料证明 `strategy=consistent-hashing` 或 `strategy=round-robin` 是其原生配置字段或等价映射。
- **跨客户端对比，非 Shadowrocket 证据**：[Mihomo 官方负载均衡文档](https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/config/proxy-groups/load-balance.en.md)给出该客户端的 `strategy` 及 `consistent-hashing`、`round-robin` 等语义；不能把 Mihomo 的字段或行为直接推定为 Shadowrocket 的实现。

## 原始配置交叉核对

[LOWERTOP 的原始配置](https://github.com/LOWERTOP/Shadowrocket/blob/e1ee7d7a201fe55cfa3ec8f93d70fd6a76a33a3f/lazy_group.conf#L150-L178)在 `[Proxy Group]` 中列出 `load-balance` 与 `random`，并写明“名称 = 类型, 策略, 参数”的格式，成员可为节点或分组，参数示例包括 `interval`、`timeout`、`url`。这比“只有功能公告，没有任何文本写法”更具体；但它仍是作者维护的配置资料，不是开发者正式语法规范。

[同一作者维护的手册](https://github.com/LOWERTOP/Shadowrocket/blob/main/README.md#负载均衡)描述 `load-balance` 为同域名使用同一节点，`random` 可让同域名使用不同节点。其 [仓库说明](https://github.com/LOWERTOP/Shadowrocket/blob/main/README.md)明确声明非官方，且与 Shadow Launch Technology Limited 无关联；不能将它改称官方文档。上述语义可作为测试目标，尚未由本次客户端运行验证。

依照原始配置说明，可以构造以下**待客户端验证**的完整配置片段。成员名称仅为示例，须对应 `[Proxy]` 中已有声明；测试地址和周期来自当前组设置，不代表官方必填项或默认值。

```ini
[Proxy Group]
AUTO_HK = load-balance, HK 01, HK 02, url=http://www.gstatic.com/generate_204, interval=300
```

原始配置没有提供 Mihomo 的 `strategy=consistent-hashing` 或 `lazy=true` 字段依据；不直接把它们拼进上述文本。

## 当前订阅与实现

后续按用户要求补查了 GitHub 中的非注释分组声明：两个仓库和两份 Gist 分别展示正则筛选、订阅引用和显式成员列表，详见 [GitHub 配置实例](shadowrocket-github-config-examples.md)。这些是具体配置文本，超出前文仅有注释语法的证据范围；仍不称为官方规范或本次实机验证。

通过同一份下游订阅的 Mihomo 输出只提取策略组字段，确认当前 `AUTO_HK` 为 `load-balance`，设置 `strategy: consistent-hashing`、`lazy: true`、`interval: 300`，当前生成结果只有一个成员。没有保存完整输出、节点凭据或订阅 Token。该结果只是当前快照，不能据此把分组永久改为单节点或手动选择。

调查时，`apps/server/src/services/generation/adapters/shadowrocket.ts` 的前置类型检查拒绝所有 `load-balance`。`apps/server/src/core/generators/shadowrocket-generator.ts` 已有按原类型拼接分组行的路径，但仅为 `url-test`、`fallback` 输出测试 URL 与周期；`strategy`、`lazy` 未映射。

## 用户决定与输出调整

2026-11-09 用户明确要求先写入 `strategy`、`lazy`，接受暂未确认客户端支持的状态，遇到客户端报错再处理。因此放行 `load-balance`，输出成员、测试 URL、周期，并原样写入显式设置的这两个选项；未设置时不补造值。该决定仅适用于当前 Shadowrocket 工作，不推进此前暂缓的其他客户端问题。

已在真实应用的临时数据 HTTP 回归中确认：三种策略值、`lazy=true`、`lazy=false`、未设置选项、默认测试参数，以及预览、完整下载和重启后的输出。修改前该回归返回 HTTP 422，修改后 Shadowrocket 的 13 项 HTTP 测试全部通过。

官方完整语法、`consistent-hashing` 的算法等价性和 `lazy` 的客户端效果仍未确认；不能将用户接受尝试写成已经证实客户端会忽略未知字段。尚未做 Shadowrocket 实机导入或部署到用户提供链接所在的服务。
