# CPA Manager Pro

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA%E8%AE%A4%E5%8F%AF-FFB003?style=for-the-badge&logo=discourse&logoColor=white)](https://linux.do/)

> ## **⭐ 基于这两位大佬开发的项目上进行的二开，大家感兴趣也可以给这两个大佬的项目点一下 star。**
>
> - ## **https://github.com/seakee/CPA-Manager-Plus**
> - ## **https://github.com/basketikun/chatgpt2api**
>
> ## **主要是将 chatgpt2api 里面的将 GPT Free 账号通过网页请求的方式 2api 出来可以通过 api 进行直接调用 gpt-image-2 的模型的核心功能嵌入到了当前项目里面。**

[English](README.md)

这是面向 **CLI Proxy API（CPA）** 的单文件 Web 管理面板，并提供 **Manager Server** 用于持久化请求统计和托管面板。

CPA 自 v6.10.0 起不再内置用量统计。当前方案通过常驻 Manager Server 消费 CPA 的用量队列，把请求级事件写入 SQLite，并向面板提供兼容的用量查询接口。

CPA Manager Pro 是 CPA-Manager 的推荐后续版本。它把 CPA 管理面板与可 Docker 部署的 Manager Server 组合在一起，提供管理员密钥保护的完整面板模式、加密保存 CPA Management Key、服务端统计分析、模型价格、API Key 别名、仪表盘卡片和 Codex 账号巡检。

- **CPA 主项目**: https://github.com/router-for-me/CLIProxyAPI
- **推荐 CPA 版本**: >= v7.1.0
- **HTTP 用量队列最低 CPA 版本**: >= v6.10.8

## 面板预览

![首页仪表盘，展示流量概览、采集器状态、用量指标、健康提醒和版本信息](img/home.jpg)
![监控中心，展示用量分析、实时请求事件、账号汇总、API Key 拆解和模型费用统计](img/monitoring.jpg)
![Codex 账号巡检，展示探测进度、账号状态、清理建议和执行日志](img/codex-inspection.png)

## 提供什么

- 面向 CPA Management API（`/v0/management`）的单文件 React 管理面板
- Docker 化 Manager Server，用 SQLite 持久化请求统计并托管内置面板
- Windows/macOS/Linux 原生 `amd64` 和 `arm64` 运行包，内置管理面板
- 两种部署模式：
  - **完整 Docker 方案**：访问 Manager Server 内置面板，首次启动在日志中输出管理员密钥；首次 setup 使用管理员密钥保存 CPA 连接，之后登录使用管理员密钥管理整个面板
  - **CPA 控制面板方案**：继续使用 CPA 的 `/management.html`，然后在面板中配置单独部署的 Manager Server 地址
- 运行时监控、账号/模型/渠道拆解、模型价格、Token 费用估算、导入导出、认证文件管理、配额视图、日志、配置编辑和系统工具

## 选择部署模式

| 模式 | 入口地址 | 用户需要配置 | 适用场景 |
|---|---|---|---|
| 完整 Docker 方案 | `http://<host>:18317/management.html` | 首次启动日志获取管理员密钥；首次 setup：管理员密钥 + CPA 地址 + CPA Management Key；之后登录：管理员密钥 | 新部署、单入口、最少浏览器/CORS 问题 |
| CPA 控制面板方案 | `http://<cpa-host>:8317/management.html` | 先用 CPA Management Key 登录 CPA，再在「配置面板 -> CPA Manager Pro 配置」配置 Manager Server 地址 | 保留 CPA 自动载入面板的现有习惯 |
| 前端开发方案 | Vite dev server 或 `apps/web/dist/index.html` | CPA 地址，可选 Manager Server 地址 | 本地开发 |

完整 Docker 方案不内置 CPA 本体。CPA 仍然作为上游服务独立运行；Docker 镜像提供 Manager Server 和内置管理面板。

## CPA 前置条件

请求统计依赖 CPA 的用量队列：

- CPA 必须启用 Management，因为用量队列与 `/v0/management` 使用相同的可用性条件和 Management Key。
- 使用请求监控时，CPA 必须启用用量发布：配置 `usage-statistics-enabled: true`，或通过 `PUT /usage-statistics-enabled` 提交 `{ "value": true }`。CPA Manager Pro 初始化或保存启用请求监控时会自动打开该开关。
- 关闭 CPAM 请求监控只会停止 Manager Server 采集器，不会自动关闭 CPA 用量发布或清空 CPA 用量队列。如果 CPA 用量发布仍开启，在队列保留时间内再次启用请求监控，可能会采集到关闭采集器期间保留的数据。
- 推荐使用 CPA `v7.1.0+` 以匹配当前面板能力；CPA `v6.10.8+` 已提供 HTTP 用量队列接口 `/v0/management/usage-queue`，可通过普通 HTTP 反代访问。
- Manager Server 的 `auto` 模式会先尝试 RESP Pub/Sub（`subscribe`），再尝试 HTTP 用量队列，最后回退到旧版 RESP 弹出模式。RESP 传输监听在 CPA API 端口，通常是 `8317`，不能通过普通 HTTP 反代转发。
- CPA 在内存中保留队列项的时间由 `redis-usage-queue-retention-seconds` 控制，默认 `60` 秒，最大 `3600` 秒。Manager Server 应保持常驻运行。
- Manager Server 的 `pollIntervalMs` 必须小于等于 CPA 队列保留时间换算后的毫秒值；否则服务会拒绝保存，避免空闲轮询过慢导致队列项过期。
- 同一个 CPA 实例只应有一个 Manager Server 消费用量队列。

## 架构

### 完整 Docker 方案

```text
浏览器
  -> Manager Server :18317
      -> 内置 management.html
      -> /v0/management/usage 和 /v0/management/model-prices 从 SQLite 返回
      -> 其他 /v0/management/* 反代到 CPA
      -> HTTP/RESP/PubSub 消费器 -> CPA API 端口
      -> SQLite /data/usage.sqlite
```

首次启动时，如果未通过 `CPA_MANAGER_ADMIN_KEY` / `CPA_MANAGER_ADMIN_KEY_FILE` 提供管理员密钥，Manager Server 会生成一个 `cmp_admin_...` 管理员密钥，并只在首次启动日志中输出一次。登录页会调用 `GET /usage-service/info`，识别当前是否由 Manager Server 托管。如果响应显示尚未配置，会进入初始化页：你先输入管理员密钥，再填写 CPA 地址、CPA Management Key，并选择是否启用请求监控。启用时还需要填写采集轮询间隔，Manager Server 会验证 CPA Management API，启用 CPA 用量统计，校验采集间隔不超过 CPA 队列保留时间，把 CPA Manager Pro 配置保存到 SQLite，按配置的采集模式启动采集器（默认 `auto`：RESP Pub/Sub、HTTP 队列、RESP 弹出依次回退），并从同源提供完整管理面板。关闭请求监控时仍会保存 CPA 连接用于反代管理接口，但不会启用 CPA 用量统计或启动采集器。

Manager Server 配置完成后，新浏览器再次打开同一地址会使用普通登录表单。完整 Docker 方案的登录凭证是管理员密钥；CPA Management Key 只保存在服务端，用于 Manager Server 访问 CPA 上游。

### CPA 控制面板方案

```text
浏览器
  -> CPA /management.html
      -> 普通 CPA Management API 请求仍然访问 CPA
      -> usage 相关请求访问已配置的 Manager Server

Manager Server
  -> HTTP/RESP/PubSub 消费器 -> CPA API 端口
  -> SQLite /data/usage.sqlite
```

当你希望保留 CPA 自动下载并托管面板的机制时，使用这个方案。该模式由 CPA 托管页面，因此不会显示完整 Docker 初始化页，也不要求用户在 CPA 面板里输入 Manager Server 管理员密钥。请求监控是可选能力；如果没有部署 Manager Server，面板会自动隐藏请求监控入口，直接访问监控页时会提示先部署并配置 Manager Server。需要请求监控时，先用 CPA Management Key 登录 CPA，再单独部署 Manager Server，然后在面板的「配置面板 -> CPA Manager Pro 配置」中启用并填写地址。该方案做的是完整 Docker 方案的减法：不托管主入口、不提供初始化页、不接管 CPA 普通管理接口。

### Manager Server 后端

Go 后端位于 `github.com/seakee/cpa-manager-plus/apps/manager-server` 模块。它仍保留兼容的 `/usage-service/*` 管理端点。请求链路按以下分层组织：

```text
model -> repository -> service -> controller -> router
```

- `internal/model` 定义持久化和 API 响应相关数据结构。
- `internal/repository` 负责 SQLite 读写和 schema 迁移，并保持现有数据表兼容。
- `internal/service` 承担 setup、CPA Manager Pro 配置、usage、模型价格、API Key 别名、代理、面板和 collector 生命周期等业务规则。
- `internal/http/controller`、`internal/http/middleware` 和 `internal/http/router` 把 HTTP decode、CORS/auth/recovery、Gin 路由和响应写入限制在边界层。
- `internal/httpapi` 保留为当前 `cmd/cpa-manager-plus` 入口的兼容 wrapper。
- `internal/worker` 负责 collector 启动、重启和停止，不改变现有 HTTP、RESP Pub/Sub、RESP 弹出和 auto 队列消费协议。

## 快速开始：完整 Docker 方案

### 容器镜像

公开多架构镜像会发布到两个仓库：

- Docker Hub：`seakee/cpa-manager-plus`
- GitHub Container Registry：`ghcr.io/seakee/cpa-manager-plus`

```bash
docker run -d \
  --name cpa-manager-plus \
  --restart unless-stopped \
  -p 18317:18317 \
  -v cpa-manager-plus-data:/data \
  seakee/cpa-manager-plus:latest
```

打开：

```text
http://<host>:18317/management.html
```

首次 setup 时填写：

- 管理员密钥：首次启动日志中的 `CPA Manager Pro admin key generated: cmp_admin_...`
- CPA 地址：
  - Docker Desktop 访问宿主机 CPA：`http://host.docker.internal:8317`（默认建议值；如果面板构建时设置了 `VITE_DEFAULT_CPA_BASE_URL`，则使用该值）
  - 同一 compose 网络：`http://cli-proxy-api:8317`
  - 远程 CPA：`https://your-cpa.example.com`
- CPA Management Key

可通过 `docker logs cpa-manager-plus` 查看首次生成的管理员密钥。setup 完成后，同一入口地址会使用 Manager Server SQLite 中保存的 CPA 连接。新浏览器只需要在登录页填写管理员密钥。

发布镜像支持 `linux/amd64` 和 `linux/arm64`。Docker 示例默认使用 Docker Hub。如果要从 GitHub Container Registry 拉取，把 `seakee/cpa-manager-plus:latest` 替换成 `ghcr.io/seakee/cpa-manager-plus:latest`。

### 原生运行包

GitHub Releases 同时提供内置面板的原生运行包：

- `cpa-manager-plus_<version>_linux_amd64.tar.gz`
- `cpa-manager-plus_<version>_linux_arm64.tar.gz`
- `cpa-manager-plus_<version>_darwin_amd64.tar.gz`
- `cpa-manager-plus_<version>_darwin_arm64.tar.gz`
- `cpa-manager-plus_<version>_windows_amd64.zip`
- `cpa-manager-plus_<version>_windows_arm64.zip`

macOS/Linux：

```bash
tar -xzf cpa-manager-plus_vX.Y.Z_linux_amd64.tar.gz
cd cpa-manager-plus_vX.Y.Z_linux_amd64
./cpa-manager-plus
```

tar 包已保留执行权限，正常解压后不需要额外 `chmod +x`。macOS 如果提示无法打开未签名程序，可在解压目录执行 `xattr -dr com.apple.quarantine .` 后再运行。

Windows PowerShell：

```powershell
Expand-Archive .\cpa-manager-plus_vX.Y.Z_windows_amd64.zip -DestinationPath .
cd .\cpa-manager-plus_vX.Y.Z_windows_amd64
.\cpa-manager-plus.exe
```

Windows 可直接双击 `cpa-manager-plus.exe` 启动，但推荐用 PowerShell 运行，方便查看日志和错误信息。

启动后打开：

```text
http://<host>:18317/management.html
```

原生包不包含 CPA 本体。请让 CPA 独立运行，并在首次 setup 时填写管理员密钥、CPA 地址和 CPA Management Key。setup 完成后，登录页只需要管理员密钥。需要自定义数据位置时，可以设置 `USAGE_DATA_DIR` 或 `USAGE_DB_PATH` 覆盖默认值。

原生包首次启动时，如果没有设置 `USAGE_DATA_DIR` 或 `USAGE_DB_PATH`，会在程序所在目录自动生成 `config.json`，并把 SQLite 数据写入同目录下的 `data/usage.sqlite`。这样解压后的目录就是完整的程序和用户数据目录。

### Docker Compose

```yaml
services:
  cpa-manager-plus:
    image: seakee/cpa-manager-plus:latest
    restart: unless-stopped
    ports:
      - "18317:18317"
    volumes:
      - cpa-manager-plus-data:/data

volumes:
  cpa-manager-plus-data:
```

启动：

```bash
docker compose up -d
```

如果要使用 GitHub Container Registry，把 compose 中的镜像替换为 `ghcr.io/seakee/cpa-manager-plus:latest`。

### Linux 宿主机运行 CPA

如果 CPA 直接运行在 Linux 宿主机，Manager Server 运行在 Docker 中，需要添加 host gateway：

```bash
docker run -d \
  --name cpa-manager-plus \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 18317:18317 \
  -v cpa-manager-plus-data:/data \
  seakee/cpa-manager-plus:latest
```

然后在首次 setup 时将 CPA 地址填写为 `http://host.docker.internal:8317`。

## 快速开始：CPA 控制面板方案

1. 正常启动 CPA，打开：

   ```text
   http://<cpa-host>:8317/management.html
   ```

   使用 CPA Management Key 登录 CPA。这个入口由 CPA 托管，不使用完整 Docker 初始化页。

2. 单独部署 Manager Server：

   ```bash
   docker run -d \
     --name cpa-manager-plus \
     --restart unless-stopped \
     -p 18317:18317 \
     -v cpa-manager-plus-data:/data \
     seakee/cpa-manager-plus:latest
   ```

3. 在 CPA 面板进入：

   ```text
   配置面板 -> CPA Manager Pro 配置
   ```

4. 启用并填写：

   ```text
   http://<manager-server-host>:18317
   ```

5. 保存 CPA Manager Pro 配置。

面板会把当前 CPA 地址和 CPA Management Key 发送给 Manager Server。之后监控页从 Manager Server 读取用量数据，其他管理功能仍然访问 CPA。该外置模式下，Manager Server 接口兼容 CPA Management Key；完整 Docker 模式仍使用管理员密钥。

## 本地从源码构建

```bash
docker compose -f docker-compose.manager.yml up --build
```

该命令会构建 React 面板，并把它内置到 Go Manager Server 二进制中。

## Manager Server 配置项

大多数用户可以直接在面板的「配置面板 -> CPA Manager Pro 配置」中配置 CPA 地址、CPA Management Key、是否启用请求监控、采集模式和轮询间隔。CPA Manager Pro 配置会保存到 SQLite；环境变量更适合首次引导和无人值守部署。

下表是 Manager Server 运行时配置。前端构建时配置是独立的：`VITE_DEFAULT_CPA_BASE_URL` 用于设置 Manager Server 托管面板首次初始化页中展示的默认 CPA 地址；未设置时，Docker 托管面板默认建议 `http://host.docker.internal:8317`。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `CPA_MANAGER_CONFIG` | 空 | 可选配置文件路径；为空时原生包默认使用程序同目录的 `config.json` |
| `HTTP_ADDR` | `0.0.0.0:18317` | Manager Server HTTP 监听地址 |
| `USAGE_DB_PATH` | Docker：`/data/usage.sqlite`；原生包：`./data/usage.sqlite` | SQLite 数据库路径 |
| `USAGE_DATA_DIR` | Docker：`/data`；原生包：`./data` | 未覆盖 `USAGE_DB_PATH` 时的数据目录 |
| `CPA_MANAGER_ADMIN_KEY` | 空 | 可选管理员密钥；为空时首次启动自动生成并输出到日志 |
| `CPA_MANAGER_ADMIN_KEY_FILE` | `/run/secrets/cpa_admin_key` | 可选管理员密钥文件 |
| `CPA_MANAGER_DATA_KEY` | 空 | 可选数据加密密钥；为空时从 `CPA_MANAGER_DATA_KEY_PATH` 读取或自动生成 |
| `CPA_MANAGER_DATA_KEY_FILE` | `/run/secrets/cpa_data_key` | 可选数据加密密钥文件 |
| `CPA_MANAGER_DATA_KEY_PATH` | Docker：`/data/data.key`；原生包：`./data/data.key` | 自动生成的数据加密密钥文件路径 |
| `CPA_UPSTREAM_URL` | 空 | 可选 CPA 地址，用于无人值守启动 |
| `CPA_MANAGEMENT_KEY` | 空 | 可选 CPA Management Key，用于无人值守启动 |
| `CPA_MANAGEMENT_KEY_FILE` | `/run/secrets/cpa_management_key` | 可选密钥文件 |
| `USAGE_COLLECTOR_MODE` | `auto` | 采集方式：`auto` 依次尝试 RESP Pub/Sub、HTTP 用量队列、RESP 弹出；`subscribe` 强制 RESP Pub/Sub；`http` 强制 HTTP；`resp` 强制 RESP 弹出 |
| `USAGE_RESP_QUEUE` | `usage` | RESP key 参数；当前 CPA 会忽略该值，除非上游行为变化，否则保持默认即可 |
| `USAGE_RESP_POP_SIDE` | `right` | `right` 使用 `RPOP`；`left` 使用 `LPOP` |
| `USAGE_BATCH_SIZE` | `100` | 每次最多弹出记录数 |
| `USAGE_POLL_INTERVAL_MS` | `500` | 队列空闲时轮询间隔 |
| `USAGE_QUERY_LIMIT` | `50000` | 兼容 `/usage` 最多返回的近期事件数 |
| `USAGE_CORS_ORIGINS` | `*` | CPA 控制面板方案下允许的浏览器来源 |
| `USAGE_RESP_TLS_SKIP_VERIFY` | `false` | RESP TLS 连接是否跳过证书校验 |
| `PANEL_PATH` | 空 | 使用自定义 `management.html` 替代内置面板 |

启动类配置的优先级为：环境变量 > `config.json` > 程序默认值。配置文件中的相对路径按配置文件所在目录解析。默认生成的配置文件内容如下：

```json
{
  "httpAddr": "0.0.0.0:18317",
  "dataDir": "./data"
}
```

如果设置了 `CPA_MANAGER_ADMIN_KEY`，服务会使用该值初始化管理员凭证，不会在日志中输出生成的管理员密钥。如果设置了 `CPA_UPSTREAM_URL` 和 `CPA_MANAGEMENT_KEY`，服务启动后会自动开始采集，并作为环境变量管理的 CPA 连接配置展示在面板中。否则通过完整 Docker 初始化流程配置，保存到 SQLite `settings.manager_config_v1`；旧版 `settings.setup` 会继续写入，用于兼容已有数据和回滚。

### CPA 与 CPA Manager Pro 配置边界

- **CPA 配置**：`usage-statistics-enabled`、`redis-usage-queue-retention-seconds`、代理、日志、路由、认证文件等仍属于 CPA，由 `/config` / `/config.yaml` 管理。
- **CPA Manager Pro 配置**：CPA 连接地址、CPA Management Key、请求监控开关、Manager Server 采集模式、`pollIntervalMs`、`batchSize`、`queryLimit`、CPA 控制面板模式下的 Manager Server 引导地址等保存到 Manager Server SQLite。
- 配置面板会分开展示 CPA 与 CPA Manager Pro 配置。保存 CPAM 配置不会写入 CPA `config.yaml`；启用请求监控时会按要求调用 CPA Management API 启用用量统计，关闭请求监控时只停止 CPAM 采集器。

### 迁移指引

从旧 CPA-Manager 升级时，请优先阅读 [CPA-Manager 到 CPA Manager Pro 迁移指南](docs/migration-from-cpa-manager.zh-CN.md)。核心规则如下：

1. 先停止旧后端服务，再备份旧 `/data` 目录或 Docker volume，至少包含 `usage.sqlite`、`usage.sqlite-wal`、`usage.sqlite-shm`。
2. 使用同一个旧 `/data` volume 启动 CPA Manager Pro，或把旧数据复制到新 `/data`。旧项目默认 volume 常见为 `cpa-manager-data`，Plus 示例默认是 `cpa-manager-plus-data`，不要误用空的新 volume。
3. 首次启动 Plus 后会新增 `settings.admin_credential_v1`、`settings.bootstrap_state_v1` 和 `/data/data.key`。从这一步开始，备份必须同时包含 SQLite 文件和 `data.key`。
4. 完整 Docker 方案的登录凭证会变成 Manager Server 管理员密钥，不再是 CPA Management Key。建议发布/迁移时显式设置 `CPA_MANAGER_ADMIN_KEY` 或 `CPA_MANAGER_ADMIN_KEY_FILE`，否则务必保存首次启动日志里的 `cmp_admin_...`。
5. 如果旧版本已经通过 `/setup` 保存过 CPA 地址和 CPA Management Key，服务会从 `settings.setup` 自动生成新的 `settings.manager_config_v1`，并在启动迁移时把旧明文 CPA Management Key 改写为加密存储。
6. 如果使用环境变量 `CPA_UPSTREAM_URL` / `CPA_MANAGEMENT_KEY`，连接配置仍由环境变量管理；要改为面板持久化，请移除环境变量后重启，再在面板保存。
7. CPA 托管面板模式下，浏览器仍需要先知道 Manager Server 地址才能读取其数据库配置；首次填写后会同步写入 SQLite，并继续保留本地缓存作为 bootstrap。

## 数据与安全说明

- SQLite 数据存储在 `/data`，必须挂载到持久化 volume 或宿主机目录。
- 管理员密钥不会明文保存；SQLite `settings.admin_credential_v1` 只保存盐和 HMAC-SHA256 摘要。自动生成的管理员密钥只在首次启动日志输出一次，建议通过 `CPA_MANAGER_ADMIN_KEY_FILE` 使用 Docker Secret 或其他外部密钥管理。
- CPA Management Key 会用数据密钥加密后保存到 SQLite `settings` 表，用于容器重启后恢复采集和反代 CPA 管理接口。
- 数据密钥由 `CPA_MANAGER_DATA_KEY` / `CPA_MANAGER_DATA_KEY_FILE` 提供，或自动生成到 `CPA_MANAGER_DATA_KEY_PATH`，Docker 默认 `/data/data.key`，权限 `0600`。
- 数据密钥安全评估：AES-GCM 加密能避免 SQLite 离线泄露时直接读出 CPA Management Key，但如果攻击者同时拿到 `/data/usage.sqlite` 和 `/data/data.key`，仍可解密；如果丢失数据密钥，已加密的 CPA Management Key 无法恢复，只能重新初始化/重新保存 CPA 连接。
- 新版会优先读取 SQLite `settings.manager_config_v1`；旧 `settings.setup` 会保留为兼容数据。
- 请保护 `/data` volume，它包含用量元数据、管理员凭证摘要、数据密钥文件和加密后的 CPA Management Key。
- Manager Server 会在保存 raw JSON 快照前脱敏疑似密钥字段，但请求元数据仍可能暴露请求/实际模型、接口、账号标签、项目快照和 token 用量。
- RESP 弹出队列是破坏性消费，RESP Pub/Sub 是流式订阅；不要让多个 Manager Server 同时消费同一个 CPA 实例。
- 如果 Manager Server 停机超过 CPA 队列保留时间，该时段用量无法在不修改 CPA 的情况下恢复。
- 如果只关闭 CPAM 采集器而 CPA 用量发布仍开启，队列保留时间内重新开启采集器可能会消费停用期间仍保留的队列项。

## 运行时接口

| 接口 | 用途 |
|---|---|
| `GET /health` | 基础健康检查 |
| `GET /status` | 采集器、SQLite、事件数、错误状态 |
| `GET /usage-service/info` | 让前端识别完整 Docker 方案，并通过 `configured` 区分 setup 和登录流程 |
| `GET /usage-service/config` | 读取 CPA Manager Pro 持久化配置和 CPA 用量统计状态 |
| `PUT /usage-service/config` | 保存 CPA Manager Pro 配置，并按需重启采集器 |
| `POST /setup` | 使用管理员密钥保护；保存 CPA 地址和 CPA Management Key，并启动采集 |
| `GET /v0/management/usage` | 面板兼容用量数据 |
| `GET /v0/management/usage/export` | JSONL 导出用量事件 |
| `POST /v0/management/usage/import` | 导入 JSONL 用量事件或旧版 JSON 快照 |
| `GET /v0/management/model-prices` | 读取 SQLite 中保存的模型价格 |
| `PUT /v0/management/model-prices` | 替换已保存的模型价格 |
| `POST /v0/management/model-prices/sync` | 从 LiteLLM、OpenRouter 等价格元数据同步模型价格，并返回价格来源 |
| `GET /models`、`GET /v1/models` | setup 后将模型列表请求反代到 CPA |
| `/v0/management/*` | 除 usage 外反代到 CPA |

完整 Docker setup 后，`/status`、用量、模型价格和 `/v0/management/*` 反代接口需要使用管理员密钥作为 Bearer token。CPA 控制面板外置模式下，这些 Manager Server 接口兼容 CPA Management Key，以保持 CPA 面板方案不需要额外登录 Manager Server。

用量导入支持两类文件：Manager Server 导出的 JSONL/NDJSON 事件文件，以及旧版 CPA `/usage/export` 生成的 JSON 快照。旧版 JSON 只有在 `usage.apis.*.models.*.details[]` 明细存在时才能转换为事件；如果文件只包含聚合总量，Manager Server 会拒绝导入，因为无法还原请求级明细。旧版导入属于迁移/恢复能力，不是与 Manager Server 新采集数据完全等价的历史延续：旧文件可能缺少 `api_key_hash`、渠道、请求 ID、method/path、延迟、缓存 token 或失败原因等元数据，账号匹配、API Key 维度分析和明细精度可能低于新采集数据。导入旧文件会影响总量、趋势图和账号/Key 拆解，准确性敏感时建议先导入测试库或备份库验证。

## 功能概览

- **仪表盘**：连接状态、后端版本、快速健康概览
- **配置管理**：可视化和源码模式编辑 CPA 配置，并单独管理 CPA Manager Pro 配置
- **AI 提供商**：Gemini、Codex、Claude、Vertex、OpenAI 兼容渠道、Ampcode
- **认证文件**：上传、下载、删除、状态、OAuth 排除模型、模型别名
- **配额管理**：支持提供商的配额视图
- **请求监控**：持久化用量 KPI、模型/渠道/账号/API Key 拆解、请求模型与实际模型追踪、项目快照、模型价格、Token 费用估算、失败分析、展示可读来源和单条优先补充信息的实时表格
- **Codex 账号巡检**：批量探测 Codex 认证池并给出清理建议
- **日志**：增量读取和筛选文件日志
- **中心信息**：模型列表、版本检查、本地状态工具

## 开发命令

前端：

```bash
npm install
npm run dev
npm run type-check
npm run lint
npm run build
```

Manager Server：

```bash
cd apps/manager-server
go test ./...
go test -race ./...
go vet ./...
go run ./cmd/cpa-manager-plus
```

## 构建与发布

- Vite 输出单文件 `apps/web/dist/index.html`
- 打 `vX.Y.Z` 或 `vX.Y.Z-beta` 这类预发布标签会触发 `.github/workflows/release.yml`
- 发布流程会上传 `apps/web/dist/management.html`、原生运行包和 `checksums.txt` 到 GitHub Releases
- 原生运行包会发布 `linux`、`darwin`、`windows` 的 `amd64` 和 `arm64` 版本，包内已内置管理面板
- 同一个 workflow 会构建 `Dockerfile.manager-server`，并把公开镜像推送到 Docker Hub 和 GitHub Container Registry
- Docker 镜像会发布 `linux/amd64` 和 `linux/arm64`
- GitHub Container Registry 镜像是 `ghcr.io/seakee/cpa-manager-plus`，使用 workflow 自带的 `GITHUB_TOKEN` 和 `packages: write` 权限发布
- 启用 Docker Hub 发布时，workflow 会把 `README.md` 同步到 Docker Hub overview
- Docker Hub 发布的可选 GitHub secrets：
  - `DOCKERHUB_USERNAME`
  - `DOCKERHUB_TOKEN`

## 常见问题

- **完整 Docker 方案无法连接 CPA**：确认容器内能访问 CPA 地址。Linux 宿主机 CPA 需要 `--add-host=host.docker.internal:host-gateway`。
- **完整 Docker 方案打开的是登录表单而不是 setup**：Manager Server 已经配置过。输入管理员密钥即可，CPA 地址来自服务端配置。
- **首次 setup 默认 CPA 地址不符合环境**：使用 `VITE_DEFAULT_CPA_BASE_URL=<your-cpa-url>` 重新构建面板，或手动填写正确的 CPA 地址。
- **监控页为空**：确认 CPA 已启用用量发布，检查 Manager Server `/status`，并确认只有一个消费者。
- **`unsupported RESP prefix 'H'`**：升级 CPA 到 `v6.10.8+`，或在普通 HTTP 反代场景使用 `USAGE_COLLECTOR_MODE=http`。RESP Pub/Sub/RESP 弹出模式要求 CPA 地址必须是容器/主机内能直连 `8317` 的地址，不能是普通 HTTP 反代域名。
- **Manager Server 返回 401**：完整 Docker 方案使用管理员密钥；CPA 控制面板外置模式使用 CPA Management Key。
- **Docker 面板数据不更新**：检查 `/status` 中的 `lastConsumedAt`、`lastInsertedAt`、`lastError`。
- **CPA 控制面板方案有 CORS 错误**：将 `USAGE_CORS_ORIGINS` 设置为 CPA 面板来源；私有部署可保持默认 `*`。
- **容器重建后数据丢失**：确认 `/data` 已挂载到 Docker volume 或宿主机目录。
- **从 CPA-Manager 迁移后看不到旧数据**：确认 Plus 容器挂载的是旧 `/data` volume，而不是新建的 `cpa-manager-plus-data` 空 volume。
- **管理员密钥丢失**：已有 `settings.admin_credential_v1` 时，单独设置 `CPA_MANAGER_ADMIN_KEY` 不会覆盖旧凭证。按迁移指南的离线恢复步骤处理，并先备份 `/data`。
- **完整 FAQ**：查看 [CPA Manager Pro 常见问题与解决方案](https://github.com/LiveAckerman/CPA-Manager-Pro/wiki/FAQ-and-Troubleshooting) 或 [English FAQ and Troubleshooting](https://github.com/LiveAckerman/CPA-Manager-Pro/wiki/FAQ-and-Troubleshooting)。

## 参考

- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
- Redis 用量队列文档: https://help.router-for.me/management/redis-usage-queue.html
- CPA-Manager 到 CPA Manager Pro 迁移指南: [docs/migration-from-cpa-manager.zh-CN.md](docs/migration-from-cpa-manager.zh-CN.md)
- 发布前检查清单: [docs/release-checklist.zh-CN.md](docs/release-checklist.zh-CN.md)

## 致谢

- 感谢上游项目 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 和 [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) 提供基础与参考。
- 感谢 [Linux.do](https://linux.do/) 社区对项目推广与反馈的支持。

## 许可证

MIT
