# Shadowrocket GitHub 配置实例

核查日期：2026-11-09。以下是四个不同社区作者发布的配置文本（两个仓库、两份 Gist），不是 Shadowrocket 官方开发者文档。每行均为 `[Proxy Group]` 内未注释的分组声明；这只能证明配置中声明了分组，不能证明用户实际导入、匹配到多个节点或运行成功。

## tickmao/Rules

作者在文件头将其标为自用 Shadowrocket 配置；[分组段从第 21 行开始](https://github.com/tickmao/Rules/blob/f34d4303f26f4fecb189ef698b934dad8f80af8a/Shadowrocket/Shadowrocket.conf#L21)，[第 60 行](https://github.com/tickmao/Rules/blob/f34d4303f26f4fecb189ef698b934dad8f80af8a/Shadowrocket/Shadowrocket.conf#L60)为：

```ini
US Balance = load-balance,policy-regex-filter=🇺🇸|美|US|USA|States|America,url=http://latency-test.skk.moe/endpoint,interval=300
```

按正则筛选节点，没有显式成员或 `use`；设置了测试 URL 和 `interval=300`，未指定 `timeout`、`strategy` 或 `lazy`。同文件另有启用的 [JP 和 EU 分组](https://github.com/tickmao/Rules/blob/f34d4303f26f4fecb189ef698b934dad8f80af8a/Shadowrocket/Shadowrocket.conf#L61-L62)，其他若干地区分组则被注释。

## SANYIMOE/Quan_Shado_Conf

[文件头标注 SANYIMOE 版权](https://github.com/SANYIMOE/Quan_Shado_Conf/blob/40cf154400b9a89323e07eaba80c9b411343f1bc/conf/shadowrocket.conf#L1-L3)，[分组段从第 58 行开始](https://github.com/SANYIMOE/Quan_Shado_Conf/blob/40cf154400b9a89323e07eaba80c9b411343f1bc/conf/shadowrocket.conf#L58)。例如[第 110 行](https://github.com/SANYIMOE/Quan_Shado_Conf/blob/40cf154400b9a89323e07eaba80c9b411343f1bc/conf/shadowrocket.conf#L110)：

```ini
🇭🇰香港(负载均衡) = load-balance,url=http://www.gstatic.com/generate_204,interval=600,timeout=5,select=0,policy-regex-filter=^(?=.*(🇭🇰|港|虚通|(?i)HK|Hong))(?!.*(回国|校园|游戏|教育|(?i)GAME|IPV6)).*$
```

按香港相关名称正则筛选并排除部分节点；没有显式成员或 `use`。指定 URL、`interval=600`、`timeout=5` 和 `select=0`；未指定 `strategy` 或 `lazy`。紧邻的[第 109 行](https://github.com/SANYIMOE/Quan_Shado_Conf/blob/40cf154400b9a89323e07eaba80c9b411343f1bc/conf/shadowrocket.conf#L109)名称虽写“故障转移”，实际类型是 `random`：

```ini
🇭🇰香港(故障转移) = random,url=http://www.gstatic.com/generate_204,interval=600,timeout=5,select=0,policy-regex-filter=^(?=.*(🇭🇰|港|虚通|(?i)HK|Hong))(?!.*(回国|校园|游戏|教育|(?i)GAME|IPV6)).*$
```

## Mionlp 的 Config-MM.conf

[作者发布的 Gist](https://gist.github.com/Mionlp/83efce9332b0062936faae361b8f9ae7)在 `[Proxy Group]` 内声明：

```ini
LB = load-balance,HOSTED OUTLINE,use=true,interval=600,timeout=5,url=http://www.gstatic.com/generate_204
```

引用订阅名称 `HOSTED OUTLINE`，带 `use=true`、测试 URL、`interval=600`、`timeout=5`，没有 `strategy` 或 `lazy`。这证明作者提供了订阅引用形式的负载均衡声明，不证明当前设备上存在该订阅或规则已使用此分组。核对的是 Gist 文件正文，未将其中无关的节点、证书内容纳入笔记。

## wiihunting 的 Shadowrocket_202603.conf

[作者发布的 Gist](https://gist.github.com/wiihunting/1612163a885c07edc25a01f5a4cb28cd)在 `[Proxy Group]` 内声明：

```ini
YouTube = load-balance, 自动选择, 🇭🇰HK, 🇨🇳TW, 🇸🇬SG, 🇯🇵JP, 🇺🇸US, url=http://www.gstatic.com/generate_204, timeout=5, tolerance=100, interval=600
```

列出多个成员；同一段中 `自动选择` 被声明为 `url-test`，所以至少包含嵌套分组引用，不能将列表一概称为直接节点。设置测试 URL、`timeout=5`、`tolerance=100`、`interval=600`，没有 `strategy` 或 `lazy`。文件头有 Shadowrocket 时间戳，但本次不把时间戳当作运行成功证明。

## 归纳

上述四个作者的配置分别展示正则筛选、订阅引用、显式成员列表。所摘录的分组行均没有 `strategy` 或 `lazy`，因此能为基础 `load-balance` 文本输出提供具体参考，不能确认这两个 Mihomo 参数的等价映射。SANYIMOE 的重复转载不计作新作者；Surge、Loon 的同名分组语法不作为 Shadowrocket 证据。

文本无法确定各版本是否接受所有参数、默认值、调度算法或均衡效果。本次未改业务代码或用户配置，未做客户端导入验证。
