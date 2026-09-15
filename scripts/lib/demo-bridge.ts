/** The local demo writes only the synthetic user's notification preference. */
export function demoBridge(docker = false) {
  return {
    url: docker ? 'http://identity-demo:4319/agent18/bridge' : 'http://127.0.0.1:4319/agent18/bridge',
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
}
