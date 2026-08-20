import { env } from '../config/env'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

export const companyAgencyService = {
  configuredUserId(): string | null {
    const id = env.COMPANY_AGENCY_USER_ID?.trim()
    return id || null
  },

  async requireCompanyAgencyUserId(): Promise<string> {
    const id = this.configuredUserId()
    if (!id) {
      throw new AppError(
        400,
        'COMPANY_AGENCY_USER_ID is not configured',
        'COMPANY_AGENCY_NOT_CONFIGURED',
      )
    }
    const user = await prismaRead.user.findUnique({
      where: { id },
      select: { id: true, isAgent: true, status: true },
    })
    if (!user || user.status === 'deleted') {
      throw new AppError(400, 'Company agency user was not found', 'COMPANY_AGENCY_NOT_FOUND')
    }
    if (!user.isAgent) {
      throw new AppError(
        400,
        'Company agency user must be an agency agent',
        'COMPANY_AGENCY_NOT_AGENT',
      )
    }
    return user.id
  },

  isCompanyAgencyUser(userId: string | null | undefined): boolean {
    const configured = this.configuredUserId()
    return Boolean(configured && userId && configured === userId)
  },
}
