// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV; // 注入 KV 绑定
    }
    return handleRequest(request);
  }
}

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
]); // 代理时需剥离的响应头

const JSON_SOURCES = {
  '健康过滤版 (normal)': {
    name: 'lite',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/lite.json'
  },
  '完整过滤版 (normal+premium)': {
    name: 'adult',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/adult.json'
  },
  '完整版 (Full)': {
    name: 'Full',
    url: 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/KVideo-config.json'
  }
};

const FORMAT_CONFIG = {
  '0': { proxy: false },
  'raw': { proxy: false },
  '1': { proxy: true },
  'proxy': { proxy: true }
};

// 🔑 域名标识提取器
function extractSourceId(apiUrl) {
  try {
    const url = new URL(apiUrl);
    const hostname = url.hostname;
    const parts = hostname.split('.');
    if (parts.length >= 3 && ['caiji', 'api', 'cj', 'www'].includes(parts[0])) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    return parts[0].toLowerCase().replace(/zyapi$|zy$|api$/, '').replace(/[^a-z0-9]/g, '') || 'source';
  } catch {
    return 'source' + Math.random().toString(36).substr(2, 6);
  }
}

// 🛠️ 处理 JSON 结构：递归修改 baseUrl
function processJsonStructure(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(item => processJsonStructure(item, newPrefix));
  const newObj = {};
  for (const key in obj) {
    if (key === 'baseUrl' && typeof obj[key] === 'string') {
      let apiUrl = obj[key];
      const urlIndex = apiUrl.indexOf('?url=');
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5);
      if (!apiUrl.startsWith(newPrefix)) {
        const sourceId = extractSourceId(apiUrl);
        const baseUrlPath = newPrefix.replace(/\/?\?url=$/, ''); 
        apiUrl = `${baseUrlPath}/p/${sourceId}?url=${encodeURIComponent(apiUrl)}`;
      }
      newObj[key] = apiUrl;
    } else {
      newObj[key] = processJsonStructure(obj[key], newPrefix);
    }
  }
  return newObj;
}

// KV 缓存逻辑
async function getCachedJSON(url) {
  const kvAvailable = typeof globalThis.KV !== 'undefined' && globalThis.KV && typeof globalThis.KV.get === 'function';
  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url;
    const cached = await globalThis.KV.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { await globalThis.KV.delete(cacheKey); }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const data = await res.json();
    await globalThis.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 });
    return data;
  }
  const res = await fetch(url);
  return await res.json();
}

// 主请求处理
async function handleRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  
  const reqUrl = new URL(request.url);
  const pathname = reqUrl.pathname;
  const targetUrlParam = reqUrl.searchParams.get('url');
  const formatParam = reqUrl.searchParams.get('format');
  const prefixParam = reqUrl.searchParams.get('prefix');
  const sourceParam = reqUrl.searchParams.get('source');
  const currentOrigin = reqUrl.origin;
  const defaultPrefix = currentOrigin + '/?url=';

  if (pathname === '/health') return new Response('OK', { status: 200, headers: CORS_HEADERS });
  
  // 转发代理请求
  if ((pathname.startsWith('/p/') || pathname === '/') && targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin);
  }
  
  // 订阅转换请求
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix);
  }
  
  // 首页 UI
  return handleHomePage(currentOrigin, defaultPrefix);
}

// 代理请求转发优化：处理编码与数据清洗
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  try {
    let fullTargetUrl = decodeURIComponent(targetUrlParam);
    const targetURL = new URL(fullTargetUrl);
    
    // 复制除 url 外的其他参数
    const reqUrl = new URL(request.url);
    for (const [key, value] of reqUrl.searchParams) {
      if (key !== 'url') targetURL.searchParams.append(key, value);
    }

    const response = await fetch(new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
    }));

    // 构建响应头
    const responseHeaders = new Headers(CORS_HEADERS);
    let contentType = response.headers.get('content-type') || 'application/json';
    if (!contentType.includes('charset')) contentType += '; charset=utf-8';

    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
    }
    responseHeaders.set('Content-Type', contentType);

    // 数据清洗：解决 &nbsp; 和乱码问题
    if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml')) {
      let text = await response.text();
      // 移除多余的 HTML 实体字符（可选，视源站情况而定）
      // text = text.replace(/&nbsp;/g, ' '); 
      return new Response(text, { status: response.status, headers: responseHeaders });
    }

    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (err) {
    return errorResponse('Proxy Error', { message: err.message }, 502);
  }
}

// JSON 格式化输出
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam];
    if (!config) return errorResponse('Invalid format', { format: formatParam }, 400);
    const sourceConfig = JSON_SOURCES[sourceParam] || JSON_SOURCES['full'];
    const data = await getCachedJSON(sourceConfig.url);
    const newData = config.proxy ? processJsonStructure(data, prefixParam || defaultPrefix) : data;
    return new Response(JSON.stringify(newData), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
    });
  } catch (err) {
    return errorResponse(err.message, {}, 500);
  }
}

async function handleHomePage(currentOrigin, defaultPrefix) {
  // 预生成表格行
  const tableRows = Object.entries(JSON_SOURCES).map(([key, item]) => {
    return `
      <tr>
        <td rowspan="2">
          <div style="font-weight:600;color:#fff">${item.name}</div>
          <span class="badge">${key}</span>
        </td>
        <td><span class="badge">原始 Raw</span></td>
        <td><div class="copy-zone" onclick="quickCopy('${currentOrigin}/?format=0&source=${key}')">点击复制</div></td>
      </tr>
      <tr>
        <td><span class="badge proxy-badge">代理 Proxy</span></td>
        <td><div class="copy-zone" onclick="quickCopy('${currentOrigin}/?format=1&source=${key}')">点击复制</div></td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <title>KVideo Config Nexus</title>
  <style>
    :root { 
      --primary: #3b82f6; 
      --bg: #0f172a; 
      --card-bg: #1e293b;
      --text: #f1f5f9; 
      --text-mute: #94a3b8;
      --border: #334155; 
      --accent: #10b981;
      --code-bg: #0f172a;
    }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      background: var(--bg); 
      color: var(--text); 
      max-width: 900px; 
      margin: 0 auto; 
      padding: 40px 20px; 
      line-height: 1.6;
    }
    .header { 
      text-align: center; 
      margin-bottom: 50px; 
    }
    .header h1 { 
      font-size: 2.2rem; 
      margin-bottom: 10px; 
      background: linear-gradient(to right, #60a5fa, #a78bfa); 
      -webkit-background-clip: text; 
      -webkit-text-fill-color: transparent; 
      font-weight: 800; 
    }
    
    .card { 
      background: var(--card-bg); 
      border-radius: 16px; 
      padding: 24px; 
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); 
      margin-bottom: 24px; 
      border: 1px solid var(--border); 
    }
    h2 { 
      font-size: 1.2rem; 
      margin-top: 0; 
      margin-bottom: 16px;
      display: flex; 
      align-items: center; 
      gap: 10px; 
      color: #fff; 
    }
    h2::before { 
      content: ''; 
      width: 4px; 
      height: 18px; 
      background: var(--primary); 
      border-radius: 4px; 
    }
    
    /* 介绍板块样式 */
    .intro-grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
      gap: 20px; 
      margin-top: 15px; 
    }
    .intro-item { 
      background: var(--code-bg); 
      padding: 15px; 
      border-radius: 10px; 
      border: 1px solid var(--border); 
    }
    .intro-item h3 { 
      font-size: 0.95rem; 
      color: var(--primary); 
      margin-top: 0; 
      margin-bottom: 8px;
    }
    .intro-item p { 
      font-size: 0.85rem; 
      color: var(--text-mute); 
      margin-bottom: 0; 
    }
    
    /* 表格容器 - 横向滚动 */
    .table-responsive {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin-top: 10px;
      border-radius: 8px;
    }
    
    table { 
      width: 100%; 
      border-collapse: collapse; 
      min-width: 520px; /* 确保在小屏幕时触发横向滚动 */
    }
    th { 
      text-align: left; 
      color: var(--text-mute); 
      font-size: 0.8rem; 
      padding: 12px; 
      border-bottom: 1px solid var(--border); 
      white-space: nowrap;
    }
    td { 
      padding: 12px; 
      border-bottom: 1px solid var(--border); 
      font-size: 0.9rem; 
      vertical-align: middle;
    }
    
    .badge { 
      font-size: 11px; 
      padding: 2px 8px; 
      border-radius: 6px; 
      background: #334155; 
      color: #cbd5e1; 
      white-space: nowrap;
      display: inline-block;
    }
    .proxy-badge { 
      background: rgba(16, 185, 129, 0.2); 
      color: #34d399; 
    }
    
    .copy-zone { 
      cursor: pointer; 
      background: var(--code-bg); 
      padding: 8px 12px; 
      border-radius: 8px; 
      font-family: monospace; 
      font-size: 12px; 
      color: var(--text-mute); 
      text-align: center; 
      border: 1px solid transparent; 
      transition: 0.2s; 
      word-break: break-all;
      white-space: pre-wrap;
      display: inline-block;
      max-width: 100%;
      box-sizing: border-box;
    }
    .copy-zone:hover { 
      border-color: var(--primary); 
      color: var(--primary); 
    }
    
    .toast { 
      position: fixed; 
      top: 20px; 
      left: 50%; 
      transform: translateX(-50%); 
      background: var(--primary); 
      color: white; 
      padding: 8px 20px; 
      border-radius: 50px; 
      display: none; 
      z-index: 100; 
      font-size: 14px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.5); 
      white-space: nowrap;
    }
    code { 
      font-family: monospace; 
      color: #f472b6; 
      background: rgba(244, 114, 182, 0.1); 
      padding: 2px 4px; 
      border-radius: 4px; 
    }
    
    /* 移动端优化 */
    @media screen and (max-width: 600px) {
      body {
        padding: 20px 12px;
      }
      
      .header h1 {
        font-size: 1.8rem;
      }
      
      .card {
        padding: 16px;
      }
      
      td {
        padding: 8px;
      }
      
      .copy-zone {
        font-size: 11px;
        padding: 6px 8px;
        white-space: normal;
      }
      
      .intro-grid {
        grid-template-columns: 1fr;
        gap: 12px;
      }
    }

    /* 超小屏幕优化 */
    @media screen and (max-width: 380px) {
      .badge {
        font-size: 10px;
        padding: 1px 6px;
      }
      
      .copy-zone {
        font-size: 10px;
        padding: 5px 6px;
      }
      
      th, td {
        padding: 6px;
      }
    }
  </style>
</head>
<body>
  <div id="toast" class="toast">复制成功</div>
  
  <div class="header">
    <h1>KVideo Config Nexus</h1>
    <p style="color: var(--text-mute)">自动化接口中转、跨域绕过与 GitHub 配置增强工具</p>
  </div>

  <div class="card">
    <h2>📖 功能介绍</h2>
    <div class="intro-grid">
      <div class="intro-item">
        <h3>🔄 递归代理转换</h3>
        <p>自动识别 JSON 配置中的 <code>baseUrl</code>，并将其重写为经过本节点中转的链接，彻底解决资源站接口无法访问的问题。</p>
      </div>
      <div class="intro-item">
        <h3>🚀 GitHub 加速</h3>
        <p>利用 Cloudflare 网络直连 GitHub Raw 资源，并配合 KV 级别缓存（600s），大幅提升订阅加载速度。</p>
      </div>
      <div class="intro-item">
        <h3>🛡️ 跨域与清洗</h3>
        <p>自动处理 CORS 跨域头，并剥离冗余的 Cookie 及编码头，确保播放器（如 TVBox）能稳定解析数据。</p>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>📦 快捷订阅源</h2>
    <div class="table-responsive">
      <table>
        <thead>
          <tr>
            <th>配置版本</th>
            <th>链接类型</th>
            <th>操作 (点击复制)</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>🚀 基础代理用法</h2>
    <p style="color: var(--text-mute); font-size: 0.9rem; margin-bottom: 15px; word-break: break-word;">直接将需要加速的 API 或图片链接拼接在下方前缀后：</p>
    <div class="copy-zone" onclick="quickCopy('${defaultPrefix}')" style="width: 100%;">
      ${defaultPrefix}https://example.com/api.php
    </div>
  </div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => t.style.display = 'none', 2000);
    }

    async function quickCopy(text) {
      try {
        await navigator.clipboard.writeText(text);
        showToast('复制成功');
      } catch (err) {
        const input = document.createElement('input');
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('复制成功');
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  });
}

function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}
