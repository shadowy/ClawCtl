import type Database from "better-sqlite3";

export interface SkillEntry {
  name: string;
  source: "bundled" | "clawhub";
  note: string;
}

export interface SkillTemplate {
  id: string;
  name: string;
  name_zh: string;
  description: string;
  description_zh: string;
  icon: string;
  skills: SkillEntry[];
  builtin: number;
  sort_order: number;
}

export const BUILTIN_TEMPLATES: SkillTemplate[] = [
  {
    id: "engineering",
    name: "Engineering",
    name_zh: "工程开发",
    description: "GitHub, CI/CD, code delegation, skill authoring",
    description_zh: "GitHub、CI/CD、代码委托、Skill 开发",
    icon: "wrench",
    skills: [
      { name: "github", source: "bundled", note: "PR/Issue/CI" },
      { name: "gh-issues", source: "bundled", note: "GitHub Issues management" },
      { name: "coding-agent", source: "bundled", note: "Code delegation" },
      { name: "skill-creator", source: "bundled", note: "Skill authoring" },
      { name: "clawhub", source: "bundled", note: "Skill marketplace" },
      { name: "tmux", source: "bundled", note: "Terminal multiplexer" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
    ],
    builtin: 1,
    sort_order: 1,
  },
  {
    id: "marketing",
    name: "Marketing",
    name_zh: "营销运营",
    description: "Content, campaigns, social media, analytics",
    description_zh: "内容创作、营销推广、社交媒体、数据分析",
    icon: "megaphone",
    skills: [
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "notion", source: "bundled", note: "Notion workspace" },
      { name: "xurl", source: "bundled", note: "URL fetching" },
      { name: "himalaya", source: "bundled", note: "Email client" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "blogwatcher", source: "bundled", note: "Blog monitoring" },
      { name: "byterover", source: "clawhub", note: "Social media analytics" },
    ],
    builtin: 1,
    sort_order: 2,
  },
  {
    id: "design",
    name: "Design",
    name_zh: "设计创意",
    description: "Image generation, PDF editing, video processing",
    description_zh: "图片生成、PDF编辑、视频处理",
    icon: "palette",
    skills: [
      { name: "openai-image-gen", source: "bundled", note: "Image generation" },
      { name: "nano-banana-pro", source: "bundled", note: "Image editing" },
      { name: "nano-pdf", source: "bundled", note: "PDF operations" },
      { name: "video-frames", source: "bundled", note: "Video frame extraction" },
      { name: "peekaboo", source: "bundled", note: "Screenshot capture" },
      { name: "canvas", source: "bundled", note: "Drawing canvas" },
      { name: "gifgrep", source: "bundled", note: "GIF search" },
    ],
    builtin: 1,
    sort_order: 3,
  },
  {
    id: "finance",
    name: "Finance",
    name_zh: "财务分析",
    description: "Document processing, knowledge graphs, data analysis",
    description_zh: "文档处理、知识图谱、数据整理",
    icon: "bar-chart",
    skills: [
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "nano-pdf", source: "bundled", note: "PDF operations" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "ontology", source: "clawhub", note: "Knowledge graph" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
      { name: "model-usage", source: "bundled", note: "Model usage tracking" },
    ],
    builtin: 1,
    sort_order: 4,
  },
  {
    id: "team",
    name: "Team",
    name_zh: "团队协作",
    description: "Discord, Slack, WhatsApp, task management",
    description_zh: "Discord/Slack/WhatsApp、任务管理",
    icon: "users",
    skills: [
      { name: "discord", source: "bundled", note: "Discord integration" },
      { name: "slack", source: "bundled", note: "Slack integration" },
      { name: "wacli", source: "bundled", note: "WhatsApp CLI" },
      { name: "trello", source: "bundled", note: "Trello boards" },
      { name: "notion", source: "bundled", note: "Notion workspace" },
      { name: "imsg", source: "bundled", note: "iMessage" },
    ],
    builtin: 1,
    sort_order: 5,
  },
  {
    id: "smart-home",
    name: "Smart Home",
    name_zh: "智能生活",
    description: "IoT control, music, weather, reminders",
    description_zh: "IoT控制、音乐、天气、提醒",
    icon: "home",
    skills: [
      { name: "weather", source: "bundled", note: "Weather forecast" },
      { name: "apple-reminders", source: "bundled", note: "Apple Reminders" },
      { name: "spotify-player", source: "bundled", note: "Spotify playback" },
      { name: "openhue", source: "bundled", note: "Philips Hue control" },
      { name: "sonoscli", source: "bundled", note: "Sonos speaker control" },
      { name: "apple-notes", source: "bundled", note: "Apple Notes" },
      { name: "1password", source: "bundled", note: "1Password vault" },
    ],
    builtin: 1,
    sort_order: 6,
  },
  {
    id: "ai-coding",
    name: "AI Coding",
    name_zh: "编程助手",
    description: "Code delegation, docs, review, testing",
    description_zh: "代码委托、文档生成、代码审查",
    icon: "cpu",
    skills: [
      { name: "coding-agent", source: "bundled", note: "Code delegation" },
      { name: "github", source: "bundled", note: "PR/Issue/CI" },
      { name: "gh-issues", source: "bundled", note: "GitHub Issues management" },
      { name: "skill-creator", source: "bundled", note: "Skill authoring" },
      { name: "nano-pdf", source: "bundled", note: "PDF operations" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "session-logs", source: "bundled", note: "Session log viewer" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
      { name: "context7", source: "clawhub", note: "Documentation context" },
    ],
    builtin: 1,
    sort_order: 7,
  },
  {
    id: "product-mgmt",
    name: "Product Management",
    name_zh: "产品管理",
    description: "Feature specs, roadmaps, user research",
    description_zh: "需求文档、路线图、用户调研",
    icon: "clipboard-list",
    skills: [
      { name: "notion", source: "bundled", note: "Notion workspace" },
      { name: "trello", source: "bundled", note: "Trello boards" },
      { name: "github", source: "bundled", note: "PR/Issue/CI" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "blogwatcher", source: "bundled", note: "Blog monitoring" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
    ],
    builtin: 1,
    sort_order: 8,
  },
  {
    id: "productivity",
    name: "Productivity",
    name_zh: "效率提升",
    description: "Tasks, calendar, email, knowledge management",
    description_zh: "任务管理、日程、邮件、知识库",
    icon: "zap",
    skills: [
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "apple-reminders", source: "bundled", note: "Apple Reminders" },
      { name: "apple-notes", source: "bundled", note: "Apple Notes" },
      { name: "obsidian", source: "bundled", note: "Obsidian vault" },
      { name: "himalaya", source: "bundled", note: "Email client" },
      { name: "session-logs", source: "bundled", note: "Session log viewer" },
    ],
    builtin: 1,
    sort_order: 9,
  },
  {
    id: "customer-support",
    name: "Customer Support",
    name_zh: "客户支持",
    description: "Ticket triage, responses, knowledge base",
    description_zh: "工单分拣、客服回复、知识库",
    icon: "headphones",
    skills: [
      { name: "discord", source: "bundled", note: "Discord integration" },
      { name: "slack", source: "bundled", note: "Slack integration" },
      { name: "wacli", source: "bundled", note: "WhatsApp CLI" },
      { name: "himalaya", source: "bundled", note: "Email client" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
    ],
    builtin: 1,
    sort_order: 10,
  },
  {
    id: "sales",
    name: "Sales",
    name_zh: "销售",
    description: "Outreach, pipeline, CRM, social selling",
    description_zh: "客户外联、销售管道、CRM",
    icon: "trending-up",
    skills: [
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "himalaya", source: "bundled", note: "Email client" },
      { name: "notion", source: "bundled", note: "Notion workspace" },
      { name: "xurl", source: "bundled", note: "URL fetching" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "byterover", source: "clawhub", note: "Social media analytics" },
    ],
    builtin: 1,
    sort_order: 11,
  },
  {
    id: "data",
    name: "Data",
    name_zh: "数据分析",
    description: "SQL, visualizations, dashboards, reports",
    description_zh: "SQL分析、可视化、仪表盘、报表",
    icon: "database",
    skills: [
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "nano-pdf", source: "bundled", note: "PDF operations" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
      { name: "canvas", source: "bundled", note: "Drawing canvas" },
      { name: "ontology", source: "clawhub", note: "Knowledge graph" },
      { name: "tavily-search", source: "clawhub", note: "AI-optimized search" },
    ],
    builtin: 1,
    sort_order: 12,
  },
  {
    id: "cn-social",
    name: "Chinese Social",
    name_zh: "中国社交媒体",
    description: "Xiaohongshu, Bilibili, Douyin, Weibo, WeChat",
    description_zh: "小红书、B站、抖音、微博、公众号",
    icon: "message-circle",
    skills: [
      { name: "internet-reach", source: "clawhub", note: "Internet content access" },
      { name: "xiaohongshu-skills", source: "clawhub", note: "Xiaohongshu integration" },
      { name: "bibigpt-skill", source: "clawhub", note: "Bilibili video summary" },
      { name: "humanize-chinese", source: "clawhub", note: "Chinese text humanization" },
      { name: "xurl", source: "bundled", note: "URL fetching" },
      { name: "baoyu-skills", source: "clawhub", note: "Translation & content" },
    ],
    builtin: 1,
    sort_order: 13,
  },
  {
    id: "cn-enterprise",
    name: "Chinese Enterprise",
    name_zh: "中国企业协作",
    description: "Feishu, DingTalk, WeCom, WeChat",
    description_zh: "飞书、钉钉、企业微信",
    icon: "building",
    skills: [
      { name: "openclaw-china", source: "clawhub", note: "China ecosystem" },
      { name: "feishu-openclaw", source: "clawhub", note: "Feishu integration" },
      { name: "openclaw-plugin-wecom", source: "clawhub", note: "WeCom integration" },
      { name: "gog", source: "bundled", note: "Google search" },
      { name: "notion", source: "bundled", note: "Notion workspace" },
      { name: "summarize", source: "bundled", note: "Text summarization" },
    ],
    builtin: 1,
    sort_order: 14,
  },
  {
    id: "cn-ai",
    name: "Chinese AI",
    name_zh: "百度/国产AI",
    description: "Baidu Search, Baike, Scholar, domestic LLMs",
    description_zh: "百度搜索、百科、学术、国产大模型",
    icon: "brain",
    skills: [
      { name: "baidu-search", source: "clawhub", note: "Baidu search engine" },
      { name: "baidu-baike", source: "clawhub", note: "Baidu encyclopedia" },
      { name: "baidu-scholar", source: "clawhub", note: "Baidu academic search" },
      { name: "ai-ppt-generator", source: "clawhub", note: "AI presentation generator" },
      { name: "aisa-provider", source: "clawhub", note: "Domestic LLM provider" },
      { name: "deep-research-agent", source: "clawhub", note: "Deep research agent" },
    ],
    builtin: 1,
    sort_order: 15,
  },
];

/**
 * Seed built-in skill templates into the database.
 * Uses INSERT OR IGNORE so it's idempotent — existing rows are not overwritten.
 */
export function seedTemplates(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO skill_templates (id, name, name_zh, description, description_zh, icon, skills, builtin, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const t of BUILTIN_TEMPLATES) {
      stmt.run(
        t.id,
        t.name,
        t.name_zh,
        t.description,
        t.description_zh,
        t.icon,
        JSON.stringify(t.skills),
        t.builtin,
        t.sort_order,
      );
    }
  });

  insertAll();
}
