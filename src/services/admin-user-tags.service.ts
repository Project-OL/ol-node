import { AppError } from '../middlewares/errorHandler'
import { normalizeAdminTags } from '../models/admin-user-tags.schemas'
import { userRepository } from '../repositories/user.repository'
import { meService } from './me.service'

export const adminUserTagsService = {
  async setTags(
    targetUserId: string,
    tags: string[],
  ): Promise<{ userId: string; adminTags: string[] }> {
    const user = await userRepository.findById(targetUserId)
    if (!user) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const adminTags = normalizeAdminTags(tags)
    const updated = await userRepository.setAdminTags(targetUserId, adminTags)
    await meService.invalidateUserCaches(targetUserId)

    return { userId: updated.id, adminTags: updated.adminTags }
  },
}
