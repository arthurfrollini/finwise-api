import { type DeepMockProxy, mock, mockDeep } from 'jest-mock-extended';
import type { ObservableResult } from '@opentelemetry/api';
import { PrismaService } from '@shared/database/prisma.service';
import {
  DEPENDENCY_TIMEOUT_MS,
  HealthService,
  type RedisPinger,
} from './health.service';

describe('HealthService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let redis: ReturnType<typeof mock<RedisPinger>>;
  let service: HealthService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis = mock<RedisPinger>();
    redis.ping.mockResolvedValue('PONG');
    service = new HealthService(prisma, redis);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports both dependencies up when they answer', async () => {
    await expect(service.check()).resolves.toEqual({
      postgres: 'up',
      redis: 'up',
    });
  });

  it('reports postgres down when the query fails', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.check()).resolves.toEqual({
      postgres: 'down',
      redis: 'up',
    });
  });

  it('reports redis down when ping fails', async () => {
    redis.ping.mockRejectedValueOnce(new Error('stream not writeable'));

    await expect(service.check()).resolves.toEqual({
      postgres: 'up',
      redis: 'down',
    });
  });

  it('reports a dependency that hangs as down once the timeout passes', async () => {
    jest.useFakeTimers();
    // A stuck connection: the promise never settles.
    redis.ping.mockReturnValueOnce(new Promise(() => {}));

    const report = service.check();
    await jest.advanceTimersByTimeAsync(DEPENDENCY_TIMEOUT_MS);

    await expect(report).resolves.toEqual({ postgres: 'up', redis: 'down' });
  });

  it('exports each dependency as 1 (up) or 0 (down) on the gauge', async () => {
    redis.ping.mockRejectedValueOnce(new Error('down'));
    const result = mock<ObservableResult>();

    await service.observeDependencies(result);

    expect(result.observe).toHaveBeenCalledWith(1, { dependency: 'postgres' });
    expect(result.observe).toHaveBeenCalledWith(0, { dependency: 'redis' });
  });
});
