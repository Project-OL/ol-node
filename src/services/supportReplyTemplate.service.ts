import { AppError } from '../middlewares/errorHandler'
import { supportReplyTemplateRepository } from '../repositories/supportReplyTemplate.repository'
import { auditService } from './audit.service'
import type { AdminAuditRequestMeta } from '../utils/admin-audit'

interface AdminActor {
  id: string
  role: string
  request?: AdminAuditRequestMeta
}

async function findTemplateOrThrow(templateId: string) {
  const template = await supportReplyTemplateRepository.findById(templateId)
  if (!template) {
    throw new AppError(404, 'Reply template not found', 'REPLY_TEMPLATE_NOT_FOUND')
  }
  return template
}

export const supportReplyTemplateService = {
  async list() {
    const templates = await supportReplyTemplateRepository.list()
    return { templates }
  },

  async create(actor: AdminActor, input: { title: string; content: string }) {
    const template = await supportReplyTemplateRepository.create({
      title: input.title.trim(),
      content: input.content.trim(),
      createdByAdminId: actor.id,
    })
    auditService.logAdmin({
      adminUserId: actor.id,
      actionType: 'ADMIN_SUPPORT_REPLY_TEMPLATE_CREATE',
      actionStatus: 'success',
      actionDetails: { templateId: template.id, title: template.title },
      destination: `Reply template ${template.title}`,
      request: actor.request,
    })
    return template
  },

  async update(actor: AdminActor, templateId: string, input: { title?: string; content?: string }) {
    await findTemplateOrThrow(templateId)
    const template = await supportReplyTemplateRepository.update(templateId, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.content !== undefined ? { content: input.content.trim() } : {}),
    })
    auditService.logAdmin({
      adminUserId: actor.id,
      actionType: 'ADMIN_SUPPORT_REPLY_TEMPLATE_UPDATE',
      actionStatus: 'success',
      actionDetails: { templateId },
      destination: `Reply template ${template.title}`,
      request: actor.request,
    })
    return template
  },

  async remove(actor: AdminActor, templateId: string) {
    const existing = await findTemplateOrThrow(templateId)
    await supportReplyTemplateRepository.remove(templateId)
    auditService.logAdmin({
      adminUserId: actor.id,
      actionType: 'ADMIN_SUPPORT_REPLY_TEMPLATE_DELETE',
      actionStatus: 'success',
      actionDetails: { templateId },
      destination: `Reply template ${existing.title}`,
      request: actor.request,
    })
    return { ok: true as const, id: templateId }
  },
}
