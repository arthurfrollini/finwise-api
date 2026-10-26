import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { bullRootOptions } from '@shared/config/bullmq';
import { HealthController } from './health.controller';
import { HEALTH_REDIS, HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_REDIS,
      // Its own connection, separate from BullMQ's. A ping sent while Redis
      // is unreachable waits in the offline queue, and HealthService's
      // timeout turns that wait into "down".
      useFactory: () =>
        new Redis({
          ...bullRootOptions().connection,
          maxRetriesPerRequest: 1,
        }),
    },
  ],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(HEALTH_REDIS) private readonly redis: Redis) {}

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
