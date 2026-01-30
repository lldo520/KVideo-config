const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置区 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const README_PATH = path.join(__dirname, "README.md");

const MAX_DAYS = 30;
const WARN_STREAK = 3; 
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; 
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 1. 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
}
const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const apiEntries = configArray.map((s) => ({
    name: s.name,
    api: s.baseUrl,
    id: s.id || "-", // 对应原版中的地址/备注列
    disabled: s.enabled === false,
}));

// === 2. 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = old.match(/```json\n([\s\S]+?)\n```/);
    if (match) { try { history = JSON.parse(match[1]); } catch (e) {} }
}

const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";

// === 3. 工具函数 ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            return res.status === 200;
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return false;
};

const testSearch = async (api, keyword) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const url = `${api}?wd=${encodeURIComponent(keyword)}`;
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            if (res.status !== 200 || !res.data || !res.data.list) return "❌";
            return res.data.list.length ? "✅" : "无结果";
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return "❌";
};

const queueRun = async (tasks, limit) => {
    const results = [];
    const executing = new Set();
    for (const [i, task] of tasks.entries()) {
        const p = task().then(res => results[i] = res);
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
};

// === 主逻辑 ===
(async () => {
  console.log("⏳ 正在检测 API 与搜索功能可用性（队列并发 + 重试机制）...");

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    if (disabled) return { name, api, disabled, success: false, searchStatus: "无法搜索" };

    const ok = await safeGet(api);
    const searchStatus = ENABLE_SEARCH_TEST ? await testSearch(api, SEARCH_KEYWORD) : "-";
    return { name, api, disabled, success: ok, searchStatus };
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);

  const todayRecord = {
    date: new Date().toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORD,
    results: todayResults,
  };

  history.push(todayRecord);
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 ===
  const stats = {};
  for (const { name, api, detail, disabled } of apiEntries) {
    stats[api] = { name, api, detail, disabled, ok: 0, fail: 0, fail_streak: 0, trend: "", searchStatus: "-", status: "❌" };

    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
    }

    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) break;
      streak++;
    }
    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";

    const recent = history.slice(-7);
    stats[api].trend = recent.map(day => {
      const r = day.results.find(x => x.api === api);
      return r ? (r.success ? "✅" : "❌") : "-";
    }).join("");

    const latest = todayResults.find(x => x.api === api);
    if (latest) stats[api].searchStatus = latest.searchStatus;

    if (disabled) stats[api].status = "🚫";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${apiEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}\n\n`;
  md += "| 状态 | 资源名称 | 地址 | API | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 |\n";
  md += "|------|---------|-----|-----|---------|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    const detailLink = s.detail.startsWith("http") ? `[Link](${s.detail})` : s.detail;
    const apiLink = `[Link](${s.api})`;
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;


  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log("📄 报告已生成:", REPORT_PATH);
})();
