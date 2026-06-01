import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { creditScoreService } from '../services/creditScoreService.js'

function requireTenant(req: Request): asserts req is AuthenticatedRequest {
  const user = (req as AuthenticatedRequest).user
  if (!user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  if (user.role !== 'tenant') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Tenant role required')
  }
}

function requireAdmin(req: Request): asserts req is AuthenticatedRequest {
  const user = (req as AuthenticatedRequest).user
  if (!user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  if (user.role !== 'admin' && user.role !== 'super_admin') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Admin role required')
  }
}

function serializeSnapshot(snapshot: Awaited<ReturnType<typeof creditScoreService.getLatestSnapshot>>) {
  if (!snapshot) return null
  return {
    id: snapshot.id,
    score: snapshot.score,
    band: snapshot.band,
    factors: snapshot.factors,
    computedAt: snapshot.computedAt.toISOString(),
  }
}

export function createCreditScoreRouter(): Router {
  const router = Router()

  router.get('/my', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireTenant(req)
      const snapshot = await creditScoreService.getLatestSnapshot(req.user.id)
      if (!snapshot) {
        throw new AppError(ErrorCode.NO_SCORE_YET, 404, 'No credit score snapshot available yet')
      }

      res.json({
        ...serializeSnapshot(snapshot),
        tips: creditScoreService.generateImprovementTips(snapshot).slice(0, 3),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/my/history', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireTenant(req)
      const history = await creditScoreService.getHistory(req.user.id)

      res.json({
        snapshots: history.map((snapshot) => ({
          id: snapshot.id,
          score: snapshot.score,
          band: snapshot.band,
          computedAt: snapshot.computedAt.toISOString(),
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

export function createAdminCreditScoreRouter(): Router {
  const router = Router()

  router.get('/credit-score/:tenantId', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireAdmin(req)
      const { tenantId } = req.params
      if (!tenantId) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'tenantId is required')
      }

      const snapshot = await creditScoreService.getLatestSnapshot(tenantId)
      if (!snapshot) {
        throw new AppError(ErrorCode.NO_SCORE_YET, 404, 'No credit score snapshot available yet')
      }

      res.json({
        id: snapshot.id,
        tenantId,
        score: snapshot.score,
        band: snapshot.band,
        factors: snapshot.factors,
        computedAt: snapshot.computedAt.toISOString(),
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}