export const SKILL_CATEGORIES = [
  "dev", "social", "productivity", "creative",
  "communication", "iot", "utility", "ai",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: "bundled" | "clawhub";
  emoji?: string;
  category: SkillCategory;
  tags: string[];
  author?: string;
  downloads?: number;
  homepage?: string;
  requires?: { bins?: string[]; env?: string[]; os?: string[] };
}

const BUNDLED_CATALOG: readonly SkillCatalogEntry[] = [
  // — Passwords & Secrets —
  {
    name: "1password",
    description: "Set up and use 1Password CLI (op)",
    source: "bundled",
    emoji: "\uD83D\uDD10",
    category: "utility",
    tags: ["password", "secrets", "1password"],
    requires: { bins: ["op"] },
  },

  // — Note-Taking —
  {
    name: "apple-notes",
    description: "Manage Apple Notes via memo CLI",
    source: "bundled",
    emoji: "\uD83D\uDCDD",
    category: "productivity",
    tags: ["notes", "apple", "macos"],
    requires: { bins: ["memo"], os: ["darwin"] },
  },
  {
    name: "bear-notes",
    description: "Create/search Bear notes via grizzly CLI",
    source: "bundled",
    emoji: "\uD83D\uDC3B",
    category: "productivity",
    tags: ["notes", "bear", "macos"],
    requires: { bins: ["grizzly"], os: ["darwin"] },
  },
  {
    name: "obsidian",
    description: "Work with Obsidian vaults",
    source: "bundled",
    emoji: "\uD83D\uDC8E",
    category: "productivity",
    tags: ["notes", "obsidian", "markdown"],
    requires: { bins: ["obsidian-cli"] },
  },

  // — Reminders & Tasks —
  {
    name: "apple-reminders",
    description: "Manage Apple Reminders via remindctl",
    source: "bundled",
    emoji: "\u2705",
    category: "productivity",
    tags: ["reminders", "apple", "macos"],
    requires: { bins: ["remindctl"], os: ["darwin"] },
  },
  {
    name: "things-mac",
    description: "Manage Things 3 via things CLI",
    source: "bundled",
    emoji: "\u2611\uFE0F",
    category: "productivity",
    tags: ["todo", "things", "macos"],
    requires: { bins: ["things"], os: ["darwin"] },
  },

  // — Email —
  {
    name: "himalaya",
    description: "CLI email via IMAP/SMTP",
    source: "bundled",
    emoji: "\uD83D\uDCE7",
    category: "communication",
    tags: ["email", "imap", "smtp"],
    requires: { bins: ["himalaya"] },
  },

  // — Messaging —
  {
    name: "imsg",
    description: "iMessage/SMS CLI",
    source: "bundled",
    emoji: "\uD83D\uDCAC",
    category: "communication",
    tags: ["imessage", "sms", "macos"],
    requires: { os: ["darwin"] },
  },
  {
    name: "wacli",
    description: "WhatsApp CLI",
    source: "bundled",
    emoji: "\uD83D\uDCF1",
    category: "communication",
    tags: ["whatsapp", "messaging"],
    requires: { bins: ["wacli"] },
  },
  {
    name: "bluebubbles",
    description: "iMessage via BlueBubbles",
    source: "bundled",
    emoji: "\uD83E\uDEE7",
    category: "communication",
    tags: ["imessage", "bluebubbles"],
  },

  // — Chat Platforms —
  {
    name: "discord",
    description: "Discord ops via message tool",
    source: "bundled",
    emoji: "\uD83C\uDFAE",
    category: "communication",
    tags: ["discord", "chat"],
  },
  {
    name: "slack",
    description: "Slack integration",
    source: "bundled",
    emoji: "\uD83D\uDCBC",
    category: "communication",
    tags: ["slack", "chat", "workspace"],
  },

  // — Project Management —
  {
    name: "notion",
    description: "Notion API for pages/databases",
    source: "bundled",
    emoji: "\uD83D\uDCDD",
    category: "productivity",
    tags: ["notion", "docs", "database"],
  },
  {
    name: "trello",
    description: "Manage Trello boards",
    source: "bundled",
    emoji: "\uD83D\uDCCB",
    category: "productivity",
    tags: ["trello", "kanban", "tasks"],
  },

  // — Development —
  {
    name: "github",
    description: "GitHub ops via gh CLI",
    source: "bundled",
    emoji: "\uD83D\uDC19",
    category: "dev",
    tags: ["github", "git", "pr", "ci"],
    requires: { bins: ["gh"] },
  },
  {
    name: "gh-issues",
    description: "GitHub issues auto-fix",
    source: "bundled",
    emoji: "\uD83D\uDD27",
    category: "dev",
    tags: ["github", "issues", "automation"],
    requires: { bins: ["gh"] },
  },
  {
    name: "coding-agent",
    description: "Delegate to Codex/Claude Code/Pi",
    source: "bundled",
    emoji: "\uD83E\uDD16",
    category: "dev",
    tags: ["coding", "agent", "delegation"],
  },

  // — Content Creation —
  {
    name: "openai-image-gen",
    description: "Batch image gen via OpenAI",
    source: "bundled",
    emoji: "\uD83C\uDFA8",
    category: "creative",
    tags: ["image", "openai", "generation"],
    requires: { env: ["OPENAI_API_KEY"] },
  },
  {
    name: "openai-whisper",
    description: "Local speech-to-text",
    source: "bundled",
    emoji: "\uD83C\uDF99\uFE0F",
    category: "creative",
    tags: ["whisper", "speech", "transcription"],
    requires: { bins: ["whisper"] },
  },
  {
    name: "openai-whisper-api",
    description: "Transcribe via OpenAI API",
    source: "bundled",
    emoji: "\uD83C\uDFA4",
    category: "creative",
    tags: ["whisper", "speech", "api"],
    requires: { env: ["OPENAI_API_KEY"] },
  },
  {
    name: "nano-banana-pro",
    description: "Gemini image gen/edit",
    source: "bundled",
    emoji: "\uD83C\uDF4C",
    category: "creative",
    tags: ["image", "gemini", "generation"],
  },
  {
    name: "nano-pdf",
    description: "Edit PDFs with natural language",
    source: "bundled",
    emoji: "\uD83D\uDCC4",
    category: "creative",
    tags: ["pdf", "editing", "documents"],
    requires: { bins: ["nano-pdf"] },
  },
  {
    name: "video-frames",
    description: "Extract frames from videos",
    source: "bundled",
    emoji: "\uD83C\uDFAC",
    category: "creative",
    tags: ["video", "frames", "ffmpeg"],
    requires: { bins: ["ffmpeg"] },
  },
  {
    name: "gifgrep",
    description: "Search GIF providers",
    source: "bundled",
    emoji: "\uD83D\uDDBC\uFE0F",
    category: "creative",
    tags: ["gif", "search", "animation"],
  },
  {
    name: "songsee",
    description: "Audio spectrograms",
    source: "bundled",
    emoji: "\uD83C\uDFB5",
    category: "creative",
    tags: ["audio", "visualization", "spectrogram"],
    requires: { bins: ["songsee"] },
  },

  // — TTS & Voice —
  {
    name: "sag",
    description: "ElevenLabs TTS",
    source: "bundled",
    emoji: "\uD83D\uDD0A",
    category: "creative",
    tags: ["tts", "elevenlabs", "voice"],
    requires: { env: ["ELEVENLABS_API_KEY"] },
  },
  {
    name: "sherpa-onnx-tts",
    description: "Local TTS via sherpa-onnx",
    source: "bundled",
    emoji: "\uD83D\uDDE3\uFE0F",
    category: "creative",
    tags: ["tts", "local", "offline"],
    requires: { bins: ["sherpa-onnx-tts"] },
  },
  {
    name: "voice-call",
    description: "Voice calls via plugin",
    source: "bundled",
    emoji: "\uD83D\uDCDE",
    category: "communication",
    tags: ["voice", "call", "phone"],
  },

  // — Music & Audio —
  {
    name: "spotify-player",
    description: "Spotify playback/search",
    source: "bundled",
    emoji: "\uD83C\uDFA7",
    category: "iot",
    tags: ["spotify", "music", "playback"],
    requires: { bins: ["spogo"] },
  },
  {
    name: "sonoscli",
    description: "Sonos speaker control",
    source: "bundled",
    emoji: "\uD83D\uDD08",
    category: "iot",
    tags: ["sonos", "speaker", "audio"],
    requires: { bins: ["sonoscli"] },
  },
  {
    name: "blucli",
    description: "BluOS speaker control",
    source: "bundled",
    emoji: "\uD83C\uDFB6",
    category: "iot",
    tags: ["bluos", "speaker", "audio"],
    requires: { bins: ["blu"] },
  },

  // — Smart Home —
  {
    name: "openhue",
    description: "Philips Hue control",
    source: "bundled",
    emoji: "\uD83D\uDCA1",
    category: "iot",
    tags: ["hue", "lights", "smarthome"],
    requires: { bins: ["openhue"] },
  },
  {
    name: "eightctl",
    description: "Eight Sleep pod control",
    source: "bundled",
    emoji: "\uD83D\uDECF\uFE0F",
    category: "iot",
    tags: ["sleep", "temperature", "smarthome"],
    requires: { bins: ["eightctl"] },
  },

  // — Web & Content —
  {
    name: "gog",
    description: "Google Workspace CLI",
    source: "bundled",
    emoji: "\uD83D\uDD0D",
    category: "productivity",
    tags: ["google", "gmail", "calendar", "drive", "sheets"],
    requires: { bins: ["gog"] },
  },
  {
    name: "goplaces",
    description: "Google Places API",
    source: "bundled",
    emoji: "\uD83D\uDCCD",
    category: "utility",
    tags: ["google", "places", "maps"],
    requires: { bins: ["goplaces"] },
  },
  {
    name: "gemini",
    description: "Gemini CLI for Q&A",
    source: "bundled",
    emoji: "\u264A",
    category: "ai",
    tags: ["gemini", "google", "llm"],
  },
  {
    name: "weather",
    description: "Weather via wttr.in",
    source: "bundled",
    emoji: "\u26C5",
    category: "utility",
    tags: ["weather", "forecast"],
  },
  {
    name: "blogwatcher",
    description: "Blog/RSS monitor",
    source: "bundled",
    emoji: "\uD83D\uDCE1",
    category: "utility",
    tags: ["blog", "rss", "monitoring"],
    requires: { bins: ["blogwatcher"] },
  },
  {
    name: "xurl",
    description: "X (Twitter) API CLI",
    source: "bundled",
    emoji: "\uD83D\uDC26",
    category: "social",
    tags: ["twitter", "x", "social"],
    requires: { bins: ["xurl"] },
  },

  // — System & Utilities —
  {
    name: "tmux",
    description: "Remote-control tmux sessions",
    source: "bundled",
    emoji: "\uD83D\uDDA5\uFE0F",
    category: "utility",
    tags: ["tmux", "terminal", "remote"],
    requires: { bins: ["tmux"] },
  },
  {
    name: "healthcheck",
    description: "Host security hardening",
    source: "bundled",
    emoji: "\uD83C\uDFE5",
    category: "utility",
    tags: ["security", "hardening", "health"],
  },
  {
    name: "peekaboo",
    description: "macOS UI capture/automation",
    source: "bundled",
    emoji: "\uD83D\uDC40",
    category: "utility",
    tags: ["screenshot", "macos", "automation"],
    requires: { bins: ["peekaboo"], os: ["darwin"] },
  },
  {
    name: "camsnap",
    description: "RTSP/ONVIF camera capture",
    source: "bundled",
    emoji: "\uD83D\uDCF7",
    category: "iot",
    tags: ["camera", "rtsp", "surveillance"],
  },
  {
    name: "session-logs",
    description: "Search session logs",
    source: "bundled",
    emoji: "\uD83D\uDCDC",
    category: "utility",
    tags: ["logs", "sessions", "history"],
  },
  {
    name: "summarize",
    description: "Summarize URLs/PDFs/files",
    source: "bundled",
    emoji: "\uD83D\uDCCB",
    category: "utility",
    tags: ["summarize", "extract", "transcribe"],
  },

  // — Skill Authoring —
  {
    name: "clawhub",
    description: "ClawHub CLI for skill management",
    source: "bundled",
    emoji: "\uD83C\uDFEA",
    category: "dev",
    tags: ["clawhub", "skills", "marketplace"],
  },
  {
    name: "skill-creator",
    description: "Create/edit/audit skills",
    source: "bundled",
    emoji: "\u270F\uFE0F",
    category: "dev",
    tags: ["skill", "authoring", "creation"],
  },

  // — MCP —
  {
    name: "mcporter",
    description: "MCP server management",
    source: "bundled",
    emoji: "\uD83D\uDD0C",
    category: "dev",
    tags: ["mcp", "servers", "tools"],
    requires: { bins: ["mcporter"] },
  },
  {
    name: "oracle",
    description: "Oracle CLI best practices",
    source: "bundled",
    emoji: "\uD83D\uDD2E",
    category: "ai",
    tags: ["oracle", "prompting", "cli"],
    requires: { bins: ["oracle"] },
  },

  // — Specialized —
  {
    name: "ordercli",
    description: "Foodora order tracking",
    source: "bundled",
    emoji: "\uD83C\uDF54",
    category: "utility",
    tags: ["food", "delivery", "orders"],
    requires: { bins: ["ordercli"] },
  },
  {
    name: "model-usage",
    description: "CodexBar CLI usage stats",
    source: "bundled",
    emoji: "\uD83D\uDCCA",
    category: "ai",
    tags: ["usage", "costs", "models"],
    requires: { bins: ["codexbar"] },
  },
  {
    name: "canvas",
    description: "HTML display on connected nodes",
    source: "bundled",
    emoji: "\uD83D\uDDBC\uFE0F",
    category: "creative",
    tags: ["html", "visualization", "dashboard"],
  },
] as const satisfies readonly SkillCatalogEntry[];

/** Returns the full bundled skill catalog (52 skills). */
export function getBundledCatalog(): SkillCatalogEntry[] {
  return BUNDLED_CATALOG.slice() as SkillCatalogEntry[];
}

/** Returns all unique tags from the catalog, sorted alphabetically. */
export function getAllTags(): string[] {
  const tagSet = new Set<string>();
  for (const entry of BUNDLED_CATALOG) {
    for (const tag of entry.tags) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet).sort();
}

/** Returns all skill categories. */
export function getAllCategories(): readonly string[] {
  return SKILL_CATEGORIES;
}

/** Filter catalog by tag, category, or search query (name/description/tags match). */
export function filterCatalog(opts: {
  tag?: string;
  category?: string;
  query?: string;
}): SkillCatalogEntry[] {
  const { tag, category, query } = opts;
  const lowerQuery = query?.toLowerCase();

  const results: SkillCatalogEntry[] = [];
  for (const entry of BUNDLED_CATALOG) {
    if (tag && !entry.tags.includes(tag)) continue;
    if (category && entry.category !== category) continue;
    if (lowerQuery) {
      const inName = entry.name.toLowerCase().includes(lowerQuery);
      const inDesc = entry.description.toLowerCase().includes(lowerQuery);
      const inTags = entry.tags.some(t => t.toLowerCase().includes(lowerQuery));
      if (!inName && !inDesc && !inTags) continue;
    }
    results.push(entry as SkillCatalogEntry);
  }
  return results;
}

/** Placeholder -- will be implemented in api/skills.ts via SSH. */
export async function searchClawHub(
  _query: string,
): Promise<SkillCatalogEntry[]> {
  return [];
}
