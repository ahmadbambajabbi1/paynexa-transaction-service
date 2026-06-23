import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from './rabbitmq.service';
import { TransactionsService } from '../../transactions/transactions.service';
import { TransactionAdminService } from '../../admin/transaction-admin.service';

@Injectable()
export class RabbitmqRpcConsumer implements OnModuleInit {
  private readonly logger = new Logger(RabbitmqRpcConsumer.name);

  constructor(
    private readonly rabbit: RabbitmqService,
    private readonly transactions: TransactionsService,
    private readonly admin: TransactionAdminService,
  ) {}

  async onModuleInit() {
    await this.rabbit.consumeRpc(
      'transaction-service.rpc',
      [
        'transaction.rpc.room.get',
        'transaction.rpc.public.claim',
        'transaction.rpc.mark-funded',
        'transaction.rpc.admin.transactions.list',
        'transaction.rpc.admin.transactions.get',
        'transaction.rpc.admin.disputes.list',
        'transaction.rpc.admin.disputes.get',
        'transaction.rpc.admin.disputes.resolve',
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

          case 'transaction.rpc.admin.transactions.list': {
            return this.admin.listTransactions({
              query: b.query as string | undefined,
              status: b.status as string | undefined,
              limit: b.limit as number | undefined,
              offset: b.offset as number | undefined,
            });
          }

          case 'transaction.rpc.admin.transactions.get': {
            return this.admin.getTransactionDetail(b.id as string);
          }

          case 'transaction.rpc.admin.disputes.list': {
            return this.admin.listDisputes({
              status: b.status as string | undefined,
              limit: b.limit as number | undefined,
              offset: b.offset as number | undefined,
            });
          }

          case 'transaction.rpc.admin.disputes.get': {
            return this.admin.getDisputeDetail(b.id as string);
          }

          case 'transaction.rpc.admin.disputes.resolve': {
            return this.admin.resolveDispute(b.id as string, {
              adminId: b.adminId as string,
              resolution: (b.dto as { resolution: 'RELEASE_TO_SELLER' | 'REFUND_TO_BUYER' })
                .resolution,
              resolutionReason: (b.dto as { resolutionReason: string }).resolutionReason,
              internalNotes: (b.dto as { internalNotes?: string }).internalNotes,
            });
          }

          default:
            this.logger.warn(`Unknown RPC routing key: ${routingKey}`);
            throw new Error(`Unknown RPC routing key: ${routingKey}`);
        }
      },
    );
  }
}
