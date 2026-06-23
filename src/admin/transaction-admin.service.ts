import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DisputeResolution,
  DisputeStatus,
  PlatformFeeType,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RabbitmqService } from '../infrastructure/rabbitmq/rabbitmq.service';
import { TransactionNotificationsService } from '../notifications/transaction-notifications.service';
import type { ResolveDisputeDto } from '../dto/dispute.dto';
import { formatFeeTypeLabel } from '../fees/platform-fee.util';
import { mapUnifiedDispute } from '../disputes/dispute-thread.util';
import { resolveTransactionCurrency } from '../transactions/transaction-currency.util';

@Injectable()
export class TransactionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitmqService,
    private readonly notificationEvents: TransactionNotificationsService,
  ) {}

  async listTransactions(params: {
    query?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const take = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const skip = Math.max(params.offset ?? 0, 0);
    const q = params.query?.trim();
    const status = params.status?.trim().toUpperCase();

    const where: Prisma.TransactionWhereInput = {};
    if (status) {
      where.status = status as TransactionStatus;
    }
    if (q) {
      where.OR = [
        { id: { contains: q, mode: 'insensitive' } },
        { productTitle: { contains: q, mode: 'insensitive' } },
        { shareToken: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const items = rows.map((tx) => ({
      id: tx.id,
      productTitle: tx.productTitle,
      amount: tx.amount.toString(),
      currencyCode: resolveTransactionCurrency({
        currencyCode: tx.currencyCode,
        terms: tx.terms,
      }),
      status: tx.status,
      platformFeeAmount: tx.platformFeeAmount?.toString() ?? null,
      sellerNetAmount: tx.sellerNetAmount?.toString() ?? null,
      platformFeeType: tx.platformFeeType,
      buyerId: tx.buyerId,
      sellerId: tx.sellerId,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
    }));

    const userIds = [
      ...new Set(
        items.flatMap((i) => [i.buyerId, i.sellerId].filter(Boolean) as string[]),
      ),
    ];
    const profiles = await this.lookupUsersBatch(userIds);

    const payments = await Promise.all(
      items.map(async (row) => {
        if (!['FUNDED', 'IN_PROGRESS', 'INSPECTION', 'COMPLETED', 'CLOSED', 'DISPUTED'].includes(row.status)) {
          return null;
        }
        return this.fetchPaymentSnapshot(row.id);
      }),
    );

    return {
      items: items.map((row, index) => ({
        ...row,
        buyer: row.buyerId ? profiles[row.buyerId] ?? null : null,
        seller: profiles[row.sellerId] ?? null,
        payment: payments[index],
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  private async lookupUsersBatch(
    userIds: string[],
  ): Promise<Record<string, { id: string; fullName: string | null; displayName: string | null; email: string | null; phone: string | null }>> {
    const out: Record<string, { id: string; fullName: string | null; displayName: string | null; email: string | null; phone: string | null }> = {};
    await Promise.all(
      userIds.map(async (userId) => {
        out[userId] = (await this.lookupUser(userId)) ?? {
          id: userId,
          fullName: null,
          displayName: null,
          email: null,
          phone: null,
        };
      }),
    );
    return out;
  }

  async getTransactionDetail(id: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        disputes: { orderBy: { createdAt: 'asc' }, include: { responses: true } },
        auditLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!tx) throw new NotFoundException('transaction not found');

    const [buyer, seller, payment] = await Promise.all([
      tx.buyerId ? this.lookupUser(tx.buyerId) : null,
      this.lookupUser(tx.sellerId),
      this.fetchPaymentSnapshot(tx.id),
    ]);

    return {
      transaction: {
        id: tx.id,
        workflow: tx.workflow,
        productTitle: tx.productTitle,
        amount: tx.amount.toString(),
        currencyCode: resolveTransactionCurrency({
        currencyCode: tx.currencyCode,
        terms: tx.terms,
      }),
        status: tx.status,
        platformFeeAmount: tx.platformFeeAmount?.toString() ?? null,
        platformFeeType: tx.platformFeeType,
        platformFeeTypeLabel: formatFeeTypeLabel(tx.platformFeeType),
        platformFeePercent: tx.platformFeePercent?.toString() ?? null,
        platformFeeFixed: tx.platformFeeFixed?.toString() ?? null,
        sellerNetAmount: tx.sellerNetAmount?.toString() ?? null,
        deliveryDetails: tx.deliveryDetails,
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt.toISOString(),
      },
      buyer,
      seller,
      payment,
      disputes: tx.disputes.map((d) => this.mapDispute(d)),
      auditLogs: tx.auditLogs.map((a) => ({
        at: a.createdAt.toISOString(),
        action: a.action,
        actorId: a.actorId,
        detail: a.detail,
      })),
    };
  }

  async listDisputes(params: { status?: string; limit?: number; offset?: number }) {
    const take = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const skip = Math.max(params.offset ?? 0, 0);
    const status = params.status?.trim().toUpperCase() as DisputeStatus | undefined;

    const txWhere: Prisma.TransactionWhereInput = {
      disputes: {
        some: status ? { status } : {},
      },
    };

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: txWhere,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        include: {
          disputes: {
            include: { responses: { orderBy: { createdAt: 'asc' } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      this.prisma.transaction.count({ where: txWhere }),
    ]);

    const items = (
      await Promise.all(
        transactions.map(async (tx) => {
          const unified = mapUnifiedDispute(tx.disputes);
          if (!unified) return null;
          const [buyer, seller] = await Promise.all([
            tx.buyerId ? this.lookupUser(tx.buyerId) : null,
            this.lookupUser(tx.sellerId),
          ]);
          return {
            ...unified,
            transaction: {
              id: tx.id,
              productTitle: tx.productTitle,
              amount: tx.amount.toString(),
              currencyCode: resolveTransactionCurrency({
                currencyCode: tx.currencyCode,
                terms: tx.terms,
              }),
              status: tx.status,
            },
            buyer,
            seller,
          };
        }),
      )
    ).filter((row): row is NonNullable<typeof row> => row != null);

    return { items, total, limit: take, offset: skip };
  }

  async getDisputeDetail(id: string) {
    const dispute = await this.prisma.transactionDispute.findUnique({
      where: { id },
      include: { transaction: true },
    });
    if (!dispute) throw new NotFoundException('dispute not found');

    const allDisputes = await this.prisma.transactionDispute.findMany({
      where: { transactionId: dispute.transactionId },
      include: { responses: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    const unified = mapUnifiedDispute(allDisputes);
    if (!unified) throw new NotFoundException('dispute not found');

    const tx = dispute.transaction;
    const [buyer, seller, payment] = await Promise.all([
      tx.buyerId ? this.lookupUser(tx.buyerId) : null,
      this.lookupUser(tx.sellerId),
      this.fetchPaymentSnapshot(tx.id),
    ]);
    return {
      dispute: unified,
      transaction: {
        id: tx.id,
        productTitle: tx.productTitle,
        amount: tx.amount.toString(),
        currencyCode: resolveTransactionCurrency({
          currencyCode: tx.currencyCode,
          terms: tx.terms,
        }),
        status: tx.status,
        sellerNetAmount: tx.sellerNetAmount?.toString() ?? null,
        platformFeeAmount: tx.platformFeeAmount?.toString() ?? null,
      },
      buyer,
      seller,
      payment,
    };
  }

  async resolveDispute(disputeId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.transactionDispute.findUnique({
      where: { id: disputeId },
      include: { transaction: true },
    });
    if (!dispute) throw new NotFoundException('dispute not found');
    if (dispute.status === DisputeStatus.RESOLVED) {
      throw new ConflictException('dispute is already resolved');
    }
    const tx = dispute.transaction;
    if (!tx.buyerId) {
      throw new BadRequestException('transaction has no buyer');
    }

    const resolution = dto.resolution as DisputeResolution;
    const sellerNet = tx.sellerNetAmount?.toString() ?? tx.amount.toString();
    const reason = dto.resolutionReason.trim();

    if (resolution === DisputeResolution.RELEASE_TO_SELLER) {
      await this.rpcSettleToSeller({
        transactionId: tx.id,
        sellerUserId: tx.sellerId,
        amount: sellerNet,
        actorId: dto.adminId,
        productTitle: tx.productTitle,
        platformFeeAmount: tx.platformFeeAmount?.toString() ?? '0',
      });
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: TransactionStatus.COMPLETED },
      });
    } else {
      await this.rpcRefundToBuyer({
        transactionId: tx.id,
        buyerUserId: tx.buyerId,
        actorId: dto.adminId,
        productTitle: tx.productTitle,
      });
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: TransactionStatus.REFUNDED },
      });
    }

    const updated = await this.prisma.transactionDispute.update({
      where: { id: disputeId },
      data: {
        status: DisputeStatus.RESOLVED,
        resolution,
        resolutionReason: reason,
        internalNotes: dto.internalNotes?.trim() || null,
        resolvedByAdminId: dto.adminId,
        resolvedAt: new Date(),
      },
    });

    await this.prisma.transactionDispute.updateMany({
      where: {
        transactionId: tx.id,
        status: { not: DisputeStatus.RESOLVED },
      },
      data: {
        status: DisputeStatus.RESOLVED,
        resolution,
        resolutionReason: reason,
        resolvedByAdminId: dto.adminId,
        resolvedAt: new Date(),
      },
    });

    await this.prisma.transactionAudit.create({
      data: {
        transactionId: tx.id,
        action: 'dispute.resolved',
        actorId: dto.adminId,
        detail: JSON.stringify({
          resolution: dto.resolution,
          resolutionReason: reason,
        }),
      },
    });

    const outcomeLabel =
      resolution === DisputeResolution.RELEASE_TO_SELLER
        ? 'Funds released to seller'
        : 'Funds refunded to buyer';
    const notifyMessage = `${outcomeLabel} for "${tx.productTitle}". Reason: ${reason}`;

    await this.notificationEvents.notify({
      transactionId: tx.id,
      recipientId: tx.buyerId,
      role: 'buyer',
      eventType: 'transaction.dispute_resolved',
      title: 'Dispute resolved',
      message: notifyMessage,
    });
    await this.notificationEvents.notify({
      transactionId: tx.id,
      recipientId: tx.sellerId,
      role: 'seller',
      eventType: 'transaction.dispute_resolved',
      title: 'Dispute resolved',
      message: notifyMessage,
    });

    return { dispute: this.mapDispute(updated), transactionId: tx.id };
  }

  private async rpcSettleToSeller(params: {
    transactionId: string;
    sellerUserId: string;
    amount: string;
    actorId: string;
    productTitle: string;
    platformFeeAmount: string;
  }) {
    try {
      const result = await this.rabbit.rpc<Record<string, unknown>>(
        'escrow.rpc.wallet.settle-to-seller',
        { ...params, releaseDespiteFreeze: true },
      );
      const alreadyReleased = result.alreadyReleased === true;
      const released = String(result.released ?? '0');
      if (!alreadyReleased && Number(released) <= 0) {
        throw new BadGatewayException('seller wallet was not credited');
      }
      return result;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      throw new BadGatewayException(
        `escrow could not release funds to seller: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async rpcRefundToBuyer(params: {
    transactionId: string;
    buyerUserId: string;
    actorId: string;
    productTitle: string;
  }) {
    try {
      const result = await this.rabbit.rpc<Record<string, unknown>>(
        'escrow.rpc.wallet.refund-to-buyer',
        { ...params, releaseDespiteFreeze: true },
      );
      const alreadyRefunded = result.alreadyRefunded === true;
      const refunded = String(result.refunded ?? '0');
      if (!alreadyRefunded && Number(refunded) <= 0) {
        throw new BadGatewayException('buyer wallet was not credited');
      }
      return result;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      throw new BadGatewayException(
        `escrow could not refund buyer: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private mapDispute(d: {
    id: string;
    transactionId: string;
    raisedByUserId: string;
    raisedByRole: string;
    description: string;
    parentDisputeId: string | null;
    status: DisputeStatus;
    resolution: DisputeResolution | null;
    resolutionReason: string | null;
    internalNotes: string | null;
    resolvedByAdminId: string | null;
    resolvedAt: Date | null;
    createdAt: Date;
    responses?: Array<{
      id: string;
      actorId: string;
      actorRole: string;
      message: string;
      createdAt: Date;
    }>;
  }) {
    return {
      id: d.id,
      transactionId: d.transactionId,
      raisedByUserId: d.raisedByUserId,
      raisedByRole: d.raisedByRole,
      description: d.description,
      parentDisputeId: d.parentDisputeId,
      status: d.status,
      resolution: d.resolution,
      resolutionReason: d.resolutionReason,
      internalNotes: d.internalNotes,
      resolvedByAdminId: d.resolvedByAdminId,
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      responses: (d.responses ?? []).map((r) => ({
        id: r.id,
        actorId: r.actorId,
        actorRole: r.actorRole,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  private async lookupUser(userId: string) {
    try {
      const row = await this.rabbit.rpc<{
        id: string;
        displayName?: string | null;
        fullName?: string | null;
        email?: string | null;
        phone?: string | null;
      }>('user.rpc.user.search', { query: userId }, 3_000);
      if (!row) return null;
      return {
        id: row.id,
        fullName: row.fullName ?? row.displayName ?? null,
        displayName: row.displayName ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
      };
    } catch {
      return { id: userId, fullName: null, displayName: null, email: null, phone: null };
    }
  }

  private async fetchPaymentSnapshot(transactionId: string) {
    try {
      return await this.rabbit.rpc<Record<string, unknown>>(
        'escrow.rpc.transaction-payment.get',
        { transactionId },
      );
    } catch {
      return null;
    }
  }
}
