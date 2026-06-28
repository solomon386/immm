# Web 即时聊天系统

这是一个轻量级 Web 即时聊天系统原型，使用 Node.js、Express 和 Socket.IO 实现。

## 已实现功能

- 用户注册和登录
- JWT 登录态校验
- 个人头像和昵称修改
- 搜索用户
- 发送好友请求
- 同意或拒绝好友请求
- 好友请求处理结果回执
- 删除好友
- 好友在线状态
- 好友新消息小红点提示
- 实时文本聊天
- 消息已读回执
- 消息删除
- 文本消息撤回编辑
- 图片消息上传和预览
- 语音消息上传和播放
- 视频消息上传和播放
- 上传文件安全校验，包括扩展名、MIME 类型、文件头和大小限制
- 一对一实时语音/视频通话，支持全局开关，默认关闭
- 聊天记录持久化到数据库，开发环境 SQLite，生产环境 MySQL
- Web 接口层日志系统，区分开发环境和生产环境

## 运行方式

请先安装 Node.js 18 或更高版本，然后在项目目录执行：

```bash
npm install
npm start
```

启动后打开：

```text
http://localhost:3000
```

## 数据库配置

项目已接入数据库持久化：

- 开发环境：默认使用 SQLite，数据文件为 `data.sqlite`。
- 生产环境：默认使用 MySQL，需要提前创建数据库。
- 测试环境：使用内存存储，不写入真实数据库。
- 个人数据、好友请求、好友关系、消息数据分别存储在 `users`、`friend_requests`、`friendships`、`messages` 表中。

开发环境可指定 SQLite 文件位置：

```bash
SQLITE_FILE=./data.sqlite npm start
```

生产环境可使用 MySQL 环境变量：

```bash
NODE_ENV=production MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASSWORD=your_password MYSQL_DATABASE=web_im_chat npm start
```

也可以使用连接串：

```bash
NODE_ENV=production DATABASE_URL=mysql://user:password@127.0.0.1:3306/web_im_chat npm start
```

## 数据库迁移

项目提供迁移管理脚本，用于模型数据结构变化后同步修改数据库。迁移文件按数据库类型分别存放：

- SQLite：`migrations/sqlite/*.sql`
- MySQL：`migrations/mysql/*.sql`

查看迁移状态：

```bash
npm run db:migrate:status
```

执行未执行的迁移：

```bash
npm run db:migrate
```

创建一组新的迁移文件：

```bash
npm run db:migration:create -- add_user_last_login
```

该命令会同时创建 SQLite 和 MySQL 两份 SQL 文件。模型字段或表结构变化时，请分别补充两个文件中的 SQL，再执行 `npm run db:migrate`。

生产环境执行 MySQL 迁移示例：

```bash
NODE_ENV=production MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASSWORD=your_password MYSQL_DATABASE=web_im_chat npm run db:migrate
```

语音和视频聊天默认关闭。如需开启，请在启动时设置：

```bash
ENABLE_CALLS=true npm start
```

生产环境启动：

```bash
npm run start:prod
```

## 日志系统

日志中间件接入在 HTTP Web 请求层，打开首页、加载静态资源和访问 `/api` 接口都会记录日志；每个请求都会返回 `X-Request-Id`，便于排查问题。

- 开发环境：默认 `NODE_ENV=development`，终端先输出彩色摘要，再输出格式化 JSON 详情。
- 生产环境：使用 `NODE_ENV=production`，日志以 JSON Lines 格式写入 `logs/access-YYYY-MM-DD.log`。
- 日志字段包含 `timestamp`、`environment`、`level`、`requestId`、`method`、`path`、`routeType`、`statusCode`、`durationMs`、`ip`、`userAgent`、`userId` 和 `requestData`。
- `requestData` 会记录查询参数和接口提交数据；`password`、`token` 等敏感字段会脱敏；图片、语音、视频等上传文件只记录文件名、类型、大小和 `/uploads/...` 存储路径，不记录文件内容。

## 自动化测试

项目使用 Node.js 内置测试框架，不需要额外安装 Jest。运行：

```bash
npm test
```

当前测试覆盖上传安全校验、文件头识别、消息已读回执辅助逻辑和媒体消息删除清理。

## 使用建议

1. 注册两个不同账号。
2. 用账号 A 搜索账号 B 并发送好友请求。
3. 用账号 B 登录后同意或拒绝好友请求，账号 A 会看到明确的处理结果。
4. 双方进入好友聊天窗口，即可发送文本、图片、语音和视频消息。
5. 收到非当前会话的新消息时，好友列表对应好友会显示小红点，打开该会话后自动消失。
6. 当好友在线时，点击聊天窗口右上角的“语音通话”或“视频通话”即可发起实时通话。
7. 对方打开会话后，发送方消息下方会从“未读”更新为“已读”。
8. 右键自己发送的消息，可选择“撤回编辑”修改文本消息，也可选择“删除消息”同步移除该消息。
9. 在好友列表中右键好友，可选择“清空聊天记录”只清理你和该好友之间的消息，也可选择“删除好友”解除好友关系并清理双方会话消息。

## 项目结构

```text
.
├── package.json
├── server.js
├── public
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── logs
└── uploads
```

## 注意事项

- 这是便于本地演示和二次开发的原型项目，默认使用本地 JSON 文件存储数据。
- 语音和视频通话使用浏览器 WebRTC 能力，语音通话需要麦克风权限，视频通话需要摄像头和麦克风权限。
- 本地测试建议使用 `localhost`；如果部署到服务器，摄像头和麦克风通常要求 HTTPS 环境。
- 上传仅允许常见图片、语音和视频格式；图片最大 10MB，语音最大 30MB，视频最大 100MB。
- 生产环境建议替换为数据库，例如 PostgreSQL、MySQL 或 MongoDB。
- 生产环境必须修改 `JWT_SECRET`，并进一步增加病毒扫描、对象存储隔离、鉴权下载、TURN 中继服务、消息已读回执、离线推送等能力。
