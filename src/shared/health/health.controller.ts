import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { isPublic } from '@shared/decorators/public.decorator';
import { HealthService } from './health.service';

@ApiTags('health')
@isPublic()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: '/health',
    description:
      'Whether Postgres and Redis answer. Meant for an external uptime monitor',
  })
  @ApiResponse({ status: 200, description: 'Every dependency is up' })
  @ApiResponse({ status: 503, description: 'At least one dependency is down' })
  async check(@Res({ passthrough: true }) res: Response) {
    const report = await this.healthService.check();
    const allUp = Object.values(report).every((status) => status === 'up');
    res.status(allUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
