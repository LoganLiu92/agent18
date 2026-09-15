import { describe, it, expect } from 'vitest';
import { Agent18 } from '@agent18/web-sdk';
describe.skipIf(process.env.AGENT18_INTEGRATION !== '1')('live Compose headless workflow', () => {
  it('goes from signed customer identity to durable Case, Worker result, citations and audit', async () => {
    const identity = await fetch('http://localhost:4319/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'aurora' }),
    }).then((r) => r.json());
    const sdk = new Agent18({
      baseUrl: 'http://localhost:4318',
      projectKey: identity.projectKey,
      getToken: async () => identity.token,
    });
    sdk.setContext({
      pageUrl: 'https://invoice.example/invoices?token=must-not-store#private',
      entityType: 'invoice',
      entityId: 'DEMO-018',
    });
    const key = crypto.randomUUID();
    const report = {
      title: '发票提交失败',
      description: '演示验收：填写信息并提交发票后，页面提示提交失败。预期能完成提交。请支持团队进一步排查。',
    };
    const created = await sdk.reportCase(report, key);
    expect((await sdk.reportCase(report, key)).case.id).toBe(created.case.id);
    let detail = await sdk.getCase(created.case.id);
    const deadline = Date.now() + 15000;
    while (detail.runs[0]?.state !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      detail = await sdk.getCase(created.case.id);
    }
    expect(detail.runs[0]?.state).toBe('completed');
    expect(detail.runs).toHaveLength(1);
    expect(detail.case.status).toBe('needs_human');
    expect(detail.evidence.length).toBeGreaterThan(0);
    expect(detail.audit.some((event) => event.reason === 'EVIDENCE_VALIDATED')).toBe(true);
    expect(detail.case.context.pagePath).toBe('/invoices');
    expect(JSON.stringify(detail)).not.toContain('must-not-store');
    sdk.destroy();
  });
});
