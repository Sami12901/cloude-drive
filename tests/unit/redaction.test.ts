import { describe, expect, it } from 'vitest';
import { findLeakedSecrets, redactArgs, redactText, redactValue } from '@shared/redaction.js';

describe('redaction', () => {
  it('removes OAuth tokens and JSON token blobs', () => {
    const token =
      '{"access_token":"ya29.SECRETVALUE","token_type":"Bearer","refresh_token":"1//0eFRESH","expiry":"2030-01-01T00:00:00Z"}';
    const redacted = redactText(`token received: ${token}`);
    expect(redacted).not.toContain('ya29.SECRETVALUE');
    expect(redacted).not.toContain('1//0eFRESH');
  });

  it('removes bearer headers, ini secrets and CLI secrets', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactText('password = hunter2')).not.toContain('hunter2');
    expect(redactText('client_secret = s3cr3t-value')).not.toContain('s3cr3t-value');
    expect(redactText('rclone --password hunter2 copy')).not.toContain('hunter2');
    expect(redactText('RCLONE_CONFIG_PASS=super-secret')).not.toContain('super-secret');
  });

  it('removes credentials embedded in URLs and AWS keys', () => {
    expect(redactText('https://user:hunter2@example.com/dav/')).not.toContain('hunter2');
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts nested object values and masks suspicious keys', () => {
    const value = redactValue(
      { remote: 'gdrive', token: 'abc123secret', nested: { password: 'pw', ok: 'visible' } },
      { extraSecrets: ['abc123secret'] },
    ) as unknown as { token: string; nested: { password: string; ok: string } };
    expect(value.token).toBe('[REDACTED]');
    expect(value.nested.password).toBe('[REDACTED]');
    expect(value.nested.ok).toBe('visible');
  });

  it('reports leaked secrets so tests can assert on log safety', () => {
    const secrets = ['super-secret-1', 'another'];
    expect(findLeakedSecrets('value super-secret-1 here', secrets)).toEqual(['super-secret-1']);
    expect(findLeakedSecrets('nothing to see', secrets)).toEqual([]);
  });

  it('replaces the home directory when asked', () => {
    expect(redactText('/home/alice/CloudSSD/cache', { homeDir: '/home/alice' })).toBe('~/CloudSSD/cache');
  });
});

describe('redactArgs (subprocess argument arrays)', () => {
  it('removes provider tokens passed as rclone config arguments', () => {
    const rendered = redactArgs([
      'config',
      'create',
      'gdrive',
      'drive',
      'token={"access_token":"ya29.LEAK-VALUE","refresh_token":"1//0gSECRET"}',
      'client_id=123.apps.googleusercontent.com',
    ]);
    expect(rendered).not.toContain('ya29.LEAK-VALUE');
    expect(rendered).not.toContain('1//0gSECRET');
    expect(rendered).toContain('config create gdrive drive');
    expect(rendered).toContain('client_id=123.apps.googleusercontent.com');
  });

  it('removes the value that follows a sensitive flag', () => {
    expect(redactArgs(['--rc-pass', 'sup3rs3cret'])).not.toContain('sup3rs3cret');
    expect(redactArgs(['--rc-pass', 'sup3rs3cret'])).toContain('--rc-pass');
  });

  it('keeps ordinary arguments readable so problems can still be diagnosed', () => {
    const rendered = redactArgs(['lsjson', 'gdrive:CloudSSD', '--fast-list']);
    expect(rendered).toBe('lsjson gdrive:CloudSSD --fast-list');
  });
});
