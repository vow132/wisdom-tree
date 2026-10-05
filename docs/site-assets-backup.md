# 网站图片备份与恢复

管理员上传的 logo、浏览器图标和花园背景存储在 API 的 `/var/lib/wisdom-tree/uploads`。Docker 使用 `site_uploads` 命名卷；生产固定项目名 `wisdom-tree` 对应卷名 `wisdom-tree_site_uploads`。开发直接运行 Node 时使用 `.local/site-assets`。图片不会进入 Git、源码 ZIP、镜像或发布包。

图片经过完整解码、缩放和重新编码，保存文件名为随机的 32 位小写十六进制加 `.png` 或 `.webp`。替换图片只更新数据库设置，历史文件和元数据保留。这样数据库历史快照与浏览器缓存中的地址仍然有效。每张图片最多 2 MiB，备份中图片总量最多 1 GiB。

## 创建配套备份

在包含持久 `.env` 的应用根目录运行最新版本脚本：

```sh
bash /path/to/latest/scripts/backup.sh /opt/wisdom-tree/backups
```

脚本与部署共用独占锁。停止 API 后，完整验证数据库 dump，归档图片卷并验证完整 gzip、tar 与图片数据，再保存配置。原来运行的 API 会在备份完成或失败后启动；原本停止的 API 保持停止。同一个备份 ID 包含三项：

```text
wisdom-<UTC timestamp>-<pid>.dump
wisdom-<UTC timestamp>-<pid>.env
wisdom-<UTC timestamp>-<pid>.uploads.tar.gz
```

备份目录权限 `700`，三个文件均为 `600`。必须一起复制到受保护的异机存储；`.env` 包含数据库密码、API 密钥和第三方 Secret 的加密主密钥，不应放进公开仓库。部署产生的备份也采用同样的 `.dump`、`.env`、`.uploads.tar.gz` 配对规则。

独立图片工具的调用契约如下；调用者负责先停止 API，保证它与数据库快照一致：

```sh
bash scripts/backup-site-assets.sh \
  'ghcr.io/owner/repository/api@sha256:<64 hex digest>' \
  wisdom-tree_site_uploads \
  /opt/wisdom-tree/backups/<backup-id>.uploads.tar.gz
```

工具镜像必须包含 `dist/site-media-archive.js`，可以使用不可变 GHCR digest、40 位提交标签或本地 `sha256:` 镜像 ID。输出路径必须不存在；工具不会覆盖旧备份。图片卷不存在时创建有效的空归档，不创建上传卷。读取图片时使用只读挂载、非 root 用户、无网络；验证容器内存限制 512 MiB，CPU 限制 1 核。

## 恢复

先备份当前现场。在应用根目录确认现有 `.env` 与备份对应的加密密钥、数据库密码一致；脚本检查二者，但不盲目覆盖凭证，因为现有 PostgreSQL 用户仍使用原密码。恢复 OAuth 或更新 Token 等配置时也需要配套加密主密钥。

```sh
bash /path/to/latest/scripts/restore.sh \
  /opt/wisdom-tree/backups/<backup-id>.dump --replace-database
```

恢复先只读验证整个数据库和图片归档，然后停止 API。图片在磁盘上完整暂存、验证；只添加缺失文件，同名不同内容会拒绝。它不删除或覆盖现场历史图片。随后数据库通过 `pg_restore --clean --if-exists --no-owner --single-transaction` 恢复。恢复完成后检查全部 `site_assets` 元数据所引用文件及字节数，检查通过才允许重新启动原本运行的 API。

归档拒绝绝对路径、`..`、子目录、软链接、硬链接、设备、PAX 路径覆盖、重复文件名、类型不匹配或无法完整解码的图片、损坏 gzip/tar，以及超限内容。临时暂存使用磁盘卷，不使用 1 GiB 内存盘，适用于 2 GiB 内存服务器。

## 旧备份与旧应用版本

只有 `.dump` 的旧备份仍可恢复，脚本保留现有图片卷并检查恢复后引用。没有 `site_assets` 表的旧数据库没有图片引用；存在图片引用但缺少对应文件时，API 保持停止，管理员需恢复匹配图片再检查，不能把缺图当作恢复成功。

旧 API 镜像没有归档验证 CLI 时，应显式指定已拉取、包含此 CLI 的最新不可变 API 镜像；独立工具不要求旧 Compose 已经声明图片卷：

```sh
SITE_ASSETS_TOOL_IMAGE='ghcr.io/owner/repository/api@sha256:<64 hex digest>' \
  bash /path/to/latest/scripts/restore.sh backups/<backup-id>.dump --replace-database
```

同一变量也适用于 `backup.sh`。数据库恢复不自动运行迁移或切换应用镜像，应选择与恢复后的 schema 兼容的应用版本，再按正常部署流程升级。代码回滚保留数据库和整个上传卷，不恢复历史图片快照。不要执行生产环境的 `docker compose down -v`、删除上传卷或无条件清理历史图片。
