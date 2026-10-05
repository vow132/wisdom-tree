# 默认数据库与模型回复

从 GitHub 下载源码后，新数据库通过 `backend/migrations/` 自动创建表结构、系统规则和公开模型数据。默认数据库指这套迁移与种子数据，不是连接项目运营者的数据库，也不包含生产用户、管理员密码、API 密钥、OAuth 凭证、调用记录或账本。每个部署保存自己的账户与养成数据。

## 全新部署的初始内容

| 模型 ID | 显示名称 | 金币／次 | 默认回复 |
|---|---|---:|---|
| `gpt-5.6-luna` | `gpt-5.6-luna` | 1 | 鸡蛋 ASCII 图案与指定仓库文案 |
| `gpt-5.6-sol` | `gpt-5.6-sol` | 2 | 鸡蛋 ASCII 图案与指定仓库文案 |
| `claude-fable-5.1` | `claude-fable-5.1` | 5 | 鸡蛋 ASCII 图案与指定仓库文案 |
| `wisdom-tree` | 智慧树 | 1 | 80 条智慧树语料，按编号循环 |

三个非智慧树模型各有一条编号回复，其内容与后备默认文本相同。鸡蛋图案来自参考项目 [fake-ai-api 的原始 ASCII 文件](https://github.com/XTxiaoting14332/fake-ai-api/blob/main/ascii.txt)，共 24 行，每行 46 个字符。公开固定回复保存在 [default-model-reply.txt](../backend/data/default-model-reply.txt)，以 Markdown `text` 代码围栏保留空格和换行，后面附上指定的仓库链接及文案。

三个模型的公开 ID、显示名称、价格和流式配置保存在 [default-models.json](../backend/data/default-models.json)，与站点当前默认配置一致：均启用，每块 8 个字符、间隔 20 毫秒，初始没有输入匹配规则。

该固定回复中的“本仓库静态托管在 Vercel 上，不会上传您的任何数据”是站点所有者指定的模拟回复文字。智慧树应用实际采用 Docker、Fastify 与 PostgreSQL 部署，并在当前部署的数据库保存账户、养成、密钥密文和调用记录；模拟回复文字不是数据库或部署方式的说明。

初始系统规则为每日 5 袋肥料、库存上限 10 袋、每次施肥奖励 10 金币并长高 1 英尺、每分钟最多 60 次已接受的 API 请求。全新数据库没有预设登录账户；管理员应通过自己的环境变量运行 `npm run admin:create`，或使用部署流程的首次管理员初始化。

## 创建与修改模型

管理员新增模型时，表单默认填入同一份鸡蛋回复。通过 `/api/admin/models` 创建模型且省略 `replyText` 时，服务端也会采用这份内容，并创建第一条编号回复；显式提交自定义 `replyText` 会保留自定义内容。管理员仍可编辑后备文本、编号回复和输入匹配规则。

实际返回内容按既有顺序选择：先匹配输入规则，再轮换编号回复库，编号回复库为空时使用后备文本。智慧树继续使用自己的语料库，与其他模型的鸡蛋回复分别管理。

## 升级已有数据库

[007_default_model_reply.sql](../backend/migrations/007_default_model_reply.sql) 只替换非智慧树模型中仍保留旧占位句“智慧树说：每天照料一点，耐心就会发芽。”的默认文本和编号条目。管理员编辑过的其他文字会保留，智慧树的 80 条语料不受影响；重复运行迁移不会重复添加条目。

[008_default_models.sql](../backend/migrations/008_default_models.sql) 在用户表为空时同步上述公开模型 ID 和显示名称等初始配置。已有账户的数据库不会被这次元数据迁移覆盖；管理员修改过的 ID、显示名称、价格、启停或流式参数继续保留。旧部署若仍使用 `claude-sonnet-4-6`，该 ID 会继续有效，应以本部署 `/v1/models` 的结果为准。

已经接受的请求保存独立回复快照。升级或修改模型后，使用原 `Idempotency-Key` 和原请求体重放，仍得到原来的回复且不重复扣费；新请求使用当前配置。

## Agent 请求示例

要收到完整图案和文案，请将输出额度设为至少 1024：Chat Completions、Completions 与 Anthropic Messages 使用 `max_tokens`，Responses 使用 `max_output_tokens`。输出额度较低时，服务会正常截断回复，并按对应协议返回截断标记。

```python
from openai import OpenAI

client = OpenAI(api_key="sk_你的密钥", base_url="https://你的域名/v1")
reply = client.chat.completions.create(
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=1024,
)
print(reply.choices[0].message.content)
```

普通响应与流式响应使用同一份固定内容；流式分片重新拼接后会保留所有 ASCII 空格、换行和文案。模型仍按每次调用扣固定金币。
