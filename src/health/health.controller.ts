import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

/** Public readiness endpoint for infrastructure health checks. */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  /** @param healthService database readiness service. */
  constructor(private readonly healthService: HealthService) {}

  /**
   * Returns service readiness after checking PostgreSQL.
   *
   * @returns an `ok` readiness payload.
   * @throws a server error when the database cannot be reached.
   */
  @Get()
  @ApiOperation({ summary: 'Check Support API readiness' })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  check(): Promise<{ status: 'ok' }> {
    return this.healthService.check();
  }
}
