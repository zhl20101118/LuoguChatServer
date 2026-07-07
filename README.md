# LuoguChat Server

Cloudflare Worker 服务端，用于 LuoguChat 客户端的 AI 配额管理和用户监控。

## 功能

- **AI 使用次数管理**：每人每天默认 50 次，可自定义用户级配额
- **白名单 / 黑名单模式**：灵活控制哪些用户可以使用 AI 功能
- **无限制用户**：特定 UID（如 1049425）不受配额限制
- **Admin 管理后台**：高颜值科技风界面，支持用户管理和设置调整
- **KV 存储**：基于 Cloudflare KV，数据持久化

## 部署

### 前置要求

- Cloudflare 账号
- 已安装 Node.js (>= 16)
- 已安装 wrangler CLI

### 步骤

1. **克隆仓库**

```bash
git clone <repo-url>
cd LuoguChatServer
```

2. **安装依赖**

```bash
npm install
```

3. **登录 Cloudflare**

```bash
npx wrangler login
```

4. **创建 KV 命名空间**

```bash
npx wrangler kv:namespace create chat_kv
```

将输出的 `id` 填入 `wrangler.toml` 的 `kv_namespaces.id`。

如需预览环境：
```bash
npx wrangler kv:namespace create chat_kv --preview
```

5. **配置 wrangler.toml**

编辑 `wrangler.toml`，填入：
- `account_id`：你的 Cloudflare Account ID
- `kv_namespaces.id`：上一步创建的 KV 命名空间 ID
- `kv_namespaces.preview_id`：预览环境 KV ID（可选）

6. **部署**

```bash
npm run deploy
```

### 本地开发

```bash
npm run dev
```

## API 接口

### 客户端接口

#### `POST /api/sync`

同步状态，获取剩余次数和是否允许使用。

**请求体：**
```json
{
  "uid": "1049425",
  "device_id": "device-uuid"
}
```

**响应：**
```json
{
  "remaining": 45,
  "total": 50,
  "allowed": true,
  "in_whitelist": true,
  "in_blacklist": false,
  "whitelist_mode": false,
  "blacklist_mode": false,
  "is_unlimited": false
}
```

#### `POST /api/report`

上报使用进度（客户端每使用 10 次上报一次）。

**请求体：**
```json
{
  "uid": "1049425",
  "count": 10
}
```

**响应：**
```json
{
  "remaining": 35,
  "total": 50
}
```

### Admin 接口

需要 `Authorization: Bearer <admin_password>` 请求头。

- `POST /admin/login` - 登录验证
- `GET /admin/users` - 获取用户列表
- `GET /admin/settings` - 获取全局设置
- `POST /admin/settings` - 保存全局设置
- `GET /admin/user/:uid` - 获取指定用户用量
- `POST /admin/user/:uid` - 修改用户配额/已用次数
- `POST /admin/reset/:uid` - 重置用户今日用量

## Admin 后台

访问 Worker 的根路径 `/` 即可进入管理后台。

默认管理员密码：`zhl_super_admin`

### 功能页面

1. **用户管理**：查看所有用户今日用量、限额、状态，可单独设置和重置
2. **全局设置**：默认限额、白名单/黑名单模式及名单配置

## 配置说明

### 无限制用户

在 `worker.js` 中修改 `UNLIMITED_USERS` 数组：
```js
const UNLIMITED_USERS = [1049425];
```

### 管理员密码

在 `worker.js` 中修改：
```js
const ADMIN_PASSWORD = "zhl_super_admin";
```

## KV 存储结构

所有 key 前缀：`lc_`

| Key | 说明 |
|-----|------|
| `lc_settings` | 全局设置 |
| `lc_usage_{uid}_{YYYY-MM-DD}` | 用户每日用量 |

## 技术栈

- Cloudflare Workers
- Cloudflare KV
- Vanilla JS (前端管理界面)

## License

MIT
