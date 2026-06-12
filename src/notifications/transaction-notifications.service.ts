import { Injectable, MessageEvent } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { Subject } from 'rxjs';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RabbitmqService } from '../infrastructure/rabbitmq/rabbitmq.service';

export type TransactionPartyRef = {
  id: string;
  buyerId: string | null;
  sellerId: string;
  productTitle: string;
};

@Injectable()
export class TransactionNotificationsService {
  private readonly notifications$ = new Subject<MessageEvent>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitmqService,
  ) {}

  streamForUser(userId: string) {
    return this.notifications$.asObservable().pipe();
  }

  get notificationsSubject(): Subject<MessageEvent> {
    return this.notifications$;
  }

  counterpartyId(
    tx: Pick<TransactionPartyRef, 'buyerId' | 'sellerId'>,
    actorId: string,
  ): string | null {
    if (actorId === tx.buyerId && tx.sellerId) return tx.sellerId;
    if (actorId === tx.sellerId && tx.buyerId) return tx.buyerId;
    return null;
  }

  async notify(params: {
    transactionId: string;
    recipientId: string;
    message: string;
    role: string;
    title?: string;
    eventType?: string;
  }): Promise<void> {
    if (!params.recipientId?.trim()) {
      return;
    }
    const row = await this.prisma.transactionNotification.create({
      data: {
        transactionId: params.transactionId,
        recipientId: params.recipientId,
        message: params.message,
        role: params.role,
      },
    });
    this.notifications$.next({
      data: {
        type: 'notification.created',
        id: row.id,
        recipientId: params.recipientId,
        transactionId: params.transactionId,
        message: params.message,
        role: params.role,
        readAt: null,
        createdAt: row.createdAt.toISOString(),
      },
    });
    await this.rabbit.publish('notification.push', {
      recipientId: params.recipientId,
      transactionId: params.transactionId,
      title: params.title ?? 'PayNexa',
      body: params.message,
      eventType: params.eventType ?? 'transaction.notification',
      notificationId: row.id,
      occurredAt: new Date().toISOString(),
    });
  }

  async notifyFunded(tx: TransactionPartyRef, actorId: string): Promise<void> {
    if (!tx.sellerId || actorId === tx.sellerId) return;
    const recent = await this.prisma.transactionNotification.findFirst({
      where: {
        transactionId: tx.id,
        recipientId: tx.sellerId,
        role: 'seller',
        message: { contains: 'has been funded' },
        createdAt: { gte: new Date(Date.now() - 120_000) },
      },
    });
    if (recent) return;
    await this.notify({
      transactionId: tx.id,
      recipientId: tx.sellerId,
      role: 'seller',
      eventType: 'transaction.funded',
      title: 'Transaction funded',
      message: `Transaction has been funded for "${tx.productTitle}".`,
    });
  }

  async notifyStateChange(
    tx: TransactionPartyRef,
    next: TransactionStatus,
    actorId: string,
  ): Promise<void> {
    const title = tx.productTitle;
    switch (next) {
      case TransactionStatus.IN_PROGRESS:
        if (tx.buyerId) {
          await this.notify({
            transactionId: tx.id,
            recipientId: tx.buyerId,
            role: 'buyer',
            eventType: 'transaction.delivery_started',
            title: 'Delivery started',
            message: `The seller has started delivery for "${title}".`,
          });
        }
        break;
      case TransactionStatus.INSPECTION:
        if (tx.buyerId) {
          await this.notify({
            transactionId: tx.id,
            recipientId: tx.buyerId,
            role: 'buyer',
            eventType: 'transaction.inspection',
            title: 'Ready for inspection',
            message: `Your transaction is ready for inspection: "${title}".`,
          });
        }
        break;
      case TransactionStatus.COMPLETED: {
        const fromDispute = actorId === tx.buyerId || actorId === tx.sellerId;
        const message =
          fromDispute && tx.buyerId && actorId === tx.buyerId
            ? `Dispute resolved. Funds have been released for "${title}".`
            : `Transaction completed. Funds have been released for "${title}".`;
        await this.notify({
          transactionId: tx.id,
          recipientId: tx.sellerId,
          role: 'seller',
          eventType: 'transaction.completed',
          title: 'Transaction completed',
          message,
        });
        break;
      }
      case TransactionStatus.CLOSED:
        await this.notify({
          transactionId: tx.id,
          recipientId: tx.sellerId,
          role: 'seller',
          eventType: 'transaction.closed',
          title: 'Transaction closed',
          message: `The buyer closed the transaction for "${title}".`,
        });
        break;
      case TransactionStatus.REFUNDED:
        if (tx.buyerId) {
          await this.notify({
            transactionId: tx.id,
            recipientId: tx.buyerId,
            role: 'buyer',
            eventType: 'transaction.refunded',
            title: 'Payment refunded',
            message: `Your payment has been refunded for "${title}".`,
          });
        }
        break;
      case TransactionStatus.DISPUTED: {
        const recipientId = this.counterpartyId(tx, actorId);
        if (recipientId) {
          const role = recipientId === tx.buyerId ? 'buyer' : 'seller';
          await this.notify({
            transactionId: tx.id,
            recipientId,
            role,
            eventType: 'transaction.dispute_opened',
            title: 'Dispute opened',
            message: `A dispute was opened on your transaction for "${title}".`,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  async notifyDisputeOpened(
    tx: TransactionPartyRef,
    actorId: string,
    reason: string,
  ): Promise<void> {
    const recipientId = this.counterpartyId(tx, actorId);
    if (!recipientId) return;
    const role = recipientId === tx.buyerId ? 'buyer' : 'seller';
    const detail = reason.trim() ? ` Reason: ${reason.trim()}` : '';
    await this.notify({
      transactionId: tx.id,
      recipientId,
      role,
      eventType: 'transaction.dispute_opened',
      title: 'Dispute opened',
      message: `A dispute was opened on your transaction for "${tx.productTitle}".${detail}`,
    });
  }

  async notifyAccepted(
    tx: TransactionPartyRef,
    actorId: string,
    nextStatus: TransactionStatus,
  ): Promise<void> {
    const counterparty = this.counterpartyId(tx, actorId);
    if (!counterparty) return;
    const role = counterparty === tx.buyerId ? 'buyer' : 'seller';
    if (nextStatus === TransactionStatus.AWAITING_FUNDING) {
      if (tx.buyerId) {
        await this.notify({
          transactionId: tx.id,
          recipientId: tx.buyerId,
          role: 'buyer',
          eventType: 'transaction.awaiting_funding',
          title: 'Ready for payment',
          message: `Your PayNexa transaction for "${tx.productTitle}" is ready for payment.`,
        });
      }
      if (tx.sellerId && tx.sellerId !== actorId) {
        await this.notify({
          transactionId: tx.id,
          recipientId: tx.sellerId,
          role: 'seller',
          eventType: 'transaction.awaiting_funding',
          title: 'Awaiting payment',
          message: `Both parties accepted "${tx.productTitle}". Waiting for buyer payment.`,
        });
      }
      return;
    }
    await this.notify({
      transactionId: tx.id,
      recipientId: counterparty,
      role,
      eventType: 'transaction.accepted',
      title: 'Transaction accepted',
      message: `Your counterparty accepted the PayNexa transaction for "${tx.productTitle}".`,
    });
  }

  async notifyParticipantAccepted(
    tx: TransactionPartyRef,
    inviterId: string,
    partySide: 'buyer' | 'seller',
    role: 'LAWYER' | 'AGENT',
  ): Promise<void> {
    const roleWord = role === 'LAWYER' ? 'lawyer' : 'agent';
    await this.notify({
      transactionId: tx.id,
      recipientId: inviterId,
      role: partySide,
      eventType: 'transaction.participant_accepted',
      title: 'Invitation accepted',
      message: `Your invited ${roleWord} accepted the invitation for "${tx.productTitle}".`,
    });
  }

  // Marketplace booking notifications — enable when service-marketplace push is wired.
  // async notifyMarketplaceBooking(params: {
  //   bookingId: string;
  //   transactionId?: string;
  //   recipientId: string;
  //   role: string;
  //   eventType: string;
  //   title: string;
  //   message: string;
  // }): Promise<void> {
  //   await this.notify({
  //     transactionId: params.transactionId ?? params.bookingId,
  //     recipientId: params.recipientId,
  //     role: params.role,
  //     eventType: params.eventType,
  //     title: params.title,
  //     message: params.message,
  //   });
  // }
}
