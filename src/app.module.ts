import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DEFAULT_THROTTLE } from '@shared/security/throttle';
import { LOG_REDACT_PATHS } from '@shared/logger/log-redact';
import { AuthGuard } from '@modules/auth/auth.guard';
import { UsersModule } from '@modules/users/users.module';
import { AuthModule } from '@modules/auth/auth.module';
import { CategoriesModule } from '@modules/categories/categories.module';
import { DatabaseModule } from '@shared/database/database.module';
import { MailModule } from '@shared/mail/mail.module';
import { LlmModule } from '@shared/llm/llm.module';
import { StorageModule } from '@shared/storage/storage.module';
import { RolesGuard } from '@shared/guards/roles.guard';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { EducationModule } from './modules/education/education.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { PlanModule } from '@shared/plan/plan.module';
import { BillingModule } from '@shared/billing/billing.module';
import { HealthModule } from '@shared/health/health.module';

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [DEFAULT_THROTTLE] }),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: LOG_REDACT_PATHS,
        transport: {
          targets: [
            { target: 'pino/file', options: { destination: 1 } },
            {
              target: 'pino-loki',
              options: {
                host: process.env.LOKI_URL ?? 'http://localhost:3100',
                labels: { app: 'finwise-api' },
              },
            },
          ],
        },
      },
    }),
    UsersModule,
    DatabaseModule,
    AuthModule,
    MailModule,
    LlmModule,
    StorageModule,
    CategoriesModule,
    BankAccountsModule,
    TransactionsModule,
    EducationModule,
    AssistantModule,
    PlanModule,
    BillingModule,
    HealthModule,
  ],
  controllers: [],
  providers: [
    // First guard: rate limiting runs before authentication.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
