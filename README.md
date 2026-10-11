# Stella Web IM

基于 **React 18 + TypeScript + SharedWorker** 与 **Node.js + Express + WebSocket + MySQL** 的轻量化 Web 即时通讯系统原型。

全局唯一长连接、握手鉴权、指数退避重连、HTTP 增量轮询降级、多标签抢占单例、跨标签全局登出、双源消息加载、企业级 Axios 请求治理、完整好友与双向聊天闭环、群聊与群管理、消息撤回/转发/引用/置顶/免打扰/搜索/收藏、语音消息、账号与隐私安全基线（HttpOnly Cookie + CSRF + CSP + 限流）、Web Push 离线推送、PWA 与本地缓存。

---

## 一、快速开始

### 环境要求

| 依赖  | 版本                              |
| ----- | --------------------------------- |
| Node  | >= 18（已在 v22.14.0 验证）       |
| pnpm  | >= 9（已在 10.6.1 验证，推荐 10+） |
| MySQL | 8.x，监听 `127.0.0.1:3308`        |

本项目是 **pnpm workspace**：`server` 与 `web` 两个包共用根目录一份锁文件（`pnpm-lock.yaml`）与一个内容寻址存储，**在根目录执行一次安装即可**。

```bash
# 若尚未安装 pnpm（Node 18+ 自带 corepack）
corepack enable pnpm
# 或：npm i -g pnpm
```

数据库连接默认使用 `root / 123456`、端口 `3308`、库名 `stella_im`。
库与表在服务端启动时**自动创建**（幂等），无需手工执行 SQL。

### 安装与启动

```bash
# 1) 安装依赖（一次装齐 server + web）
pnpm install

# 2) 启动后端与前端（并行）
pnpm dev                    # = pnpm -r --parallel dev

# 也可分开启动：
pnpm dev:server             # 后端，--watch 热重载，默认 http://127.0.0.1:3001
pnpm dev:web                # 前端，默认 http://localhost:5173
```

浏览器打开 `http://localhost:5173`，注册两个账号（建议用**普通窗口 + 隐私窗口**，或两台设备）即可体验加好友与实时聊天。

### 配置覆盖（可选）

- 后端：复制 `server/.env.example` 为 `server/.env`
- 前端：复制 `web/.env.example` 为 `web/.env.local`

关键变量：`DB_PORT`、`DB_PASSWORD`、`DB_NAME`、`PORT`、`CORS_ORIGINS`、`SYSTEM_NOTICE_MS`、`VITE_API_BASE`、`VITE_API_PROXY_TARGET`。

> **安全 / 通知相关**：`COOKIE_SECURE`（生产置 `true`）、`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（Web Push；不设则开发启动时自动生成临时密钥）、`PUSH_ENABLED`、`RATE_LIMIT_DISABLED`（仅测试）、`CONTENT_FILTER_WORDS`。
> **开发同源**：前端默认 `API.base` 为空，由 Vite 代理 `/api` 与 `/ws` 到后端（`VITE_API_PROXY_TARGET`，默认 `http://127.0.0.1:3001`），使 `SameSite=Lax` 的 refresh Cookie 生效。**若你的 dev server 是在本次改动前启动的，请重启 `pnpm dev`。**

### pnpm 相关说明

- 依赖声明严格（无幽灵依赖）：两个包只声明自己用到的依赖，未声明即不可 `import`。
- pnpm 10 默认不执行依赖的构建脚本，已在 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 中显式放行 `esbuild`（Vite 需要），其余依赖均为纯 JS、无需构建。
- 常用命令：

| 命令                          | 作用                                     |
| ----------------------------- | ---------------------------------------- |
| `pnpm -C <dir> <script>`      | 在指定包内执行脚本（如 `pnpm -C web build`） |
| `pnpm -r <script>`            | 在所有包中依次执行                       |
| `pnpm -r --parallel dev`      | 并行启动所有包                           |
| `pnpm -C web add -D <pkg>`    | 给 web 包新增依赖                        |
| `pnpm -C web why <pkg>`       | 查看某依赖为何被安装                     |

---

## 二、目录结构

```
im/
├── server/                        # 后端：Express + ws + MySQL
│   └── src/
│       ├── index.js               # 应用装配（HTTP + WS + 定时任务 + 优雅退出）
│       ├── config.js              # 集中配置（全部带安全默认值）
│       ├── db/                    # 连接池 + 幂等建库建表 / 建表迁移 / 枚举升级
│       ├── repositories/          # 数据访问层（纯 SQL，可独立替换）
│       │   ├── userRepo / tokenRepo / sessionRepo
│       │   ├── friendRepo / blockRepo / inviteLinkRepo / userSettingsRepo
│       │   ├── messageRepo / conversationRepo / favoriteRepo
│       │   ├── groupRepo / attachmentRepo / noticeRepo / pushRepo
│       ├── services/              # 业务逻辑层（鉴权/好友/消息/群/公告/推送/风控）
│       ├── routes/                # HTTP 接口层（含 conversations/favorites/push/reports/settings）
│       ├── middleware/            # auth / csrf / rateLimit / securityHeaders / error
│       ├── ws/                    # 握手鉴权 / 连接中心 / 心跳 / 持续校验
│       ├── utils/                 # jwt / cookies / origin / logger（含脱敏）
│       └── jobs/                  # 2 分钟系统公告广播
│   └── test/e2e.js                # 后端集成测试（97 项）
└── web/                           # 前端：React18 + TS + Vite
    ├── public/
    │   ├── realtime-engine.js     # 与宿主无关的 WS 状态机（重连/降级/自愈）
    │   ├── realtime-worker.js     # SharedWorker：全局唯一连接 + 标签页广播 + 抢占
    │   ├── sw.js                  # Service Worker：Web Push 展示 + 离线外壳缓存
    │   └── manifest.webmanifest   # PWA 清单
    ├── src/
    │   ├── lib/                   # 能力中台（无 UI 依赖）
    │   │   ├── axiosClient.ts     # Axios 请求治理（含 Cookie/CSRF）
    │   │   ├── session.ts         # 会话管理（access 仅内存）+ 跨标签登出
    │   │   ├── realtime.ts        # 实时层门面（SharedWorker / 页内降级）
    │   │   ├── bus.ts             # 跨页总线（BroadcastChannel → StorageEvent）
    │   │   ├── push.ts            # Web Push 订阅
    │   │   ├── idb.ts             # IndexedDB 缓存 + storage.estimate
    │   │   ├── theme.ts / transport.ts / storage.ts / conversation.ts
    │   │   └── api.ts             # 类型化接口
    │   ├── context/AppContext.tsx # 全局能力层（只存能力，不存业务数据）
    │   ├── pages/                 # 登录页 / 应用外壳 / 好友 / 聊天窗口
    │   └── components/            # Toast / 冻结遮罩 / 设置 / 群信息 / 资料 / 头像
    └── test/                      # 引擎测试（8 项）+ 治理（4 项）+ 浏览器 E2E（17 项）
```

---

## 三、架构落地说明

### 四层分层（单向依赖）

| 层             | 目录                                    | 职责                                                     |
| -------------- | --------------------------------------- | -------------------------------------------------------- |
| 底层通信兼容层 | `web/public/*`、`web/src/lib/bus.ts`    | 全局长连接、跨页同步、降级兜底                           |
| 全局能力中台层 | `web/src/lib/*`                         | WS 连接管理、Axios 治理、会话管理、多标签抢占            |
| 全局状态调度层 | `web/src/context/AppContext.tsx`        | **只管理能力、订阅、状态**，不存任何业务数据             |
| 页面业务层     | `web/src/pages/*`                       | 好友/消息等业务数据全部页面私有，卸载即销毁              |

### 能力全局、数据局部

`AppContext` 仅暴露：登录用户、连接状态、标签页活跃状态、两条订阅总线（页面消息 / 全局通知）、全局活跃会话 ID、Toast 能力。
好友列表、消息列表、未读计数、系统公告均由 `ChatShell` / `ChatWindow` 本地持有，切换会话或卸载时彻底清理。

### 完全解耦订阅

页面通过 `subscribeFrames` / `subscribeNotices` 订阅，不直接依赖 WebSocket。
`onPoll`（轮询结果）在 Context 内被**归一化成与 WS 完全相同的 frame 形状**，因此页面只有一条处理路径 —— 无漏消息、无重复渲染。

---

## 四、需求实现对照

### 1. 全局唯一 WebSocket 长连接（SharedWorker）

- `web/public/realtime-worker.js`：浏览器内**唯一**的 WS 持有者，所有标签页通过 `MessagePort` 接入。
- 多标签实测：打开第二个标签后 `/api/health` 的 `connections` 仍为 `1`（见浏览器 E2E）。
- 不支持 SharedWorker 时，`realtime.ts` 自动切换「页内降级」：经总线选出**唯一 leader 标签**持有连接，其余标签接收转发帧。

### 2. WebSocket 握手鉴权

- 前端：无有效 Token 时引擎**直接不发起握手**（`getToken()` 返回空 → 状态 `idle` + 请求令牌）。
- 后端：`ws/server.js` 接管 `upgrade` 事件，未通过 JWT 校验（缺失/无效/过期/`token_version` 不匹配/**设备会话已吊销**）时**写入 HTTP 401 并销毁 socket**，协议升级永不完成；同时校验 `Origin` 白名单（非生产放行 localhost 任意端口）。
- 连接持续鉴权：后端定时（默认 60s）复核每个在线连接的 Token 有效期、`token_version` 与**设备会话（`sid`）状态**，失效主动断开（关闭码 `4001` 过期 / `4002` 会话被吊销）。

### 3. 断线重连：指数退避 + 随机抖动

- `computeBackoff()`：`min(cap, base·2^n)`，叠加抖动，1s → 2s → 4s → … 封顶 30s。
- 最大重连次数超限后**停止冲击**，转入轮询。登出/会话失效立即终止所有重连。

### 4. 彻底失效自动降级 HTTP 增量轮询

- 触发条件：浏览器不支持 WS、持续多次重连失败。
- 轮询携带 `sinceId` / `noticeSinceId` 游标，只取增量；空数据自动拉长间隔（3s→15s），有数据立即恢复高频。
- 后台持续探测 WS（默认 30s），一旦恢复立刻切回长连接、停止轮询，并**做一次补拉**填补降级期间的缺口。

### 5. 多标签抢占式单例

- 新窗口打开即抢占活跃权，旧窗口**冻结界面**（全屏遮罩，可一键「在此窗口继续操作」接管）。
- Worker 侧维护标签存活心跳（3s ping + 10s 陈旧判定），leader 崩溃自动提升最活跃标签。

### 6. 登录 / 退出 / 跨标签同步登出

- 后端 `token_version` 机制：登出即自增版本号，**该用户所有 access/refresh token 立即失效**，并主动断开全部在线连接。
- 前端跨标签：写入登出信号 → 其他标签经 `StorageEvent` 感知 → 清空登录态、关闭连接、跳转登录页。

### 7. 好友体系与双向聊天

- 搜索用户 → 发起申请（WS 实时推送 `friend:request`）→ 对方同意（双方收到 `friend:accepted`）→ 建立**双向对称好友关系**（`friendships` 双行写入，事务保证）。
- 修改资料（昵称 / 头像）经 `profile:updated` 推送给自己所有标签与全部好友，列表与聊天标题即时刷新。
- 非好友发消息被拒绝（403 `NOT_FRIENDS`）。

#### 删除好友是**单向**的，因此拆成了两个判定

`DELETE /api/friends/:friendId` 只删除**我自己那一行**：对方列表里仍有我、且双方仍能继续收发消息。这个语义有一个必须处理的陷阱，否则会形成死局：

- 若消息闸门沿用「发起方有对方」的**有向**判定 → 我删掉对方后能收不能回（点开会话只能看到 403）。
- 若为了修上面而把**加好友**的判定也改成对称 → 对方会变成「幽灵好友」：从我的列表消失、却仍出现在搜索结果里、且点添加永远返回 `ALREADY_FRIENDS`。

所以判定拆成两处，各管一段：

| 判定 | 方向 | 用途 |
| ---- | ---- | ---- |
| `friendRepo.areFriends` | **有向** | 仅 `sendRequest` 的「已是好友」前置校验（保证删掉后还能重新添加） |
| `friendRepo.canChat` | **对称** | 仅消息发送闸门（保证单向删除后会话不死） |

由此：单向删除后可重新申请并恢复好友关系；双方互删后两向皆无记录，消息重新被 `NOT_FRIENDS` 拒绝；真正陌生人行为不变。UI 上如实呈现为「从我的列表移除」，并在确认按钮的 `title` 里说明对方仍保留你。

### 8. 后端定时系统通知

- `jobs/systemNotice.js`：每 2 分钟广播携带**当前服务端时间**的公告，全局强制弹窗。
- 公告同时落库，轮询降级链路也能取到（不会因长连接不可用而漏掉公告）。

### 9. 消息双源策略

- 进入会话：HTTP 拉取历史（`/api/messages/history`，支持 `beforeId` 上翻分页）。
- 在线期间：WS 推送增量；发送方乐观渲染 + `clientMsgId` 幂等去重 + 8s 超时标记失败可重发。
- 已读回执：`message:read` → 作者收到 `chat:status`。

### 10. 精准全局通知

| 事件             | 行为                                    |
| ---------------- | --------------------------------------- |
| 当前会话的消息   | 静默更新聊天列表                        |
| 其他会话的消息   | Toast 弹窗 + 未读角标 +「查看」跳转会话 |
| 好友申请 / 通过  | 任意页面 Toast 弹窗                     |
| 系统公告         | 任意页面强制 Toast 弹窗                 |

### 11. 企业级 Axios 请求治理（`lib/axiosClient.ts`）

| 能力           | 实现要点                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| 请求拦截       | 统一注入 Token（登录/注册/刷新接口除外）                                      |
| 响应拦截       | 统一剥离 `{ok,data}` 信封、归一化错误为 `ApiError{status,code,message}`       |
| 竞态取消       | 同指纹读取请求：新请求到来即 abort 旧请求                                     |
| 重复请求去重   | 同指纹写请求在 1.2s 窗口内合并到同一次在途调用                                |
| 并发队列限流   | 信号量限制最大 6 并发，防浏览器连接阻塞                                       |
| 401 无感刷新   | 单飞刷新 + 在途请求排队，成功后批量重放；失败则**全局跨标签登出**             |
| 失败自动重试   | 仅网络异常 / 5xx 重试 2 次，指数退避 + 抖动；4xx 业务错误不重试               |

### 12. 内存与容错

页面数据局部化、卸载即销毁；订阅在 `useEffect` 清理函数中退订；定时器统一回收。

### 13. 清单补齐（P1–P4）

在原有能力之上，按《精简功能清单》补齐了四个阶段：

**P1 · 账号 / 隐私 / 安全基线**
- 账号：修改密码（改密后吊销其他会话）、活跃会话管理（列表 / 远程登出 / 登出其他设备）、注销 + 7 天冷静期找回、登录失败锁定（5 次 / 15 分钟）、记住我。
- 隐私与关系链：添加我的方式（用户名 / 邀请链接 / 群聊）、加好友需验证开关、黑名单、好友备注（仅本地）、邀请链接、好友上限 2000、个性签名。
- 风控与合规：注册 / 登录 / 加好友 / 发消息 / 建群限流、违规词拦截、举报（含回执）、禁言 / 封禁处置、审计日志、日志 PII 脱敏。
- 安全基线：refresh token 改为 **HttpOnly Cookie**、access token **仅存内存**、**CSRF** 双提交、安全响应头（CSP / X-Frame-Options / Referrer-Policy / Permissions-Policy）、CORS 凭据、WS 握手 Origin 校验。
- 开发同源：Vite 代理 `/api` `/ws`，使 `SameSite=Lax` Cookie 生效。

**P2 · 消息与会话**
- 撤回（2 分钟，双方转为系统提示）、引用回复、逐条转发、删除（本地）、清空会话、置顶（上限 10）、免打扰、会话内搜索、消息收藏。
- 群聊：群昵称、管理员（群主任命）、入群确认开关、群文件。
- 体验：消息右键菜单、签名与草稿、输入 2000 字上限、链接自动识别（`rel="noopener noreferrer"`）。

**P3 · 通知 / 多端 / 数据**
- Web Push（离线推送，尊重免打扰与桌面通知开关、点击回到会话）、标签页标题未读角标 + favicon 徽标、提示音、桌面通知（用户手势后申请权限）。
- IndexedDB 本地缓存（首屏加速）、PWA 清单 + Service Worker 离线外壳、按会话导出聊天记录、存储占用查看与清理。

**P4 · 多媒体与打磨**
- 语音消息（MediaRecorder 录制 / 上传 / 播放）、青少年模式（关闭陌生人添加）、隐私政策说明。

---

## 五、HTTP / WebSocket 接口

### HTTP

> 鉴权：除登录/注册/刷新/恢复外均需 `Authorization: Bearer <accessToken>`。登录/注册/刷新/恢复的 **refresh token 通过 `Set-Cookie: stella_rt`（HttpOnly）下发**，请求体不再返回；`/api/auth/refresh` 需带 `X-CSRF-Token`（值等于非 HttpOnly 的 `stella_csrf` Cookie）。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/api/health` | 健康检查（含在线用户数、连接数） |
| POST | `/api/auth/register` | 注册（返回 accessToken + 用户） |
| POST | `/api/auth/login` | 登录（支持 `rememberMe`） |
| POST | `/api/auth/refresh` | 刷新（单次轮换；Cookie + CSRF） |
| POST | `/api/auth/restore` | 冷静期内恢复已注销账号 |
| POST | `/api/auth/logout` | 登出（吊销全部令牌 + 断开连接） |
| GET  | `/api/auth/me` | 当前用户 |
| PATCH| `/api/auth/me` | 修改资料：`nickname` / `avatar` / `bio` |
| DELETE| `/api/auth/me` | 注销账号（软删 + 冷静期，需密码） |
| POST | `/api/auth/password` | 修改密码（吊销其他会话） |
| GET  | `/api/auth/sessions` | 活跃会话（设备）列表 |
| DELETE| `/api/auth/sessions/:id` | 远程登出该设备 |
| POST | `/api/auth/sessions/revoke-others` | 登出其他所有设备 |
| GET / PATCH | `/api/settings` | 隐私与通知开关 |
| GET  | `/api/friends` | 好友列表（含 `remark`） |
| GET  | `/api/friends/search?q=` | 搜索用户（受添加方式开关约束） |
| GET  | `/api/friends/requests` | 待处理好友申请 |
| POST | `/api/friends/requests` | 发起申请：`{toUserId}`，或 `{token}` 走邀请链接 |
| POST | `/api/friends/requests/:id/accept` | 同意（`:action` 亦可为 `reject`） |
| PATCH| `/api/friends/:friendId` | 设置好友备注（仅本地可见） |
| DELETE| `/api/friends/:friendId` | **单向**移除好友 |
| GET / POST | `/api/friends/blocks` | 黑名单列表 / 拉黑 |
| DELETE| `/api/friends/blocks/:id` | 移出黑名单 |
| GET / POST | `/api/friends/invite-links` | 邀请链接列表 / 生成 |
| DELETE| `/api/friends/invite-links/:token` | 使邀请链接失效 |
| GET  | `/api/messages/history` | 历史消息（`friendId`/`beforeId`/`limit`） |
| GET  | `/api/messages/search` | 会话内搜索（`friendId` 或 `groupId` + `q`） |
| GET  | `/api/messages/poll` | 增量轮询（`sinceId`/`noticeSinceId`） |
| POST | `/api/messages` | 发送（可带 `quoteId` / `attachmentId`） |
| POST | `/api/messages/:id/recall` | 撤回（限 2 分钟） |
| POST | `/api/messages/:id/forward` | 逐条转发 |
| DELETE| `/api/messages/:id` | 本地删除（仅我可见） |
| POST | `/api/messages/conversation/clear` | 清空会话 |
| POST | `/api/messages/read` | 已读回执 |
| GET  | `/api/conversations` | 置顶 / 免打扰设置列表 |
| PATCH| `/api/conversations/:peerKind/:peerId` | 置顶 / 免打扰 |
| POST | `/api/conversations/:peerKind/:peerId/clear` | 清空该会话 |
| GET / POST | `/api/favorites` | 收藏列表 / 收藏消息 |
| DELETE| `/api/favorites/:id` | 删除收藏 |
| POST | `/api/reports` | 举报 |
| GET  | `/api/reports/mine` | 我的举报回执 |
| GET  | `/api/push/public-key` | VAPID 公钥 + 是否启用 |
| POST | `/api/push/subscribe` · `/unsubscribe` | 订阅 / 退订 Web Push |
| GET / POST | `/api/groups` | 我的群 / 建群 |
| GET  | `/api/groups/search?q=` | 按群号或群名查找 |
| GET / PATCH / DELETE | `/api/groups/:id` | 群详情 / 改资料（`joinApproval` 等）/ 解散 |
| GET  | `/api/groups/:id/messages` | 群历史 |
| POST | `/api/groups/:id/members` | 添加成员 |
| DELETE| `/api/groups/:id/members/:userId` | 移除成员 |
| PATCH| `/api/groups/:id/members/me` | 设置我的群昵称 |
| PATCH| `/api/groups/:id/members/:userId/role` | 任命 / 取消管理员 |
| GET  | `/api/groups/:id/files` | 群文件 |
| POST | `/api/groups/:id/read` | 推进我的群已读游标 |
| POST | `/api/groups/:id/join-requests` | 申请入群（开放群直接入群） |
| GET / POST | `/api/groups/:id/join-requests[/:requestId/:action]` | 查看 / 审批入群申请 |
| POST | `/api/groups/:id/leave` | 退群（群主退群即解散） |
| POST | `/api/attachments` | 上传（字段 `file`，可选 `kind=voice`） |
| GET  | `/api/attachments/:id/raw?token=` | 附件字节流 |
| GET  | `/api/system/notices` | 公告增量拉取 |

### WebSocket（`ws://host:3001/ws?token=<accessToken>`）

上行：`ping`、`auth:refresh`、`chat:send`、`chat:recall`、`message:read`

下行：`ready`、`pong`、`chat:message`、`chat:status`、`chat:error`、`chat:recalled`、`conversation:updated`、`favorite:updated`、`friend:request`、`friend:accepted`、`friend:removed`、`profile:updated`、`presence`、`notice:system`、`session:invalid`、`group:created`、`group:updated`、`group:member_added`、`group:member_removed`、`group:member_left`、`group:member_updated`、`group:dissolved`、`group:join_requested`、`group:join_result`

应用层关闭码：`4001` Token 过期（可续期重连）、`4002` 会话被吊销（必须重新登录）、`4004` 被替换。

---

## 六、数据模型（MySQL / `stella_im`）

库表在服务端启动时幂等创建；新增列 / 枚举升级走 `information_schema` 守卫的迁移（见 `db/init.js` 的 `MIGRATIONS` / `INDEX_MIGRATIONS` / `ALTERS`）。

| 表 | 关键设计 |
| -- | -------- |
| `users` | `token_version` 支持「一登出即全体失效」；`bio` / `muted_until` / `banned` / `deleted_at`（注销冷静期） |
| `sessions` | 登录谱系：`session_id` / `current_jti` / UA / IP，支持**按设备**吊销（活跃会话管理） |
| `refresh_tokens` | 仅存 `sha256` 摘要 + `jti` + `session_id`；轮换式单次使用 + 重用检测 + 30s 宽限 lineage（并发刷新不误杀） |
| `friendships` | 双向两行 + 唯一索引；`remark` 私密备注 |
| `friend_requests` | `(from,to)` 唯一键 + upsert，拒绝后可再次申请 |
| `blocks` | 有向黑名单，消息闸门对称判黑 |
| `friend_invite_links` | 邀请链接（token / 有效期 / 失效） |
| `user_settings` | 隐私（添加方式 / 验证）与通知（桌面 / 声音 / 内容）开关 |
| `messages` | 自增 `id` 兼作增量游标；`client_msg_id` 唯一键保证幂等；`group_id` / `type` / `mention_user_ids` / `attachment_id`；P2 增 `recalled_at` / `quote_id` |
| `conversation_settings` | 每用户每会话的 `pinned` / `muted` / `cleared_before_id`（清空水位） |
| `message_hidden` | 单条消息的本地删除（仅我不可见） |
| `favorites` | 收藏**快照**（原消息撤回后仍可读） |
| `groups` | `group_no` 群号、`announcement`、`join_approval` 入群确认 |
| `group_members` | `role` ∈ `owner`/`admin`/`member`、`nickname` 群昵称、`last_read_message_id` 已读游标 |
| `group_join_requests` | 入群申请（`(group,user)` 唯一 + upsert） |
| `attachments` | 上传元数据；`kind` ∈ `image`/`file`/`voice` |
| `reports` | 举报与状态 |
| `audit_logs` | 敏感操作审计（最小必要） |
| `push_subscriptions` | Web Push 订阅（endpoint 唯一） |
| `system_notices` | 公告落库，轮询降级链路亦可获取 |

---

## 七、界面与交互

### 视觉：微信风格

界面采用微信式视觉语言（绿色 `#07C160` 品牌色、带小尖角的圆角气泡、72px 左侧 Rail、微信浅/深色）。所有颜色仍然收敛在 `:root` 令牌里（组件内不写死颜色），令牌随主题切换：

| 令牌 | 用途 |
| ---- | ---- |
| `--bg` / `--surface` / `--surface-2` | 页面 / 侧栏与卡片 / 次级面板 |
| `--border` / `--text` / `--text-2` | 边框 / 正文 / 次要文字 |
| `--brand`（回退 `--accent`） | 强调色（我的气泡、主按钮、选中态） |
| `--bubble-tail` | 气泡小尖角（主题可选开关） |

规则：圆角气泡、低对比分隔线、头像圆形；保留 `prefers-reduced-motion` 全量降级与 `:focus-visible` 焦点环。

### 头像：内置几何预设

不引入任何上传/静态服务：`users.avatar` 只存一个短 ID（服务端白名单 `server/src/constants/avatars.js` 的 `p01`–`p12`，非法值一律 400 `INVALID_AVATAR`），图形由 `web/src/lib/avatarPresets.tsx` 用内联 SVG 绘制，取色走 `--avatar-*` 令牌。未设置头像时回退为首字母方块。改头像/昵称后经 `profile:updated` 推送给自己所有标签与全部好友，无需刷新。

### 主题：多套配色

主题只是**一组 CSS 变量**，切换就是在 `<html>` 上改一个 `data-theme` 属性 —— 不触发任何 React 重渲染。默认微信风格，并保留多套外观：

| id | 观感 |
| -- | ---- |
| `wechat`（默认） | 微信浅色：白底 + 绿 `#07C160` |
| `wechat-dark` | 微信深色 |
| `apple` / `apple-dark` | iOS 观感：系统蓝 + iMessage 气泡 + 玻璃材质 |
| `acid` / `cyan` / `lime` / `magenta` / `ember` / `blueprint` / `paper` | 早期粗野主义配色（保留） |

做法上有两个关键点：

- **`--accent` 与 `--on-accent` 拆开**：强调色既被当作填充（我的气泡、主按钮，压黑字），也被当作文字（链接、告警）。把「填充上的文字色」独立成 `--on-accent` 后，浅色主题才能既保留高饱和强调色又不丢对比度。另有一个 `--accent-ink` 专门用于「强调色当文字」的场景。
- **头像预设跟着主题走**：SVG 取色走 `--avatar-*`，所以浅色主题下自动变成深色图案浅底，无需第二套素材。

主题是**设备本地偏好**（`localStorage: stella.im.theme`），不上传服务端。`index.html` 里有一段内联脚本在首次绘制前套用存储的主题，刷新不会闪一下默认配色。Rail 底部的日/夜开关按 `THEME_PAIRS`（`lib/theme.ts`）在**同一族**内切换。

### 响应式：手机上单屏单面板

| 断点 | 行为 |
| ---- | ---- |
| `> 1024px` | 双栏：`72px` Rail + 可拖拽侧栏（默认 392px）+ 内容区（最小 480px） |
| `768–1024px` | 双栏保留，内容区最小宽度降到 360px（平板/小笔记本不再压缩内容） |
| `≤ 768px` | 隐藏拖拽分割线；触控目标放大 |
| `≤ 640px` | **单屏单面板**：由全局 `activeConversationId` 决定显示侧栏还是聊天面板（`.shell.conv-open`），聊天面板顶部出现返回键；Toast 移到顶部避免遮挡输入框；输入区使用 `env(safe-area-inset-bottom)` 适配全面屏 |

### 文案

按「激进精简」处理：删除全部营销/说明段落与技术状态文字，技术细节改挂在 `title` / `aria-label` / `data-*` 上（人看不到、但可悬停查看、测试可断言）。健康状态下状态区只剩一个连接点和一个角色标记 —— **不出声即正常**，异常时才出现两字提示（`重连` / `轮询` / `断开` / `离线`）。

### 性能：按变更频率拆分 Context

原先所有全局能力挤在**一个** context value 里，于是「来了一条 Toast」或「连接状态抖动一次」都会让 value 变化，进而重渲染**每一个**消费者 —— 包括正在显示几百条消息的聊天窗口。现在按变更频率拆成四个 context，消费者只订阅自己真正读取的那一片：

| Context | 变更频率 | 谁在消费 |
| ------- | -------- | -------- |
| `ActionsContext` | **从不变化** | 所有组件（稳定的回调，不引起任何重渲染） |
| `SessionContext` | 很少 | 登录用户、当前会话 id |
| `RealtimeContext` | 连接状态跃迁时 | 只有状态指示器与冻结遮罩 |
| `ToastsContext` | 每条 Toast | 只有 Toast 容器 |

配套的几处：

- `ChatWindow` **完全不读任何全局 state**，只接收 `myId` / `frozen` 作为 props，并且用 `memo` 包住 —— 因此 Toast、连接抖动、好友列表变化都不会重渲染消息列表。
- 每条消息是一个 `memo` 化的 `MessageRow`；消息对象在局部更新时**保持引用不变**，所以新来一条消息只重渲染那一条。
- 「加载更早的消息」用**递减的负 seq** 把旧页插到前面，而不是把整个数组重新编号（后者会让所有行都换新对象、全部重渲染）。
- **已读回执改为批量发送**：原先每收到一条消息就发一次 HTTP（一次 40 条的突发 = 40 个请求 + 40 轮额外重渲染），现在按 400ms 窗口合并，并在切换会话/卸载时兜底冲刷。
- 相同的连接状态更新直接跳过（返回旧 state，React 不来渲染）。
- 渲染期写 ref 改为在 effect 中写（并发渲染下渲染期写 ref 是不安全的）。

#### 实测（`pnpm perf`）

基准脚本会造一个长会话、灌入突发消息，用页面内的 `requestAnimationFrame` 采样帧间隔、`PerformanceObserver` 采样长任务、`MutationObserver` 采样消息落屏时刻。

| 场景 | 结果 |
| ---- | ---- |
| 生产构建，200 条历史 + 40 条突发 | 帧间隔稳定 **16.7ms（60fps）**，掉帧 0，长任务 0，逐条落屏延迟 **≈0ms** |
| dev server 同样场景 | 同样 60fps / 0 掉帧（所以卡顿并非单纯来自 dev 模式） |
| 1500 条历史 + 40 条突发 | 出现一次 50–217ms 卡顿（大量节点首次挂载），打字延迟开始可测 |

**行级 `memo` 的收益在长列表下才显现**（1500 条消息时实测）：

| 打字 → 上屏 | 无行 memo | 有行 memo |
| ----------- | --------- | --------- |
| p50 | 20.3ms | **13.5ms** |
| p95 | 25.3ms | **19.2ms** |

诚实说明：**在 200 条消息以内，这些优化测不出差别** —— 此时重渲染的开销本来就落在帧预算内。优化是长列表与高消息速率下的保险，不是把「已经很快」变成「更快」。

```bash
pnpm build:web && pnpm preview:web          # 基准跑在 :4173 的生产构建上
pnpm perf                                   # 默认 200 条历史 + 40 条突发
BENCH_HISTORY=1500 BENCH_PAGES=30 pnpm perf # 长列表场景
```

### 界面快照

```bash
pnpm visual        # 渲染 1440 / 768 / 375 三档（含主题）并输出 PNG 到 web/test/screenshots
```

## 八、测试与验证

四套自动化测试。

```bash
# 后端集成测试（自启独立端口的服务进程：鉴权/会话/好友/消息/令牌轮换/单向删除/撤回收发/群管理/
# 推送订阅/隐私开关/拉黑/内容过滤/举报/注销恢复/审计 等）
pnpm test:server             # 97 passed（另有 2 项为仓库既有 WIP 的公告文案断言失败，与本次无关）

# 实时引擎测试：鉴权门禁、退避序列、单连接不变量、降级轮询、断网恢复、会话吊销
pnpm test:engine             # 8 passed

# 无需浏览器的两项可一次跑完
pnpm test

# Axios 请求治理（真实浏览器 + 网络拦截：Cookie 续期 / 5xx 重试 / 4xx 不重试 / 写请求去重）
pnpm test:governance         # 4 passed   （需先 pnpm dev）

# 真实浏览器 E2E（Chrome/Edge headless）
pnpm build:web
pnpm preview:web             # 另开终端，监听 4173
pnpm test:browser            # 17 passed
```

> 四套测试也可直接以 `node` 运行（不依赖包管理器）：
> `node server/test/e2e.js`、`node web/test/engine.e2e.mjs`、
> `node web/test/governance.e2e.mjs`、`node web/test/browser.e2e.mjs`。

> 后端集成测试的 harness 已适配新的鉴权：使用 **Cookie jar** 走 refresh，断言「有 accessToken、无 refreshToken、有 Set-Cookie」，并注入 `RATE_LIMIT_DISABLED=1` / `REFRESH_GRACE_MS=0` / `CONTENT_FILTER_WORDS`。

> 浏览器 E2E 中的「系统公告」断言需要后端在等待窗口内广播公告。
> 建议以 `SYSTEM_NOTICE_MS=5000` 启动后端；若使用默认 120s，该项会打印 skip 提示并自动跳过。

> `test:governance` 直接对着**你正在运行的服务**跑（默认 `http://localhost:5173` + `:3001`）：
> 通过**真实 UI 登录**（refresh token 在 HttpOnly Cookie 中），再用请求拦截把某次读取注入 401 来触发静默续期，验证「续期一次并重放、不登出」。可用 `E2E_APP` / `E2E_API` 覆盖。

### 浏览器 E2E 覆盖的实际场景

1. 未登录访问 → 跳登录页，且 `/api/health` 的 `connections === 0`（**未登录不建立任何长连接**）
2. 登录后 `connections === 1`
3. **打开第二个标签后 `connections` 仍为 1**（SharedWorker 复用，核心亮点）
4. 两个标签中有且仅有一个可操作，另一个被冻结；点击「在此窗口继续操作」活跃权正确转移
5. 第二个用户登录 → 产生独立的第二条连接
6. 建立好友关系：HTTP 发起 + WS 推送同步到双方界面
7. 会话外消息触发 Toast 弹窗与未读角标
8. 会话内消息静默渲染，**不产生重复弹窗**
9. 后端定时系统公告在页面强制弹窗并携带服务端时间、同时固定到侧边栏
10. 修改昵称与头像：本地立即生效，并经 WS 同步到好友窗口
11. 从我的列表移除好友：我方两处（好友列表 / 会话列表）消失，对方仍保留我且仍可发消息
12. 任意窗口退出 → 所有窗口同步下线、连接归零；登出后不再重连

### 引擎测试覆盖的实际场景

1. 无 Token 时引擎不发起连接并向上层索要令牌
2. 退避函数满足指数增长、抖动下限与封顶约束
3. 无效令牌握手被拒 → 退避序列精确为 `[60,120,240]ms` → 超限自动降级轮询
4. **单连接不变量**：并发 `start()` / `retryNow()` 不会创建第二条连接
5. 经 TCP 代理切断长连接 → 降级轮询 → **拉取到中断期间产生的消息** → 网络恢复后自动切回 WS，后续消息以 frame 到达且不再轮询
6. 服务端登出 → 引擎收到会话失效并彻底停止重连（不会继续刷新重试）

### Axios 治理测试覆盖的实际场景（`test:governance`）

1. **401 无感续期**：真实登录（refresh 在 HttpOnly Cookie）→ 重载后内存令牌丢失 → 应用从 Cookie 静默续期一次，并重放被注入 401 的读取；断言未登出、Cookie 已轮换、且 access token **未**写入 localStorage
2. **5xx 自动重试**：注入一次 500 → 请求次数精确等于 `基线 + 1`（先测出含 React StrictMode 双挂载的基线，再断言「只多一次」）
3. **4xx 不重试**：全部注入 400 → 请求次数**等于基线**（零重试），且错误被抛到业务层并弹出提示
4. **写请求去重**：同一帧内双击「添加好友」→ 只发出一次 `POST /api/friends/requests`

> 说明：**竞态取消**（同指纹读请求以 abort 取代旧请求）与**并发队列限流**这两项只能在库内部观测，
> 当前未被断言；它们已实现但属于「间接验证」（每次页面加载都会经过该路径）。

---

## 九、双账号实时聊天演示

一条命令即可拉起「开箱即可聊天」的双账号演示：脚本会先幂等地创建两个演示账号并互相加为好友、写入几条历史消息，然后打开**两个互相独立的浏览器窗口**（各自独立的 localStorage 与 SharedWorker，等价于两个真实用户），并持续打印后端长连接数。

```bash
# 后端与前端 dev server 需已在运行
pnpm demo                       # 或 pnpm -C web demo / node web/test/demo-browser.mjs
```

| 窗口     | 账号        | 密码      |
| -------- | ----------- | --------- |
| 左侧窗口 | `demo_alice` | `123456` |
| 右侧窗口 | `demo_bob`   | `123456` |

预期监控输出（连接数必须恒为 2，出现 >2 即为连接泄漏）：

```
后端长连接数 = 2（两个独立窗口应分别为 1 条，合计 2）
  [18:35:28] 长连接数=2 在线用户=2
  [18:35:38] 长连接数=2 在线用户=2
```

脚本还会记录任何 `POST /api/auth/logout` 请求发起方，便于区分「用户点击退出」与「异常登出」。按 `Ctrl+C` 结束演示并关闭窗口。

建议在演示中依次体验：

1. 在左侧窗口发消息 → 右侧窗口立即收到（WS 实时推送）与未读角标
2. 打开右侧会话后再发消息 → 右侧静默更新、不再弹窗
3. 在**同一窗口**再开一个标签 → 长连接数仍为 2（SharedWorker 复用），旧标签被冻结
4. 停掉后端进程 → 观察退避重连日志；长时间不可用则降级为增量轮询；恢复后端后自动切回长连接
5. 在任一窗口点「退出」→ 该窗口的所有标签同步下线，长连接数减 1

---

## 十、已知边界

- **部署**：生产需自行配置 HTTPS 与静态托管（代码已就绪：CSP、HttpOnly + Secure Cookie、Service Worker / Web Push 均要求安全上下文）。开发环境通过 Vite 代理实现前后端同源，使 `SameSite=Lax` Cookie 生效。
- **Web Push**：未配置 `VAPID_*` 时开发启动会生成临时密钥，**重启后已订阅设备失效**；生产请固定密钥。iOS 需 16.4+ 且「添加到主屏幕」才支持。
- **表情**：一期仅系统 emoji（表情包后置）。
- **Token 传递**：WS 握手与附件 `<img>`/下载通过查询串 `?token=` 传 access token（浏览器无法为其设置自定义请求头），后端同时兼容 `Authorization: Bearer`，便于非浏览器客户端接入。
- **单机内存态连接中心**（`ws/hub.js`）：多实例部署需引入 Redis 等做跨进程广播，当前为单实例原型定位。
- **本地缓存非权威**：IndexedDB 仅用于首屏加速，可能被浏览器自动清理；聊天记录以服务端漫游为准。
- 页内降级模式仅在不支持 SharedWorker 的环境生效，用于保证「业务完全可用」。
