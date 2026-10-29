## vercel-metacubex

MetaCubeXD 面板的静态托管。

upstream 的 `compressed-dist.tgz` 是完整 Nuxt SPA（SSR 关闭，hashMode 路由），
构建时拉取解压即可，零服务端依赖。

## 访问链路

```
访客 → /                 → 门页面（填后端地址 + 密钥，先校验连通性）
     → /panel.html       → 面板本体
       ├─ mihomo API     → 直连用户填的后端
       ├─ control API    → 直连用户填的后端的 /api/control
       └─ /config.js     → api/config.js（动态生成，注入本机保存的信息）
```

**没有中间层。** 面板直接请求使用者自己的后端，Vercel 只托管静态文件。

## 它解决什么

面板有两个独立 API 客户端：

| 客户端 | base | 说明 |
| --- | --- | --- |
| mihomo API | 用户填的「后端地址」 | mihomo 自带 `external-controller-cors`，浏览器直连即可 |
| control API | `window.metacubexd.control.base`，缺省是 `location.origin + '/api/control'` | metacubexd-server **不带任何 CORS 头**，跨域直连会被浏览器拦 |

control API 的 base 由 `api/config.js` 注入的引导代码改写：

```js
window.metacubexd.control = {
    base: 后端地址 + '/api/control',
    token: 控制令牌
};
```

面板读 base 的代码是 `window.metacubexd?.control?.base`，设了就用设的，
**面板代码不用改**，fetch 与 EventSource（SSE）都会跟着走。

## 凭据模型

| 凭据 | 存在哪 | 谁校验 |
| --- | --- | --- |
| 后端地址 | 本机 localStorage（`endpointList`） | — |
| 密钥 | 本机 localStorage（`endpointList`） | mihomo |
| 控制令牌 | 本机 localStorage（`mcx-control-token`） | metacubexd-server |

服务端不持有也不预填任何凭据——服务出去的 `config.js` 里只有空的后端地址。

门页面问三项，保存前会先探后端的 `/version` 确认地址和密钥都对，校验通过才
写 localStorage。

### 控制令牌

面板的 control 客户端需要一个控制令牌才能调 `/api/control`。门页面里它
**留空即沿用上面的密钥**：metacubexd-server 与 mihomo 部署在一起时，官方
compose 的示例就是 `CONTROL_TOKEN` 与 `CLASH_SECRET` 相同，使用者只填一个。

两者不同时单独填控制令牌，探测会用填的那个值：

| 门页面填法 | localStorage 里的 `mcx-control-token` |
| --- | --- |
| 只填密钥 | 密钥（与 mihomo 共用） |
| 密钥 + 不同的控制令牌 | 填的那个控制令牌 |

探测失败（后端不接受这个令牌）时提示「控制中心不可用」，但 mihomo 的部分
照常可用，localStorage 里也不会留下控制令牌。

## 后端要满足的条件

control API 必须发 CORS 头：面板的 control 请求带 `Authorization` 头，浏览器
会先发 OPTIONS 预检，后端要应答预检并带上 `Access-Control-Allow-Origin`。

mihomo 的 external-controller 自带 `external-controller-cors` 配置，不需要管。
metacubexd-server 自身没有 CORS 能力，需要在前面加一层反向代理。

## 目录结构

```
vercel-metacubex/
├── gate/
│   ├── index.html               # 门页面（规范副本，构建时复制到 public/）
│   └── sw.js                    # Service Worker 替身（构建时覆盖上游的）
├── api/
│   └── config.js                # 动态 config.js + control base 注入
├── scripts/build.mjs             # 拉取 upstream 并组装 public/
├── test/                         # 门页面 / 契约测试
└── vercel.json
```

`public/` **不入库**，由 `scripts/build.mjs` 在构建时现拉现组装。

## Service Worker 必须换掉

上游的 `sw.js` 是 Workbox 生成的 PWA SW，里面一句

```js
registerRoute(new NavigationRoute(createHandlerBoundToURL("./")))
```

会把**所有导航请求**都指向 precache 里的 `./`，也就是站点根路径。

而本项目的根路径是门页面，面板本体在 `/panel.html`。保留上游的 SW 的话，
浏览器访问 `/panel.html` 时会被 SW 返回缓存的 `./`（门页面）——面板永远打不开。

Workbox 的 `NavigationRoute` 没有「只对某些路径生效」的写法，所以这个 SW 与
「根路径放门页面」的布局无法共存。构建时用 `gate/sw.js` 覆盖它：那个替身只
清理旧缓存、不拦截任何请求（面板是实时控制面板，离线缓存没有意义）。

首次访问时旧 SW 仍在控制页面，替身 activate 后会清掉旧缓存并重载一次页面。

## 构建

`scripts/build.mjs` 做四件事：

1. 取 upstream 最新 tag（可用 `METACUBEXD_TAG` 环境变量固定版本）
2. 下载 `compressed-dist.tgz` 并解压到 `public/`
3. `index.html` → `panel.html`，门页面补位到 `index.html`，删掉 `config.js`，
   用 `gate/sw.js` 覆盖上游的 Service Worker
4. **校验契约**：面板是否仍引用 `config.js`、仍使用 `endpointList` /
   `selectedEndpoint` / `controlToken` 这几个键名，以及 `sw.js` 是否是替身

第 4 步很重要：这些键名和引用方式来自 upstream 内部实现，改版可能变。变了
不会报错，只会让门页面静默失效。所以契约变更时让构建直接失败。

解压用的是自带的 tar 解析器（`node:zlib` + ustar），不依赖系统 tar——upstream
的压缩包里有超过 100 字符的路径（`_fonts/` 下的文件名），GNU tar 会拆到
prefix 字段，得处理。解析结果与系统 tar 逐字节一致。

## 部署

### Vercel 项目

| 项 | 值 |
| --- | --- |
| Build Command | `node scripts/build.mjs` |
| Output Directory | `public` |
| Node 版本 | 22 |
| 环境变量 | 无 |

### 域名

```bash
vercel domains add <你的域名>
```

DNS 处 CNAME 到该项目在 Vercel 控制台显示的目标值。每个项目目标值不同，
抄别的项目的会报 `invalid configuration`。

目标值 API 不暴露，可以从 projectId 反推：

```
CNAME 目标 = sha256(projectId)[:16] + ".vercel-dns-017.com"
```

DNS 改完后 Vercel 才会签发证书，期间该域名的 TLS 握手会直接失败
（`Cipher is (NONE)`）——边缘对没有证书的 SNI 一律断连，属正常现象。

## 自动更新

`.github/workflows/sync.yml` 每天检查 upstream 是否有新 tag，有则触发 Vercel
重新部署（构建时自然会拉到新版本）。

需要配两个 GitHub 仓库配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Actions variable | `SITE_URL` | 站点地址，用于查询当前线上版本 |
| Actions secret | `VERCEL_DEPLOY_HOOK` | Vercel 项目设置里创建的 Deploy Hook URL |

没配 `VERCEL_DEPLOY_HOOK` 时工作流会跳过并提示，不会误报。

## 访问控制

面板本身不做鉴权，公开暴露前在 Vercel WAF 里限定访问来源。当前配置：

| # | 名称 | 条件 | 动作 |
| --- | --- | --- | --- |
| 1 | `Shanghai & JIangsu` | `geo_country = CN` 且 `geo_country_region ∈ {SH, JS}` | Bypass |
| 2 | `DenyOthers` | `path starts with /`（无条件） | Deny |

顺序不能反：Bypass 命中后会跳过其余规则，Deny 命中即终止评估。

注意规则 2 要写成**无条件**，不要写成「Country is not CN」——那样境内
非白名单省份（如北京）两条规则都不命中，会被直接放行，只挡住了境外。

```bash
vercel firewall rules list --project vercel-metacubex
vercel firewall publish --project vercel-metacubex --yes
```

## 已知限制

**HTTPS 面板 → HTTP mihomo API**：浏览器会拦截混合内容。Vercel 只支持
HTTPS，面板侧无解。可选：

1. mihomo 开启 `external-controller-tls`，配一个浏览器信任的证书
   （自签需手动信任，或用 Let's Encrypt）。
2. 面板部署在能出 HTTP 的环境（家里 NAS 上的反向代理去掉 HTTPS，
   或内网直接 `IP:8080`）。

**每个后端自己得支持 CORS**：control API 的跨域是使用者后端的责任。官方
metacubexd-server 镜像不带 CORS 能力，需要自己加一层代理。
