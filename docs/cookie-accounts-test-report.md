# Cookie 托管账号端到端可用性测试报告

> 验证目标:被「401 / refresh_token 失效」后改用 **session cookie** 托管的免费 ChatGPT 账号,
> 到底是「只能查配额、一调用就报错」,还是**能真正调用模型(生图 + 聊天)**。

| 项目 | 内容 |
|---|---|
| 测试日期 | 2026-06-05 |
| 被测系统 | CPA Manager Pro · image-service(容器 `cpa-manager`) |
| 部署地址 | https://cpam.lijiwang.top |
| 账号池总量 | cookie 托管账号 **63 个** |
| 本次抽测 | **9 个**(均为「曾经 401、用扩展重新存过 cookie」的账号) |
| 测试方式 | 端到端、**绕过号池轮换**,逐号用各自 cookie 现换 token 后直接打真实接口 |

---

## 一、测试背景

有用户反馈:

> 「这个方法不是不能用了吗?这样只能获取 AT,导入进去只能看到额度,一调用就报错。」
> 「现在这个方法 plus 和 free 一样都不能用了,能查配额,但是无法调用模型。」

**「能查配额」和「能调用模型」走的是完全不同的接口**:

| 行为 | 实际请求的接口 |
|---|---|
| 查配额(巡检) | `GET /backend-api/wham/usage` |
| 真实生图 | `POST /backend-api/f/conversation/prepare` + 对话流 |
| 真实聊天 | `POST /backend-api/conversation`(ChatGPT 网页版对话) |

因此「巡检过 ≠ 能生图」在理论上确实可能发生。本测试就是要用**真实生图 / 真实聊天**把这个问题打穿。

---

## 二、测试方法

对每个被测账号,依次执行 5 步,任一步失败都会被记录:

| 步骤 | 动作 | 验证点 |
|---|---|---|
| ① 换 token | 用该号 session cookie 调 `/api/auth/session` | cookie 是否还活着 |
| ② token 类型 | 解析 JWT 的 `amr` 声明 | 是否纯密码会话(易被作废) |
| ③ 查配额 | `GET /backend-api/wham/usage` | 别人说「能查配额」 |
| ④ **真实生图** | `gpt-image-2` 实际生成一张图 | **别人说「一调用就报错」** |
| ⑤ **真实聊天** | ChatGPT 网页版对话直连(不走号池兜底) | **真实模型调用** |

> 关键:④⑤ 都是**绕过号池**、用被测账号自己的 token 直接打,排除「别的号顶上」的干扰,
> 测的就是这个号本身。

---

## 三、测试结果

### 总览(9 个号 + 1 个重复文件,共 10 次)

| # | 账号 | ①换token | ③查配额 | ④真实生图 | ⑤真实聊天 |
|---|---|:---:|:---:|:---:|:---:|
| 1 | crouton-snap-bunny@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 2 | drab-driver-salsa@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 3 | earplugs-spur-dad@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 4 | finale-envoy-creme@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 5 | flaky-flail-chug@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 6 | header-floss-jab@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 7 | herbal-fool-walk@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 8 | hertz-turkey-reach@duck.com | ✅ | 200 | ✅ 出图 | ✅ |
| 9 | hull-mold-trophy@duck.com | ✅ | 200 | ✅ 出图 | ✅ |

**通过率:生图 9/9(100%)· 聊天 9/9(100%)· 查配额 9/9(100%)**

### 聊天真实回复样本(证据)

| 账号 | 模型实际回复 |
|---|---|
| crouton-snap-bunny | 你好,很高兴见到你,祝你今天愉快! |
| drab-driver-salsa | 你好!希望你今天充满笑容和好心情。 |
| finale-envoy-creme | 你好,祝你今天心情愉快、事事顺利! |
| herbal-fool-walk | 你好,很高兴见到你,祝你今天愉快! 😊 |
| hertz-turkey-reach | 你好呀!希望你今天充满好心情和惊喜。 |
| hull-mold-trophy | 你好呀!希望你今天心情愉快,万事顺意! |

> 生图 9 个号均返回了实际图片字节(base64 b64_json),非空、非文字拒绝。

---

## 四、结论

### ✅ 核心结论:cookie 托管账号能真正调用模型,不是只能查配额

本次抽测的 9 个「曾经 401、改用 cookie 托管」的免费账号,**全部**通过真实生图与真实聊天,
通过率 100%。**「只能查配额、一调用就报错」的说法在本部署上不成立。**

### 为什么别人会遇到「能查配额但不能调用」?

差别在**导入的是哪一个 token**:

| 做法 | 结果 |
|---|---|
| ❌ 直接导入**浏览器登录拿到的 access_token** | 常是「纯密码会话」(`amr: ["pwd"]`),OpenAI 会作废 → **只能查配额,一调用就 401** |
| ✅ 本方案:存 **cookie**,服务端**用 cookie 现换 token** | 换出来的是有效会话 → **生图、聊天都能调** |

> 补充观察:本次换出的 token `amr = None`(既非 pwd 也非 otp/mfa),仍可正常生图聊天。
> 说明决定可用性的关键**不是 amr,而是「token 是否由 cookie 实时换取」** —— 实时换的就是活的。

### 与 gpt-5.4 / gpt-5.5 报 503 无关

- 本测试「聊天能用」走的是 **ChatGPT 网页版对话(model=auto)**,免费号天生支持;
- `gpt-5.4 / gpt-5.5` 报 503,走的是 **CPA → codex 的受限模型**,是 **OpenAI 限制免费号**所致,
  与 cookie 机制无关。

---

## 五、发现的问题

| 问题 | 说明 | 建议 |
|---|---|---|
| 重复认证文件 | `hull-mold-trophy` 同时存在 `...@duck.com-free.json` 与 `...@duck.com.json`,内容重复 | 清理其一,避免号池占双槽 |

---

## 六、复现方式

测试脚本:`/tmp/test_cookie_gen.py`(容器内),传邮箱片段即可逐号端到端验证:

```bash
ssh cpaserver 'docker exec -w /opt/image-service cpa-manager \
  /opt/image-service/.venv/bin/python /tmp/test_cookie_gen.py crouton-snap-bunny hull-mold-trophy'
```

脚本对每个匹配账号依次执行:换 token → token 类型 → 查配额 → **真实生图** → **真实聊天**。

---

*报告生成:CPA Manager Pro 运维测试 · 2026-06-05*
