# Docker 部署说明

本项目提供 Docker Compose 部署配置，包含：

- Node.js 应用容器
- PM2 守护进程
- MySQL 8.4
- Redis 7
- Nginx 反向代理
- media-cleanup 定时清理服务

## 文件说明

- `Dockerfile`：构建 Node.js 应用镜像，并通过 `pm2-runtime` 启动。
- `ecosystem.config.cjs`：PM2 进程配置。
- `docker-compose.yml`：编排 app、media-cleanup、mysql、redis、nginx。
- `scripts/media-cleanup-scheduler.js`：使用 `node-schedule` 定时清理过期媒体文件。
- `nginx/docker.conf.template`：容器环境使用的 Nginx 反向代理模板，由环境变量生成实际配置。
- `.env.docker.development.example`：开发环境变量示例。
- `.env.docker.production.example`：生产环境变量示例。
- `.env.docker.example`：通用 Docker 环境变量示例。

## 启动

开发环境复制环境变量文件：

```bash
cp .env.docker.development.example .env
```

生产环境复制环境变量文件：

```bash
cp .env.docker.production.example .env
```

修改 `.env` 中的密钥和数据库密码，至少需要修改：

```text
JWT_SECRET
MYSQL_ROOT_PASSWORD
MYSQL_PASSWORD
```

启动服务：

```bash
docker compose up -d --build
```

Compose 会根据 `.env` 中的 `APP_ENV` 同步切换 app、PM2、Redis、MySQL 和 Nginx 配置。

查看服务状态：

```bash
docker compose ps
```

查看应用日志：

```bash
docker compose logs -f app
```

访问：

```text
http://localhost
```

如果修改了 `NGINX_HTTP_PORT`，例如 `8080`，则访问：

```text
http://localhost:8080
```

## 服务连接

容器内服务连接如下：

- Node.js app：`app:3000`
- 定时清理：`media-cleanup`
- MySQL：`mysql:3306`
- Redis：`redis:6379`
- Nginx：对外暴露 `${NGINX_HTTP_PORT:-80}`

应用容器环境变量：

```text
APP_ENV=production
NODE_ENV=production
MYSQL_HOST=mysql
REDIS_URL=redis://redis:6379
```

开发环境示例：

```text
APP_ENV=development
MESSAGE_RETENTION_SECONDS=60
NGINX_HTTP_PORT=8080
NGINX_UPLOAD_CACHE_CONTROL=no-cache
```

生产环境示例：

```text
APP_ENV=production
MESSAGE_RETENTION_SECONDS=86400
NGINX_HTTP_PORT=80
NGINX_SERVER_NAME=chat.example.com
```

## PM2

应用容器使用 `pm2-runtime ecosystem.config.cjs --env ${APP_ENV}` 启动。

当前配置使用单进程 `fork` 模式：

```text
instances: 1
exec_mode: fork
```

实时在线状态和 Socket.IO 当前基于单进程内存状态管理，暂不建议直接改成多实例 `cluster`。如果未来需要多实例，需要先接入 Socket.IO Redis Adapter 和在线状态共享。

## Redis 消息过期

开发环境默认：

```text
MESSAGE_RETENTION_SECONDS=60
```

生产环境默认：

```text
MESSAGE_RETENTION_SECONDS=86400
```

生产环境聊天消息最多保存 24 小时。非文本消息过期后，`media-cleanup` 服务会使用 `node-schedule` 清理对应的图片、音频、视频文件。

媒体文件清理 Cron：

```text
MEDIA_CLEANUP_CRON="*/1 * * * *"
```

如需调整：

```bash
MESSAGE_RETENTION_SECONDS=3600 MEDIA_CLEANUP_CRON="*/5 * * * *" docker compose up -d
```

## 数据持久化

Compose 使用命名卷保存数据：

- `mysql_data`：MySQL 数据
- `redis_data`：Redis AOF 数据
- `app_uploads`：上传文件
- `app_logs`：应用日志

## 常用命令

重启应用容器：

```bash
docker compose restart app
```

重启 Nginx：

```bash
docker compose restart nginx
```

停止服务：

```bash
docker compose down
```

停止并删除数据卷：

```bash
docker compose down -v
```

## 数据库迁移

应用启动时会确保基础表存在。如需手动执行迁移：

```bash
docker compose exec app npm run db:migrate
```

查看迁移状态：

```bash
docker compose exec app npm run db:migrate:status
```


# 修改.env后restart环境变量未加载成功

在使用 Docker Compose 时，仅修改 .env 文件并执行 docker compose up -d，往往不会触发容器重建，因此环境变量不会更新。这是因为 Compose 默认不会检测 .env 文件变化。以下是几种常用且高效的刷新方法。

### 方法一：强制重建容器

步骤：
- 修改 .env 文件内容并保存。
执行： docker compose up -d --force-recreate [service_name] 可指定单个服务，避免影响其他服务。
该命令会重新读取 .env 文件并重建容器，同时保留网络和卷。
特点：
- 更新速度快。
- 不会中断无关服务。
- 推荐在生产环境使用。


```bash
docker compose up -d --force-recreate [service_name]
docker compose up -d --force-recreate app
docker compose up -d --force-recreate media-cleanup
```

