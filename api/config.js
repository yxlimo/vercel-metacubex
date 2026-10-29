/**
 * 动态生成面板的 config.js。
 *
 * upstream 发行包里带的是一份静态 config.js（只有 defaultBackendURL 和
 * githubToken 两个空字段），每次同步都会被覆盖。这里改为运行时生成，
 * 好在两点：
 *
 *   1. 面板的「后端地址」由门页面写进本机 localStorage，服务端不预填，
 *      所以访客打开页面拿不到别人的后端地址；
 *   2. 面板的 control 客户端默认连 location.origin + '/api/control'，那是
 *      同源但没有这个接口。这里让它直连使用者自己的后端。
 *
 * 面板读 control base 的代码是：
 *     let t = window?.metacubexd?.control;
 *     if (t?.base) return {base: t.base, token: t.token};
 * 也就是说设置 window.metacubexd.control 就能覆盖默认行为，面板代码不用改。
 *
 * 前端直连的前提是后端发 CORS 头：面板的 control 请求带 Authorization 头，
 * 浏览器会先发 OPTIONS 预检，后端需要应答预检并带上
 * Access-Control-Allow-Origin。mihomo 的 external-controller 自带
 * external-controller-cors 配置，metacubexd-server 没有，需要在前面加一层
 * 反向代理补上。
 */
module.exports = (req, res) => {
    const config = {
        // 留空：后端地址由门页面写进本机 localStorage
        defaultBackendURL: '',
        githubToken: '',
    };

    const bootstrap = `
try {
    var list = JSON.parse(localStorage.getItem('endpointList') || '[]');
    var sel = localStorage.getItem('selectedEndpoint') || '';
    try { sel = JSON.parse(sel); } catch (e) {}
    var cur = null;
    if (Array.isArray(list)) {
        cur = list.filter(function (x) { return x && x.id === sel; })[0] || list[0];
    }
    var tok = localStorage.getItem('mcx-control-token');
    if (cur && cur.url && tok) {
        window.metacubexd = window.metacubexd || {};
        window.metacubexd.control = {
            base: cur.url.replace(/\\/+$/, '') + '/api/control',
            token: tok
        };
    }
} catch (e) {}
`;

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(`window.__METACUBEXD_CONFIG__ = ${JSON.stringify(config)};\n${bootstrap}`);
};
