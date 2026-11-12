# sing-box 出站引用与策略组核查

核查日期：2026-11-09。目标为当时 SubOne 声明的 sing-box 1.14.4；同时核对当时的官方文档与该版本源码。以下为该次核查记录。未修改业务代码或用户配置。

## 真实响应

用户提供的 sing-box 完整订阅链接返回 HTTP 422：

```text
sing-box 出站引用需修复
source-doh-dependency-missing
绑定需修复，缺少连接依赖：unresolved:🐟 漏网之鱼
reason: ordinary routing
```

该响应证明生成结果中存在无法解析的普通路由出站引用。它不证明缺失引用的具体位置或形成过程；不能据此认定与 Shadowrocket 的 load-balance 拒绝属于同一原因。为避免泄露订阅凭据，不保存完整链接。

## 官方要求

| 事项 | 文档或源码确认的事实 | 依据 |
| --- | --- | --- |
| 默认路由 | `route.final` 是默认出站的 tag；空值采用第一个出站。`🐟 漏网之鱼` 只是可自定义的名称，没有内置行为。 | [官方 Route 文档](https://sing-box.sagernet.org/configuration/route/#final)、[1.14.4 文档](https://github.com/SagerNet/sing-box/blob/v1.14.4/docs/configuration/route/index.md#final) |
| 路由规则 | `action: route` 的 `outbound` 字段填写目标出站 tag。 | [官方 Rule Action 文档](https://sing-box.sagernet.org/configuration/route/rule_action/#route) |
| 组成员 | `selector.outbounds` 填已有出站的 tag；1.14.4 启动时逐个查找成员，未找到会报错。 | [官方 Selector 文档](https://sing-box.sagernet.org/configuration/outbound/selector/)、[1.14.4 selector.go](https://github.com/SagerNet/sing-box/blob/v1.14.4/protocol/group/selector.go#L73-L81) |
| 默认出站检查 | 1.14.4 对不存在的显式默认出站返回 `default outbound not found`，不会把未知名称视为内置出口。 | [1.14.4 出站管理器](https://github.com/SagerNet/sing-box/blob/v1.14.4/adapter/outbound/manager.go#L37-L45) |
| 负载均衡 | 官方出站列表和 1.14.4 注册表中的策略组为 `selector`、`urltest`，没有原生 `load-balance` 类型。后两者不等同于负载均衡，不能宣称无损转换。 | [官方 Outbound 文档](https://sing-box.sagernet.org/configuration/outbound/)、[URLTest 文档](https://sing-box.sagernet.org/configuration/outbound/urltest/)、[1.14.4 注册表](https://github.com/SagerNet/sing-box/blob/v1.14.4/include/registry.go#L75-L101) |

## 与 SubOne 的对应关系

- `apps/server/src/services/node-references.ts` 的 `prepareTemplateReferences` 在模板引用无法匹配模板原生出站、内置目标、节点或策略组时保存 `unresolved:<名称>`；`resolveTemplateReferences` 在克隆配置中保留这一失效标记，避免悄悄换出口。
- `apps/server/src/services/generation/runtime-dependencies.ts` 的 `validateSingboxRuntime` 检查 `route.final`、路由规则以及策略组路径。该次报错路径为 `ordinary routing`，所以诊断码中的 `source-doh` 前缀不能作为实际 DoH 故障的证据。
- 仓库自带的 `templates/singbox-client.json`、`templates/singbox-gateway.json` 均出现 `route.final: 🐟 漏网之鱼`。这是排查线索，尚未读取该订阅保存的模板，不能断定用户当前一定使用了这两份模板。
- `apps/server/src/core/generators/singbox-generator.ts` 核查时把 `urltest` / `fallback` 生成成 `urltest`，其他非特殊策略组进入 `selector` 分支。已用 `pnpm --filter @subone/server exec tsx -e ...` 最小调用真实的 `injectUnifiedToSingbox`，输入名称为 `AUTO_HK`、类型为 `load-balance`、策略为 `round-robin` 的单成员组；断言并确认输出为 `selector`，且不含 `strategy`。这确认了生成函数会改变该策略的行为，不代表真实订阅在修好缺失引用后已经完整生成或导入成功。

## 后续处理边界

查找当前订阅的 `🐟 漏网之鱼` 引用及其原目标，核对模板、策略组身份和启用状态，再修复引用。官方文档说明空 `final` 的行为，不构成可以擅自清空用户默认路由或改成直连的授权。sing-box 原生无法表达的负载均衡策略需要明确呈现兼容性差异。

本次完成文档和响应核查；尚未修复、运行原生核心或验证客户端连接。
