import { describe, expect, it, vi } from 'vitest';
import { createSmtpTarget, smtpSettings, renderBeijingEmail, expectedTime, contextualBatch } from './smtp-monitor.mjs';
import { extractEvents } from '../src/events';
import { loadConfig } from '../src/config';
import { runMonitor, postVersion } from '../src/monitor';
import { emptyState } from '../src/state';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settings = { sender: 'sender@163.com', recipient: 'recipient@163.com', python: 'python3' };
const item = { key: 'event-1', post: { id: '1', text: '<script>reset</script>', createdAt: null, url: 'https://x.com/thsottiaux/status/1', media: [] }, events: [], targets: [], delivered: [] };
const root = { id: '2114200152701575656', canonicalId: '2114200152701575656', text: 'Day 20/ Rest and reset', createdAt: '2026-10-25T03:39:31Z', url: 'https://x.com/thsottiaux/status/2114200152701575656', media: [] };
const timing = { id: '2114200291319124163', canonicalId: '2114200291319124163', text: 'By midnight PST', createdAt: '2026-10-25T03:40:04Z', url: 'https://x.com/thsottiaux/status/2114200291319124163', media: [] };
const done = { id: '2114237083652882932', canonicalId: '2114237083652882932', text: 'It is all propagated. Enjoy some mad codexing tomorrow. Fun week ahead too.', createdAt: '2026-10-25T06:06:16Z', url: 'https://x.com/thsottiaux/status/2114237083652882932', media: [] };
const asRaw = post => ({ ...post, type: 'status', author: { id: '123' }, created_at: post.createdAt });
const rawRoot = asRaw(root);
const rawTiming = { ...asRaw(timing), replying_to: { screen_name: 'thsottiaux', status: root.id } };
const contextOptions = { userId: '123', username: 'thsottiaux' };
describe('real split reset announcements', () => {
  it('includes new uncertain reset messages only when enabled and labels the email clearly', async () => {
    const post = { ...root, text: '@larsencc @bot Not enough resets' };
    const batch = contextualBatch([post], [asRaw(post)], { ...contextOptions, includeMentions: true }, 'America/Los_Angeles');
    const events = batch.classify(post);
    expect(events[0].type).toBe('mention');
    expect(renderBeijingEmail({ post, events }).text).toContain('未确认，不代表已重置');
    const execute = vi.fn().mockReturnValue({ status: 0 });
    await createSmtpTarget(settings, loadConfig({}), execute).send({ ...item, post, events });
    expect(JSON.parse(execute.mock.calls[0][2].input).subject).toContain('【未确认】');
    expect(contextualBatch([post], [asRaw(post)], contextOptions).classify(post)).toEqual([]);
  });
  it('recognizes the Oct 26 daily reset announcement and ignores unrelated posts', () => {
    const post = { ...root, text: 'Day 21/ Wonder what happens the remaining seven days. But today is a reset.' };
    const batch = contextualBatch([post], [asRaw(post)], { ...contextOptions, includeMentions: true });
    expect(batch.classify(post)[0].type).toBe('reset');
    const unrelated = { ...root, text: 'Reminder you can customize the appearance of chatgpt on web' };
    expect(batch.classify(unrelated)).toEqual([]);
  });
  it('keeps live and recovery identities identical even when live posts include media', () => {
    const raw = [rawRoot, rawTiming, asRaw(done)];
    const options = { ...contextOptions, now: Date.parse('2026-10-25T08:00:00Z') };
    const live = contextualBatch([{ ...done, media: [{ type: 'photo', url: 'https://example.com/photo.jpg' }] }], raw, options);
    const replay = contextualBatch([], raw, options);
    expect(postVersion(live.posts.find(post => post.id === done.id))).toBe(postVersion(replay.posts.find(post => post.id === done.id)));
  });
  it('recovers an old skipped completion once and does not email it on every poll', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-reset-recovery-'));
    try {
      const config = loadConfig({ STATE_PATH: join(dir, 'state.json') });
      await writeFile(config.statePath, JSON.stringify({ ...emptyState('thsottiaux', 'reset'), sinceId: done.id, userId: '123' }));
      const batch = contextualBatch([], [rawRoot, rawTiming, asRaw(done)], { ...contextOptions, now: Date.parse('2026-10-25T08:00:00Z') }, 'America/Los_Angeles');
      const target = { id: 'smtp:test', channel: 'email', send: vi.fn().mockResolvedValue(undefined) };
      const dependencies = { targets: [target], classifyEvents: batch.classify, source: { resolveUserId: async () => '123', getPosts: async () => ({ posts: batch.posts, newestId: done.id }) } };
      await runMonitor(config, dependencies);
      await runMonitor(config, dependencies);
      expect(target.send).toHaveBeenCalledTimes(1);
      expect(target.send.mock.calls[0][0].events[0].status).toBe('completed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('recognizes the daily shorthand and joins a self-reply deadline in Beijing time', () => {
    const batch = contextualBatch([root, timing], [rawTiming, rawRoot], contextOptions, 'America/Los_Angeles');
    const combined = batch.posts.find(post => post.id === root.id);
    const events = batch.classify(combined);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('scheduled');
    expect(expectedTime(events[0])).toContain('2026-10-25 16:00 前');
    expect(events[0].time.note).toContain(timing.url);
    expect(batch.classify(timing)).toEqual([]);
  });
  it('revisits an already seen parent for a new timing reply, with a stable delivery identity', () => {
    const a = contextualBatch([timing], [rawRoot, rawTiming], contextOptions, 'America/Los_Angeles');
    const b = contextualBatch([timing], [rawTiming, rawRoot], contextOptions, 'America/Los_Angeles');
    expect(a.posts.find(post => post.id === root.id).canonicalId).toBe(b.posts.find(post => post.id === root.id).canonicalId);
  });
  it('recognizes the contextual completion without interpreting tomorrow as the reset time', () => {
    const batch = contextualBatch([done], [rawRoot, rawTiming, asRaw(done)], contextOptions, 'America/Los_Angeles');
    const events = batch.classify(done);
    expect(events[0].status).toBe('completed');
    expect(events[0].time.kind).toBe('observed');
    expect(events[0].time.note).toContain(root.url);
    expect(renderBeijingEmail({ post: done, events }).text).toContain('2026-10-25 14:06');
    expect(expectedTime(events[0])).toContain('未明确');
  });
  it('rejects unrelated propagation, other authors, stale context and negated shorthand', () => {
    expect(contextualBatch([done], [asRaw(done)], contextOptions).classify(done)).toEqual([]);
    expect(contextualBatch([done], [{ ...rawRoot, author: { id: 'other' } }, asRaw(done)], contextOptions).classify(done)).toEqual([]);
    expect(contextualBatch([done], [{ ...rawRoot, created_at: '2026-10-20T03:39:31Z' }, asRaw(done)], contextOptions).classify(done)).toEqual([]);
    const negative = { ...root, text: 'Day 20/ No reset today' };
    expect(contextualBatch([negative], [asRaw(negative)], contextOptions).classify(negative)).toEqual([]);
  });
});
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
