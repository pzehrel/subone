# SubOne

本项目 fork 自 [cfm019/subone](https://github.com/cfm019/subone)。感谢原作者 [cfm019](https://github.com/cfm019) 及所有贡献者的工作。当前仓库为 [pzehrel/subone](https://github.com/pzehrel/subone)。

原项目文档：[cfm019/subone-doc](https://cfm019.github.io/subone-doc/)。本仓库的来源模型与客户端支持范围见下文及[客户端支持与验证](docs/client-support.md)。

SubOne 管理上游订阅，保存实际订阅原文，将解析节点、策略组、分流规则和模板组合为下游订阅。所有节点均来自上游；本地设置支持改名与禁用。

支持生成 sing-box、Mihomo、Loon、Quantumult X、Egern 和 Shadowrocket 六类完整配置，以及 Base64 编码的纯节点 URI 列表。输入格式与客户端能力分别说明，见[客户端支持与验证](docs/client-support.md)。

---

## 快速开始

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pzehrel/subone/main/install.sh)
```

- **控制台访问**：`http://<你的VPS_IP>:3456`
- **安装目录**：`/opt/subone`
- **配置文件**：`/opt/subone/config.json`（默认免密直接登录，修改 `adminPassword` 后重启可启用密码）
- **常用命令**：
  ```bash
  # 一键更新到最新版本并重新编译重启
  bash /opt/subone/install.sh update

  # 服务管理
  systemctl status subone     # 查看状态
  journalctl -u subone -f     # 查看实时日志
  systemctl restart subone    # 重启服务
  systemctl stop subone       # 停止服务
  ```

### Docker 运行

先克隆本仓库并进入项目目录，再构建镜像：

```bash
git clone https://github.com/pzehrel/subone.git
cd subone
docker build -t subone:local .

docker run -d \
  --name subone \
  --restart unless-stopped \
  -p 3456:3456 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/templates:/app/templates \
  subone:local
```

或使用 Docker Compose：

```bash
docker compose up -d --build
```

Docker 配置保存在 `data/server-config.json`。重建容器时，请保留 `data/` 和 `templates/` 目录。

### 登陆后请立即设置访问密码
现在默认是免密登录的，请一定登陆后修改设置，添加密码，否则暴露在公网存在安全风险。

---



## 主要特性

- **上游与原文**：保存最近一次完整取回的订阅正文，支持查看、复制和下载。节点与上游 DoH 按单次成功更新整体生效；失败保留上次生效结果，批量更新按来源分别处理。
- **解析节点**：按上游来源分组，支持查看连接信息、本地改名与禁用。来源内连接身份唯一且未变时，改名或调序保留本地设置；不同来源分别保留。
- **订阅信息**：支持用节点名称正则匹配用量与到期提示。匹配项不进入可用节点或输出；响应头信息优先，缺失项使用匹配结果。修改规则可按缓存重新分类。
- **策略组与规则**：保留来源挂载、显式出站、节点正则、Relay 顺序、测速参数、YAML 编辑和分流规则管理。具体策略、协议、传输及规则能否输出，由目标适配器检查并报告。
- **下游订阅**：每份配置有独立 Token，可选择节点、策略组、规则和模板，生成六类客户端配置或纯节点列表。用量汇总所选普通来源，不计入仅为连接补齐的依赖来源；未知信息保持未知。
- **来源 DoH**：上游 DoH 自动绑定该来源全部解析节点。生成预览显示实际映射、降级、未生效项和必要依赖；无上游 DoH 时保留模板 DNS。详细能力与验证范围见[客户端支持与验证](docs/client-support.md)。

## 源码编译部署
## 1. 环境要求

- **Node.js**：`24.22.2`（24 LTS，版本见 `.nvmrc`、`.node-version`）。
- **pnpm**：`12.16.1`（版本见 `package.json` 的 `packageManager`）。

```bash
nvm install
nvm use
npm install --global pnpm@12.16.1
```

| 目录 | 包名 | 用途 |
| :--- | :--- | :--- |
| `apps/server` | `@subone/server` | API 与订阅服务 |
| `apps/web` | `@subone/web` | Web 控制台 |
| `templates` | — | 各客户端的默认配置模版 |

## 2. 配置与编译

服务启动依赖根目录 `config.json` 或环境变量，示例文件见 [config.example.json](config.example.json)。

### 配置文件 `config.json`

```json
{
  "port": 3456,
  "adminPassword": "YOUR_ADMIN_PASSWORD"
}
```

- `port`: 服务监听端口，默认 `3456`。
- `adminPassword`: Web 控制台管理密码。若留空或未设置，则不启用登录鉴权。


### 环境变量（可选）

也可直接通过环境变量配置：
- `PORT`
- `ADMIN_PASSWORD`


```bash
# 确认 Node 版本为 24 LTS
node -v

# 安装依赖
pnpm install --frozen-lockfile

# 编译后端与前端
pnpm build
```

本地开发与检查命令：

```bash
pnpm dev             # 启动 API 和 Web 控制台
pnpm dev:server      # 仅启动 API（默认 3456）
pnpm dev:web         # 仅启动 Web 控制台（默认 5173）
pnpm check           # 类型检查、代码检查和测试
pnpm start           # 启动编译后的服务
```

配置、数据与模版统一位于仓库根目录的 `config.json`、`data/`、`templates/`。

### 3. 后台常驻运行 (Systemd 服务)

创建服务文件 `/etc/systemd/system/subone.service`：

```ini
[Unit]
Description=SubOne Subscription Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/subone
ExecStart=/usr/bin/node /root/subone/apps/server/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> 注：可通过 `command -v node` 查询 Node.js 的绝对路径，并替换 `ExecStart` 中的 `/usr/bin/node`；`WorkingDirectory` 请替换为实际项目所在目录。

管理服务命令：

```bash
# 重载并启动服务，设置开机自启
systemctl daemon-reload
systemctl enable --now subone

# 查看运行状态
systemctl status subone

# 查看实时日志
journalctl -u subone -e -f

# 重启 / 停止服务
systemctl restart subone
systemctl stop subone
```

### 4. 反向代理 (Caddy)

公网部署建议使用 Caddy 反向代理并自动申请 HTTPS 证书：

```caddy
sub.yourdomain.com {
    reverse_proxy 127.0.0.1:3456
    encode gzip zstd
}
```

```bash
caddy reload
```

## 订阅端点与格式分发

每个订阅配置（Profile）拥有独立的访问 Token，可通过下列路径或请求头获取对应格式：

| 客户端 / 场景 | 专用订阅路径 | 输出 |
| :--- | :--- | :--- |
| 自动识别 | `/s/:token` | 根据 `User-Agent` 选择目标格式 |
| sing-box | `/s/:token/singbox` | JSON 完整配置；入站与 TUN 等由模板决定 |
| Mihomo | `/s/:token/mihomo` | YAML：`proxies`、`proxy-groups`、`rules` |
| Loon | `/s/:token/loon` | CONF：`[Proxy]`、`[Proxy Group]`、`[Rule]` |
| Quantumult X | `/s/:token/qx` 或 `/s/:token/quantumultx` | CONF：`[server_local]`、`[policy]`、`[filter_local]` |
| Egern | `/s/:token/egern` | 原生 YAML：typed `proxies`、`policy_groups`、`rules` |
| Shadowrocket | `/s/:token/shadowrocket` 或 `/s/:token/rocket` | CONF 完整配置 |
| 纯节点列表 | `/s/:token/shadowrocket?format=base64` | Base64 编码的节点 URI 列表，不承载 DoH、DNS 规则或完整模板 |
| 来源节点/provider | `/s/:token/source/:sourceId?target=xxx` | 只输出本份订阅普通选择中属于该来源的节点；格式随目标适配器确定 |

自动识别入口与来源节点入口可使用 `?target=xxx` 指定目标，例如 `mihomo`、`qx`、`egern`。固定客户端路径使用路径指定的目标。

来源节点/provider 复用完整计划的节点命名与筛选，不转发原始上游链接。必要连接依赖与普通候选分开处理；纯节点输出不收集未使用的 DNS 依赖。能力及验证范围见[客户端支持与验证](docs/client-support.md)。

## 模版示例与参考

客户端基础模板位于根目录 `templates/`。系统启动与新建模板时读取对应文件，可按需编辑；使用前应核对目标版本、生成诊断及本机网络配置。

| 模版文件 | 目标客户端 / 模块 | 适用场景与特征 |
| :--- | :--- | :--- |
| [templates/singbox-client.json](templates/singbox-client.json) | Sing-box | macOS/iOS 终端设备，配置 Tun 排除私网/Tailscale防回环、防IPv6泄漏 |
| [templates/singbox-gateway.json](templates/singbox-gateway.json) | Sing-box | 软路由/Linux 旁路由透明网关，`auto_redirect` 自动流量与 DNS 接管 |
| [templates/mihomo.yaml](templates/mihomo.yaml) | Mihomo / Clash | 标准 YAML 基础模版，Fake-IP DNS 设置与出站占位 |
| [templates/loon.conf](templates/loon.conf) | Loon | 标准 CONF 基础模版，包含 [Proxy]、[Proxy Group]、[Rule] 占位 |
| [templates/quantumultx.conf](templates/quantumultx.conf) | Quantumult X | 标准 CONF 基础模版，包含 [server_local]、[policy]、[filter_local] 占位 |
| [templates/egern.yaml](templates/egern.yaml) | Egern | 原生 YAML 基础模板，使用 `proxies`、`policy_groups` 和 typed `rules` |
| [templates/shadowrocket.conf](templates/shadowrocket.conf) | Shadowrocket | CONF 基础模板；协议与规则能力以生成诊断为准 |
| [templates/rules.json](templates/rules.json) | 分流规则 (JSON) | 默认统一分流规则定义（结构化字段，包含广告拦截、AI、YouTube、Telegram 等本地/远程规则） |
| [templates/rules.yaml](templates/rules.yaml) | 分流规则 (YAML) | 默认统一分流规则定义（YAML 列表文本格式，带清晰注释分类，方便文本直接修改） |
| [templates/proxy-groups.json](templates/proxy-groups.json) | 策略组模版 | 默认内置策略组（节点选择、AI 服务、国外域名、国内服务、自动测速等） |
| [templates/country-rules.json](templates/country-rules.json) | 地区识别规则 | 默认国家/地区正则匹配与策略组映射规则（香港、台湾、日本、美国等） |

---

## 路由器 / OpenWrt 自动更新脚本

对于部署在 OpenWrt 或 Linux 软路由 / 旁路由上的 Sing-box 透明网关，在 [tools/update-singbox.sh](tools/update-singbox.sh) 提供了订阅更新脚本，配套 [templates/singbox-gateway.json](templates/singbox-gateway.json) 模版使用。

### 使用方法

#### 1. 下载脚本到路由器
```bash
# 下载到管理目录（如 /root）并赋予执行权限
curl -4 -sSL -o /root/update-singbox.sh https://raw.githubusercontent.com/pzehrel/subone/main/tools/update-singbox.sh
chmod +x /root/update-singbox.sh
```

#### 2. 执行更新
支持以下任一方式传入您的 Sing-box 订阅链接（注意路径后带 `/singbox`）：

```bash
# 方式 1：命令行直接传参（推荐）
/root/update-singbox.sh "https://sub.yourdomain.com/s/YOUR_TOKEN/singbox"

# 方式 2：通过环境变量执行
SUB_URL="https://sub.yourdomain.com/s/YOUR_TOKEN/singbox" /root/update-singbox.sh

# 方式 3：编辑脚本开头的 SUB_URL 变量后直接执行
/root/update-singbox.sh
```

#### 3. 可选环境变量与路径调整
根据路由固件环境，可通过环境变量覆盖默认路径：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SUB_URL` | *(必填)* | SubOne 的 Sing-box 订阅链接 |
| `TARGET_CONF` | `/etc/sing-box/config.json` | 路由器上 sing-box 的配置文件目标路径 |
| `SINGBOX_BIN` | `/usr/bin/sing-box` | sing-box 核心二进制程序路径 |
| `RELOAD_CMD` | `/etc/init.d/sing-box restart` | 重载/重启 sing-box 服务的命令 (systemd 环境可设为 `systemctl restart sing-box`) |

#### 4. 配置定时自动更新 (Crontab)
在 OpenWrt 终端执行 `crontab -e`，添加定时任务（如每天凌晨 4:00 自动更新并记录日志）：

```cron
0 4 * * * /root/update-singbox.sh "https://sub.yourdomain.com/s/YOUR_TOKEN/singbox" >> /var/log/update-singbox.log 2>&1
```
