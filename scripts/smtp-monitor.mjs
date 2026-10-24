import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.ts';
import { createTargets } from '../src/notifications.ts';
import { DateTime } from 'luxon';
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
    if (event.time?.note && event.time.kind !== 'observed') lines.push(`时间说明：${event.time.note}`);
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
  const state = await runMonitor(config, { targets: [...createTargets(config), smtp] });
  console.log(`Checked @${state.username}: ${state.lastRunStatus}; ${state.outbox?.length || 0} pending.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'SMTP monitor failed');
    process.exitCode = 1;
  });
}
