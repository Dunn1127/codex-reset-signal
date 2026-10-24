import { describe, expect, it, vi } from 'vitest';
import { createSmtpTarget, smtpSettings } from './smtp-monitor.mjs';
import { loadConfig } from '../src/config';

const settings = { sender: 'sender@163.com', recipient: 'recipient@163.com', python: 'python3' };
const item = { key: 'event-1', post: { id: '1', text: '<script>reset</script>', createdAt: null, url: 'https://x.com/thsottiaux/status/1', media: [] }, events: [], targets: [], delivered: [] };
describe('163 SMTP notification target', () => {
  it('requires a credential and rejects header injection or multiple recipients', () => {
    expect(() => smtpSettings({ EMAIL_TO: 'a@163.com' })).toThrow('SMTP_PASSWORD');
    expect(() => smtpSettings({ EMAIL_TO: 'a@163.com\nBcc:b@example.com', SMTP_PASSWORD: 'secret' })).toThrow();
    expect(() => smtpSettings({ EMAIL_TO: 'a@163.com,b@163.com', SMTP_PASSWORD: 'secret' })).toThrow();
    expect(smtpSettings({ EMAIL_TO: 'a@163.com', SMTP_PASSWORD: 'secret' }).sender).toBe('a@163.com');
  });
  it('passes escaped content through stdin and hashes recipient identity', async () => {
    const execute = vi.fn().mockReturnValue({ status: 0 });
    const target = createSmtpTarget(settings, loadConfig({}), execute);
    await target.send(item);
    await target.send(item);
    const payload = JSON.parse(execute.mock.calls[0][2].input);
    expect(payload.recipient).toBe(settings.recipient);
    expect(payload.html).not.toContain('<script>');
    expect(payload.messageId).toBe(JSON.parse(execute.mock.calls[1][2].input).messageId);
    expect(target.id).not.toContain(settings.recipient);
    expect(execute.mock.calls[0][2].shell).toBeUndefined();
  });
  it('keeps failed deliveries pending without leaking SMTP errors', async () => {
    const execute = vi.fn().mockReturnValue({ status: 1, stderr: 'secret credential' });
    await expect(createSmtpTarget(settings, loadConfig({}), execute).send(item)).rejects.toThrow('SMTP delivery failed');
  });
  it('labels test mail and does not treat it as a reset event', async () => {
    const execute = vi.fn().mockReturnValue({ status: 0 });
    await createSmtpTarget(settings, loadConfig({}), execute).test();
    const payload = JSON.parse(execute.mock.calls[0][2].input);
    expect(payload.subject).toContain('测试');
    expect(payload.text).toContain('不代表发生了额度重置');
  });
});
