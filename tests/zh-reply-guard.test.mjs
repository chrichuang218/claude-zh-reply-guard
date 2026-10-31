// 运行：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  detectIntent,
  handle,
  isChineseLanguage,
  splitTurn,
  toolText,
  DEFAULTS,
} from '../hooks/zh-reply-guard.mjs';

const HOOK = fileURLToPath(new URL('../hooks/zh-reply-guard.mjs', import.meta.url));

// 每个测试用独立的配置目录、项目目录和状态目录，不受本机真实设置影响
function sandbox({ userSettings, projectSettings, guardConfig } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zrg-test-'));
  const configDir = path.join(root, 'config');
  const project = path.join(root, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  if (userSettings) fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(userSettings));
  if (projectSettings) fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify(projectSettings));
  if (guardConfig) fs.writeFileSync(path.join(configDir, 'zh-reply-guard.json'), JSON.stringify(guardConfig));
  const env = { CLAUDE_CONFIG_DIR: configDir, ZH_REPLY_GUARD_STATE_DIR: path.join(root, 'state') };
  let n = 0;
  const call = (input) => handle({ session_id: 's1', cwd: project, ...input }, env);
  const transcript = (entries) => {
    const f = path.join(root, `t${n++}.jsonl`);
    fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return f;
  };
  return { root, project, env, call, transcript };
}

// ---------------------------------------------------------------- 样本

const EN_LONG = [
  'I have fixed the issue in the parser. The problem was that the tokenizer did not handle escaped quotes, so the state machine got stuck in the string state.',
  'I added a regression test for this case, and all of the tests pass now. Let me know if you want me to open a pull request for it.',
].join(' ');
const EN_LONG_2 =
  'The build is failing because the lockfile is out of date. You should run the install command again and then commit the updated lockfile, otherwise the CI job will keep rejecting the change.';
const EN_PROGRESS =
  'Now I will look at how the config loader works.\nThen I need to check whether the tests cover the empty file case before I change anything.';

const ZH = {
  plain: '我已经修好了解析器的问题。原因是分词器没有处理转义引号，状态机卡在了字符串状态。我补了一个回归测试，现在全部测试都通过了。',
  tech: '问题出在 React 的 useEffect 依赖数组上：API 返回的 token 没有及时刷新，所以 Hook 每次都拿到旧值。改成 useCallback 包一层，再把 fetchUser 放进依赖里就好了。',
  codeBlock:
    '改好了，用下面的命令运行：\n```bash\n# This script will build the project and then run all of the tests in watch mode for you\nnpm run build && npm test -- --watch\n```\n```\nError: The module could not be found in any of the directories that were searched by the resolver\n```\n运行后应该能看到全部通过。',
  pathsAndCommands:
    '配置在 C:\\Users\\someone\\.claude\\settings.json 和 ~/.claude/settings.json 里。运行 `claude plugin install zh-reply-guard@zh-reply-guard --scope user` 安装，然后用 `/hooks` 检查。\n$ node hooks/zh-reply-guard.mjs --check ./session.jsonl\n文档见 https://code.claude.com/docs/en/hooks 。',
  quote:
    '官方文档是这样写的：\n> Stop does not run if the stoppage occurred due to a user interrupt, and API errors fire the StopFailure event instead of this one.\n也就是说用户按 Esc 中断时不会触发。',
  link: '参考 [How to write a hook that blocks the model from stopping when the task is not done](https://example.com/a/b) 这篇文章，里面讲得比较清楚。',
  techArticle:
    '## 为什么 Stop Hook 需要防循环\n\nStop Hook 返回 block 之后，Claude 会继续工作。如果判断条件永远无法满足，就会一直循环。官方提供了 `stop_hook_active` 字段，在 Hook 已经让 Claude 继续过一次时为 true。\n\n> If the hook keeps blocking, Claude Code overrides the next block after eight consecutive continuations and ends the turn.\n\n所以实现时检查这个字段即可，不需要自己维护复杂的计数器。',
};

// ---------------------------------------------------------------- 语言检测

test('完整中文回复：放行', () => {
  assert.equal(analyze(ZH.plain).violation, false);
});

test('大段英文解释：违规', () => {
  const m = analyze(EN_LONG);
  assert.equal(m.violation, true);
  assert.ok(m.E >= 30 && m.R === 1);
  assert.equal(analyze(EN_LONG_2).violation, true);
});

test('中文夹杂技术英文：放行', () => {
  assert.equal(analyze(ZH.tech).violation, false);
});

test('中文解释 + 英文代码块（含未闭合代码块）：放行', () => {
  assert.equal(analyze(ZH.codeBlock).violation, false);
  assert.equal(analyze(`下面是脚本：\n\`\`\`\n${EN_LONG}\n`).violation, false);
});

test('中文解释 + 英文命令、路径、URL：放行', () => {
  assert.equal(analyze(ZH.pathsAndCommands).violation, false);
});

test('中文 + 英文引用块、英文标题的链接、技术文章：放行', () => {
  assert.equal(analyze(ZH.quote).violation, false);
  assert.equal(analyze(ZH.link).violation, false);
  assert.equal(analyze(ZH.techArticle).violation, false);
});

test('很短的英文回复：放行', () => {
  assert.equal(analyze('Done. All tests pass.').violation, false);
  assert.equal(analyze('OK, I will do that now.').violation, false);
});

test('日文回复：放行（只拦英文）', () => {
  const ja = '解析器の問題を修正しました。原因はトークナイザーがエスケープされた引用符を処理していなかったことです。回帰テストを追加し、すべてのテストが通りました。';
  assert.equal(analyze(ja).violation, false);
});

test('没有虚词的英文词串不算句子', () => {
  const list = 'Fixed parser tokenizer escaping regression tests lockfile build pipeline config loader cache invalidation handling retries timeouts logging metrics';
  assert.equal(analyze(list).E, 0);
});

test('阈值边界：词数刚好低于 / 达到阈值', () => {
  const th = { minSentenceWords: 6, minEnglishWords: 20, minEnglishRatio: 0.5 };
  const words = (n) => Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 'the' : i % 4 === 1 ? 'file' : i % 4 === 2 ? 'is' : 'ready')).join(' ');
  assert.equal(analyze(words(19), th).violation, false);
  assert.equal(analyze(words(20), th).violation, true);
});

test('阈值边界：英文占比低于 / 高于阈值', () => {
  const th = { minSentenceWords: 6, minEnglishWords: 10, minEnglishRatio: 0.5 };
  const en = 'the file is ready and the tests are all passing now';
  assert.equal(analyze(en, th).E, 11);
  // 11 个词；汉字 24 个折算 12 个词 → R < 0.5
  assert.equal(analyze(`${en}。${'中'.repeat(24)}`, th).violation, false);
  // 汉字 20 个折算 10 个词 → R > 0.5
  assert.equal(analyze(`${en}。${'中'.repeat(20)}`, th).violation, true);
});

test('空内容和异常输入：不违规', () => {
  for (const v of ['', null, undefined, '   ', '```\n```']) assert.equal(analyze(v).violation, false);
});

// ---------------------------------------------------------------- 用户语言意图

test('识别明确的语言要求', () => {
  const turn = [
    '用英文回答我',
    '请改用日语写这段说明',
    '帮我写一个英文 README',
    '出一个英文版的文案',
    '把这段翻译成英文',
    '帮我写提交信息',
    '生成这个 PR 的描述',
    'Please answer in English.',
    'Can you translate this paragraph into English?',
    'English please',
  ];
  for (const p of turn) assert.deepEqual(detectIntent(p), { kind: 'other', scope: 'turn' }, p);
  for (const p of ['从现在起都用英文回复', '以后一直用英文', 'Reply in English from now on']) {
    assert.deepEqual(detectIntent(p), { kind: 'other', scope: 'session' }, p);
  }
});

test('否定、抱怨和只是提到英文：不算语言要求', () => {
  for (const p of ['不要用英文回复', '别再用英文了', '你怎么又用英文了', '为什么用英文回答', '这个英文文档讲了什么', '解释一下这段代码', '看看这个提交信息有什么问题']) {
    assert.equal(detectIntent(p).kind, null, p);
  }
});

test('粘贴内容和代码里的 English 不算语言要求', () => {
  const p = '这段代码为什么报错？\n```js\n// reply in English when the user asks\nconst lang = "English";\n```';
  assert.equal(detectIntent(p).kind, null);
  assert.equal(detectIntent('看看这段：\n> Please answer in English.\n是什么意思').kind, null);
});

test('恢复中文', () => {
  assert.equal(detectIntent('改回中文吧').kind, 'restore');
  assert.equal(detectIntent('用中文解释一下').kind, 'restore');
});

// ---------------------------------------------------------------- 官方 language 设置

test('language 的各种中文写法都识别为中文', () => {
  for (const v of ['Chinese', 'chinese', ' 简体中文 ', '中文', 'zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'Simplified Chinese', '繁體中文']) {
    assert.equal(isChineseLanguage(v), true, v);
  }
  for (const v of ['english', 'Japanese', 'ja', '', null]) assert.equal(isChineseLanguage(v), false, String(v));
});

test('SessionStart：未设置 language 时注入，设为中文时不注入，compact 后重新注入', () => {
  const a = sandbox();
  for (const source of ['startup', 'compact']) {
    const out = a.call({ hook_event_name: 'SessionStart', source });
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /简体中文/);
  }
  const b = sandbox({ userSettings: { language: 'Chinese' } });
  assert.equal(b.call({ hook_event_name: 'SessionStart', source: 'startup' }), null);
});

test('language 设为其他语言：整个守卫停用', () => {
  const s = sandbox({ projectSettings: { language: 'english' } });
  assert.equal(s.call({ hook_event_name: 'SessionStart', source: 'startup' }), null);
  assert.equal(s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG }), null);
});

test('项目 language 优先于用户 language', () => {
  const s = sandbox({ userSettings: { language: 'english' }, projectSettings: { language: '简体中文' } });
  assert.ok(s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG }));
});

// ---------------------------------------------------------------- Stop

test('Stop：英文回复阻断，原因是中文并列出段落首行', () => {
  const s = sandbox();
  const out = s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /简体中文/);
  assert.match(out.reason, /I have fixed the issue/);
});

test('Stop：中文回复静默放行', () => {
  const s = sandbox();
  for (const msg of Object.values(ZH)) assert.equal(s.call({ hook_event_name: 'Stop', last_assistant_message: msg }), null);
});

test('Stop：stop_hook_active 时放行，避免无限重试', () => {
  const s = sandbox();
  assert.equal(s.call({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: EN_LONG }), null);
});

test('Stop：同一 prompt_id 只阻断一次', () => {
  const s = sandbox();
  assert.ok(s.call({ hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: EN_LONG }));
  assert.equal(s.call({ hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: EN_LONG_2 }), null);
  assert.ok(s.call({ hook_event_name: 'Stop', prompt_id: 'p2', last_assistant_message: EN_LONG }));
});

test('Stop：context 模式输出 additionalContext', () => {
  const s = sandbox({ guardConfig: { stopMode: 'context' } });
  const out = s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG });
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, /简体中文/);
});

// transcript 条目的写法与当前 Claude Code 一致：每个内容块一条 assistant 记录
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (name = 'Bash') => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input: {} }] } });
const think = (thinking, display = 'updates') => ({ type: 'assistant', thinkingDisplay: display, message: { role: 'assistant', content: [{ type: 'thinking', thinking }] } });

test('splitTurn：最后一次工具调用之后是最终回复，之前是进度播报', () => {
  const { final, progress } = splitTurn([say('先看看'), tool(), toolResult(), say('再改'), tool(), toolResult(), say('完成了'), say('补充')]);
  assert.deepEqual(progress, ['先看看', '再改']);
  assert.deepEqual(final, ['完成了', '补充']);
});

test('Stop：中文最终回复 + 多行英文进度播报 → 阻断并只列出进度播报', () => {
  const s = sandbox();
  const t = s.transcript([user('修一下'), say(EN_PROGRESS), tool(), toolResult(), say(ZH.plain)]);
  const out = s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: ZH.plain });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /进度播报：Now I will look/);
  assert.doesNotMatch(out.reason, /我已经修好/);
});

test('Stop：一行英文前置说明不拦', () => {
  const s = sandbox();
  const t = s.transcript([user('修一下'), say('Let me check the config loader first and see what it does.'), tool(), toolResult(), say(ZH.plain)]);
  assert.equal(s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: ZH.plain }), null);
});

test('Stop：只检查本轮，上一轮的英文不算', () => {
  const s = sandbox();
  const t = s.transcript([user('上一轮'), say(EN_LONG), user('这一轮'), say(ZH.plain)]);
  assert.equal(s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: ZH.plain }), null);
});

test('Stop：updates 方式显示的英文思考按进度播报判定，其他方式不检查', () => {
  const s = sandbox();
  const t1 = s.transcript([user('修一下'), think(EN_PROGRESS), tool(), toolResult(), say(ZH.plain)]);
  assert.ok(s.call({ hook_event_name: 'Stop', transcript_path: t1, last_assistant_message: ZH.plain }));
  const s2 = sandbox();
  const t2 = s2.transcript([user('修一下'), think(EN_PROGRESS, null), tool(), toolResult(), say(ZH.plain)]);
  assert.equal(s2.call({ hook_event_name: 'Stop', transcript_path: t2, last_assistant_message: ZH.plain }), null);
});

test('Stop：checkProgress 关闭时不检查进度播报', () => {
  const s = sandbox({ guardConfig: { checkProgress: false } });
  const t = s.transcript([user('修一下'), say(EN_PROGRESS), tool(), toolResult(), say(ZH.plain)]);
  assert.equal(s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: ZH.plain }), null);
});

test('Stop：transcript 未写入最终回复且 last_assistant_message 为英文 → 立即阻断', () => {
  const s = sandbox({ guardConfig: { waitSeconds: 3 } });
  const t = s.transcript([user('修一下'), tool(), toolResult()]);
  const started = Date.now();
  const out = s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: EN_LONG });
  assert.equal(out.decision, 'block');
  assert.ok(Date.now() - started < 1000, '不应等待');
});

test('Stop：transcript 未写入且 last_assistant_message 为中文 → 最多等待 waitSeconds', () => {
  const s = sandbox({ guardConfig: { waitSeconds: 0.3 } });
  const t = s.transcript([user('修一下'), tool(), toolResult()]);
  const started = Date.now();
  assert.equal(s.call({ hook_event_name: 'Stop', transcript_path: t, last_assistant_message: ZH.plain }), null);
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 2000, `waited ${waited}ms`);
});

test('Stop：transcript 不存在或格式异常 → 只用 last_assistant_message 判定', () => {
  const s = sandbox();
  const missing = path.join(s.root, 'nope.jsonl');
  assert.ok(s.call({ hook_event_name: 'Stop', transcript_path: missing, last_assistant_message: EN_LONG }));
  const bad = path.join(s.root, 'bad.jsonl');
  fs.writeFileSync(bad, '{not json\n\u0000\u0001garbage\n');
  assert.equal(s.call({ hook_event_name: 'Stop', transcript_path: bad, last_assistant_message: ZH.plain }), null);
});

test('Stop：transcript 带 BOM 和 CRLF', () => {
  const s = sandbox();
  const f = path.join(s.root, 'crlf.jsonl');
  fs.writeFileSync(f, '\uFEFF' + [user('修一下'), say(EN_PROGRESS), tool(), toolResult(), say(ZH.plain)].map((e) => JSON.stringify(e)).join('\r\n'));
  assert.ok(s.call({ hook_event_name: 'Stop', transcript_path: f, last_assistant_message: ZH.plain }));
});

// ---------------------------------------------------------------- 用户豁免

test('用户要求英文：本轮放行，下一轮恢复检测', () => {
  const s = sandbox();
  s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: '用英文回答：什么是事件循环？' });
  assert.equal(s.call({ hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: EN_LONG }), null);
  s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: '那 Promise 呢？' });
  assert.ok(s.call({ hook_event_name: 'Stop', prompt_id: 'p2', last_assistant_message: EN_LONG }));
});

test('用户要求以后都用英文：整个会话放行，改回中文后恢复', () => {
  const s = sandbox();
  s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: '从现在起都用英文回复' });
  s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: '继续' });
  assert.equal(s.call({ hook_event_name: 'Stop', prompt_id: 'p2', last_assistant_message: EN_LONG }), null);
  s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p3', prompt: '改回中文吧' });
  assert.ok(s.call({ hook_event_name: 'Stop', prompt_id: 'p3', last_assistant_message: EN_LONG }));
});

test('英文 README、翻译、PR 描述、提交信息：本轮放行', () => {
  for (const prompt of ['帮我写一个英文 README', '把下面这段翻译成英文', '帮我生成这个 PR 的描述', '写一下提交信息']) {
    const s = sandbox();
    s.call({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt });
    assert.equal(s.call({ hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: EN_LONG }), null, prompt);
  }
});

test('没有 prompt_id 时以 UserPromptSubmit 为界', () => {
  const s = sandbox();
  s.call({ hook_event_name: 'UserPromptSubmit', prompt: 'answer in English please' });
  assert.equal(s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG }), null);
  s.call({ hook_event_name: 'UserPromptSubmit', prompt: '下一个问题' });
  assert.ok(s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG }));
});

// ---------------------------------------------------------------- PreToolUse

const askEn = {
  questions: [
    {
      question: 'Which approach should we use for the cache layer?',
      header: 'Cache',
      multiSelect: false,
      options: [
        { label: 'In-memory LRU', description: 'Fast and simple, but it is lost when the process restarts.' },
        { label: 'Redis', description: 'Shared between instances and survives restarts.' },
      ],
    },
  ],
};
const askZh = {
  questions: [
    {
      question: '缓存层用哪种方案？',
      header: '缓存',
      multiSelect: false,
      options: [
        { label: '内存 LRU', description: '快且简单，但进程重启就没了。' },
        { label: 'Redis', description: '多实例共享，重启后还在。' },
      ],
    },
  ],
};

test('PreToolUse：英文问题卡被拒绝，原因为中文', () => {
  const s = sandbox();
  const out = s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: askEn });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /简体中文/);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
});

test('PreToolUse：中文问题卡放行', () => {
  const s = sandbox();
  assert.equal(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: askZh }), null);
});

test('PreToolUse：同一轮同一工具第二次放行，新一轮再次拒绝', () => {
  const s = sandbox();
  const ask = (prompt_id) => s.call({ hook_event_name: 'PreToolUse', prompt_id, tool_name: 'AskUserQuestion', tool_input: askEn });
  assert.ok(ask('p1'));
  assert.equal(ask('p1'), null);
  assert.ok(ask('p2'));
});

test('PreToolUse：桌面端 wrap_up（actions 为 JSON 字符串）与 update_plan', () => {
  const s = sandbox();
  const wrap = {
    recap: 'The parser bug is fixed and all of the tests pass. Nothing has been committed yet.',
    ask: 'Should I commit this change now?',
    actions: JSON.stringify([{ label: 'Yes, commit' }, { label: 'Not now' }]),
  };
  const out = s.call({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: wrap });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const plan = { items: [{ content: 'Look at how the config loader is set up', status: 'in_progress' }, { content: 'Write the tests for the empty file case', status: 'pending' }] };
  assert.ok(s.call({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ccd_turn__update_plan', tool_input: plan }));
  assert.equal(s.call({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ccd_turn__update_plan', tool_input: { advance: true } }), null);
});

test('PreToolUse：未列入 tools 的工具不检查', () => {
  const s = sandbox();
  assert.equal(s.call({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'README.md', content: EN_LONG } }), null);
  assert.equal(s.call({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi', description: EN_LONG } }), null);
});

test('toolText：只取文案字段', () => {
  assert.doesNotMatch(toolText('AskUserQuestion', { questions: [{ question: '选哪个？', options: [{ label: 'A', preview: EN_LONG }] }] }), /fixed/);
  assert.match(toolText('TodoWrite', { todos: [{ content: '写测试', activeForm: '正在写测试', status: 'pending' }] }), /写测试/);
  assert.equal(toolText('TaskUpdate', { taskId: '3', status: 'completed' }), '');
});

// ---------------------------------------------------------------- 开关与异常

test('ZH_REPLY_GUARD=off：全部放行', () => {
  const s = sandbox();
  const env = { ...s.env, ZH_REPLY_GUARD: 'off' };
  assert.equal(handle({ hook_event_name: 'Stop', session_id: 's', cwd: s.project, last_assistant_message: EN_LONG }, env), null);
  assert.equal(handle({ hook_event_name: 'SessionStart', session_id: 's', cwd: s.project }, env), null);
});

test('配置文件 enabled: false：全部放行', () => {
  const s = sandbox({ guardConfig: { enabled: false } });
  assert.equal(s.call({ hook_event_name: 'Stop', last_assistant_message: EN_LONG }), null);
});

test('状态目录不可写：静默放行或正常判定，不抛异常', () => {
  const s = sandbox();
  const blocker = path.join(s.root, 'file-not-dir');
  fs.writeFileSync(blocker, 'x');
  const env = { ...s.env, ZH_REPLY_GUARD_STATE_DIR: path.join(blocker, 'state') };
  assert.doesNotThrow(() => handle({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: s.project, prompt: '你好' }, env));
  assert.doesNotThrow(() => handle({ hook_event_name: 'PreToolUse', session_id: 's', cwd: s.project, tool_name: 'AskUserQuestion', tool_input: askEn }, env));
});

test('未知事件和缺失字段：放行', () => {
  const s = sandbox();
  assert.equal(s.call({ hook_event_name: 'Notification' }), null);
  assert.equal(s.call({ hook_event_name: 'Stop' }), null);
  assert.equal(s.call({ hook_event_name: 'PreToolUse' }), null);
  assert.equal(handle(null), null);
});

test('默认阈值配置完整', () => {
  for (const g of ['reply', 'progress', 'progressSingleLine', 'tool']) {
    assert.ok(DEFAULTS[g].minSentenceWords > 0 && DEFAULTS[g].minEnglishWords > 0 && DEFAULTS[g].minEnglishRatio > 0);
  }
});

// ---------------------------------------------------------------- 端到端（子进程）

function run(stdin, extraEnv = {}) {
  const s = sandbox();
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, env: { ...process.env, ...s.env, ...extraEnv }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, s };
}

test('子进程：英文回复输出合法的阻断 JSON，退出码 0', () => {
  const { code, stdout, stderr } = run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e', last_assistant_message: EN_LONG }));
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
});

test('子进程：中文回复无任何输出', () => {
  const { code, stdout, stderr } = run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e', last_assistant_message: ZH.plain }));
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('子进程：非法 JSON、空输入、带 BOM 的输入都安全处理', () => {
  for (const input of ['{not json', '', '   ', '[]', 'null']) {
    const { code, stdout, stderr } = run(input);
    assert.equal(code, 0, input);
    assert.equal(stdout, '', input);
    assert.equal(stderr, '', input);
  }
  const bom = run('\uFEFF' + JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e', last_assistant_message: EN_LONG }));
  assert.equal(JSON.parse(bom.stdout).decision, 'block');
});

test('子进程：调试日志只记录统计数值，不记录原文', () => {
  const { s } = run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'e2e', last_assistant_message: EN_LONG }), { ZH_REPLY_GUARD_DEBUG: '1' });
  const log = fs.readFileSync(path.join(s.env.ZH_REPLY_GUARD_STATE_DIR, 'debug.log'), 'utf8');
  assert.match(log, /"decision":"block"/);
  assert.doesNotMatch(log, /fixed the issue/);
});

test('子进程：--check 输出最后一轮的判定', () => {
  const s = sandbox();
  const t = s.transcript([user('修一下'), say(EN_PROGRESS), tool(), toolResult(), say(ZH.plain)]);
  const r = spawnSync(process.execPath, [HOOK, '--check', t], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[违规\] 进度播报/);
  assert.match(r.stdout, /\[通过\] 最终回复/);
});

// ---------------------------------------------------------------- 安装脚本

const INSTALL = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));

function install(configDir, ...flags) {
  return spawnSync(process.execPath, [INSTALL, ...flags], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, cwd: configDir, encoding: 'utf8' });
}

test('install.mjs：保留已有设置和其他 Hook，重复安装不产生重复条目，卸载只删自己的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zrg-install-'));
  const other = { type: 'command', command: 'echo other' };
  const original = { theme: 'dark', hooks: { Stop: [{ hooks: [other] }], PostToolUse: [{ matcher: 'Write', hooks: [other] }] } };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(original));

  assert.equal(install(dir).status, 0);
  assert.equal(install(dir).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark');
  const ours = (groups) => groups.flatMap((g) => g.hooks).filter((h) => (h.args || []).join(' ').includes('zh-reply-guard.mjs'));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) assert.equal(ours(s.hooks[ev]).length, 1, ev);
  assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo other')));
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'zh-reply-guard.mjs')));
  const ref = ours(s.hooks.Stop)[0].args[0];
  assert.ok(!ref.includes('${') && !ref.includes(String.fromCharCode(92)), ref);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bak-zh-reply-guard-')));

  assert.equal(install(dir, '--uninstall').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), original);
  assert.ok(!fs.existsSync(path.join(dir, 'hooks', 'zh-reply-guard.mjs')));
});

test('install.mjs：settings.json 不是有效 JSON 时不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zrg-install-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "theme": "dark", ');
  const r = install(dir);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ "theme": "dark", ');
});

test('install.mjs --project：写入项目 .claude/settings.json 并使用 ${CLAUDE_PROJECT_DIR}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zrg-install-'));
  assert.equal(install(dir, '--project').status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.Stop[0].hooks[0].args[0], '${CLAUDE_PROJECT_DIR}/.claude/hooks/zh-reply-guard.mjs');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'hooks', 'zh-reply-guard.mjs')));
});

// ---------------------------------------------------------------- 短文案（桌面端实测中发现的漏拦）

test('PreToolUse：不带虚词的英文任务项也能拦下（按字段判定）', () => {
  const s = sandbox();
  const plan = { items: [{ content: 'Run node --version', status: 'in_progress' }, { content: 'Ask test option preference', status: 'pending' }, { content: 'Summarize results', status: 'pending' }], scope: 'first_task' };
  assert.ok(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'mcp__ccd_turn__update_plan', tool_input: plan }));
  const todos = { todos: [{ content: 'Fix parser bug', activeForm: 'Fixing parser bug', status: 'in_progress' }, { content: 'Add regression test', activeForm: 'Adding regression test', status: 'pending' }] };
  assert.ok(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'TodoWrite', tool_input: todos }));
});

test('PreToolUse：中文任务项里夹技术词、中文问题配英文产品名选项，都放行', () => {
  const s = sandbox();
  const plan = { items: [{ content: '运行 node --version', status: 'in_progress' }, { content: '修改 README 和 CHANGELOG', status: 'pending' }, { content: '用 Redis Cluster 做缓存', status: 'pending' }] };
  assert.equal(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'mcp__ccd_turn__update_plan', tool_input: plan }), null);
  const ask = { questions: [{ question: '缓存层用哪种方案？', header: '缓存', options: [{ label: 'Redis Cluster' }, { label: 'Postgres' }, { label: 'In-memory LRU' }] }] };
  assert.equal(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'AskUserQuestion', tool_input: ask }), null);
  const wrap = { recap: '解析器的问题修好了，测试全部通过，还没有提交。', ask: '现在提交吗？', actions: [{ label: '提交' }, { label: 'Not now' }] };
  assert.equal(s.call({ hook_event_name: 'PreToolUse', prompt_id: 'p1', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: wrap }), null);
});
