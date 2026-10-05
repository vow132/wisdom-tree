# 持续集成

`.github/workflows/ci.yml` 在针对默认分支 `codex/wisdom-tree` 的 Pull Request 上运行，也支持 Actions 页面手动运行以及 `workflow_call`。默认分支的 push 由 CD 调用同一套 CI，检查通过后才能发布，避免一次推送重复测试。CI 不需要服务器凭证或仓库 Secrets，只有 `contents: read` 权限，checkout 不保留 Git 凭证。

## 检查内容

- Ubuntu 24.04、Node.js 24，通过根目录 `package-lock.json` 执行 `npm ci`，缓存 npm 下载目录。
- 两个工作区的 TypeScript 检查、完整应用测试与兼容 SDK 测试、生产构建。
- 独立 PostgreSQL 17 服务上的真实事务验收：全新迁移与重复迁移、管理员初始化与登录、并发领取和施肥、加密密钥、余额不足并发、幂等重放、三种 SDK 协议的普通与流式回复、模型 ID 级联修改、封禁及最后管理员保护。
- API 和 Web 两个生产 Dockerfile 分别构建，构建在 GitHub runner 上进行。

`scripts/ci-postgres.ts` 只接受显式的 `CI_DATABASE_URL`。它创建随机 `ci_…` schema，所有测试连接的 `search_path` 仅指向该 schema，结束后清理该 schema，不修改 public schema。请使用临时测试数据库；测试账号、余额及密钥都是一次性数据。PostgreSQL 服务中的密码是公开的 CI 临时值，不是生产密码。

## 本地运行

需要 Node.js 24。常规检查：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

真实 PostgreSQL 验收需要 PostgreSQL 17，并为测试用户授予数据库上的 schema 创建权限：

```sh
export CI_DATABASE_URL='postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/TEST_DATABASE'
node --import tsx --test scripts/ci-postgres.ts
```

Docker 构建检查：

```sh
docker build --pull -f backend/Dockerfile -t wisdom-tree-api:ci .
docker build --pull -f Dockerfile.frontend -t wisdom-tree-web:ci .
```

## 失败与维护

同一 PR 或同一分支的新 CI 会取消旧 CI；CD 的部署并发策略独立管理。每个 job 设置 20 分钟超时。失败时只上传 `.local/ci-logs/*.log`，保留 7 天；不上传 `.env`、密钥文件、数据库或完整 `.local` 目录。CI 没有接收生产 Secrets。Actions 日志也可直接查看各步骤的输出。

外部 Actions 固定到完整 release commit SHA，来源为官方仓库及 GitHub API tag 解析，核验日期 2026-10-05：

| Action | Release | SHA |
| --- | --- | --- |
| [checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0) | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| [upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.1) | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

更新 Action 时，先在其官方 release 页面核验版本及完整 commit，再更换 SHA 和表中记录。GitHub 托管 runner 满足这些 Action 的 Node 24 runtime 要求；自托管 runner 应根据各官方 README 更新 runner 版本。
