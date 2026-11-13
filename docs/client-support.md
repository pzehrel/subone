# 客户端支持与验证

配置资料复核日期：2026-11-07；运行验证记录更新日期：2026-11-13。输入格式、输出目标与真实客户端加载是三项不同的支持范围。

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

来源 DoH 属于一次成功更新的结果，自动绑定该来源全部解析节点，全部服务按输入顺序保存。六种完整输出按节点服务器域名汇总、去重合并上游 DoH，同域名节点共享，包括自身来源无 DoH 的节点；该域名没有任何上游 DoH 时沿用模板 DNS。决定见 [ADR 0001](adr/0001-source-doh-bindings.md)。

节点域名范围由程序自动生成：按 DNS 标签归并使用相同 DoH 组合的同层子域，公共后缀及私有后缀作为边界，检查已知的其他解析意图、DoH 服务和引导域名。父域本身单独处理，无法归并时保留完整域名。范围不会改写保存的来源绑定。决定见 [ADR 0002](adr/0002-node-domain-ranges.md)。

| 目标与核验版本 | 配置能力与输出方式 |
| --- | --- |
| [sing-box 1.14.4](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4) | 程序按域名范围为节点分配 `domain_resolver`，引用同域合并后的首项 DoH，并明确报告其余未采用项。使用 typed HTTPS DNS，保留已有出站、引导和连接选项处理。DNS 规则使用域名、后缀或正则字段，没有直接填写 glob 的字段。[节点解析](https://sing-box.sagernet.org/configuration/shared/dial/#domain_resolver)、[DNS 规则](https://sing-box.sagernet.org/configuration/dns/rule/) |
| [Mihomo 1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33) | 将范围及完整 DoH 列表写入 `dns.proxy-server-nameserver-policy`。`*.example.com` 匹配单级子域；父域及多级子域另有原生语法。模板需提供有效的基础 DNS 和引导配置。合并后的规则参与必要连接及循环检查。[DNS](https://wiki.metacubex.one/config/dns/)、[通配语法](https://wiki.metacubex.one/en/handbook/syntax/#domain-wildcards) |
| [Loon 3.5.3](https://apps.apple.com/hk/app/loon/id1373567447) | 节点通过 `server-dns="https://a/dns-query,https://b/dns-query"` 使用完整 DoH 列表；3.5.2 (996)+ 支持并发查询并采用首个有效结果。Host Map 支持 `*`、`?`。[节点 DNS](https://nsloon.app/en/docs/Node/#node-dns)、[Host 通配](https://nsloon.app/en/docs/Node/subscription/#host) |
| [Quantumult X](https://apps.apple.com/us/app/quantumult-x/id1443988620)，实测 1.8.0 build946（macOS） | 在 `[dns]` 保留同域合并后的全部 DoH，按来源及服务顺序，每项独立输出一行 `doh-server = /范围/URL`；保留未被接管的模板 DNS。配置注释说明 1.8.0 同域仅首条生效，支持叠加的新版可使用多条。单项绑定、glob、别名及同域拆行已实测；同行多 URL 的绑定对照失败，不采用该写法。[官方样例](https://raw.githubusercontent.com/crossutility/Quantumult-X/master/sample.conf) |
| [Egern 2.21.0](https://apps.apple.com/us/app/egern/id1616105820) | `forward` 的精确域名或 `domain_wildcard` 指向 `upstreams` 多 DoH 组。配置 `proxy_nameservers` 会绕过这些规则，因此要求先修复模板；不擅自修改其他域名的解析路径。代理 DNS 的原生上游连接为直连。[DNS](https://egernapp.com/docs/configuration/dns/) |
| [Shadowrocket 2.2.93](https://apps.apple.com/us/app/shadowrocket/id932747118) | 在 `[Host]` 输出 `*.example.com = server:https://a/dns-query,https://b/dns-query`：一个 `server:` 前缀，URL 用逗号连接，无引号。官方 2.2.92 确认 Host 多服务器；具体写法由配置作者发布的完整原始配置交叉核对，后者属于社区资料。[官方公告](https://t.me/s/ShadowrocketNews?before=1650)、[原始配置第 308 行](https://github.com/budaobu/rules/blob/b97b9f322c23be5ad0dad096d9bafc9b3e124304/conf/lazy_rocket.conf#L308) |

Quantumult X 的上述多行输出兼容已验证的 macOS 1.8.0 build946，旧版运行时只使用首条不要求从配置删除后续行。[1.8.1 build950 的 iOS TestFlight 公告](https://t.me/QuanXNews/431)已明确新增同一域名范围多条 DNS 规则叠加并发查询，示例为同一范围分别写多行 `doh-server`，并说明旧行为仅首条生效。截至 2026-11-13，[iOS 商店页面](https://apps.apple.com/us/app/quantumult-x/id1443988620)显示 1.8.1 于 10 月 7 日发布，[macOS 商店页面](https://apps.apple.com/us/app/quantumult-x/id1443988620?platform=mac)仍为 1.8.0；后续 [1.9.0 build952 公告](https://t.me/QuanXNews/434)已将该 DNS 能力列入 iOS、tvOS 和 macOS 的测试范围。本项目尚未实机验证这些新版，不将 iOS 测试能力作为 macOS 1.8.0 的能力依据。全局多个 DoH 的逗号列表是另一种已在[官方样例](https://github.com/crossutility/Quantumult-X/blob/master/sample.conf#L54-L56)中明确支持的配置，不能把本轮域名绑定对照概括为 Quantumult X 整体不支持多个 DoH。

预览及下载头中的 DoH 采用结果表示生成配置实际写入的服务。完整多行输出记录全部已写入项，不把后续项报告为生成器未采用；客户端是否使用这些行取决于其版本能力，采用结果不代表在线连通检测。

2026-11-12 的 Quantumult X 1.8.0 build946 域名绑定对照，已按当时的生成参数及原生任务回传复核。核心绑定结构共四种；下表的 `D` 表示同一节点服务器域名，`A`、`B` 表示完整 DoH URL。

| 绑定结构 | `doh-server` 右侧示意 | 实测结果 |
| --- | --- | --- |
| 单域单项 | `/D/A` | 健康服务成功，故意失效服务失败，绑定生效。 |
| 逗号连接，每项重复域名前缀 | `/D/A, /D/B` | 失败；调整服务顺序后仍失败。 |
| 逗号连接，仅首项带域名前缀 | `/D/A, B` | 失败，回传为 `No DNS results`。 |
| 同域服务分别写独立行 | 一行 `/D/A`，另一行 `/D/B` | 健康服务排首成功，失效服务排首失败；交换顺序后复核首条生效。 |

两种同行逗号结构还分别测试了重复同一健康 DoH：单项参照成功，重复列表均为 `No DNS results`。按服务组合细分，共六类绑定用例；不同服务与重复健康服务是同一语法的参数对照。仅首项带域名前缀的用例标识为 `scope-prefix-once`，其 `Scope-Reference` 成功、`Scope-Duplicate` 和 `Scope-Distinct` 失败，配对 IP、范围外及普通上网检查成功。全局多个 DoH 的逗号列表和 glob 单项另外验证通过，分别属于非绑定对照与单项匹配范围变体。以上结论限定于当时的 macOS 1.8.0 build946。

官方文档及配置样例作为能力依据，真实客户端加载单独记录。各客户端通配符的层级、父域匹配及字段不同，不将同一个 glob 字符串直接复制为所有目标的配置。与来源范围完全对应的模板 Host 映射由来源 DNS 接管；更宽的 Host 覆盖无法保留其他域名行为时明确要求修复。

来源指定的 DoH 出站、引导解析器及其他连接参数仅在目标能够完整表达时采用；无法转换时保留模板 DNS 并报告未生效。DoH 出站没有独立编辑入口，也不提供独立 DoH 服务库或手工覆盖。

## 依赖、来源输出与纯节点

预览、完整订阅与来源/provider 输出共用生成计划和节点命名。必要连接可补齐仍存在且启用的节点或策略组，并在预览单独列出。禁用、删除、信息节点或停用来源不会因依赖补齐恢复；依赖节点不进入普通候选、来源节点/provider 正文或普通来源用量汇总。模板原生动态候选无法确认隔离必要依赖时，完整输出要求修复，不以警告放行。

Mihomo 的 `include-all`、`include-all-proxies` 与额外依赖节点组合时，完整输出要求改用明确的普通候选；动态组使用原生筛选表达式而无法完整核验成员时，也要求修复。Quantumult X 的 `server-tag-regex` 策略和内置 `proxy` 同样不能与未隔离的依赖节点组合输出。未被来源节点/provider 使用的模板路由不影响其节点正文。

独立来源节点/provider 只切片该下游订阅普通选择中属于请求来源的节点，不转发原始上游链接。来源输出不是完整配置：例如 Mihomo provider 不承载主配置 DNS，Loon 节点行则可包含已确认的 `server-dns` 字段。

六种完整输出及预览始终直接包含所选节点及必要连接依赖；`expand=false`、`expand=0` 和预览中的非展开参数也采用相同行为。不自动生成需要再次下载的节点资源，也不自动追加以上游名称命名的策略组。用户明确选择的策略组、来源筛选和模板中已有的外部节点资源、远程规则继续保留。

节点定义与引用在客户端下次更新整份订阅时一同生效。已使用旧远程节点模式的客户端需要重新获取整份订阅。独立来源切片、格式化节点及 Quantumult X 的 `/s/:token/nodes/qx` 入口继续可用，但完整输出不再引用这些节点资源；它们不保证与另一时刻的旧完整配置使用相同编号。

纯节点输出是 Base64 编码的 URI 列表，只包含所选且启用的普通节点，不承载 DoH、DNS 规则、策略组或完整模板，不补齐未使用的 DNS 依赖。节点间链路在 URI 中不生效并报告警告；无 URI 表达的协议会被省略并明确报告。不会生成猜测的 URI 出站字段，也不承诺与来源原始节点完全往返一致。

实际使用的必要出站或引导缺失、失效或成环时，受影响输出要求修复。检查覆盖仍可选的全部成员路径，不自动换出口、删成员或添加公共 DNS。Relay、协议、传输、原生策略和远程规则仍受各目标能力限制，不承诺所有客户端相同。

Shadowrocket 完整输出支持 `load-balance` 分组，包含成员、测试 URL 和周期；显式设置的 `strategy`、`lazy` 也会写入，`lazy=false` 会保留。这两个选项是否生效及客户端如何处理未知字段尚未实机验证。

## 验证记录

| 验证层 | 已有证据及限制 |
| --- | --- |
| HTTP 与持久化 | 271/271 服务端测试通过，零跳过；同时启用 sing-box 和 Mihomo 原生校验。使用真实本地应用、可控上游、临时存储和重启，验证来源事务、稳定身份、策略组及 YAML、绑定、诊断、必要依赖、普通候选隔离和来源输出边界。覆盖自动范围归并、公共及私有后缀、同域多来源去重与共享、别名成功快照、按范围记录采用结果、模板覆盖、同一行内多个 DNS 作用域的保留、来源默认引导诊断及生成通配规则的循环检查。 |
| 浏览器 | 2026-11-06 已有记录：真实 HTTP 下完成策略组桌面与手机的 17 项行为检查；上游、节点和六目标预览另有贯穿检查。覆盖错误保留、重试、稳定选择、禁用、Relay、YAML 与重载，无页面异常或横向溢出。 |
| 格式与引用 | 对目标结构、命名、原生引用、模板保留和不支持能力做自动检查。文件可解析、HTTP 200 或引用检查通过不代表真实客户端已加载。 |
| sing-box 原生验证 | 官方 Linux 1.14.4 对 HTTP 生成配置执行 `check -c` 及隔离短时启动，已通过；IMM 106 节点输出另通过原生检查。 |
| Mihomo 原生验证 | 本机 `verge-mihomo` 1.19.33 对 HTTP 生成配置执行 `-t` 及隔离短时启动，已通过；IMM 106 节点输出另通过原生检查。 |
| Apple 客户端加载 | 2026-11-08 用户在 Quantumult X 1.8.0（Mac）确认：完整下载直接可见 169 个节点。2026-11-13 已补充在 1.8.0 build946、macOS 27.0.1 的节点解析与连接对照：单域单 DoH、原有 glob 和别名可用；无效绑定失败时配对 IP 节点仍可连接。保留 169 个节点的单 DoH 配置中，5 条代表性别名/解析路径及配对 IP 控制通过，用户另确认延迟优选组的测速和网页访问正常；未逐一测试全部节点或完整分流规则。Loon、Egern、Shadowrocket 的真实应用加载仍为 **UNVERIFIED**。 |
| 六目标首次下载 | 2026-11-08 真实订阅的六种默认输出均直接包含 169 个节点，没有自动生成的远程节点资源或上游分组。新增 HTTP 交叉回归验证所选节点、禁用及排除节点、策略组和默认预览一致性；该检查无需客户端再次获取节点资源。Loon、Egern、Shadowrocket 仅完成输出及格式检查，尚未进行实机导入。 |

2026-11-08 跨客户端修复的 `pnpm check` 与 `pnpm build` 通过；服务端 301 项、前端 3 项测试全部通过，零跳过。已启用 Mihomo 1.19.33 与 sing-box 1.14.4 的原生校验及隔离短时启动；真实订阅的两份 169 节点配置另分别通过原生配置检查。此前 Quantumult X 单项修复阶段为服务端 287 项、前端 3 项通过，4 项可选原生核心校验未启用。

2026-11-09 Shadowrocket 负载均衡输出调整后，`pnpm check` 与 `pnpm build` 通过；服务端 295 项、前端 3 项测试通过，6 项可选原生核心检查未启用。Shadowrocket 的 13 项 HTTP 测试全部通过，覆盖负载均衡成员、测试参数、显式 `strategy`、`lazy=true/false`、完整下载及重启后的输出；尚未在真实 Shadowrocket 客户端导入。

2026-11-07 已执行 `pnpm typecheck`、`pnpm lint`、`pnpm test` 与 `pnpm build`；类型检查、测试和构建通过，lint 保留已有告警。该次原生测试通过 `SUBONE_SINGBOX_BINARY` 和 `SUBONE_TEST_MIHOMO` 指定可用核心，两项检查均已启用。

原生校验和短时启动只证明所测配置的解析、引用及初始化；没有验证外部 DNS 应答、代理握手或生产网络连通。不会把生成成功写成实机可用。

2026-11-13 Quantumult X 对照还区分了输出能力与服务连通性：某上游首项 DoH 在原生绑定中间歇失败，macOS 日志显示 TCP RST 发生在 TLS 握手期间、HTTP/DNS 请求发送前；同一客户端也记录到成功连接。当前证据无法确认 RST 的发送方。临时采用后续服务的配置通过，不代表生成器可以自动改变上游顺序；正式输出按 ADR 0001 保留全部服务并逐项分行，1.8.0 仍只使用首条，不替换为全局 DoH。

2026-11-13 多行输出修订后，51 项相关回归全部通过，覆盖同域完整列表、来源顺序、去重、整范围转换、预览/下载/重启一致性及来源保存。`pnpm check` 与 `pnpm build` 通过：服务端 364 项、前端 3 项通过，4 项可选 sing-box 原生检查因缺少二进制跳过；已启用本机 Mihomo 检查。真实 169 节点配置的生成对照中，4 个域名范围由 4 条首项记录变为 12 条完整记录（每范围分别 4、2、4、2 项），各范围首条保持一致，其他配置及 6 个 AUTO 延迟优选组一致；本次新生成文件尚未再次实机导入，新版并发行为仍未实测。
