# 智慧树

原版《植物大战僵尸》智慧树网页养成、站内金币、兼容 OpenAI / Anthropic 的假 AI API，以及用户与模型管理后台。

用户在网页养树获得金币；API 每次请求按所选模型的价格扣金币。模型先匹配管理员设置的“客户输入 → 指定回复”，未匹配时按编号回复库循环返回文本或 ASCII，提供 JSON 和流式协议，不连接真实模型。

## 本机运行

需要 Node.js 22 以上版本，推荐 Node.js 24。项目已包含原版场景图像和转换后的动画，无需先下载素材。

本次交付已放入 `D:\智慧树` 并安装依赖，双击 `启动预览.cmd` 即可运行。下面的 `npm ci` 适用于重新安装或使用源码压缩包的情况。

```powershell
cd D:\智慧树
npm ci
npm run dev:preview
```

打开 <http://127.0.0.1:5173>。本机预览使用 PGlite 的 PostgreSQL 内核，数据保存在项目的 `.local/preview-db`；生产使用独立 PostgreSQL 服务。首次进入可注册账号、领取种子、种植并领取每日肥料。

本机管理员初始化需要先停止正在运行的预览，然后在 PowerShell 中运行：

```powershell
$env:DATABASE_MODE = "embedded"
$env:PGLITE_PATH = Join-Path (Get-Location) ".local\preview-db"
$env:ADMIN_USERNAME = "admin"
$adminSecret = Read-Host "设置管理员密码（至少8位）" -AsSecureString
$adminSecretHandle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecret)
try {
  $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminSecretHandle)
  npm run admin:create
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminSecretHandle)
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $adminSecret.Dispose()
}
npm run dev:preview
```

管理员登录后打开 `/admin`。初始化命令不会把已经存在的普通账号自动升级为管理员。

## 服务器部署

Linux 服务器需要 Docker Engine 和 Compose 插件。将域名解析到服务器并开放 80/443 端口。

```bash
cp .env.example .env
# 编辑 .env 后启动：
docker compose up -d --build
docker compose exec -T api node dist/admin-cli.js
```

必须配置 `SITE_ADDRESS`、`PUBLIC_ORIGIN`、`POSTGRES_PASSWORD`、`ADMIN_PASSWORD` 和 `API_KEY_ENCRYPTION_KEY`。Caddy 自动申请 HTTPS 证书，无须提供邮箱。加密主密钥需要 64 位随机十六进制字符串，可用 `openssl rand -hex 32` 生成并填入 `.env`；升级旧版本时也要新增此项。数据库密码请使用字母、数字、短横线或下划线组成的长随机字符串；连接 URL 中的其他字符需进行 URL 编码。`PUBLIC_ORIGIN` 例如 `https://tree.example.com`，与浏览器访问域名一致。

GitHub 自动发布使用 [CI/CD 部署说明](docs/deployment.md) 中的 `compose.deploy.yml`，服务器运行已构建的镜像，避免在 2GB 机器上编译。默认分支 `codex/wisdom-tree` 的每次推送先执行 [CI](docs/ci.md)，通过后发布私有 GHCR 镜像、启动一次性完整 Docker 栈验证 Caddy 与普通/流式接口，再通过固定主机公钥的 SSH 连接部署。生产目录固定为 `/opt/wisdom-tree`，目标站点为 `https://ai.91i.asia`。源码不包含服务器密码、SSH 私钥或生产 `.env`。

启动时会执行数据库迁移。数据库、HTTPS 证书使用持久卷；PostgreSQL 与后端端口不暴露到公网。初次初始化管理员后，可从 `.env` 清除 `ADMIN_PASSWORD` 并重建 API 服务。

```bash
docker compose ps
docker compose logs --tail=100 api
sh scripts/backup.sh
# 恢复会替换现有数据库；先保存当前备份：
sh scripts/restore.sh backups/wisdom-时间.dump --replace-database
```

备份恢复必须同时保留同一份 `API_KEY_ENCRYPTION_KEY`，它用于恢复 API 密钥和后台保存的 OAuth Client Secret。数据库备份不包含 `.env`，请单独安全保管该文件；不能在恢复时重新生成主密钥。本机预览的主密钥自动保存于 `.local/api-key-encryption.key`，备份本机数据时同时保留该文件和 `.local/preview-db`。

## 三种登录

账号密码无需外部服务。GitHub 和 Linux Do 需在各平台申请 OAuth 应用，然后打开“管理控制台 → 第三方登录”，填写各自的 Client ID 与 Client Secret，勾选开启并保存。后台提供完整回调地址及复制按钮，须填入平台的应用配置：

| 提供方 | 回调地址 |
|---|---|
| GitHub | `https://你的域名/api/auth/github/callback` |
| Linux Do | `https://你的域名/api/auth/linuxdo/callback` |

未开启或凭证未配置完整的方式不会显示在登录页面，也不提供新绑定入口。配置保存后立即生效，不用重启。关闭方式不会删除已有身份绑定或退出现有会话，之后的新 OAuth 登录与绑定会被服务端阻止。

Client Secret 加密保存在数据库中，后台只显示是否已配置；留空保存会保留旧密钥，需要更换时填写新值。后台明确保存的配置优先于 `.env`；旧部署中已有的 `GITHUB_CLIENT_ID`／`GITHUB_CLIENT_SECRET` 和 `LINUXDO_CLIENT_ID`／`LINUXDO_CLIENT_SECRET` 在首次后台保存前继续有效。没有凭证的新部署默认关闭。

已有账户在“账户”页面主动绑定第三方身份，绑定后共享同一棵树、余额和密钥。系统不按用户名或邮箱自动合并账户。平台申请与授权参数见 [GitHub 官方文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) 和 [Linux Do Connect 文档](https://wiki.linux.do/Community/LinuxDoConnect)。

成功使用第三方登录时，站内显示名称默认同步本次授权返回的第三方昵称；昵称为空时使用该平台用户名。只做绑定时保留当前站内显示名称，之后使用该身份登录再同步。管理员的用户列表和详情都会显示已绑定的平台、昵称和第三方用户 ID；接口同时返回绑定时间，不显示第三方令牌或 Secret。

第三方应用的回调地址必须使用上表完整路径，不能只填写网站首页。授权流程会先切换到 `PUBLIC_ORIGIN`，避免 `localhost` / `127.0.0.1` 或别名域之间丢失状态 Cookie；首页意外收到 `code` / `state` 时会交由服务器验证并恢复原授权流程，无法兑换时明确提示检查回调地址。登录故障的排查与验证范围见 [第三方登录说明](docs/oauth-login.md)。

## 养成与管理

初始规则：每日 5 袋肥料，最多存 10 袋，每次施肥长高 1 英尺并获得 10 金币。北京时间零点刷新每日额度，不补发往日额度；库存不足以容纳全部额度时，可分次领取。

按住场景左上角的肥料，拖到智慧树上松开，或点击照料区的“施肥”，即可消耗一袋肥料。鼠标和触摸拖放共用同一套交互；落在背景或草地上会放回肥料。直接点击树只会免费换一句话，也可使用“听下一句”按钮。

施肥成功后直接使用响应更新树高、肥料和金币，无需刷新页面。画布先播放原版倒肥动作（31 帧、20 FPS，约 1.55 秒），然后以 8 FPS 播放成长；动画期间锁定下一次施肥。前端不轮询、不在窗口切换或断线恢复时自动请求数据；首次进入、页面操作、OAuth 回调、浏览器恢复缓存页面或手动重试会单次请求状态。原版成熟树素材有画面大小上限，达到该阶段后仍会继续增加英尺数并显示成长奖励。

智慧树对白使用带“花园智慧树”标记的模型回复库，初始模型 ID 为 `wisdom-tree`，改名后仍可用于花园。播种、施肥、点击说话及未命中输入规则的 API 调用共享当前用户的轮换位置。新数据库预置 80 条中文玩法事实摘要与原创闲聊，覆盖原始资源的全部 80 个数字对白键；它们不是原版逐字台词或官方中文翻译。默认可以轮换全部条目，不按原版树高限制对白；详细索引与来源见 [语料核验](docs/wisdom-corpus.md)。后台列表与编辑窗口显示已导入回复数，并提供“管理回复”入口；默认返回文本只在编号回复库为空时使用。

右上角主题入口采用太阳／月亮图标，点击后可选择浅色、深色或随系统。选择保存在浏览器中；随系统模式监听系统配色变化，不发送后台请求。原版花园图像和对白气泡保持自身颜色。

标题旁的 GitHub 图标打开本仓库；绿点表示当前运行版本与仓库一致，黄点表示有更新，灰点表示无法确认。页面打开时单次检查，服务端合并请求并缓存成功结果 5 分钟、失败结果 1 分钟，不轮询。管理员在“系统规则 → 网站更新”配置只授权部署仓库的 Token 后，点击黄点可触发已有 CI/CD；普通访客不能执行更新。配置、权限与独立部署说明见 [网站更新](docs/website-updates.md)。

管理员可管理用户、模型、价格、流式速度、每日肥料、库存、成长、金币奖励和每分钟接口限流。在“模型管理 → 管理回复”中，可以按编号新增、查询、编辑或删除每个模型的返回文本；同一模型内编号不能重复，每个模型最多 500 条。模型默认文本作为空回复库的后备内容。回复按编号从小到大循环，每个用户、每个模型有独立位置；已经接受的请求保留原回复快照，后续编辑不改变重放内容。

在“模型管理 → 输入匹配”中新增规则，例如客户输入“你好”、指定回复“你好”。最近一条用户文本去掉首尾空格后完全一致时，优先返回该规则，不推进编号回复位置；同一输入有多个启用规则时，编号较小的优先。未匹配时继续编号回复，编号库为空时才用默认文本。每个模型最多 500 条输入规则，站内智慧树说话继续使用编号回复库。

已创建或已使用的模型 ID 都可编辑；相关回复、规则及历史关联会同步更新，已接受请求的回复快照保持不变。修改后需更新 Agent／SDK 中的模型 ID；同一个幂等 Key 重试时仍应保持原请求体。

模型和用户删除均为软删除，保留历史账本。后台无需填写操作原因，所有管理修改仍记录管理员与修改前后值，默认原因为“管理员操作”。最后一位有效管理员不能被封禁、删除或降级。停用智慧树模型后，免费说话与新 API 调用会被拒绝，施肥与养成仍可继续。

## API 与 agent 接入

登录后在“API”页面创建 `sk_` 密钥，可在自己的密钥列表随时查看明文并一键复制。数据库使用 SHA-256 摘要鉴权、AES-256-GCM 密文恢复显示，管理员只能查看标识。旧版本 `wt_` 密钥继续有效，但因原先只存摘要无法恢复明文，需要新建密钥才能使用明文复制。OpenAI Base URL 为 `https://你的域名/v1`，Anthropic Base URL 为 `https://你的域名`。

预置模型和初始按次价格：

| 模型 | 金币/次 |
|---|---:|
| `gpt-5.6-luna` | 1 |
| `gpt-5.6-sol` | 2 |
| `claude-fable-5.1` | 5 |
| `wisdom-tree`（智慧树） | 1 |

三个非智慧树模型默认返回鸡蛋 ASCII 图案及指定仓库文案；下载后新建数据库会自动导入同一套公开配置，详见 [默认数据库与模型回复](docs/default-database.md)。模型名称仅为模拟服务的标识，不代表实际模型能力。更多配置见 [agent 接入说明](docs/agent-integration.md)。

请求通过校验并被后端事务接受后扣费；接受前失败不收费，接受后连接中断仍计一次。查询模型、估算 token、健康检查免费。返回的 token 用量是估算值，金币只按请求次数计费。

需要重试时发送同一个 `Idempotency-Key`，并保持相同请求体。系统会重放保存的回复，不再次扣费或推进回复位置；同一 Key 对应不同请求体返回 409。未带稳定 Key 的重复请求均按新调用计算。

## 工程与验证

面向普通 2 核 2GB 服务器，游戏绘制与动画在浏览器执行，服务端保存数据并返回固定回复。PostgreSQL 连接池默认 5 个连接（`DB_POOL_MAX` 可调），生产 API 的 Node.js 堆上限为 256MB。Canvas 静止图层缓存，成长动画最高 24fps、闲置云层 2fps，隐藏标签页暂停绘制。实际并发容量取决于用户量与调用频率，目标服务器压力测试仍需部署后执行。

```bash
npm run typecheck
npm run build
npm test
```

`frontend/` 为 React / Canvas 2D 网页，`backend/` 为 Fastify 服务，`backend/migrations/` 为 PostgreSQL 迁移。集成测试使用独立 PGlite 数据库，覆盖登录、OAuth 模拟流程、养成、并发计费、断流、幂等、管理员权限，以及官方 SDK 的 JSON / SSE 解析。

原版素材来源与转换过程见 [素材说明](docs/assets.md)。部署、真实 OAuth 授权和公网 HTTPS 仍需在配置好实际服务器与第三方应用后验证。
完整测试范围及未验证项见 [验收记录](docs/qa-acceptance.md)，原版画面对照见 [设计核验](design-qa.md)。

## 🔗 友情链接

[LINUX DO](https://linux.do/) —— 真诚分享、友好讨论的技术社区，本项目的交流与反馈也发布于此
