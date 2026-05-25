import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TransactionEventsListener } from './infrastructure/events/transaction-events.listener';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RabbitmqModule } from './infrastructure/rabbitmq/rabbitmq.module';
import { SmsModule } from './infrastructure/sms/sms.module';
import { TransactionsController } from './transactions/transactions.controller';
import { TransactionsService } from './transactions/transactions.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RabbitmqModule,
    SmsModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionEventsListener],
})
export class AppModule {}
