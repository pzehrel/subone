# 客户端支持与验证

核验日期：2026-11-06。输入格式、输出目标与真实客户端加载是三项不同的支持范围。

## 上游输入

| 输入 | 解析范围 |
| --- | --- |
| Clash/Mihomo YAML | 受支持的代理节点及 HTTPS DNS 配置 |
| sing-box JSON | 受支持的代理出站及 HTTPS DNS 配置；保留来源中的原始连接参数 |
| Quantumult X | 原生节点列表或完整配置中的本地节点，以及可识别的 DoH 配置 |
| URI 列表 | 已实现解析的节点 URI，不携带完整 DNS 配置 |
| Base64 包装 | 解码后按受支持正文执行相同解析 |

六类完整输出不等于六类完整上游配置均可输入。Loon、Egern、Shadowrocket 完整配置不在已确认的结构化上游输入范围内。输入可解析也不保证每个目标可表达其全部协议、传输或连接选项。

上游普通 DNS、DoT 和其他未导入配置仍完整保留在原文。范围内节点或 DoH 条目解析不完整时，整次更新失败；合法完整空结果可成功清空旧结果。已有来源解析失败时保留新取回的完整原文用于排查，同时保留上次成功的节点及 DoH。首次添加失败不创建来源。

Base64 原文保留编码与内层格式信息；查看、复制和下载均使用取回的原始正文，编码正文下载为 `.txt`。

## 完整输出与来源 DoH

来源 DoH 属于一次成功更新的结果，自动绑定该来源全部解析节点。全部服务按输入顺序保存，客户端降级不改写来源意图。无 DoH 或成功更新移除 DoH 后保留模板 DNS；模板未接管的 DNS、DoT、规则和选项继续保留。

| 目标与核验版本 | 来源节点解析 DoH 的映射 |
| --- | --- |
| [sing-box 1.14.4](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4) | 节点 `domain_resolver` 指向 typed HTTPS DNS。该引用为单项，采用首项并报告其余服务未映射；已证实的出站与引导参数受最终依赖检查约束。[字段](https://sing-box.sagernet.org/configuration/shared/dial/#domain_resolver)、[HTTPS DNS](https://sing-box.sagernet.org/configuration/dns/server/https/) |
| [Mihomo 1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33) | 使用 `dns.proxy-server-nameserver-policy` 的域名键和有序服务数组。相同服务器域名的来源意图冲突时，保留该域名的模板 DNS 并逐项诊断；其他不冲突域名仍可映射。模板须具备明确且有效的基础 DNS 与引导配置。[DNS](https://wiki.metacubex.one/config/dns/) |
| [Loon 3.5.3](https://apps.apple.com/hk/app/loon/id1373567447) | 文档确认 3.5.2 (996)+ 的节点 `server-dns` URL 列表。仅在可表达时输出，状态为降级：原生 DoH 传输和独立引导仍未证实。显式不支持的出站、引导、TLS/headers、列表语法或优先 Host 映射使相关来源绑定不生效，并保留模板路径。[节点 DNS](https://nsloon.app/docs/Node/#节点-dns)、[Host Map](https://nsloon.app/docs/DNS/hostmap/) |
| [Quantumult X 1.8.1](https://apps.apple.com/us/app/quantumult-x/id1443988620) | 官方样例的普通域名 DoH 不足以证明节点服务器解析、专用出站或独立引导能力。保留模板 `[dns]`，逐项报告来源绑定未生效，不生成猜测字段。[官方样例](https://raw.githubusercontent.com/crossutility/Quantumult-X/master/sample.conf) |
| [Egern 2.21.0](https://apps.apple.com/us/app/egern/id1616105820) | `proxy_nameservers` 是已证实的共享直连能力，但官方“代理目标域名”的表述不足以证明来源节点服务器绑定。保留模板 DNS 并逐项报告绑定未生效。完整输出使用原生 typed `proxies`、`policy_groups`、`rules`。[DNS](https://egernapp.com/docs/configuration/dns/)、[完整示例](https://egernapp.com/docs/configuration/example/) |
| [Shadowrocket 2.2.93](https://apps.apple.com/us/app/shadowrocket/id932747118) | 开发者确认通用加密 DNS；来源节点服务器解析、专用出站、独立引导和多服务语义未获一手字段证据。保留模板 DNS 并逐项报告来源绑定未生效，不生成猜测字段。 |

只采用上游及模板明确提供的连接参数，不提供独立 DoH 服务库、手工覆盖或额外出站编辑入口。目标不能分别表达来源绑定时，保留模板 DNS 并列出未生效项；不任意选择另一来源覆盖。

## 依赖、来源输出与纯节点

预览、完整订阅与来源/provider 输出共用生成计划和节点命名。必要连接可补齐仍存在且启用的节点或策略组，并在预览单独列出。禁用、删除、信息节点或停用来源不会因依赖补齐恢复；依赖节点不进入普通候选、来源节点/provider 正文或普通来源用量汇总。模板原生动态候选无法确认隔离必要依赖时，完整输出要求修复，不以警告放行。

Mihomo 的 `include-all`、`include-all-proxies` 与额外依赖节点组合时，完整输出要求改用明确的普通候选；动态组使用原生筛选表达式而无法完整核验成员时，也要求修复。Quantumult X 的 `server-tag-regex` 策略和内置 `proxy` 同样不能与未隔离的依赖节点组合输出。未被来源节点/provider 使用的模板路由不影响其节点正文。

来源节点/provider 只切片该下游订阅普通选择中属于请求来源的节点，生成链接指向受 Token 保护的 SubOne 端点，不保留原始上游链接旁路。来源输出不是完整配置：例如 Mihomo provider 不承载主配置 DNS，Loon 节点行则可包含已确认的 `server-dns` 字段。

纯节点输出是 Base64 编码的 URI 列表，只包含所选且启用的普通节点，不承载 DoH、DNS 规则、策略组或完整模板，不补齐未使用的 DNS 依赖。节点间链路在 URI 中不生效并报告警告；无 URI 表达的协议会被省略并明确报告。不会生成猜测的 URI 出站字段，也不承诺与来源原始节点完全往返一致。

实际使用的必要出站或引导缺失、失效或成环时，受影响输出要求修复。检查覆盖仍可选的全部成员路径，不自动换出口、删成员或添加公共 DNS。Relay、协议、传输、原生策略和远程规则仍受各目标能力限制，不承诺所有客户端相同。

## 验证记录

| 验证层 | 已有证据及限制 |
| --- | --- |
| HTTP 与持久化 | 最终审查修复检查：246/246 服务端测试通过，零跳过。使用真实本地应用、可控上游、临时存储和重启，验证来源事务、稳定身份、策略组及 YAML、绑定、诊断、必要依赖、普通候选隔离和来源输出边界。新增覆盖编码原文、端口诊断、原生动态成员循环与隔离、不支持的节点连接出站。 |
| 浏览器 | 真实 HTTP 下完成策略组桌面与手机的 17 项行为检查；上游、节点和六目标预览另有贯穿检查。覆盖错误保留、重试、稳定选择、禁用、Relay、YAML 与重载，无页面异常或横向溢出。 |
| 格式与引用 | 对目标结构、命名、原生引用、模板保留和不支持能力做自动检查。文件可解析、HTTP 200 或引用检查通过不代表真实客户端已加载。 |
| sing-box 原生验证 | 官方 Linux 1.14.4 对实际 HTTP 生成配置执行 `check -c` 及隔离的短时启动，已通过。 |
| Mihomo 原生验证 | 本机 `verge-mihomo` 1.19.33 对实际 HTTP 生成配置执行 `-t` 及隔离的短时启动，已通过。 |
| Apple 客户端加载 | Loon、Quantumult X、Egern、Shadowrocket 在本 Linux 环境没有可用客户端，真实应用加载均为 **UNVERIFIED**。 |

本轮执行 `pnpm typecheck`、`pnpm lint`、`pnpm test` 与 `pnpm build`，均通过。原生测试通过 `SUBONE_SINGBOX_BINARY` 和 `SUBONE_TEST_MIHOMO` 指定可用核心；本轮同时启用两项检查。

原生校验和短时启动只证明所测配置的解析、引用及初始化；没有验证外部 DNS 应答、代理握手或生产网络连通。不会把生成成功写成实机可用。
