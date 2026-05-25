import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitmqService } from '../rabbitmq/rabbitmq.service';

type EscrowFundedPayload = {
  transactionId?: string;
  actorId?: string;
  amount?: string;
};

@Injectable()
export class TransactionEventsListener implements OnModuleInit {
  private readonly logger = new Logger(TransactionEventsListener.name);

  constructor(
    private readonly rabbit: RabbitmqService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rabbit.consume(
      'safetrade.transaction-service',
      ['user.created', 'escrow.funded'],
      async (routingKey, body) => {
        if (routingKey === 'escrow.funded') {
          await this.handleEscrowFunded(body as EscrowFundedPayload);
          return;
        }
        this.logger.log(
          `Consumed ${routingKey}: ${JSON.stringify(body).slice(0, 200)}`,
        );
      },
    );
  }

  private async handleEscrowFunded(payload: EscrowFundedPayload): Promise<void> {
    if (!payload.transactionId) return;
    const tx = await this.prisma.transaction.findUnique({
      where: { id: payload.transactionId },
    });
    if (!tx) return;
    if (
      tx.status !== TransactionStatus.AWAITING_FUNDING &&
      tx.status !== TransactionStatus.AWAITING_ACCEPTANCE
    ) {
      return;
    }
    await this.prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: TransactionStatus.FUNDED,
        auditLogs: {
          create: {
            action: 'payment.funded',
            actorId: payload.actorId ?? tx.buyerId ?? 'system',
            detail: payload.amount ? `amount=${payload.amount}` : 'wallet payment funded escrow',
          },
        },
      },
    });
    this.logger.log(`Marked transaction ${tx.id} as FUNDED`);
  }
}
