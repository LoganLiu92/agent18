import type { OperatorRole } from './service.js';

// Project capabilities only. Tenant-scoped ticket access must add an explicit tenant grant.
export const permissionRoles = {
  'project.read': ['viewer', 'support', 'engineer', 'knowledge_editor', 'knowledge_publisher'],
  'knowledge.read': ['viewer', 'support', 'engineer', 'knowledge_editor', 'knowledge_publisher'],
  'knowledge.edit': ['knowledge_editor'],
  'knowledge.review': ['knowledge_publisher'],
  'knowledge.publish': ['knowledge_publisher'],
  'source.read': ['engineer', 'knowledge_editor', 'knowledge_publisher'],
  'source.configure': [],
  'ticket.read': ['support', 'engineer'],
  'ticket.edit': ['support', 'engineer'],
  'operations.read': ['engineer'],
  'evidence.internal.read': ['engineer', 'knowledge_editor', 'knowledge_publisher'],
} satisfies Record<string, OperatorRole[]>;
export type OperatorPermission = keyof typeof permissionRoles;
