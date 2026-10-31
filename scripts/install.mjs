#!/usr/bin/env node
// 不使用插件时的手动安装 / 卸载。
//
//   node scripts/install.mjs              安装到用户目录（~/.claude，或 CLAUDE_CONFIG_DIR）
//   node scripts/install.mjs --project    安装到当前目录的 .claude/
//   node scripts/install.mjs --uninstall  卸载（可与 --project 同用）
//
// 只增删本工具自己的 Hook 条目，其他设置和 Hook 原样保留；修改前备份 settings.json。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'zh-reply-guard.mjs';
const PLUGIN_PATH = '${CLAUDE_PLUGIN_ROOT}/hooks/zh-reply-guard.mjs';

const args = new Set(process.argv.slice(2));
const project = args.has('--project');
const uninstall = args.has('--uninstall');

const baseDir = project
  ? path.join(process.cwd(), '.claude')
  : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = path.join(baseDir, 'settings.json');
const scriptTarget = path.join(baseDir, 'hooks', SCRIPT);
// settings 里引用脚本的路径：项目级用占位符，便于提交到仓库；用户级用绝对路径（统一为 /）
const scriptRef = project ? '${CLAUDE_PROJECT_DIR}/.claude/hooks/zh-reply-guard.mjs' : scriptTarget.replace(/\\/g, '/');

const isOurs = (h) => [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].some((s) => typeof s === 'string' && s.includes(SCRIPT));

function readSettings() {
  if (!fs.existsSync(settingsFile)) return {};
  const raw = fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return {};
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  } catch {
    // 落到下面的报错
  }
  console.error(`错误：${settingsFile} 不是有效的 JSON 对象，未做任何修改。请先修好这个文件再重试。`);
  process.exit(1);
}

function removeOurs(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((group) => {
      if (!Array.isArray(group?.hooks)) return true;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isOurs(h));
      return group.hooks.length > 0 || before === 0;
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function ourHooks() {
  const template = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8')).hooks;
  return JSON.parse(JSON.stringify(template).split(PLUGIN_PATH).join(scriptRef.replace(/"/g, '\\"')));
}

function writeSettings(settings) {
  fs.mkdirSync(baseDir, { recursive: true });
  if (fs.existsSync(settingsFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(settingsFile, `${settingsFile}.bak-zh-reply-guard-${stamp}`);
  }
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

const settings = readSettings();
removeOurs(settings);

if (uninstall) {
  writeSettings(settings);
  fs.rmSync(scriptTarget, { force: true });
  console.log(`已卸载：从 ${settingsFile} 移除了 zh-reply-guard 的 Hook，并删除了 ${scriptTarget}。`);
} else {
  fs.mkdirSync(path.dirname(scriptTarget), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'hooks', SCRIPT), scriptTarget);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, groups] of Object.entries(ourHooks())) {
    settings.hooks[event] = [...(Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []), ...groups];
  }
  writeSettings(settings);
  console.log(`已安装：脚本在 ${scriptTarget}，Hook 已写入 ${settingsFile}。`);
  console.log('新开的会话才会加载 Hook。');
}
