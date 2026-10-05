# 第三方登录与账号身份

GitHub 与 Linux DO 使用授权码登录。网站只存平台、平台用户 ID、昵称和绑定时间，不存第三方 access token。平台的用户 ID 决定身份归属；同名或相同邮箱不会自动合并账号。

## 配置回调地址

在管理控制台的“第三方登录”填写 Client ID、Client Secret 并开启对应入口。复制后台显示的完整回调地址到第三方平台的应用设置。生产环境 `PUBLIC_ORIGIN` 必须是用户实际访问的 HTTPS 站点。

| 平台 | 本仓库部署示例 |
| --- | --- |
| GitHub | `https://ai.91i.asia/api/auth/github/callback` |
| Linux DO | `https://ai.91i.asia/api/auth/linuxdo/callback` |

不要将 `https://ai.91i.asia/` 填作回调地址。Linux DO 的应用申请要求配置返回地址，授权完成后应用交换授权码并获取身份，参见 [Linux DO Connect 文档](https://wiki.linux.do/Community/LinuxDoConnect)。GitHub 的 `redirect_uri`、state 与 PKCE 参数见 [GitHub 官方文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

通过其他域名或本地 `localhost` / `127.0.0.1` 别名打开入口时，网站先重定向到 `PUBLIC_ORIGIN` 再设置 OAuth 状态 Cookie，使第三方回调与该 Cookie 的来源一致。绑定也在公开地址上完成；在不同地址登录的会话不能跨主机共用。

## 返回后的状态与名字

正常回调完成身份接受后才创建本站会话，设置 `HttpOnly`、`SameSite=Lax`、路径 `/` 的 Cookie；HTTPS 部署同时设置 `Secure`。浏览器返回后执行一次账号状态校验，缓存页面恢复时也单次校验，空闲时没有轮询。

新第三方用户默认使用平台昵称。已有绑定用户再次使用该平台登录时，也同步最新的第三方昵称；昵称为空或只有空白时使用平台用户名。主动绑定不会立即改当前站内名称。账号、树、金币、密钥仍属于原本站用户。

管理员的用户列表和用户详情都会显示平台、昵称和第三方用户 ID；接口同时返回绑定时间。普通用户只能查看自己的绑定信息；管理接口要求有效管理员会话。列表只批量查询当前页身份，不逐个请求用户详情。

## 授权成功但仍显示未登录

先观察返回页的路径，避免复制 URL 中的 `code` 或 `state` 给别人：

1. 如果返回到主页且地址中带 `code` / `state`，前端将导航到同源 `/api/auth/oauth-landing`。这个路径才能收到原本限制在 `/api/auth` 下的 OAuth Cookie，服务端验证 Cookie 与未过期状态后恢复对应平台的正常回调。此路径不能代替平台正确配置；平台拒绝 `redirect_uri` 时仍应修正第三方应用设置。
2. 回调失败时，浏览器显示固定的中文说明，例如检查回调地址、重新登录或联系管理员。错误说明不回传授权码、状态值、原始第三方响应或 Secret。接口测试客户端仍收到对应 400、401、403 或 503 状态。
3. 核验 `PUBLIC_ORIGIN`、后台显示的回调地址、第三方应用实际配置三者一致；确认 `COOKIE_SECURE` 没有在 HTTP 预览中错误设为 `true`，也没有在 HTTPS 生产中关闭。
4. 已过期、重复使用或 Cookie 不匹配的授权状态都必须重新授权。切换平台配置会让尚未完成的旧授权失效；已停用的本站用户不能通过第三方重新登录。

如果在应用内浏览器开始授权，却在 Chrome 等另一浏览器完成回调，两边的 Cookie 不共享。网页会提示“本站未收到登录验证 Cookie”；请在准备使用的同一浏览器打开本站，重新点击第三方登录，并在该浏览器完成授权。Cookie 被浏览器阻止或授权超过十分钟也可能导致 Cookie 缺失，不能仅根据这一提示断定发生过浏览器切换。

服务端对每次回调输出一条受控诊断事件：失败为 `oauth.callback.failed`，成功为 `oauth.callback.completed`。仅含 `provider`、`stage`、`code` 三个字段；不记录 URL、IP、Cookie、state、授权码、昵称、Client ID、Secret 或第三方原始错误。阶段区分配置读取、返回参数、缺失/不匹配的 Cookie、过期/已使用的状态、令牌交换、身份接受及会话创建。管理员可以通过受保护的容器日志确定失败阶段，无需索取用户完整回调网址。

不要把“主页仍是游客”单独当作 Cookie、数据库或第三方凭证故障的证明。只有成功的服务器回调、已保存的身份和随后通过会话 Cookie 取得的 `/api/me` 三者，才能证明登录已完成。

### 令牌交换阶段超时

若回调日志停在 `token_exchange`，先在 API 容器检查到 `https://connect.linux.do/oauth2/token` 的出站连接。无凭据的表单 POST 正常会返回 JSON `401 invalid_client`；它只验证连通性，不能证明实际 Client ID 与 Secret 正确。连接超时且系统 DNS 结果与可信 HTTPS DNS 结果不同，则应修复服务器的 DNS。

本部署曾因默认 DNS 返回错误的 Linux DO 地址导致令牌交换超时。备份 `/etc/resolv.conf` 后改用可连通的 `1.1.1.1`／`1.0.0.1`，再重启 API 容器使 Docker 重新读取解析配置，容器内连接恢复。其他主机先检查自身网络与 DNS 管理方式；DNS 配置需在重启后仍有效。修复后重新发起授权，已经消费的旧授权码不能再次使用。

## 自动验证与实际平台验证

`tests/oauth-session.test.ts` 使用隔离数据库、模拟平台 HTTP 端点和浏览器 Cookie Jar，覆盖 HTTPS/Lax 跨站返回、第一次账号请求、当前昵称、已有身份登录、主页返回兼容、重放拒绝、后台身份权限与敏感字段排除。`tests/oauth-settings.test.ts` 覆盖动态配置、Secret 加密、配置变更与绑定；`tests/integration.test.ts` 保留 GitHub/Linux DO 协议仿真。

自动验证不会使用生产 Client Secret 或真实用户授权。真实 Linux DO/GitHub 平台的授权许可、注册回调地址和真实用户返回路径仍需实际登录验证。
