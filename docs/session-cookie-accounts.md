# 用 Session Cookie 救活「需要二次验证」的 ChatGPT 免费号（CPA Manager Pro）

> 适用场景：你的 CPA / image-service 号池里，有一批免费 ChatGPT 账号巡检时报
> `接口返回 401，认证令牌已失效，建议删除账号`，但**账号本身没被封**，只是开启了
> 二次验证（MFA/2FA），导致没法用 OAuth 那套 refresh_token 续期。这篇讲怎么不删号、
> 用 session cookie 把它们长期救活。

---

## 一、问题是什么

ChatGPT 账号在 CPA 里靠 **OAuth `refresh_token`** 续期 access_token。但有一类号会出问题：

- 账号本身**正常、没封号**；
- 但它**要求二次验证**（手机/邮箱 OTP）；
- 走 OAuth 重新授权时会被要求**再验证一次手机号** → 续不了；
- 结果：access_token 过期后续不上 → 巡检 401 → 被当成死号「建议删除」。

**关键点：这些号不是死号，是「OAuth 续期路被二验堵死了」而已。**

---

## 二、核心原理

虽然 OAuth 续期被堵，但**直接在浏览器登录 `https://chatgpt.com/` 是没问题的**（手动过一次二验即可）。登录之后，访问：

```
GET https://chatgpt.com/api/auth/session
```

会返回这样一段（敏感信息已省略）：

```json
{
  "user": { "email": "xxx@duck.com", "mfa": true, "amr": ["pwd","otp","mfa"] },
  "expires": "2026-08-31T02:30:21.393Z",
  "accessToken": "eyJhbG...",          // ← 可直接用的 access_token，有效期约 10 天
  "authProvider": "openai"
}
```

里面有一个**可直接用的 `accessToken`**，没有 `refresh_token`。但**没关系**，因为：

| 凭证 | 有效期 | 能不能续 |
|---|---|---|
| `accessToken` | **约 10 天** | 用 cookie 再请求一次 `/api/auth/session` 就能换新的 |
| **session cookie**（`__Secure-next-auth.session-token`） | **约 3 个月** | 每次访问 `/api/auth/session` 会**滚动续期**，越用越久 |

所以整套逻辑是：

> **手动浏览器登录一次 → 拿到 session cookie → 之后服务端拿这个 cookie 周期性换新
> access_token，账号就一直活着，完全不需要 refresh_token、不需要再过二验。**

一次登录通常能管 **3 个月以上**（cookie 滚动续期甚至更久），中间全自动。

---

## 三、一个坑：别用浏览器登录直接给的 access_token

实测发现：MFA 账号在浏览器登录后，**有时候第一手拿到的 access_token 是「纯密码会话」的**
（JWT 里 `amr: ["pwd"]`），这个 token 会被 OpenAI **作废**。

而**用 session cookie 调 `/api/auth/session` 换出来的** token 才是「完整 MFA 会话」的
（`amr: ["otp","mfa"]`），这个才真正能用。

**所以服务端永远以 cookie 换出来的 token 为准，不要直接信浏览器给的那个。** （CPA Manager Pro
的 image-service 已经这么做了。）

---

## 四、CPA Manager Pro 是怎么落地的

整套机制内建在 **image-service**（容器内的生图服务）里，工作流：

```
①  你（或浏览器扩展）登录 chatgpt.com，过一次二验
        ↓ 拿到 __Secure-next-auth.session-token
②  POST /v0/image/accounts/import-session  { file_name, session_cookie }
        ↓
③  image-service 用 cookie 调 /api/auth/session 换出「MFA 会话」access_token
        ↓
④  把这个活 token 写回 CPA 认证文件（覆盖那个死的 pwd token，同名覆盖不产生重复）
        ↓
⑤  之后每隔约 8 天（token 剩 2 天到期时）自动用 cookie 换新 + 滚动更新 cookie + 再写回 CPA
        ↓
⑥  直到 cookie 约 3 个月后真的失效 → 该号在巡检里标「需要重新登录」→ 你再登录一次存 cookie
```

效果：
- **生图正常**（image-service 直接用 cookie 换的 token）；
- **本机巡检 / 服务端巡检 / CPA 直连都显示健康**（因为活 token 已写回 CPA 认证文件）；
- **不再触发 `app_session_terminated`**（全程不调 OAuth refresh_token）。

---

## 五、接口文档

### 导入 session cookie（救活一个号）

```
POST /v0/image/accounts/import-session
Authorization: Bearer <管理员密钥>      # 注意是 admin key，不是 client sk- key
Content-Type: application/json

{
  "file_name": "codex-xxx@duck.com-free.json",   // 401 账号在 CPA 里的文件名
  "session_cookie": "<__Secure-next-auth.session-token 的值>"
}
```

返回：
```json
{ "ok": true, "file_name": "...", "token_exp": 1781230862 }
```

curl 示例：
```bash
curl -sS -X POST "http://<你的cpa-manager地址>:18317/v0/image/accounts/import-session" \
  -H "Authorization: Bearer <admin-key>" \
  -H "Content-Type: application/json" \
  -d '{"file_name":"codex-xxx@duck.com-free.json","session_cookie":"<cookie值>"}'
```

### 查"需要重新登录"的号

账号列表 `GET /v0/image/accounts` 里每个号带有：
- `session_managed`：是否已托管 cookie；
- `needs_relogin`：cookie 是否也死了（true = 需要你再登录一次存 cookie）。

巡检结果里，**cookie 也死了的号**会归到「建议删除 / 需要重新登录」，扩展/人工针对这些重登即可。

---

## 六、怎么拿 session cookie

两种方式：

**A. 浏览器扩展（推荐，可批量）**
写一个 Chrome 扩展：读取 CPA 里 401 的认证文件 → 自动打开对应账号登录 → 过二验 →
从 cookie 里取 `__Secure-next-auth.session-token` → 调上面的 import-session 接口。

**B. 手动（单个号）**
1. 浏览器登录 `https://chatgpt.com/`，过二验；
2. F12 → Application → Cookies → `https://chatgpt.com` → 复制 `__Secure-next-auth.session-token` 的值；
3. 用上面的 curl 调 import-session。

---

## 七、注意事项 / FAQ

**Q：一次登录能管多久？**
A：cookie 标称有效期约 3 个月，且每次自动续期会**滚动延长**，正常情况下存一次能管 ≥3 个月，常常更久。

**Q：会不会被封 / 被风控？**
A：风险远低于以前。服务端只在 token 快过期时（约每 8 天）调一次 `/api/auth/session`，频率极低，不像 refresh_token 那样高频刷。但仍**无法 100% 保证** —— OpenAI 仍可能因安全事件、异地 IP 等作废 session。最好让服务端走和登录地一致的代理。

**Q：cookie 死了怎么办？**
A：该号会在巡检里标「需要重新登录」，你（或扩展）再登录一次、重新存 cookie 即可。不会废号。

**Q：会产生重复认证文件吗？**
A：不会。写回 CPA 用**同一个文件名覆盖**，不是新增。

**Q：和原来的 refresh_token 账号冲突吗？**
A：不冲突。只有导入过 cookie 的号才走这套；其它号照常走 CPA 的 token 下载。

**Q：会不会泄露 cookie？**
A：cookie 存在容器的 `/data` 目录里（和你的认证文件同级），请保护好服务器访问权限。
cookie 等同于账号登录态，**不要外泄**。

---

## 八、一句话总结

> 二验账号不是死号，只是 OAuth 续期被堵。手动浏览器登录一次拿 session cookie，
> 服务端拿 cookie 周期性换 access_token + 写回 CPA，一次登录管几个月，全程不碰
> refresh_token，号就一直活着用来生图。
