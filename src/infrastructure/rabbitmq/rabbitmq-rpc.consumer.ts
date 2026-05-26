import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from './rabbitmq.service';
import { TransactionsService } from '../../transactions/transactions.service';

@Injectable()
export class RabbitmqRpcConsumer implements OnModuleInit {
  private readonly logger = new Logger(RabbitmqRpcConsumer.name);

  constructor(
    private readonly rabbit: RabbitmqService,
    private readonly transactions: TransactionsService,
  ) {}

  async onModuleInit() {
    await this.rabbit.consumeRpc(
      'transaction-service.rpc',
      [
        'transaction.rpc.room.get',
        'transaction.rpc.public.claim',
        'transaction.rpc.mark-funded',
      ],
      async (routingKey, body) => {
        const b = body as Record<string, unknown>;

        switch (routingKey) {
          case 'transaction.rpc.room.get': {
            return this.transactions.getTransactionRoom(b.transactionId as string);
          }

          case 'transaction.rpc.public.claim': {
            return this.transactions.claimPublicTransaction(
              b.transactionId as string,
              b.actorId as string,
              b.deviceId as string | undefined,
            );
          }

          case 'transaction.rpc.mark-funded': {
            return this.transactions.markWalletPaymentFunded(
              b.transactionId as string,
              b.actorId as string,
            );
          }

          default:
            this.logger.warn(`Unknown RPC routing key: ${routingKey}`);
            throw new Error(`Unknown RPC routing key: ${routingKey}`);
        }
      },
    );
  }
}
