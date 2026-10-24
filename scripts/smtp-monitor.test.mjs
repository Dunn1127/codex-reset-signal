import { describe, expect, it, vi } from 'vitest';
import { createSmtpTarget, smtpSettings, renderBeijingEmail, expectedTime } from './smtp-monitor.mjs';
import { extractEvents } from '../src/events';
import { loadConfig } from '../src/config';

const settings = { sender: 'sender@163.com', recipient: 'recipient@163.com', python: 'python3' };
const item = { key: 'event-1', post: { id: '1', text: '<script>reset</script>', createdAt: null, url: 'https://x.com/thsottiaux/status/1', media: [] }, events: [], targets: [], delivered: [] };
describe('163 SMTP notification target', () => {
  it('converts the expected reset time, separately from publication', () => {
    const post = { ...item.post, createdAt: '2026-10-24T12:00:00Z', text: 'We will reset Codex limits in 2 hours.' };
    const body = renderBeijingEmail({ ...item, post, events: extractEvents(post, 'America/Los_Angeles') });
    expect(body.text).toContain('预计更新／重置时间（北京时间）：2026-10-24 22:00');
    expect(body.text).toContain('公告发布时间（仅供参考）：2026-10-24 20:00');
  });
  it('does not present completion announcement timestamps as expected arrival', () => {
    const post = { ...item.post, createdAt: '2026-10-24T12:00:00Z', text: 'I have reset usage limits for Codex.' };
    expect(renderBeijingEmail({ ...item, post, events: extractEvents(post) }).text).toContain('未给出实际到账时刻');
  });
  it('preserves deadlines, approximate times and windows', () => {
    const event = { type: 'reset', status: 'scheduled', evidence: 'reset by midnight', time: { kind: 'exact', start: '2026-10-25T07:00:00Z', evidence: 'by midnight' } };
    expect(expectedTime(event)).toContain('截止时间（北京时间）：2026-10-25 15:00 前');
    expect(expectedTime({ ...event, evidence: 'reset around 6pm', time: { ...event.time, evidence: 'around 6pm' } })).toContain('约 ');
    expect(expectedTime({ ...event, time: { kind: 'window', start: '2026-10-24T12:00:00Z', end: '2026-10-24T14:00:00Z' } })).toContain('20:00 ～ 2026-10-24 22:00');
  });
  it('handles Pacific summer and winter time with date rollover', () => {
    for (const [createdAt, expected] of [['2026-07-01T12:00:00Z', '2026-07-02 09:00'], ['2026-12-01T12:00:00Z', '2026-12-02 10:00']]) {
      const post = { ...item.post, createdAt, text: 'We will reset Codex at 6pm PT today.' };
      expect(renderBeijingEmail({ ...item, post, events: extractEvents(post, 'America/Los_Angeles') }).text).toContain(expected);
    }
  });
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
