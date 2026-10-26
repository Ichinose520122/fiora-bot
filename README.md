# Fiora Bot · 大肥鱼

面向 [Fiora](https://github.com/Ichinose520122/fiora) 聊天站的机器人，基于 **[K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) `0.4` 版本 Fork 改造**。原作者 Kondius 的 MIT 许可证和版权声明完整保留，来源说明见 [NOTICE.md](NOTICE.md)。本仓库为独立衍生项目。

## 功能与运行方式

- 通过 Fiora Bot WebSocket 网关实时收发消息，并在网站显示在线状态。
- 支持文字、图片上传与发送，断线后自动重连；发送带请求编号，网络异常时保留 HTTP 回退路径。
- 支持 OpenAI 兼容模型接口、人设、成员长期记忆、会话存档、用量统计和插件。
- 网页控制台提供会话、存档、记忆、模型和连接设置。Fiora ID 全程按字符串处理，兼容原 QQ 数字 ID 的本地数据。
- 提供 Linux Docker 镜像与 Compose 配置，使用独立数据目录，支持容器重启及升级后的数据保留。

Fiora 主站负责账号、会话授权、消息存储及广播。机器人负责模型调用、提示词、记忆和扩展执行。模型使用外部 API，基础运行不需要 GPU、QQ 客户端、OneBot 协议端或桌面环境。

## 部署前提

- 支持 Bot API、WebSocket 网关及图片接口的 Fiora 服务端。
- 管理员绑定专用普通账号，授权群组或好友私聊并签发机器人 API Key。
- 可用的模型 API 地址、密钥和模型名称。
- Docker Engine 与 Compose 插件。自动发布镜像当前面向 `linux/amd64`；其他架构可在目标机器源码构建。

## Docker Compose 部署

```sh
git clone https://github.com/Ichinose520122/fiora-bot.git
cd fiora-bot
cp .env.example .env
mkdir -p data
sudo chown 1000:1000 data
chmod 700 data
```

在 `.env` 填写 `FIORA_URL`、`FIORA_BOT_KEY`、`MODEL_API_BASE_URL`、`MODEL_API_KEY` 和 `MODEL_NAME`，然后启动：

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs --tail=100 -f fiora-bot
```

镜像位于 `ghcr.io/ichinose520122/fiora-bot:latest`。若 GHCR 包尚未设为公开，需要先登录有读取权限的 GitHub 账户，或使用下方的源码构建方式。

容器以 UID/GID `1000:1000` 运行。`data` 为宿主机持久化目录；`plugins` 和 `skills` 使用 Compose 具名卷保存安装、卸载和自定义扩展。首次创建扩展卷时会填入镜像自带扩展；后续镜像升级不会覆盖已有扩展卷，应按需单独更新扩展。

控制台仅发布到服务器本机 `127.0.0.1:3220`。在自己的电脑建立 SSH 转发：

```sh
ssh -N -L 13220:127.0.0.1:3220 user@server
```

随后打开 `http://127.0.0.1:13220`。控制台沿用本地来源检查，直接使用公网域名反向代理会被拒绝；公网管理需要另外配置认证与可信来源。

### 源码构建

```sh
docker compose up -d --build
```

基础镜像不包含 `ffmpeg`，文字和基础图片收发可直接运行。需要视频处理、GIF 转换或图片压缩时，在 `.env` 设置 `INSTALL_FFMPEG=true` 后重新源码构建。

### 迁移便携版数据

先停止原机器人，将原 `data` 目录整体复制到仓库的 `data`，再调整该目录及其内容归属为 `1000:1000`。原有配置、人设、存档、记忆和扩展状态保留；自定义的扩展源码需要同时迁移到相应扩展卷。避免两个实例使用同一账号同时自动回复。

非空环境变量优先于配置文件；迁移时需删除 `.env` 中不希望覆盖旧配置的示例值。运行时保存设置可能将环境变量的生效值写入 `data/config.json`，配置文件及 `.env` 均按凭据管理，不应提交到仓库。

## 配置

| 变量 | 用途 |
| --- | --- |
| `FIORA_URL` | Fiora 站点根地址，例如 `https://chat.example.com` |
| `FIORA_BOT_KEY` | Fiora 管理员签发的机器人密钥，与模型密钥独立 |
| `FIORA_ENABLED` | 可选，`true` 或 `false`；默认配置启用 Fiora |
| `MODEL_API_BASE_URL` | OpenAI 兼容接口地址 |
| `MODEL_API_KEY` | 模型接口密钥 |
| `MODEL_NAME` | 模型名称 |
| `QQ_AGENT_DATA_DIR` | 数据目录；镜像内固定为 `/app/data` |
| `QQ_AGENT_HOST` | 控制台监听地址；本地默认 `127.0.0.1`，镜像内为 `0.0.0.0` |
| `QQ_AGENT_PORT` | 程序监听端口，镜像内为 `3220` |
| `CONSOLE_PORT` | Compose 在服务器本机发布的控制台端口 |
| `TZ` | 时区，默认 `Asia/Shanghai` |
| `QQ_AGENT_TELEMETRY` | 可选，设为 `1` 才启用上游匿名用量上报；默认关闭 |

首次启动自动建立配置文件，已有配置不会被初始化程序覆盖。模型、人设和多数行为设置可在控制台修改；连接配置和环境变量更改后需要重新启动或创建容器。

程序保留上游公开价格表、社区与扩展市场接口，相关页面和功能可能连接上游服务。Fiora 专属接口与 QQ 专属动作能力不同，插件需要逐项适配，不能将 OneBot 兼容层视为完整 QQ 协议实现。

## 本地运行与测试

需要 Node.js 24 和 pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm start
pnpm test
```

源码启动同样不需要 Electron。测试使用临时数据、模拟 Fiora 网关和控制台页面脚本，不需要真实站点或模型密钥。

## 更新与运行边界

```sh
docker compose pull
docker compose up -d --no-build
```

容器正常停止时处理 `SIGTERM`，终止模型任务并保存索引、刷新日志和关闭连接。健康检查验证控制台 HTTP 服务可用，不代表 Fiora 已连接、模型可用或插件能力全部可用。

容器仅保存机器人数据，不直接访问 Fiora 的 MongoDB 或 Redis。磁盘使用随存档、会话和日志增长；更新前应备份 `data` 及自定义扩展。

主分支推送触发自动测试、Docker 构建、容器启动与数据保留检查，通过后发布 `latest` 和提交 SHA 标签。具体发布结果以对应 GitHub Actions 运行结论为准。

## 许可证

[MIT](LICENSE)。原版权声明为 `Copyright (c) 2026 Kondius`。衍生项目来源及改造范围见 [NOTICE.md](NOTICE.md)。
