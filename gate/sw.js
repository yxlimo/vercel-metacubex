// 上游的 sw.js 是 Workbox 生成的 PWA Service Worker，其中一句
//     registerRoute(new NavigationRoute(createHandlerBoundToURL("./")))
// 会把所有导航请求（mode: navigate）都指向 precache 里的 "./"，也就是站点
// 根路径。
//
// 本项目的根路径是门页面（public/index.html），面板本体在 /panel.html。
// 若保留上游的 SW，浏览器访问 /panel.html 时会被 SW 返回缓存的 "./"，
// 也就是门页面 —— 面板永远打不开。
//
// Workbox 的 NavigationRoute 没有「只对某些路径生效」的写法，所以这个 SW
// 与「根路径放门页面」的布局无法共存，必须换掉。
//
// 这里换成只清理旧缓存、不拦截任何请求的 SW：面板是实时控制面板，
// 离线缓存没有意义。
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        try {
            const names = await caches.keys();
            await Promise.all(names.map((name) => caches.delete(name)));
        } catch (err) {
            // 清理失败不影响使用
        }
        await self.clients.claim();
        // 接管当前页面后重载一次，摆脱旧 SW 的导航兜底
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
            client.navigate(client.url);
        }
    })());
});
