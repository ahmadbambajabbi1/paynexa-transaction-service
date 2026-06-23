import { Module } from '@nestjs/common';
import { TransactionFeeConfigService } from './transaction-fee-config.service';

@Module({
  providers: [TransactionFeeConfigService],
  exports: [TransactionFeeConfigService],
})
export class FeesModule {}
