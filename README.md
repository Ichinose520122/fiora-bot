# Fiora Bot · 大肥鱼

面向 [Fiora](https://github.com/Ichinose520122/fiora) 聊天站的机器人，基于 **[K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) `0.4` 版本 Fork 改造**。原作者 Kondius 的 MIT 许可证和版权声明完整保留，来源说明见 [NOTICE.md](NOTICE.md)。本仓库为独立衍生项目。

## 功能与运行方式

- 通过 Fiora Bot WebSocket 网关实时收发消息，并在网站显示在线状态。
- 支持文字、图片上传与发送，断线后自动重连；发送带请求编号，网络异常时保留 HTTP 回退路径。
- 长文本按 Fiora 单条 2048 个 UTF-16 码元的上限顺序分段，保留换行和完整 emoji。较小的文本分段配置继续生效；旧配置 `4000` 或 `0` 不会关闭平台上限。
- Fiora 不接受纯空白消息。短空白尾段会与相邻文字重新分配；仍含纯空白分段的文本会在发送前报错，需要缩短连续空白。
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
sudo sh scripts/prepare-docker.sh
```

`.env` 仅保存端口、时区等部署参数。启动后在网页管理界面配置 Fiora 站点、机器人 API Key、模型服务地址、模型密钥和模型名称：

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs --tail=100 -f fiora-bot
```

镜像位于 `ghcr.io/ichinose520122/fiora-bot:latest`。若 GHCR 包尚未设为公开，需要先登录有读取权限的 GitHub 账户，或使用下方的源码构建方式。

容器以 UID/GID `1000:1000` 运行，使用以下宿主机目录：

| 宿主机目录 | 容器目录 | 内容 |
| --- | --- | --- |
| `./data` | `/app/data` | 配置、人设、记忆、存档、用量和日志 |
| `./plugins` | `/app/plugins` | 插件，每个插件独立子目录 |
| `./skills` | `/app/skills` | 技能，每个技能独立子目录 |

部署目录为 `/opt/fiora-bot` 时，插件放入 `/opt/fiora-bot/plugins/<id>/`，技能放入 `/opt/fiora-bot/skills/<id>/`。控制台安装的扩展也写入这两个目录。新增或删除扩展后可在控制台刷新扩展列表；热重载开启时会自动加载。

`prepare-docker.sh` 初始化三个目录及其写入权限。扩展目录为空时，优先从当前部署的旧容器迁移；没有旧容器则从镜像提取内置扩展。已有主机扩展目录不会被覆盖。上传新扩展后，应确保其归属和目录写入权限允许 UID/GID `1000:1000` 访问。

镜像升级不会覆盖挂载目录中的扩展，内置扩展与自定义扩展均单独维护。

控制台仅发布到服务器本机 `127.0.0.1:3220`。在自己的电脑建立 SSH 转发：

```sh
ssh -N -L 13220:127.0.0.1:3220 user@server
```

随后打开 `http://127.0.0.1:13220`。控制台沿用本地来源检查，直接使用公网域名反向代理会被拒绝；公网管理需要另外配置认证与可信来源。

### 源码构建

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

默认 `compose.yaml` 只运行镜像，不要求服务器存在 Dockerfile。`compose.build.yaml` 提供源码构建选项。基础镜像不包含 `ffmpeg`，文字和基础图片收发可直接运行。需要视频处理、GIF 转换或图片压缩时，在 `.env` 设置 `INSTALL_FFMPEG=true`，使用上述构建命令。

### 与同机 Fiora 使用共享网络

主站使用 `caddy-proxy` 时，可复制网络覆盖文件，使普通 Compose 命令自动加载它：

```sh
cp compose.fiora-network.yaml compose.override.yaml
docker compose config --quiet
docker compose up -d
```

实际网络名称可通过 `.env` 的 `FIORA_DOCKER_NETWORK` 修改。该网络须已存在。连接共享网络后，机器人容器可访问 `http://fiora:9200`；当前图片链接仍复用站点地址，使用内部站点地址时还需考虑控制台预览和图片下载的可达性及地址校验。

### 迁移便携版数据

先停止原机器人，将原 `data` 目录整体复制到仓库的 `data`，再调整该目录及其内容归属为 `1000:1000`。原有配置、人设、存档、记忆和扩展状态保留；自定义扩展源码分别放入 `plugins` 和 `skills`。避免两个实例使用同一账号同时自动回复。

默认 Compose 不向应用传入站点和模型环境变量，管理界面保存的设置直接生效并持久化到 `data/config.json`。连接参数修改后需要重启机器人。

从旧版命名卷升级时，先停止机器人并备份配置、数据及扩展。保留旧容器，更新 Compose 后运行 `prepare-docker.sh`，脚本会在目标扩展目录为空时从旧容器复制扩展。旧命名卷不会被删除。原来通过环境变量设置的密钥和连接参数，需要在移除这些变量前保存到管理配置中。

直接运行容器时仍支持下表中的可选环境变量，非空值优先于配置文件，并可能随保存操作写入配置。配置文件和环境变量文件不应提交到仓库。

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
| `FIORA_DOCKER_NETWORK` | 可选网络覆盖文件使用的既有共享网络名称 |
| `TZ` | 时区，默认 `Asia/Shanghai` |
| `QQ_AGENT_TELEMETRY` | 可选，设为 `1` 才启用上游匿名用量上报；默认关闭 |

首次启动自动建立配置文件，已有配置不会被初始化程序覆盖。模型、人设和多数行为设置可在控制台修改；连接配置和环境变量更改后需要重新启动或创建容器。

程序保留上游公开价格表、社区与扩展市场接口，相关页面和功能可能连接上游服务。Fiora 专属接口与 QQ 专属动作能力不同，插件需要逐项适配，不能将 OneBot 兼容层视为完整 QQ 协议实现。

### 联网搜索

对话模型与搜索服务分别配置。默认使用无需 API Key 的 Bing 网页搜索；搜索服务地址、提供方和密钥在控制台的搜索设置中管理。更换对话模型不会自动切换搜索提供方。

Bing 默认地址为 `https://www.bing.com/search`。旧配置中的 `cn.bing.com/search` 在部分服务器网络中会重定向到首页；遇到该情况时自动重试全球站点。搜索结果提取标题对应的真实网页地址，供 `web_fetch` 继续读取，避免把 Bing 跳转页作为正文。自定义搜索端点不参与该站点回退。

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
