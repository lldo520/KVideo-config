const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const ADULT_JSON_PATH = path.join(__dirname, "adult.json");
const LITE_JSON_PATH = path.join(__dirname, "lite.json");

const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 5; 
const MAX_RETRY = 2;

if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在");
    process.exit(1);
}

const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

//读取历史记录用于计算趋势（从 report.md 提取旧 JSON）
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = old.match(/```json\n([\s\S]+?)\n```/);
    if (match) { try { history = JSON.parse(match[1]); } catch (e) {} }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function testSource(item) {
    const url = item.baseUrl;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await axios.get(`${url}?ac=detail&wd=${encodeURIComponent(SEARCH_KEYWORD)}`, { timeout: TIMEOUT_MS });
            if (res.data && res.data.list && res.data.list.length > 0) {
                return { success: true, reason: "✅" };
            }
            return { success: false, reason: res.data.list ? "无结果" : "格式错误" };
        } catch (e) {
            if (attempt === MAX_RETRY) return { success: false, reason: "连接超时" };
            await delay(1000);
        }
    }
}

(async () => {
    console.log(`⏳ 正在检测: ${SEARCH_KEYWORD}`);
    const tasks = configArray.map(item => () => testSource(item).then(res => ({ ...item, ...res })));
    
    // 队列执行
    const results = [];
    const pool = tasks.map(t => t());
    const todayResults = await Promise.all(pool);

    // 更新历史
    history.push({ date: new Date().toISOString().slice(0, 10), results: todayResults.map(r=>({api:r.baseUrl, success:r.success})) });
    if (history.length > 30) history = history.slice(-30);

    // --- 计算统计与优先级 ---
    const stats = todayResults.map(item => {
        const historyEntries = history.map(h => h.results.find(x => x.api === item.baseUrl)).filter(Boolean);
        const okCount = historyEntries.filter(h => h.success).length;
        const rate = (okCount / historyEntries.length) * 100;
        
        // 趋势计算 (最近7次)
        const trend = history.slice(-7).map(h => {
            const r = h.results.find(x => x.api === item.baseUrl);
            return r ? (r.success ? "✅" : "❌") : "-";
        }).join("");

        // 核心：动态优先级算法
        let priority = 50; // 默认中等
        if (item.success) {
            if (rate >= 100) priority = 1;
            else if (rate >= 90) priority = 5;
            else if (rate >= 80) priority = 10;
        } else {
            priority = 99; // 挂掉的排最后
        }

        return { ...item, ok: okCount, fail: historyEntries.length - okCount, rate: rate.toFixed(1) + "%", trend, priority };
    });

    // --- 1. 生成 adult.json ---
    const adultData = stats.map(s => ({
        id: s.id,
        name: s.name,
        baseUrl: s.baseUrl,
        group: s.group || "normal",
        enabled: s.success,
        priority: s.priority,
        ...(s.success ? {} : { _comment: `异常: ${s.reason}` })
    })).sort((a, b) => a.priority - b.priority);
    fs.writeFileSync(ADULT_JSON_PATH, JSON.stringify(adultData, null, 2));

    // --- 2. 生成 lite.json ---
    const liteData = adultData.filter(s => s.group !== "adult" && s.enabled);
    fs.writeFileSync(LITE_JSON_PATH, JSON.stringify(liteData, null, 2));

    // --- 3. 生成 Markdown 报告 (保留历史样式) ---
    const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";
    let md = `# API 健康报告\n\n## 状态更新：${nowCST}\n\n`;
    md += `| 状态 | 资源名称 | API接口 | 优先级 | 成功率 | 最近7天趋势 |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    
    stats.sort((a, b) => a.priority - b.priority).forEach(s => {
        md += `| ${s.success?'✅':'❌'} | ${s.name} | [Link](${s.baseUrl}) | ${s.priority} | ${s.rate} | ${s.trend} |\n`;
    });

    md += `\n<details><summary>📜 历史数据</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>\n`;
    fs.writeFileSync(REPORT_PATH, md);

    console.log("✨ 处理完毕！");
})();
