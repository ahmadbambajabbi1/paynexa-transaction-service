import { Module } from '@nestjs/common';
import { TransactionAdminService } from './transaction-admin.service';
import { FeesModule } from '../fees/fees.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [FeesModule, NotificationsModule],
  providers: [TransactionAdminService],
  exports: [TransactionAdminService],
})
export class AdminModule {}
