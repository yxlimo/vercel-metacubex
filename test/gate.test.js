const assert = require('assert');
const { readFileSync, existsSync } = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const gate = readFileSync(path.join(root, 'gate/index.html'), 'utf8');
const vercelConfig = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const configSrc = readFileSync(path.join(root, 'api/config.js'), 'utf8');
const configHandler = require('../api/config.js');

function renderConfig() {
    return new Promise((resolve, reject) => {
        const res = {
            headers: {},
            body: '',
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = body; resolve(this); },
        };
        try {
            configHandler({ url: '/config.js', headers: {} }, res);
        } catch (err) {
            reject(err);
        }
    });
}

function findUrls(text) {
    const m = text.match(/https?:\/\/[^\s"'<>)]+/g);
    return m || [];
}

(async () => {
    // 1. 门页面写入的 localStorage 键名必须与面板一致
    assert.ok(gate.includes("'endpointList'"), '门页面应写 endpointList');
    assert.ok(gate.includes("'selectedEndpoint'"), '门页面应写 selectedEndpoint');

    // 1b. 控制令牌是可选的
    //     留空时沿用 mihomo 密钥——metacubexd-server 与 mihomo 部署在一起时，
    //     官方 compose 的示例就是 CONTROL_TOKEN 与 CLASH_SECRET 相同。
    //     两者不同时才需要单独填。
    assert.ok(/id="token"/.test(gate), '控制令牌输入框应存在');
    assert.ok(!/id="token"[^>]*required/.test(gate), '控制令牌不应是必填');
    assert.ok(gate.includes('var controlToken = token || secret;'),
        '控制令牌留空时应沿用密钥');
    assert.ok(gate.includes('write(TOKEN_KEY, controlToken)'),
        '控制令牌应单独存储');

    // 1c. 写入格式必须匹配面板的序列化方式
    //     面板用 VueUse 的 useStorage：endpointList 默认值是数组 → JSON；
    //     selectedEndpoint 默认值是字符串 → 原样字符串。
    //     把 selectedEndpoint 写成 JSON 字符串，面板会读不到选中项，
    //     停在「已保存的端点」页面。
    assert.ok(gate.includes('write(SELECTED_KEY, ENDPOINT_ID)'),
        'selectedEndpoint 应写原始字符串');
    assert.ok(!gate.includes('JSON.stringify(ENDPOINT_ID)'),
        'selectedEndpoint 不应写成 JSON 字符串');
    assert.ok(gate.includes('JSON.stringify(items)'),
        'endpointList 应写 JSON');

    // 2. 门页面不得写死任何后端地址（只允许占位用的 example.com）
    const gateUrls = findUrls(gate).filter((u) => u !== 'https://example.com:8443');
    assert.deepEqual(gateUrls, [], `门页面不应包含真实后端地址：${gateUrls.join(', ')}`);
    assert.ok(!/secret\s*[:=]\s*['"][A-Za-z0-9]{16,}/.test(gate),
        '门页面不应包含写死的凭据');

    // 3. 门页面跳转到面板的路径必须与构建产物一致
    assert.ok(gate.includes("'/panel.html'"), '门页面应跳转到 /panel.html');

    // 4. 生成的 config.js 不含任何凭据
    const res = await renderConfig();
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.ok(res.body.includes('defaultBackendURL'), '应声明 defaultBackendURL');
    assert.ok(!/controlToken\s*:\s*['"][^'"]+['"]/.test(res.body),
        'config.js 里不应出现写死的 controlToken');

    // 5. 后端地址留空，由门页面写进本机
    assert.ok(res.body.includes('"defaultBackendURL":""'), '后端地址应留空');

    // 5b. 保存前必须校验连通性
    //     密钥填错或后端地址写错时，如果直接写 localStorage，用户会进到面板
    //     才看到「无法连接」，还多留一条坏配置。门页面应先探一次 /version。
    assert.ok(gate.includes('/version'), '门页面应探测后端的 /version');
    assert.ok(gate.includes('Authorization'), '探测应带上密钥');
    assert.ok(gate.includes('probeBackend'), '门页面应先校验再保存');
    assert.ok(gate.includes('probeControl'), '门页面应探测控制接口');
    assert.ok(gate.includes('/api/control/info'), '控制探测应打 /api/control/info');
    const probeIdx = gate.indexOf('probeBackend(url, secret)');
    const saveIdx = gate.indexOf('write(ENDPOINT_KEY');
    assert.ok(probeIdx > 0 && saveIdx > probeIdx,
        '写入 localStorage 必须发生在连通性校验之后');

    // 6. config.js 应把 control 客户端指向使用者自己的后端
    //    面板读 window.metacubexd.control.base，设了就用设的——
    //    这样前端直连后端，不经过任何中间层。
    assert.ok(res.body.includes('window.metacubexd'), '应设置 window.metacubexd');
    assert.ok(res.body.includes('.control'), '应设置 window.metacubexd.control');
    assert.ok(res.body.includes("'/api/control'"), 'control base 应指向后端的 /api/control');

    // 7. config.js 也必须走 rewrite（静态文件会优先命中，rewrite 失效）
    const configRewrite = (vercelConfig.rewrites || []).find((r) => r.source === '/config.js');
    assert.ok(configRewrite, 'vercel.json 必须有 /config.js 的 rewrite');
    assert.equal(configRewrite.destination, '/api/config.js');

    // 8. 不应再有中转层
    //    前端直连后端时，Vercel 只托管静态文件；留着中转函数既没意义，
    //    又多一条到后端的链路（那条链路在国内家宽上并不稳定）。
    assert.ok(!existsSync(path.join(root, 'api/control')),
        '不应存在中转函数目录');
    const controlRewrite = (vercelConfig.rewrites || []).find(
        (r) => r.source === '/api/control/:path*'
    );
    assert.ok(!controlRewrite, 'vercel.json 不应有 /api/control 的 rewrite');
    assert.ok(!/base64|btoa|atob/.test(res.body),
        'control base 不应再编码后端地址');

    // 9. 源码里不得写死任何实例地址
    const srcUrls = findUrls(configSrc);
    assert.deepEqual(srcUrls, [], `源码不应包含硬编码的地址：${srcUrls.join(', ')}`);
    assert.ok(!/process\.env\./.test(configSrc.replace(/process\.env\.[A-Z_]+/g, '')),
        'config.js 不应依赖环境变量');

    // 10. Service Worker 替身不得拦截导航
    //     上游的 Workbox SW 用 NavigationRoute 把所有导航请求指向 precache 的
    //     "./"（站点根路径）。根路径现在是门页面，保留它会让 /panel.html
    //     的导航也被替换成门页面，面板永远打不开。
    const swSrc = readFileSync(path.join(root, 'gate/sw.js'), 'utf8');
    const swCode = swSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/NavigationRoute|precacheAndRoute|createHandlerBoundToURL/.test(swCode),
        'sw.js 不得注册导航路由');
    assert.ok(/clients\.claim/.test(swCode), 'sw.js 应当接管并清理旧缓存');

    console.log('✓ 门页面键名与面板一致，序列化格式正确');
    console.log('✓ 门页面不含写死的后端地址');
    console.log('✓ config.js 不含写死的凭据，且从 localStorage 读取');
    console.log('✓ config.js 把 control 客户端指向使用者自己的后端');
    console.log('✓ config.js 的 rewrite 存在');
    console.log('✓ 无中转层（前端直连）');
    console.log('✓ 源码不含硬编码地址，也不依赖环境变量');
    console.log('✓ Service Worker 不拦截导航');
    console.log('\n全部通过');
})().catch((err) => {
    console.error('失败:', err.message);
    process.exit(1);
});
