import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { metrics, type ObservableResult } from '@opentelemetry/api';
import { PrismaService } from '@shared/database/prisma.service';

export type DependencyStatus = 'up' | 'down';
export type HealthReport = Record<'postgres' | 'redis', DependencyStatus>;

// The only part of the Redis client the check needs, so tests can fake it.
export interface RedisPinger {
  ping(): Promise<string>;
}

export const HEALTH_REDIS = Symbol('HEALTH_REDIS');

// A dependency that hangs counts as down. Prometheus scrapes every 15s, so
// the check has to answer well inside that.
export const DEPENDENCY_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService implements OnModuleInit {
  constructor(
    private readonly prismaService: PrismaService,
    @Inject(HEALTH_REDIS) private readonly redis: RedisPinger,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.prismaService.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
    ]);
    return { postgres, redis };
  }

  async observeDependencies(result: ObservableResult): Promise<void> {
    const report = await this.check();
    for (const [dependency, status] of Object.entries(report)) {
      result.observe(status === 'up' ? 1 : 0, { dependency });
    }
  }

  // Checked on every scrape, which is what the "dependency down" alert in
  // docker/grafana/provisioning/alerting/ fires on.
  onModuleInit() {
    metrics
      .getMeter('finwise-api')
      .createObservableGauge('finwise_dependency_up', {
        description: 'Whether a dependency answers (1) or not (0)',
      })
      .addCallback((result) => this.observeDependencies(result));
  }
}

async function probe(call: () => Promise<unknown>): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('dependency check timed out')),
      DEPENDENCY_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([call(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
