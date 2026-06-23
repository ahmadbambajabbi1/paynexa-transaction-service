import { Injectable } from '@nestjs/common';
import { RabbitmqService } from '../infrastructure/rabbitmq/rabbitmq.service';
import type { FeeConfigInput } from '../fees/platform-fee.util';

const DEFAULT_FEE_CONFIG: FeeConfigInput = {
  percentageEnabled: false,
  percentageFee: '0',
  fixedEnabled: false,
  fixedFee: '0',
};

@Injectable()
export class TransactionFeeConfigService {
  constructor(private readonly rabbit: RabbitmqService) {}

  async getActiveConfig(): Promise<FeeConfigInput> {
    try {
      const row = await this.rabbit.rpc<{
        percentageEnabled?: boolean;
        percentageFee?: string;
        fixedEnabled?: boolean;
        fixedFee?: string;
      }>('admin.rpc.transaction-fees.get', {});
      return {
        percentageEnabled: row.percentageEnabled === true,
        percentageFee: row.percentageFee ?? '0',
        fixedEnabled: row.fixedEnabled === true,
        fixedFee: row.fixedFee ?? '0',
      };
    } catch {
      return DEFAULT_FEE_CONFIG;
    }
  }
}
