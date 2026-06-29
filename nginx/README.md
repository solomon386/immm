# Nginx 反向代理配置

本目录提供 Web IM Chat 的 Nginx 反向代理配置。

## 配置文件

- `development.conf`：开发环境配置，监听 `8080`，反向代理到 `127.0.0.1:3000`。
- `production.conf`：生产环境配置，监听 `80`，反向代理到 `127.0.0.1:3000`，包含常用安全头和上传缓存配置。

## 开发环境

确保 Node 服务已启动：

```bash
npm start
```

复制配置：

```bash
sudo cp nginx/development.conf /etc/nginx/conf.d/web-im-chat-dev.conf
sudo nginx -t
sudo nginx -s reload
```

访问：

```text
http://localhost:8080
```

## 生产环境

先修改 `production.conf`：

- 将 `server_name chat.example.com;` 改为实际域名。
- 如 Node 服务不是 `127.0.0.1:3000`，修改 `upstream web_im_chat_prod`。
- 如使用 HTTPS，配置证书并启用文件底部的 HTTPS 示例。

部署配置：

```bash
sudo cp nginx/production.conf /etc/nginx/conf.d/web-im-chat.conf
sudo nginx -t
sudo systemctl reload nginx
```

## WebSocket

项目使用 Socket.IO，配置中已包含 `/socket.io/` 的 WebSocket 升级代理：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

不要删除这部分配置，否则实时聊天和在线状态可能无法正常工作。
