import { Module } from '@nestjs/common';
import { RabbitmqModule } from '../infrastructure/rabbitmq/rabbitmq.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { TransactionNotificationsService } from './transaction-notifications.service';

@Module({
  imports: [PrismaModule, RabbitmqModule],
  providers: [TransactionNotificationsService],
  exports: [TransactionNotificationsService],
})
export class NotificationsModule {}
