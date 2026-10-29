#!/usr/bin/env node
/**
 * 构建脚本：拉取 upstream 最新产物并组装 public/。
 *
 * public/ 不入库（见 .gitignore），每次部署时现拉现组装。
 * 组装内容：
 *   1. 解压 compressed-dist.tgz → public/
 *   2. upstream 的 index.html → public/panel.html（面板）
 *   3. 门页面 → public/index.html（入口）
 *   4. 删除 public/config.js（改由 api/config.js 动态生成）
 *
 * 之后校验面板与本项目之间的契约，契约变了就让构建失败——
 * 契约变更会静默让门页面与控制凭据失效，比构建失败难查得多。
 */
import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile, rm, readFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UPSTREAM_REPO = 'MetaCubeX/metacubexd';
const OUT_DIR = 'public';
const GATE_FILE = 'gate/index.html';
const SW_FILE = 'gate/sw.js';
const PANEL_FILE = 'panel.html';
const BLOCK = 512;

/** 读取 tar 头里的字符串字段（NUL 或空格终止） */
function readStr(buf, start, len) {
    let end = start;
    while (end < start + len && buf[end] !== 0) end += 1;
    return buf.toString('utf8', start, end).replace(/[ ]+$/, '');
}

/** 读取 tar 头里的八进制数值字段 */
function readOctal(buf, start, len) {
    const raw = readStr(buf, start, len).trim();
    if (!raw) return 0;
    return parseInt(raw, 8);
}

/**
 * 解析 tar（ustar）。
 * upstream 的压缩包里有超过 100 字符的路径（_fonts/ 下的文件名），
 * GNU tar 会拆到 prefix 字段，所以要处理 prefix 拼接与 'L' 长名扩展。
 */
function parseTar(buf) {
    const files = [];
    let off = 0;
    let pendingLongName = null;

    while (off + BLOCK <= buf.length) {
        const header = buf.subarray(off, off + BLOCK);
        let empty = true;
        for (const b of header) {
            if (b !== 0) {
                empty = false;
                break;
            }
        }
        if (empty) break;

        const name = readStr(header, 0, 100);
        const size = readOctal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 0);
        const prefix = readStr(header, 345, 155);
        off += BLOCK;

        const dataEnd = off + size;
        const padded = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK);

        if (type === 'L') {
            // GNU 长名扩展：下一条记录的真实文件名
            pendingLongName = buf.toString('utf8', off, dataEnd).replace(/\0+$/, '');
            off = padded;
            continue;
        }
        if (type === '5') {
            off = padded;
            continue;
        }

        let full = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
        pendingLongName = null;
        full = full.replace(/^\.\//, '');
        if (!full || full.includes('..')) {
            off = padded;
            continue;
        }
        files.push({ path: full, data: buf.subarray(off, dataEnd) });
        off = padded;
    }
    return files;
}

async function fetchTag() {
    if (process.env.METACUBEXD_TAG) return process.env.METACUBEXD_TAG;
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, {
        headers: { 'user-agent': 'vercel-metacubex-build' },
    });
    if (!res.ok) throw new Error(`获取 upstream 最新版本失败：HTTP ${res.status}`);
    const json = await res.json();
    if (!json.tag_name) throw new Error('upstream 未返回 tag_name');
    return json.tag_name;
}

async function download(tag) {
    const url = `https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/compressed-dist.tgz`;
    const res = await fetch(url, { headers: { 'user-agent': 'vercel-metacubex-build' } });
    if (!res.ok) throw new Error(`下载 ${url} 失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function main() {
    const tag = await fetchTag();
    console.log(`upstream 版本：${tag}`);

    const tgz = await download(tag);
    const files = parseTar(gunzipSync(tgz));
    console.log(`解压得到 ${files.length} 个文件`);

    await rm(OUT_DIR, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });

    for (const file of files) {
        const dest = path.join(OUT_DIR, file.path);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, file.data);
    }

    // 面板挪到 panel.html，把入口让给门页面
    const panelSrc = path.join(OUT_DIR, 'index.html');
    if (!existsSync(panelSrc)) throw new Error('upstream 产物缺少 index.html');
    await copyFile(panelSrc, path.join(OUT_DIR, PANEL_FILE));
    await rm(panelSrc);

    // 门页面补位
    if (!existsSync(GATE_FILE)) throw new Error(`缺少门页面 ${GATE_FILE}`);
    await copyFile(GATE_FILE, path.join(OUT_DIR, 'index.html'));

    // Service Worker 换成不拦截导航的版本
    // 上游的 Workbox SW 会把所有导航请求指向 precache 的 "./"，而根路径
    // 现在是门页面，会导致 /panel.html 也被替换成门页面。
    if (!existsSync(SW_FILE)) throw new Error(`缺少 SW 替身 ${SW_FILE}`);
    await copyFile(SW_FILE, path.join(OUT_DIR, 'sw.js'));

    // config.js 改由 api/config.js 动态生成（要带控制凭据，且不能被缓存）
    await rm(path.join(OUT_DIR, 'config.js'), { force: true });

    await verifyContracts();

    await writeFile(
        path.join(OUT_DIR, 'build-info.json'),
        `${JSON.stringify({ tag, builtAt: new Date().toISOString(), files: files.length }, null, 2)}\n`
    );
    console.log(`组装完成 → ${OUT_DIR}/`);
}

/**
 * 校验本项目与面板之间的契约。
 * 这些键名/引用方式来自 upstream 内部实现，改版可能变；
 * 变了就静默失效，所以在这里让构建失败。
 */
async function verifyContracts() {
    const indexHtml = await readFile(path.join(OUT_DIR, PANEL_FILE), 'utf8');
    const problems = [];

    if (!/src="config\.js"/.test(indexHtml)) {
        problems.push('面板不再引用 config.js，动态配置不会被加载');
    }
    if (!/__METACUBEXD_CONFIG__/.test(indexHtml)) {
        problems.push('面板不再读取 __METACUBEXD_CONFIG__');
    }

    const nuxtDir = path.join(OUT_DIR, '_nuxt');
    const jsFiles = existsSync(nuxtDir)
        ? (await readdir(nuxtDir)).filter((f) => f.endsWith('.js'))
        : [];
    let bundle = '';
    for (const f of jsFiles) {
        bundle += await readFile(path.join(nuxtDir, f), 'utf8');
    }

    for (const key of ['endpointList', 'selectedEndpoint', 'controlToken']) {
        if (!bundle.includes(key)) {
            problems.push(`面板不再使用 ${key}，门页面/配置注入会失效`);
        }
    }

    // Service Worker 必须是替身：上游的 Workbox 版本会把所有导航请求指向
    // precache 的 "./"（站点根路径），而根路径现在是门页面，
    // /panel.html 的导航会被替换成门页面。
    // 判断前先剥掉注释——替身自己的注释里会提到这些关键词。
    const sw = await readFile(path.join(OUT_DIR, 'sw.js'), 'utf8');
    const swCode = sw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    if (/NavigationRoute|precacheAndRoute|createHandlerBoundToURL/.test(swCode)) {
        problems.push('public/sw.js 仍是上游的 Workbox 版本，会拦截导航');
    }
    if (!/clients\.claim/.test(swCode)) {
        problems.push('public/sw.js 不是清理旧缓存用的替身');
    }

    if (problems.length) {
        throw new Error(`契约校验失败：\n  - ${problems.join('\n  - ')}`);
    }
    console.log(`契约校验通过（${jsFiles.length} 个 JS chunk）`);
}

main().catch((err) => {
    console.error(`构建失败：${err.message}`);
    process.exit(1);
});
