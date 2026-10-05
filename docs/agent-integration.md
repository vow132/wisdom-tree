# Agent 与 SDK 接入

本服务按模型每次请求扣固定金币。先检查该模型的指定回复规则，未命中时从独立的编号回复库按顺序循环返回一条；回复库为空时使用默认文本。工具定义与历史消息可传入，模拟回复不会执行工具或进行真实推理。网页“API”页创建的密钥以 `sk_` 开头，可在自己的列表随时查看明文并复制；管理员只有密钥标识。

预置 `gpt-5.6-luna`（1 金币/次）、`gpt-5.6-sol`（2 金币/次）、`claude-fable-5.1`（5 金币/次）与 `wisdom-tree`（显示名称“智慧树”，1 金币/次），价格与 ID 均可由管理员调整。模型 ID 只是模拟标识。SDK 和 agent 配置中的 `model` 必须使用当前公开 ID；可先调用 `/v1/models` 查看可用 ID。如果管理员已经改名，请同步修改下面示例中的 `model`。旧 ID 不会自动成为别名。

全新部署的三个非智慧树模型显示名称与 ID 相同，默认返回鸡蛋 ASCII 图案及仓库文案，详细种子配置见 [默认数据库](default-database.md)。要保留完整图案和文案，请为 Chat Completions、Completions 和 Messages 设置 `max_tokens: 1024` 或更高，为 Responses 设置 `max_output_tokens: 1024` 或更高；较小额度会按协议正常截断。

## 指定输入与回复

管理员在“模型管理 → 输入匹配”中点击“添加规则”，填入客户输入 `你好`、指定回复 `你好`。也可从“管理回复”页的“管理输入匹配规则”链接进入。启用后，该模型接收到 `你好` 就返回 `你好`，使用同一套 JSON 或流式协议和原来的按次金币价格。各模型分别配置自己的规则。

匹配只去掉输入两端的空白，保留大小写和中间空格；例如 ` 你好 ` 会命中 `你好`，`Hello` 不会命中 `hello`。这是一条完整输入的精确匹配规则。多个启用规则使用相同输入时，编号最小的一条优先。关闭规则后，新请求继续使用其他匹配规则或编号回复。命中指定回复不会推进编号库的轮换位置，重放已受理请求也不会推进。

| 接口 | 用于匹配的输入 |
| --- | --- |
| Chat Completions / Anthropic Messages | 最后一条 `role: 'user'` 消息的字符串内容；多块 `type: 'text'` 按原顺序无分隔符连接 |
| Responses | 字符串 `input`；数组输入取最后一条用户消息的字符串或 `type: 'input_text'` 文本块 |
| Completions | 字符串 `prompt`；字符串批次只取第一条。Token 数组不参与匹配 |

系统、助手、工具和图片内容不作为匹配输入。最后一条用户消息不匹配时，不会回退寻找之前的用户消息。

规则编号为 1–1,000,000 的整数，同一模型内不能重复；每个模型最多 500 条规则，关闭的规则也计入。输入须包含非空白文字，原始字符串长度最多 2,000 个 JavaScript 字符，保存时去掉两端空白。输出最多 20,000 个 JavaScript 字符，必须含非空白内容。默认文本、编号回复和指定回复都受流式时限约束：`ceil(Array.from(文本).length / 分片字符数) × 分片间隔毫秒 ≤ 120000`。分片字符数可设为 1–1,000，间隔可设为 0–1,000 毫秒；调参也会校验已有内容。

管理员接口为 `GET/POST /api/admin/models/:id/rules` 和 `PATCH/DELETE /api/admin/models/:id/rules/:ruleId`。创建请求示例：

```json
{"position":1,"input":"你好","text":"你好","enabled":true}
```

`enabled` 可省略，默认为 `true`；编辑允许部分字段。GET 返回 `{items,total}`，创建与编辑返回 `{item}`，删除返回 `{ok:true}`；条目含 `{id,position,input,text,enabled}`。操作原因可省略，后台仍用“管理员操作”记录操作者和修改前后值。详细权限、限制和错误码见 [API 契约](api-contract.md)。

## Codex

在自己的 Codex 配置中添加一个独立 provider；保留其他现有 provider：

```toml
model = "gpt-5.6-sol"
model_provider = "wisdom-tree"

[model_providers.wisdom-tree]
name = "Wisdom Tree"
base_url = "https://你的域名/v1"
env_key = "WISDOM_TREE_API_KEY"
wire_api = "responses"
supports_websockets = false
```

在启动 Codex 的终端设置 `WISDOM_TREE_API_KEY` 为网页创建的密钥。模拟服务不需真实 OpenAI Key。[官方自定义 provider 配置](https://developers.openai.com/codex/config-advanced/)。

## Claude Code

在独立终端中设置以下环境变量，然后启动 Claude Code：

```bash
export ANTHROPIC_BASE_URL="https://你的域名"
export ANTHROPIC_API_KEY="网页创建的密钥"
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_MODEL="claude-fable-5.1"
claude
```

PowerShell 使用 `$env:变量名 = "值"`。密钥只保存在自己的环境变量中，不提交到源码。

## OpenAI SDK

```js
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

const client = new OpenAI({
  apiKey: process.env.WISDOM_TREE_API_KEY,
  baseURL: 'https://你的域名/v1',
});
const idempotencyKey = randomUUID();
const response = await client.responses.create({
  model: 'wisdom-tree',
  input: '你好',
}, { headers: { 'Idempotency-Key': idempotencyKey } });
console.log(response.output_text);
```

上例配置了 `你好` 的指定回复时优先返回该规则文本；未配置或关闭规则时使用编号回复，再在空库时使用默认文本。指定回复仍需有效密钥、启用的模型与足够余额，并受接口限流约束。

针对同一次逻辑操作重试时复用 `idempotencyKey`，并保持相同请求体；新操作生成新的 Key。重放会使用当时保存的文本、价格与模型 ID，不重复扣费，也不推进回复顺序。之后修改、删除规则或调整编号回复，都不会改变这一快照。

管理员可用 `PATCH /api/admin/models/:id` 的 `{ "id": "新的公开ID" }` 修改任何已创建模型，包括已有调用的模型和智慧树。新 ID 必须唯一（已软删除模型也占用原 ID），长度 1–128，首字符为英文字母或数字，其余只允许英文字母、数字、点、冒号、下划线和短横线。历史调用关联、编号库、规则和每个用户的轮换位置会一起跟随新 ID，调用记录显示新的关联 ID。已保存的回复快照保持原样：用同一个幂等 Key 和完全相同的旧请求体可继续重放原响应；把重放请求里的 `model` 改成新 ID 会导致 409 冲突。新操作应使用新 ID 和新 Key。

智慧树模型的 API 编号回复与花园中树说的话来自同一份后台回复库。每个账号、每个模型有独立轮换位置；这个账号播种、施肥、点击树说话，以及未命中指定回复的智慧树 API 调用，都会取下一条。网页点击说话没有客户输入，直接使用编号库，不触发指定回复规则。网页点击说话免费，API 仍按模型价格收费。API 调用不要求先种树，只要求有效密钥和足够余额；网页说话要求登录并已播种。管理员在“模型管理 → 管理回复”中调整编号、内容或增删条目，新调用立即使用当前库，已接受调用的重放保留旧内容。

网页通过服务端维护的 `isWisdomTree` 标记识别智慧树模型，所以修改其公开 ID 后，播种、施肥和说话仍连接到同一个模型并保留轮换位置。站内 `/api/models` 和管理员模型返回这个标记；管理员模型还返回 `replyCount`、`ruleCount`，分别显示编号库总数和规则总数。普通创建/编辑请求不能手动更改这个标记。

初始智慧树回复库包含 80 条中文玩法事实摘要与原创闲聊，覆盖原始资源全部 80 个数字对白键，供试用完整轮换效果；不是原版逐字台词或官方中文翻译。条目来源、完整性核验与原版高度信息见 [智慧树语料](wisdom-corpus.md)。

## Anthropic SDK

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.WISDOM_TREE_API_KEY,
  authToken: null,
  baseURL: 'https://你的域名',
});
const stream = client.messages.stream({
  model: 'claude-fable-5.1',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好，智慧树' }],
});
stream.on('text', text => process.stdout.write(text));
await stream.finalMessage();
```

支持 `/v1/models`、Chat Completions、传统 Completions、Responses、Anthropic Messages 和 `messages/count_tokens`。`/responses` 是 `/v1/responses` 的别名。文本流分别遵循 [OpenAI 的事件链](https://developers.openai.com/api/docs/guides/streaming-responses)与 [Anthropic 的事件链](https://platform.claude.com/docs/en/build-with-claude/streaming)。

不支持真实工具执行、音视频生成、结构化 JSON 输出、WebSocket、后台任务或 Responses 检索接口。调用记录不保存用户的完整提示词，只保留请求摘要、计费与回复快照。
