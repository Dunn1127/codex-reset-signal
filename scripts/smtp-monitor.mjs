import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.ts';
import { createTargets, renderEmail, renderText } from '../src/notifications.ts';
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
        text: renderText(item.post, item.events, config.timezone),
        html: renderEmail(item.post, config.username, config.keyword, item.events, config.timezone),
        messageId: `<codex-reset-${digest(item.key + ':' + settings.recipient)}@163.com>`,
      });
    },
    async test() {
      await send({
        sender: settings.sender, recipient: settings.recipient,
        subject: 'Codex 重置通知：163 邮件通道测试',
        text: '这是一封部署测试邮件，不代表发生了额度重置。\n后续检测到新的重置公告或重置卡消息时，将通过此邮箱通知。时间使用北京时间。',
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
