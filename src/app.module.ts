import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TransactionEventsListener } from './infrastructure/events/transaction-events.listener';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RabbitmqModule } from './infrastructure/rabbitmq/rabbitmq.module';
import { SmsModule } from './infrastructure/sms/sms.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TransactionsController } from './transactions/transactions.controller';
import { TransactionsService } from './transactions/transactions.service';
import { FeesModule } from './fees/fees.module';
import { AdminModule } from './admin/admin.module';
import { InternalModule } from './internal/internal.module';

import { RabbitmqRpcConsumer } from './infrastructure/rabbitmq/rabbitmq-rpc.consumer';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RabbitmqModule,
    SmsModule,
    NotificationsModule,
    FeesModule,
    AdminModule,
    InternalModule,
  ],
  controllers: [TransactionsController],
  providers: [
    TransactionsService,
    TransactionEventsListener,
    RabbitmqRpcConsumer,
  ],
})
export class AppModule {}
