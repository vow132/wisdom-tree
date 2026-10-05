# GitHub CI/CD 与服务器部署

目标地址为 `https://ai.91i.asia`，服务器应用目录为 `/opt/wisdom-tree`。CI 在干净的 PostgreSQL 上运行测试、编译前后端并验证 Docker 镜像；CD 发布已经通过验证的 GHCR 镜像。部署使用固定项目名 `wisdom-tree`，数据库、Caddy 证书和用户上传的服务器配置会跨版本保留。

## 首次准备服务器

GitHub 仓库默认分支为 `codex/wisdom-tree`。推送触发 `CI and deploy`，手动运行可取消 deploy 选项只执行验证和镜像发布；PR 运行独立 CI。自动部署只有 `DEPLOY_ENABLED=true` 才执行；首次应在确认 SSH 主机公钥、密钥登录和服务器配置后开启。

仓库 Variables：`DEPLOY_HOST`、`DEPLOY_PORT`（默认 22）、`DEPLOY_USER`、`DEPLOY_ROOT`（默认 `/opt/wisdom-tree`）、`PUBLIC_ORIGIN`、`DEPLOY_ENABLED`。Secrets：`DEPLOY_SSH_PRIVATE_KEY`、`DEPLOY_KNOWN_HOSTS`。`Server preflight` 手动只读检查额外使用 `DEPLOY_BOOTSTRAP_PASSWORD`；完成部署密钥安装后可以移除此临时密码。初始生产配置的受保护副本可存为 `DEPLOY_ENV_FILE`，部署读取服务器持久 `.env`，不会在升级时覆盖它。

工作流的私有镜像拉取使用当前 job 的短期 `GITHUB_TOKEN`，经 SSH 标准输入传输，临时 `DOCKER_CONFIG` 在部署结束后删除，不在服务器保存长期 PAT。镜像按 digest 固定；完整 Docker 栈的普通回复、SSE 结束帧、密钥与幂等计费通过后才允许生产部署。

确认域名 A 记录指向服务器，错误的 AAAA 记录应修正；开放 TCP 80、443 和 SSH 的实际端口，UDP 443 用于 HTTP/3。服务器已有占用 80/443 的服务时先确认部署方式，脚本不会停止这些服务。

在 Ubuntu/Debian 上以 root 运行：

```sh
bash scripts/bootstrap-host.sh ai.91i.asia
```

脚本保留可用的 Docker/Compose，不替换已有容器引擎；新主机按 [Docker Ubuntu 官方安装说明](https://docs.docker.com/engine/install/ubuntu/) 或 [Debian 官方安装说明](https://docs.docker.com/engine/install/debian/) 使用 apt 仓库安装。发现已有冲突包时停止安装，由管理员确认处理。它只在 `.env` 不存在时创建随机数据库密码、管理员密码与加密主密钥，权限为 `600`。重复执行不会重置密码。服务器 SSH 密码与 SSH 私钥不进入源码或镜像。

`.env` 必须位于服务器 `/opt/wisdom-tree/.env`，至少包含：

```dotenv
SITE_ADDRESS=ai.91i.asia
PUBLIC_ORIGIN=https://ai.91i.asia
POSTGRES_PASSWORD=<random hex password>
API_KEY_ENCRYPTION_KEY=<64 hex characters>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<initial random password>
DB_POOL_MAX=5
```

请通过受保护的 SSH 会话读取初始管理员密码，并在站内管理员后台修改。不要把 `.env` 打印到 Actions 日志。数据库密码使用十六进制随机值，避免连接 URL 中的特殊字符编码问题。`ACME_EMAIL` 可留空。GitHub/Linux Do 的应用凭证可登录管理员后台设置。

容器内存上限分别为 API 512 MiB、数据库 512 MiB、前端 128 MiB、Caddy 192 MiB。Node 堆上限为 256 MiB，PostgreSQL 为 30 个连接与 128 MiB shared buffers，API 默认使用 5 个数据库连接。Docker JSON 日志每个容器至多 3 个 10 MiB 文件。无轮询游戏接口；流式输出在客户端请求时才产生连接。

## 发布包与镜像

新 CD 发布的 API、前端、数据库和 Caddy 四个镜像均从 GHCR 拉取，并使用不可变的镜像 digest。数据库和 Caddy 镜像分别由 `Dockerfile.db`、`Dockerfile.caddy` 基于官方 PostgreSQL 17、Caddy 2 镜像构建并发布到 GHCR；服务器拉取这些镜像只需访问 GHCR，无需直接拉取 Docker Hub。镜像拉取仍验证 HTTPS 证书，不配置 insecure registry 或跳过 TLS 校验。发布包结构如下，`.release.env` 不含凭证：

```text
incoming/<40-character-commit-sha>/
  .release.env
  compose.deploy.yml
  Caddyfile
  scripts/deploy.sh
  scripts/rollback.sh
  scripts/deploy-from-ci.sh
```

```dotenv
RELEASE_ID=<40-character-commit-sha>
API_IMAGE=ghcr.io/<owner>/<api-image>@sha256:<64-character-image-digest>
WEB_IMAGE=ghcr.io/<owner>/<web-image>@sha256:<64-character-image-digest>
DB_IMAGE=ghcr.io/<owner>/<db-image>@sha256:<64-character-image-digest>
CADDY_IMAGE=ghcr.io/<owner>/<caddy-image>@sha256:<64-character-image-digest>
```

部署脚本兼容只有 `RELEASE_ID`、`API_IMAGE`、`WEB_IMAGE` 的旧三行发布配置；此时 `DB_IMAGE` 与 `CADDY_IMAGE` 同时省略，使用官方 Docker Hub 镜像默认值。新增这两项时必须成对提供。新 CD 始终生成以上五行配置，固定全部四个 GHCR 镜像的 digest，避免升级时重新依赖服务器到 Docker Hub 的连接。

私有 GHCR 镜像需要服务器的拉取凭证，使用具有 `read:packages` 权限的专用凭证执行 `docker login ghcr.io --username <owner> --password-stdin`，输入从标准输入传递。Actions 上传发布包与执行部署使用专用 SSH 部署密钥；SSH 主机公钥必须预先通过可信渠道确认后固定。不要通过每次无条件 `ssh-keyscan` 或 `StrictHostKeyChecking=no` 接受新主机。

## 部署过程

```sh
bash /opt/wisdom-tree/incoming/<sha>/scripts/deploy.sh \
  /opt/wisdom-tree/incoming/<sha>/.release.env
```

部署加独占锁，先校验配置并拉取 API、前端、数据库和 Caddy 四个镜像，并确认新旧数据库镜像均为 PostgreSQL 17。拉取或版本校验失败会直接结束，不停止当前 API。此部署流程仅支持 PostgreSQL 17 主版本内的镜像更换，不支持跨主版本升级或主版本降级。

已有成功发布版本时，脚本先用旧版本的 Compose 配置确认旧数据库健康，标记进入版本切换，再停止旧 API。随后备份旧数据库，完整解码验证压缩归档后原子保存，并另存一份权限 `600` 的 `.env`；两项备份成功后才启动新数据库镜像并确认健康。首次部署没有旧发布版本时，先启动数据库，再完成相同的数据库与 `.env` 备份。重复部署同一 SHA 也会先备份，保留已有数据卷。

备份完成并启动新数据库后，新 API 镜像执行 `node dist/migrate.js`。迁移成功后，仅在数据库确认没有有效管理员时执行 `node dist/admin-cli.js` 创建初始管理员，不重置已有账户。随后启动 API、前端、Caddy，检查容器健康、公开 HTTPS 的 `/health`、首页 HTML 以及 HTTP 跳转 HTTPS。

首次 Caddy 申请证书需要域名解析正确且能够接收公网验证。部署完成才原子更新服务器 `.release.env`；此前成功版本保存为 `.previous-release.env`。每份发布包保留在 `releases/<sha>/`，重复部署同一 SHA 必须与原始发布包一致。

可选流式验证设置 `DEPLOY_SMOKE_API_KEY` 与 `DEPLOY_SMOKE_MODEL`。密钥只通过环境变量传入容器，检查公开 HTTPS 经过 Caddy 的 SSE 类型、分块结构与 `[DONE]`。每个 SHA 使用固定幂等键；这会按模型价格计费一次，验证账户需要足够余额。建议使用专门的验证账户和较小的固定回复。没有提供密钥时，部署日志会明确记录跳过 SSE，不能把此结果视为完成流式验收。CI 应使用一次性数据库与测试密钥执行流式协议检查。

## 失败、回滚与恢复

版本切换出错时尝试恢复上一个成功版本的数据库镜像以及 API、前端、Caddy 镜像；数据库内容、数据卷、证书和备份均保留。数据库镜像恢复仅在 PostgreSQL 17 主版本内进行，不支持主版本降级。迁移已经提交时保留其结果，不自动回退数据库内容或 schema。新增迁移应兼容前一版本应用；不兼容的破坏性迁移需要先准备独立恢复方案。

手动恢复前一个成功应用版本：

```sh
bash /opt/wisdom-tree/releases/<current-sha>/scripts/rollback.sh
```

手动回滚同样先确认新旧数据库镜像为 PostgreSQL 17，停止当前 API 并备份当前数据库与 `.env`，完成验证后才更换数据库和应用镜像；它保留数据卷并跳过旧镜像迁移，不回退数据库内容。当前与前一版本会互换，便于再次切换。应用第一次部署失败时没有旧版本可恢复，数据库与备份会保留供排查。

数据库备份位于 `/opt/wisdom-tree/backups/<UTC timestamp>-<sha>-<pid>.dump`，对应的 `.env` 快照是同名 `.env` 文件。备份目录权限 `700`，归档及密钥快照权限 `600`。应将这两种文件一起复制到受保护的异机存储；仅数据库备份缺少加密主密钥时无法解密用户密钥和 OAuth Secret。脚本不会删除旧备份或执行全机 `docker system prune`。

需要替换数据库时，先保存现场备份，在维护窗口停止 API，再用当前发布配置执行 `pg_restore --clean --if-exists --no-owner --single-transaction`。恢复后还原与备份配套的 `.env` 密钥，确认数据库密码与既有 PostgreSQL 用户一致，再启动匹配的应用版本。不要执行 `docker compose down -v`。

```sh
cd /opt/wisdom-tree
release="releases/$(sed -n 's/^RELEASE_ID=//p' .release.env)"
compose() {
  docker compose --project-name wisdom-tree --project-directory "$PWD/$release" \
    --env-file "$PWD/.env" --env-file "$PWD/$release/.release.env" \
    -f "$PWD/$release/compose.deploy.yml" "$@"
}
compose stop api
# BACKUP_PATH must point to the reviewed protected backup to restore.
compose exec -T db pg_restore -U wisdom -d wisdom --clean --if-exists \
  --no-owner --single-transaction < "$BACKUP_PATH"
# Restore the matching key/configuration snapshot securely before starting.
compose up -d --wait api web caddy
```

SSH 认证失败、网络端口不通、域名未解析或 CI Secrets 缺失时，代码检查可以继续，实际发布仍需修复这些条件。工作流通过不等于已经访问生产服务器成功；以 CD 日志、公开健康检查和实际 HTTPS 访问结果为准。
