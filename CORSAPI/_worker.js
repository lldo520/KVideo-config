// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }
    return handleRequest(request)
  }
}

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/puppet680/KVideo-config/refs/heads/main/KVideo-config.json'
}

// 移除了 Base58 相关的映射
const FORMAT_CONFIG = {
  '0': { proxy: false },
  'raw': { proxy: false },
  '1': { proxy: true },
  'proxy': { proxy: true }
}

// 🔑 从 URL 中提取唯一标识符
function extractSourceId(apiUrl) {
  try {
    const url = new URL(apiUrl)
    const hostname = url.hostname
    const parts = hostname.split('.')
    if (parts.length >= 3 && (parts[0] === 'caiji' || parts[0] === 'api' || parts[0] === 'cj' || parts[0] === 'www')) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '')
    }
    let name = parts[0].toLowerCase()
    name = name.replace(/zyapi$/, '').replace(/zy$/, '').replace(/api$/, '')
    return name.replace(/[^a-z0-9]/g, '') || 'source'
  } catch {
    return 'source' + Math.random().toString(36).substr(2, 6)
  }
}

// JSON api 字段前缀替换
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)

      if (!apiUrl.startsWith(newPrefix)) {
        const sourceId = extractSourceId(apiUrl)
        const baseUrl = newPrefix.replace(/\/?\?url=$/, '')
        apiUrl = `${baseUrl}/p/${sourceId}?url=${apiUrl}`
      }
      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// KV 缓存
async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'
  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try { return JSON.parse(cached) } catch (e) { await KV.delete(cacheKey) }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 })
    return data
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    return await res.json()
  }
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')
  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  if ((pathname.startsWith('/p/') || pathname === '/') && targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix)
  }

  return handleHomePage(currentOrigin, defaultPrefix)
}

async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected', {}, 400)
  }
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', {}, 400)
  }

  const urlMatch = request.url.match(/[?&]url=([^&]+)/)
  const fullTargetUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : targetUrlParam
  
  const reqUrl = new URL(request.url)
  const targetURL = new URL(fullTargetUrl)
  for (const [key, value] of reqUrl.searchParams) {
    if (key !== 'url') targetURL.searchParams.append(key, value)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value)
    }

    return new Response(response.body, { status: response.status, headers: responseHeaders })
  } catch (err) {
    return errorResponse('Proxy Error', { message: err.message }, 502)
  }
}

async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) return errorResponse('Invalid format', {}, 400)

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource)
    const newData = config.proxy ? addOrReplacePrefix(data, prefixParam || defaultPrefix) : data

    return new Response(JSON.stringify(newData), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
    })
  } catch (err) {
    return errorResponse(err.message, {}, 500)
  }
}

async function handleHomePage(currentOrigin, defaultPrefix) {
  // HTML 内容保持不变，仅移除了高级文档中关于 base58 的描述（建议根据需要微调 HTML 文本）
  const html = `...` // 同原 HTML，此处略以节省篇幅
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
