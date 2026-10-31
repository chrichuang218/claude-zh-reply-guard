#!/usr/bin/env node
// zh-reply-guard：Claude Code Hook，让面向用户的回复默认使用简体中文。
//
// 一个脚本处理四个事件，按输入的 hook_event_name 分派：
//   SessionStart      未设置官方 language 时注入中文规则（预防）
//   UserPromptSubmit  识别用户的语言意图，写入会话状态（豁免）
//   PreToolUse        检查问题卡、任务列表、wrap_up 等工具文案，英文则拒绝并要求重写
//   Stop              检查本轮最终回复和较长的进度播报，英文则阻断并要求补写中文
//
// 判定只用确定性规则，不调用任何模型或网络服务；任何异常都静默放行。
// 单独检查会话记录：node zh-reply-guard.mjs --check <transcript.jsonl>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 默认配置

export const DEFAULTS = {
  enabled: true,
  stopMode: 'block', // block | context
  checkProgress: true,
  checkThinkingUpdates: true,
  injectRules: true,
  waitSeconds: 3,
  maxToolDenies: 1,
  debug: false,
  reply: { minSentenceWords: 6, minEnglishWords: 12, minEnglishRatio: 0.5 },
  progress: { minSentenceWords: 6, minEnglishWords: 12, minEnglishRatio: 0.5 },
  progressSingleLine: { minSentenceWords: 6, minEnglishWords: 50, minEnglishRatio: 0.5 },
  tool: { minSentenceWords: 4, minEnglishWords: 8, minEnglishRatio: 0.5, minEnglishFields: 2 },
  tools: [
    'AskUserQuestion',
    'TodoWrite',
    'TaskCreate',
    'TaskUpdate',
    'mcp__.*__wrap_up',
    'mcp__.*__update_plan',
  ],
};

const THRESHOLD_GROUPS = ['reply', 'progress', 'progressSingleLine', 'tool'];

// ---------------------------------------------------------------- 规则与反馈文案

export const RULES = [
  '## 回复语言',
  '- 默认使用简体中文输出所有面向用户的自然语言内容，包括最终回复、进度播报、任务列表、问题卡、总结和按钮文案。',
  '- 工具调用的说明文字（如 Bash、PowerShell 的 description，界面上显示为进度行）也用简体中文。',
  '- 代码、命令、文件路径、API 名称、标识符、日志及提交信息按实际需要保留原文。',
  '- 英文内容本身是用户要求的交付物时（英文文案、README、PR 描述、提交信息、报错原文、引用、翻译结果），不要擅自翻译，只把周围的说明文字写成简体中文。',
  '- 用户明确指定其他语言时，按用户的要求输出。',
  '- 不得为了使用中文而修改代码逻辑、工具参数、文件内容、命令、测试结果或技术术语。',
].join('\n');

const REWRITE_TAIL =
  '请只把上面列出的英文段落改用简体中文重写，保持原意、事实和结构不变；已经用中文发出的内容不要再发一遍，进度播报只需写清关键进展。' +
  '不要道歉，也不要解释为什么重写。之后的回复全部使用简体中文。\n' +
  '代码、命令、路径、API 名称、标识符、日志和提交信息保留原文；如果英文本身是用户要求的交付物（英文文案、README、PR 描述、翻译结果等），保留它，只改周围的说明文字；如果用户明确要求了其他语言，按用户的要求输出。';

export function stopReason(hits) {
  const lines = hits.slice(0, 5).map((h) => `- ${h.kind === 'progress' ? '进度播报：' : ''}${h.head}`);
  return `本轮有面向用户的英文段落：\n${lines.join('\n')}\n${REWRITE_TAIL}`;
}

export function toolReason(toolName) {
  return (
    `${toolName} 中面向用户的文案（问题、选项、任务、总结或按钮等）是英文。` +
    '请把这些文案改用简体中文后重新调用，参数里的代码、命令、路径和标识符保持不变。不要道歉，也不要解释。' +
    '如果用户明确要求了其他语言，按用户的要求输出。'
  );
}

// ---------------------------------------------------------------- 语言检测

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
// 英文句段在这些字符处断开：汉字、假名、全角标点
const BREAK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

const STOPWORDS = new Set(
  (
    'a an the is are was were be been being am to of and or in on at for with from by as into onto about over ' +
    'that this these those it its it\'s there here what which who whom whose when where why how ' +
    'will would can could should shall may might must do does did done have has had having not no nor ' +
    'you your yours we our ours they their them he she his her i me my mine us ' +
    'if then so than but because while also just only all any some each every more most other such ' +
    'please let let\'s now yet still very too up out off again once here\'s that\'s don\'t doesn\'t isn\'t aren\'t ' +
    'i\'m i\'ll i\'ve we\'re we\'ll you\'re won\'t can\'t'
  ).split(/\s+/)
);

// 按顺序剔除不参与判定的内容。Markdown 链接必须在 URL 之前处理，否则会留下英文链接标题。
const STRIP = [
  /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, // 代码块（未闭合时剔到结尾）
  /`[^`\n]+`/g, // 行内代码
  /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown 链接和图片
  /<https?:\/\/[^>\s]+>/g,
  /\bhttps?:\/\/[^\s<>()]+/g, // URL
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // 邮箱
  /<\/?[A-Za-z][^>\n]*>/g, // HTML 标签
  /^[ \t]*>.*$/gm, // 引用块
  /^[ \t]*(?:\$|PS>|PS [A-Za-z]:\\[^>\n]*>|[A-Za-z]:\\[^>\n]*>|>>>)[ \t].*$/gm, // 带提示符的命令行
  /(?:[A-Za-z]:|[\w.\-~@]+)?(?:[\\/][\w.\-~@]+)+[\\/]?/g, // 路径：C:\a\b、./src/x.ts、/usr/bin
];

export function stripNonProse(text) {
  let out = String(text ?? '');
  for (const re of STRIP) out = out.replace(re, ' ');
  return out;
}

// 返回词的类别：word（普通英文词）、tech（标识符、缩写等技术词，不计数也不打断句段）
function classify(token) {
  const t = token.replace(/^[("'“‘]+|[)"'”’,.;:!?]+$/g, '');
  if (!t) return null;
  if (/^[A-Za-z]+(?:['’][A-Za-z]+)?$/.test(t) || /^[A-Za-z]+(?:-[A-Za-z]+)+$/.test(t)) {
    if (/^[A-Z]{2,}s?$/.test(t)) return 'tech'; // 全大写缩写：API、PR、URLs
    if (/[a-z][A-Z]/.test(t)) return 'tech'; // 驼峰：useState、TypeScript、GitHub
    return 'word';
  }
  if (/[A-Za-z]/.test(t)) return 'tech'; // 含 _ . / : 数字等：foo_bar、v1.2、node.js
  return null;
}

// 把文本切成"英文句段"：不含汉字和全角标点的连续区域里的普通英文词。
function englishRuns(text) {
  const runs = [];
  let words = [];
  const flush = () => {
    if (words.length) runs.push(words);
    words = [];
  };
  for (const piece of text.split(/(\s+)/)) {
    if (!piece || /^\s+$/.test(piece)) continue;
    // 一个词元里夹着汉字时，以汉字为界再切开
    const parts = piece.split(BREAK);
    parts.forEach((part, i) => {
      if (i > 0) flush();
      const kind = classify(part);
      if (kind === 'word') words.push(part.replace(/^[("'“‘]+|[)"'”’,.;:!?]+$/g, '').toLowerCase());
    });
    if (BREAK.test(piece.slice(-1))) flush();
  }
  flush();
  return runs;
}

/**
 * 判定一段文本是否为"明显的大段英文自然语言"。
 * 返回 { violation, E, C, R }：E 为合格英文句段的总词数，C 为汉字数，R = E / (E + C / 2)。
 */
export function analyze(text, th = DEFAULTS.reply) {
  const prose = stripNonProse(text);
  const C = (prose.match(CJK) || []).length;
  let E = 0;
  for (const run of englishRuns(prose)) {
    if (run.length < th.minSentenceWords) continue;
    const stops = run.filter((w) => STOPWORDS.has(w)).length;
    if (stops >= 2) E += run.length;
  }
  const R = E === 0 ? 0 : E / (E + C / 2);
  const violation = E >= th.minEnglishWords && R >= th.minEnglishRatio;
  return { violation, E, C, R: Math.round(R * 1000) / 1000 };
}

export function head(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
  const t = line.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

// ---------------------------------------------------------------- 用户语言意图

const OTHER_LANGS_ZH =
  '英文|英语|日文|日语|韩文|韩语|法文|法语|德文|德语|西班牙文|西班牙语|俄文|俄语|葡萄牙文|葡萄牙语|意大利文|意大利语|越南文|越南语|泰文|泰语|阿拉伯文|阿拉伯语';
const OTHER_LANGS_EN =
  'english|japanese|korean|french|german|spanish|russian|portuguese|italian|vietnamese|thai|arabic';
// 否定和抱怨不算意图："不要用英文"、"怎么又用英文了"
const NOT_INTENT = new RegExp(
  `(?:不要|不用|别再?|勿|禁止|不准|不许|不必|无需|不能|怎么|为什么|为啥|干嘛|又|还是?在|老是|总是)[^，。！？,.!?\\n]{0,6}?(?:${OTHER_LANGS_ZH})[^，。！？,.!?\\n]{0,6}`,
  'g'
);
const MAKE = '(?:写|生成|输出|起草|拟|创建|做|出|给我|准备|撰写|整理|提供|改成|改为)';

const INTENT_PATTERNS = [
  // 用英文回答 / 改用日语写 / 切换到英文
  new RegExp(`(?:用|使用|以|改用|换成|换用|切换到|切换成|改成|写成|输出成?)\\s*(?:${OTHER_LANGS_ZH})`),
  // 翻译成英文 / 译为日语
  new RegExp(`(?:翻译|翻|译)(?:成|为|到)\\s*(?:${OTHER_LANGS_ZH})`),
  // 写一份英文 README / 出一个英文版
  new RegExp(
    `${MAKE}[^，。！？\\n]{0,10}?(?:${OTHER_LANGS_ZH})(?:版本?|的)?\\s*(?:README|readme|文档|文案|邮件|版|稿|说明|描述|注释|提交信息|commit|PR|标题|摘要)?`
  ),
  // 本身习惯用英文的交付物：写提交信息、生成 PR 描述
  new RegExp(
    `${MAKE}[^，。！？\\n]{0,12}?(?:提交信息|提交说明|commit\\s*(?:message|msg)|(?:PR|pull\\s*request)\\s*的?\\s*(?:描述|说明|正文|标题|description|body))`,
    'i'
  ),
  new RegExp(`\\b(?:reply|respond|answer|write|speak|talk|explain|output|chat)\\b[^.\\n]{0,40}?\\bin\\s+(?:${OTHER_LANGS_EN})\\b`, 'i'),
  new RegExp(`\\btranslate\\b[^.\\n]{0,80}?\\b(?:into|to)\\s+(?:${OTHER_LANGS_EN})\\b`, 'i'),
  new RegExp(`\\b(?:${OTHER_LANGS_EN})\\s+(?:please|only|version|readme|docs?|copy)\\b`, 'i'),
];

const SESSION_SCOPE =
  /以后|之后都|接下来|从现在起|从现在开始|后面都|全程|一直|始终|今后|整个会话|本次会话|\bfrom now on\b|\balways\b|\bgoing forward\b|\bfor the rest of\b|\bfrom here on\b/i;
const RESTORE_ZH = /(?:改回|换回|切回|恢复|回到|继续用|还是用|请用|用|使用)\s*(?:简体)?(?:中文|汉语|简体)/;

export function stripPrompt(prompt) {
  return String(prompt ?? '')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ');
}

/** 返回 { kind: 'other' | 'restore' | null, scope: 'turn' | 'session' } */
export function detectIntent(prompt) {
  const raw = stripPrompt(prompt);
  const text = raw.replace(NOT_INTENT, ' ');
  if (INTENT_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'other', scope: SESSION_SCOPE.test(text) ? 'session' : 'turn' };
  }
  if (RESTORE_ZH.test(raw)) return { kind: 'restore', scope: 'session' };
  return { kind: null, scope: 'turn' };
}

// ---------------------------------------------------------------- 官方 language 设置

export function isChineseLanguage(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return false;
  return /中文|汉语|漢語|简体|簡體|繁体|繁體|普通话|國語|国语/.test(v) || /chinese|mandarin/.test(v) || /^zh(?:[-_].*)?$/.test(v);
}

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** 按 local → project → user 读取 language，返回 'chinese' | 'other' | 'unset' */
export function languageSetting(projectDir, env = process.env) {
  const files = [];
  if (projectDir) {
    files.push(path.join(projectDir, '.claude', 'settings.local.json'), path.join(projectDir, '.claude', 'settings.json'));
  }
  files.push(path.join(configDir(env), 'settings.json'));
  for (const f of files) {
    const s = readJson(f);
    if (s && typeof s.language === 'string' && s.language.trim()) {
      return isChineseLanguage(s.language) ? 'chinese' : 'other';
    }
  }
  return 'unset';
}

// ---------------------------------------------------------------- 配置

export function loadConfig(projectDir, env = process.env) {
  const cfg = structuredClone(DEFAULTS);
  const files = [path.join(configDir(env), 'zh-reply-guard.json')];
  if (projectDir) files.push(path.join(projectDir, '.claude', 'zh-reply-guard.json'));
  for (const f of files) {
    const c = readJson(f);
    if (!c || typeof c !== 'object') continue;
    for (const [k, v] of Object.entries(c)) {
      if (!(k in DEFAULTS)) continue;
      if (THRESHOLD_GROUPS.includes(k) && v && typeof v === 'object') Object.assign(cfg[k], v);
      else cfg[k] = v;
    }
  }
  const sw = String(env.ZH_REPLY_GUARD ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(sw)) cfg.enabled = false;
  const dbg = String(env.ZH_REPLY_GUARD_DEBUG ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(dbg)) cfg.debug = true;
  else if (['0', 'false', 'off', 'no'].includes(dbg)) cfg.debug = false;
  return cfg;
}

export function toolMatches(toolName, patterns) {
  return (patterns || []).some((p) => {
    try {
      return new RegExp(`^(?:${p})$`).test(toolName);
    } catch {
      return p === toolName;
    }
  });
}

// ---------------------------------------------------------------- 会话状态与日志

function stateDir(env) {
  return env.ZH_REPLY_GUARD_STATE_DIR || path.join(os.tmpdir(), 'zh-reply-guard');
}

function stateFile(sessionId, env) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(stateDir(env), `${safe}.json`);
}

export function readState(sessionId, env = process.env) {
  const s = readJson(stateFile(sessionId, env));
  return s && typeof s === 'object' ? s : {};
}

export function writeState(sessionId, state, env = process.env) {
  try {
    const dir = stateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile(sessionId, env), JSON.stringify(state));
    cleanupOldState(dir);
  } catch {
    // 状态写不进去时只是少了豁免和计数，不影响放行
  }
}

function cleanupOldState(dir) {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {
      // 忽略
    }
  }
}

function debugLog(cfg, env, record) {
  if (!cfg?.debug) return;
  try {
    const dir = stateDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // 忽略
  }
}

// 本轮的标识：优先用官方的 prompt_id，没有时用 UserPromptSubmit 记下的轮次序号
function turnKey(input, state) {
  return input.prompt_id || `turn-${state.turn || 0}`;
}

function overrideActive(state, key) {
  const o = state.override;
  if (!o) return false;
  return o.scope === 'session' || o.turn === key;
}

// ---------------------------------------------------------------- 工具文案

const SKIP_KEYS = new Set([
  'id', 'ids', 'command', 'path', 'file_path', 'filepath', 'url', 'action', 'status', 'type', 'preview',
  'code', 'pattern', 'regex', 'name', 'tool', 'taskId', 'task_id', 'owner', 'blockedBy', 'blocks', 'multiSelect',
]);

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out, depth + 1));
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) collectStrings(v, out, depth + 1);
  }
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
}

/** 取出工具调用里面向用户的文案，合并成一段文本 */
export function toolText(toolName, input) {
  return toolFields(toolName, input).join('\n');
}

/**
 * 判定工具文案。任务项、按钮这类短文案通常是不带虚词的祈使句（"Run the tests" 之外更常见的是
 * "Run node --version"），句段规则抓不到，所以再按字段数一次：
 * 不含汉字且至少有 2 个普通英文词的字段算英文字段，含汉字的算中文字段。
 * 英文字段不少于 minEnglishFields 个、并且多于中文字段时，也判为违规。
 */
export function analyzeTool(toolName, input, th = DEFAULTS.tool) {
  const fields = toolFields(toolName, input);
  const m = analyze(fields.join('\n'), th);
  let enFields = 0;
  let zhFields = 0;
  for (const f of fields) {
    const prose = stripNonProse(f);
    if (CJK.test(prose)) zhFields++;
    else if (englishRuns(prose).flat().length >= 2) enFields++;
    CJK.lastIndex = 0;
  }
  const byFields = enFields >= (th.minEnglishFields ?? 2) && enFields > zhFields;
  return { ...m, violation: m.violation || byFields, enFields, zhFields };
}

function toolFields(toolName, input) {
  const i = input && typeof input === 'object' ? input : {};
  const parts = [];
  const push = (...vs) => vs.forEach((v) => typeof v === 'string' && v && parts.push(v));
  if (toolName === 'AskUserQuestion') {
    for (const q of parseMaybeJson(i.questions) || []) {
      push(q?.question, q?.header);
      for (const o of q?.options || []) push(o?.label, o?.description);
    }
  } else if (toolName === 'TodoWrite') {
    for (const t of parseMaybeJson(i.todos) || []) push(t?.content, t?.activeForm);
  } else if (/(?:^|__)wrap_up$/.test(toolName)) {
    push(i.recap, i.ask);
    for (const a of parseMaybeJson(i.actions) || []) push(a?.label, a?.message);
  } else if (/(?:^|__)update_plan$/.test(toolName)) {
    for (const it of parseMaybeJson(i.items) || []) push(it?.content);
  } else {
    collectStrings(i, parts);
  }
  return parts;
}

// ---------------------------------------------------------------- transcript

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 丢掉被截断的第一行
    return { text: text.replace(/^﻿/, ''), whole: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 跳过写了一半的行
    }
  }
  return out;
}

function isUserTurn(e) {
  if (e?.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !c.some((b) => b?.type === 'tool_result');
  return false;
}

/** 读取 transcript 尾部，直到包含本轮开头为止。返回本轮的条目。 */
export function readTurnEntries(file) {
  for (const bytes of [1 << 20, 8 << 20, 64 << 20, Infinity]) {
    const { text, whole } = readTail(file, bytes === Infinity ? Number.MAX_SAFE_INTEGER : bytes);
    const entries = parseLines(text);
    let start = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (isUserTurn(entries[i])) {
        start = i;
        break;
      }
    }
    if (start >= 0 || whole) return entries.slice(start + 1).filter((e) => !e.isSidechain);
  }
  return [];
}

/** 把本轮内容分成最终回复和进度播报。最后一次工具调用之后的文字是最终回复。 */
export function splitTurn(entries, { checkThinkingUpdates = true } = {}) {
  const progress = [];
  let final = [];
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    for (const b of e.message?.content || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        progress.push(...final);
        final = [];
      } else if (b.type === 'text' && b.text?.trim()) {
        final.push(b.text);
      } else if (b.type === 'thinking' && checkThinkingUpdates && e.thinkingDisplay === 'updates' && b.thinking?.trim()) {
        // 思考过程以 updates 方式显示时，界面上就是进度播报
        progress.push(b.thinking);
      }
    }
  }
  return { final, progress };
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// transcript 里本轮的最终回复是否已经包含 last_assistant_message
export function hasFinal(entries, lastMessage) {
  const want = norm(lastMessage);
  if (!want) return true;
  const { final } = splitTurn(entries, { checkThinkingUpdates: false });
  const got = norm(final.join('\n'));
  return got.length > 0 && (got === want || got.endsWith(want) || want.endsWith(got));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 汇总本轮英文段落。lastMessage 为 Stop 输入的 last_assistant_message。 */
export function findHits({ entries, lastMessage, cfg }) {
  const hits = [];
  const seen = new Set();
  const add = (kind, text) => {
    const h = head(text);
    if (h && !seen.has(h)) {
      seen.add(h);
      hits.push({ kind, head: h, ...analyze(text, kind === 'progress' ? progressTh(text, cfg) : cfg.reply) });
    }
  };
  const { final, progress } = splitTurn(entries || [], cfg);
  if (cfg.checkProgress) {
    for (const t of progress) if (analyze(t, progressTh(t, cfg)).violation) add('progress', t);
  }
  for (const t of final) if (analyze(t, cfg.reply).violation) add('reply', t);
  // transcript 里还没有最终回复时，用 last_assistant_message 补上
  if (lastMessage && !hasFinal(entries || [], lastMessage) && analyze(lastMessage, cfg.reply).violation) {
    add('reply', lastMessage);
  }
  return hits;
}

function progressTh(text, cfg) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.length >= 2 ? cfg.progress : cfg.progressSingleLine;
}

// ---------------------------------------------------------------- 事件处理

function projectDirOf(input, env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || '';
}

/** 处理一次 Hook 调用，返回要写到 stdout 的对象；放行时返回 null。 */
export function handle(input, env = process.env) {
  if (!input || typeof input !== 'object') return null;
  const projectDir = projectDirOf(input, env);
  const cfg = loadConfig(projectDir, env);
  const event = input.hook_event_name;
  if (!cfg.enabled) return null;
  const lang = languageSetting(projectDir, env);
  if (lang === 'other') {
    debugLog(cfg, env, { event, decision: 'pass', why: 'language-setting-other' });
    return null; // 用户在官方设置里选了别的语言
  }

  if (event === 'SessionStart') {
    if (!cfg.injectRules || lang === 'chinese') return null;
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RULES } };
  }

  const sessionId = input.session_id;
  const state = readState(sessionId, env);

  if (event === 'UserPromptSubmit') {
    state.turn = (state.turn || 0) + 1;
    const key = turnKey(input, state);
    const intent = detectIntent(input.prompt);
    if (intent.kind === 'other') state.override = { scope: intent.scope, turn: key };
    else if (intent.kind === 'restore') delete state.override;
    else if (state.override?.scope === 'turn') delete state.override;
    writeState(sessionId, state, env);
    debugLog(cfg, env, { event, intent });
    return null;
  }

  const key = turnKey(input, state);
  if (overrideActive(state, key)) {
    debugLog(cfg, env, { event, decision: 'pass', why: 'user-language-override' });
    return null;
  }

  if (event === 'PreToolUse') {
    const tool = String(input.tool_name || '');
    if (!toolMatches(tool, cfg.tools)) return null;
    const m = analyzeTool(tool, input.tool_input, cfg.tool);
    debugLog(cfg, env, { event, tool, ...m });
    if (!m.violation) return null;
    const denies = (state.denies = state.denies?.turn === key ? state.denies : { turn: key, count: {} });
    if ((denies.count[tool] || 0) >= cfg.maxToolDenies) return null; // 防循环
    denies.count[tool] = (denies.count[tool] || 0) + 1;
    writeState(sessionId, state, env);
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: toolReason(tool) },
    };
  }

  if (event === 'Stop') {
    if (input.stop_hook_active) return null; // 本轮已经阻断过一次
    if (input.prompt_id && state.stopBlocked === input.prompt_id) return null;
    const lastMessage = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    const started = Date.now();
    let entries = [];
    if (input.transcript_path) {
      try {
        entries = readTurnEntries(input.transcript_path);
        // transcript 可能还没写入最终回复；last_assistant_message 已经违规时不必等
        if (!analyze(lastMessage, cfg.reply).violation) {
          const deadline = started + Number(cfg.waitSeconds || 0) * 1000;
          while (!hasFinal(entries, lastMessage) && Date.now() < deadline) {
            sleep(100);
            entries = readTurnEntries(input.transcript_path);
          }
        }
      } catch {
        entries = [];
      }
    }
    const hits = findHits({ entries, lastMessage, cfg });
    debugLog(cfg, env, {
      event,
      decision: hits.length ? 'block' : 'pass',
      waitedMs: Date.now() - started,
      hits: hits.map(({ kind, E, C, R }) => ({ kind, E, C, R })),
    });
    if (!hits.length) return null;
    if (input.prompt_id) {
      state.stopBlocked = input.prompt_id;
      writeState(sessionId, state, env);
    }
    const reason = stopReason(hits);
    if (cfg.stopMode === 'context') return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } };
    return { decision: 'block', reason };
  }

  return null;
}

// ---------------------------------------------------------------- 命令行

function checkTranscript(file) {
  const cfg = loadConfig(process.cwd());
  const entries = readTurnEntries(file);
  const { final, progress } = splitTurn(entries, cfg);
  const rows = [
    ...progress.map((t) => ({ kind: '进度播报', text: t, th: progressTh(t, cfg) })),
    ...final.map((t) => ({ kind: '最终回复', text: t, th: cfg.reply })),
  ];
  if (!rows.length) {
    console.log('最后一轮没有可检查的文字。');
    return;
  }
  for (const r of rows) {
    const m = analyze(r.text, r.th);
    const verdict = m.violation && (r.kind === '最终回复' || cfg.checkProgress) ? '违规' : '通过';
    console.log(`[${verdict}] ${r.kind}  E=${m.E} C=${m.C} R=${m.R}  ${head(r.text)}`);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    if (!args[1]) {
      console.log('用法：node zh-reply-guard.mjs --check <transcript.jsonl>');
      return;
    }
    checkTranscript(args[1]);
    return;
  }
  let out = null;
  try {
    const raw = await readStdin();
    out = raw.trim() ? handle(JSON.parse(raw)) : null;
  } catch {
    out = null; // 任何异常都放行
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

const invokedDirectly = (() => {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const arg = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
    return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().finally(() => {
    process.exitCode = 0;
  });
}
