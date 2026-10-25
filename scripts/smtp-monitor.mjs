import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.ts';
import { createTargets } from '../src/notifications.ts';
import { DateTime } from 'luxon';
import { extractEvents, parseEventTime } from '../src/events.ts';
import { FxEmbedClient } from '../src/fxembed-client.ts';
import { runMonitor } from '../src/monitor.ts';

// Use the runner's Python standard library for SMTP; no additional npm package.
export const smtpPython = `
import json, os, smtplib, ssl, sys
from email.message import EmailMessage
from email.utils import formatdate
data = json.load(sys.stdin)
message = EmailMessage()
message['From'] = data['sender']
message['To'] = data['recipient']
message['Subject'] = data['subject']
message['Date'] = formatdate(localtime=False)
message['Message-ID'] = data['messageId']
message.set_content(data['text'])
if data.get('html'):
    message.add_alternative(data['html'], subtype='html')
client = None
try:
    client = smtplib.SMTP_SSL('smtp.163.com', 465, timeout=20, context=ssl.create_default_context())
    client.login(data['sender'], os.environ['SMTP_PASSWORD'])
    refused = client.send_message(message)
    if refused:
        raise RuntimeError('Recipient rejected')
except Exception as error:
    code = getattr(error, 'smtp_code', None)
    print('SMTP failed: ' + type(error).__name__ + (' HTTP-like code ' + str(code) if code else ''), file=sys.stderr)
    sys.exit(1)
finally:
    if client:
        client.close()
`;

export function smtpSettings(env = process.env) {
  const recipient = (env.EMAIL_TO || '').trim();
  const sender = (env.SMTP_USER || recipient).trim();
  const mailbox = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!mailbox.test(recipient) || !mailbox.test(sender) || !sender.endsWith('@163.com'))
    throw new Error('Configure one EMAIL_TO address and a valid 163 SMTP_USER.');
  if (!env.SMTP_PASSWORD?.trim()) throw new Error('SMTP_PASSWORD secret is missing.');
  return { recipient, sender, python: env.PYTHON_EXECUTABLE || 'python3' };
}

const beijing = value => {
  const date = DateTime.fromISO(value || '', { setZone: true }).setZone('Asia/Shanghai');
  return date.isValid ? date.toFormat('yyyy-MM-dd HH:mm') : null;
};

// Source-specific shorthand rules apply only to the configured announcement author.
function announcementEvents(post, zone) {
  const events = extractEvents(post, zone).filter(event => event.type !== 'mention');
  if (!events.length && /^Day\s+\d+\s*\//i.test(post.text) && /\breset\b/i.test(post.text)
      && !/\?|\b(?:not|never|no|maybe|might|could|would|hope|wish|if|without)\b/i.test(post.text)) {
    return [{ type: 'reset', status: 'announced', evidence: post.text,
      time: { kind: 'unknown', start: null, end: null, evidence: post.text,
        note: '同作者每日公告中的简短重置声明；尚未给出明确到账时间' } }];
  }
  return events;
}

function followupTime(post, zone) {
  const midnight = post.text.trim().match(/^by midnight\s+(PST|PDT|PT)[.!]?$/i);
  if (!midnight) return parseEventTime(post.text, post.createdAt, zone);
  const token = midnight[1].toUpperCase();
  const sourceZone = token === 'PST' ? 'UTC-8' : token === 'PDT' ? 'UTC-7' : 'America/Los_Angeles';
  const ref = DateTime.fromISO(post.createdAt || '', { setZone: true }).setZone(sourceZone);
  if (!ref.isValid) return { kind: 'unknown', start: null, end: null, evidence: post.text };
  return { kind: 'exact', start: ref.startOf('day').plus({ days: 1 }).toUTC().toISO(), end: null,
    evidence: post.text, note: `${token} 按 ${sourceZone} 换算为当地当日午夜截止时间；不保证实际到账时刻` };
}

export function contextualBatch(posts, rawResults, options, zone) {
  const own = new Map();
  for (const raw of rawResults) {
    if (raw.type !== 'status' || String(raw.author?.id) !== options.userId || raw.reposted_by != null) continue;
    const text = raw.raw_text?.text ?? raw.text;
    const date = new Date(typeof raw.created_timestamp === 'number' ? raw.created_timestamp * 1000 : raw.created_at);
    if (typeof text !== 'string' || !date.getTime() || !/^\d+$/.test(String(raw.id))) continue;
    own.set(String(raw.id), { id: String(raw.id), canonicalId: String(raw.id), text, createdAt: date.toISOString(),
      url: `https://x.com/${options.username}/status/${raw.id}`, media: [], reply: raw.replying_to });
  }
  const result = new Map(posts.map(post => [post.id, post]));
  const events = new Map();
  // Direct self-replies supply timing, anchored to the reply's publication time.
  for (const reply of own.values()) {
    const parent = own.get(String(reply.reply?.status));
    if (!parent || reply.reply?.screen_name?.toLowerCase() !== options.username.toLowerCase()) continue;
    if (!result.has(parent.id) && !result.has(reply.id)) continue;
    const age = Date.parse(reply.createdAt) - Date.parse(parent.createdAt);
    const base = announcementEvents(parent, zone).filter(event => event.type === 'reset');
    if (age < 0 || age > 72 * 3600000 || !base.length || !/^(?:by|before|in|within|lands?|landing|eta|expected|scheduled)\b/i.test(reply.text.trim())) continue;
    const time = followupTime(reply, zone);
    if (time.kind === 'unknown') continue;
    const combined = { ...(result.get(parent.id) || parent), canonicalId: `${parent.id}:timing:${reply.id}`, media: [], createdAt: new Date(parent.createdAt).toISOString() };
    const prior = result.get(parent.id);
    if (prior?.contextTime && Date.parse(prior.contextTime) >= Date.parse(reply.createdAt)) continue;
    combined.contextTime = reply.createdAt;
    result.set(parent.id, combined);
    events.set(combined.canonicalId, base.map(event => ({ ...event, status: 'scheduled', time: {
      ...time, note: [time.note, `时间补充原文：${reply.url}`].filter(Boolean).join('；') } })));
  }
  // A standalone completion is accepted only with Codex wording and a recent
  // same-author reset announcement. This contextual relationship is disclosed.
  // Recover recent completion posts skipped by the old keyword-only parser.
  // The versioned identity is stable, so recovery runs notify at most once.
  const completions = new Map(posts.map(post => [post.id, post]));
  for (const post of own.values()) {
    const age = (options.now ?? Date.now()) - Date.parse(post.createdAt);
    if (age >= 0 && age <= 24 * 3600000) completions.set(post.id, result.get(post.id) || post);
  }
  for (const post of completions.values()) {
    if (!/^It is all propagated\b/i.test(post.text.trim()) || !/\bcodex(?:ing)?\b/i.test(post.text)) continue;
    const parents = [...own.values()].filter(candidate => candidate.id !== post.id && !candidate.reply
      && Date.parse(post.createdAt) - Date.parse(candidate.createdAt) >= 0
      && Date.parse(post.createdAt) - Date.parse(candidate.createdAt) <= 24 * 3600000
      && announcementEvents(candidate, zone).some(event => event.type === 'reset'))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (!parents.length) continue;
    const recovered = { ...post, canonicalId: `${post.id}:reset-context-v1`, media: [], createdAt: new Date(post.createdAt).toISOString() };
    result.set(post.id, recovered);
    const completionEvents = [{ type: 'reset', status: 'completed', evidence: post.text,
      time: { kind: 'observed', start: post.createdAt, end: null, evidence: post.text,
        note: `语境关联同作者最近的重置公告：${parents[0].url}；完成声明时间不是账号实际到账时间` } }];
    events.set(recovered.canonicalId, completionEvents);
    events.set(post.canonicalId || post.id, completionEvents);
  }
  return { posts: [...result.values()], classify: post => events.get(post.canonicalId || post.id) || announcementEvents(post, zone) };
}

function contextSource(config) {
  const raw = [];
  let classify = post => announcementEvents(post, config.sourceTimezone);
  const client = new FxEmbedClient(async (url, options) => {
    const response = await fetch(url, options);
    if (response.ok) {
      const body = await response.clone().json();
      if (Array.isArray(body.results)) raw.push(...body.results);
    }
    return response;
  });
  return { source: {
    resolveUserId: username => client.resolveUserId(username),
    async getPosts(options) {
      raw.length = 0;
      const batch = await client.getPosts(options);
      const contextual = contextualBatch(batch.posts, raw, options, config.sourceTimezone);
      classify = contextual.classify;
      return { ...batch, posts: contextual.posts };
    },
  }, classifyEvents: post => classify(post) };
}
export function expectedTime(event) {
  const time = event.time || {};
  const start = beijing(time.start), end = beijing(time.end);
  const label = event.type === 'bank_expiry' ? '预计到期' : event.type === 'bank_credit' ? '预计发放' : '预计更新／重置';
  if (time.kind === 'observed' || !start || time.kind === 'unknown')
    return `${label}时间：未明确${event.status === 'completed' ? '；公告已宣布完成，但未给出实际到账时刻' : ''}`;
  if (time.kind === 'date')
    return `${label}日期范围（北京时间）：${start} ～ ${end || '未知'}（未指定具体时刻，结束边界不含）`;
  if (time.kind === 'window')
    return `${label}时间范围（北京时间）：${start} ～ ${end || '未知'}`;
  const deadline = /\b(?:by|before)\b/i.test(time.evidence || '') || /截止/.test(time.note || '');
  const approximate = /\b(?:around|about|approximately)\b/i.test(event.evidence + ' ' + (time.evidence || ''));
  return `${label}${deadline ? '截止时间' : '时间'}（北京时间）：${approximate ? '约 ' : ''}${start}${deadline ? ' 前（不是保证到账时刻）' : ''}`;
}
export function renderBeijingEmail(item) {
  const labels = { reset: '额度重置', bank_credit: '重置卡发放', bank_expiry: '重置卡到期', mention: '未确认讨论' };
  const lines = ['Codex 额度更新通知', '以下时间均为北京时间（UTC+8）。', ''];
  for (const event of item.events) {
    lines.push(`${labels[event.type] || '更新'}：${event.status === 'completed' ? '已宣布完成' : '公告／预告'}`, expectedTime(event));
    if (event.time?.note) lines.push(`时间说明：${event.time.note}`);
    if (event.time?.evidence) lines.push(`时间依据：${event.time.evidence}`);
    lines.push('');
  }
  if (!item.events.length) lines.push('预计更新／重置时间：未明确', '');
  lines.push(`公告发布时间（仅供参考）：${beijing(item.post.createdAt) || '未知'}`, '', '公告原文：', item.post.text, '', `原文链接：${item.post.url}`);
  const text = lines.join('\n');
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return { text, html: `<!doctype html><html><body><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.6">${escaped}</pre></body></html>` };
}

export function createSmtpTarget(settings, config, execute = spawnSync) {
  const digest = value => createHash('sha256').update(value).digest('hex');
  const send = async data => {
    const result = execute(settings.python, ['-c', smtpPython], {
      input: JSON.stringify(data), encoding: 'utf8', timeout: 35000,
      maxBuffer: 65536, windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error('SMTP delivery failed; check authorization code and SMTP access.');
  };
  return {
    id: `smtp:${digest(settings.recipient).slice(0, 24)}`,
    channel: 'email',
    async send(item) {
      await send({
        sender: settings.sender, recipient: settings.recipient,
        subject: `Codex 重置通知 · @${config.username}`,
        ...renderBeijingEmail(item),
        messageId: `<codex-reset-${digest(item.key + ':' + settings.recipient)}@163.com>`,
      });
    },
    async test() {
      await send({
        sender: settings.sender, recipient: settings.recipient,
        subject: 'Codex 重置通知：163 邮件通道测试',
        text: '这是一封配置测试邮件，不代表发生了额度重置。\n检查频率已调整为每 2 小时一次。\n\n格式示例（虚构）：\n预计更新／重置时间（北京时间）：2026-10-25 09:00\n公告发布时间（仅供参考）：2026-10-25 07:00\n\n只有公告提供了可解析的时间才会换算；范围、截止时间和不确定性会保留。',
        messageId: `<codex-reset-test-${digest(process.env.GITHUB_RUN_ID || String(Date.now()))}@163.com>`,
      });
    },
  };
}

export async function main() {
  const settings = smtpSettings();
  // SMTP supplies its own durable target, so omit the upstream Resend channel.
  const config = loadConfig({ ...process.env, EMAIL_TO: '', EMAIL_FROM: '', RESEND_API_KEY: '' });
  const errors = validateConfig(config, { offline: true });
  if (errors.length) throw new Error(errors.join('\n'));
  const smtp = createSmtpTarget(settings, config);
  if (process.argv.includes('--test-email')) {
    await smtp.test();
    console.log('SMTP server accepted the test email; confirm receipt in the inbox.');
    return;
  }
  const context = config.sourceProvider === 'fxembed' ? contextSource(config) : {};
  const state = await runMonitor(config, { ...context, targets: [...createTargets(config), smtp] });
  console.log(`Checked @${state.username}: ${state.lastRunStatus}; ${state.outbox?.length || 0} pending.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'SMTP monitor failed');
    process.exitCode = 1;
  });
}
