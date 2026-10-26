import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { createApp } from '../helpers/create-app';
import { HealthService } from '../../src/shared/health/health.service';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('answers 200 without a token when postgres and redis are up', async () => {
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ postgres: 'up', redis: 'up' });
  });

  it('answers 503 and names the dependency that is down', async () => {
    jest
      .spyOn(app.get(HealthService), 'check')
      .mockResolvedValueOnce({ postgres: 'down', redis: 'up' });

    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ postgres: 'down', redis: 'up' });
  });
});
