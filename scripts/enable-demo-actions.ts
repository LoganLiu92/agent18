import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDirectory } from './config.js';
for (const file of ['server.json', 'server.docker.json']) {
  const path = resolve(localDirectory, file),
    config = JSON.parse(await readFile(path, 'utf8'));
  const project = config.projects.find((p: { key: string }) => p.key === 'invoice-demo');
  if (!project) throw new Error('Demo project not found');
  project.allowedOrigins = [...new Set([...(project.allowedOrigins ?? []), 'http://localhost:4319'])];
  project.businessBridge = {
    url: file.includes('docker')
      ? 'http://identity-demo:4319/agent18/bridge'
      : 'http://127.0.0.1:4319/agent18/bridge',
    actions: [
      {
        id: 'profile.notifications.update',
        title: '修改我的通知偏好',
        description: '设置当前登录用户自己的邮件通知偏好。示例业务只保存偏好，不发送邮件。',
        roles: ['tenant-admin'],
        enabled: true,
        fields: [{ name: 'emailNotifications', label: '邮件通知', type: 'boolean', required: true }],
      },
    ],
  };
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
console.log('Demo action registered. Restart server and identity-demo to apply.');
