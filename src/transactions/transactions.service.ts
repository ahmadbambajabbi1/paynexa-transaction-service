import {
  BadRequestException,
  ConflictException,
  Injectable,
  MessageEvent,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ParticipantInviteStatus,
  TransactionFundingParty,
  TransactionStatus,
  TransactionType,
  TransactionWorkflow,
} from '@prisma/client';
import { AddDocumentDto } from '../dto/add-document.dto';
import { CreatePublicTransactionDto, CreateTransactionDto } from '../dto/create-transaction.dto';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RabbitmqService } from '../infrastructure/rabbitmq/rabbitmq.service';
import { SmsService } from '../infrastructure/sms/sms.service';
import { TransactionNotificationsService } from '../notifications/transaction-notifications.service';
import { Observable } from 'rxjs';

/** Matches product-service `.env.example`; used only when `INTERNAL_API_SECRET` is unset and `NODE_ENV` is not production. */
const DEV_FALLBACK_INTERNAL_API_SECRET = 'change-me';

const TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  [TransactionStatus.AWAITING_ACCEPTANCE]: [
    TransactionStatus.AWAITING_FUNDING,
    TransactionStatus.CLOSED,
  ],
  [TransactionStatus.AWAITING_FUNDING]: [TransactionStatus.CLOSED],
  [TransactionStatus.FUNDED]: [
    TransactionStatus.IN_PROGRESS,
    TransactionStatus.DISPUTED,
  ],
  [TransactionStatus.IN_PROGRESS]: [
    TransactionStatus.INSPECTION,
    TransactionStatus.DISPUTED,
  ],
  [TransactionStatus.INSPECTION]: [
    TransactionStatus.COMPLETED,
    TransactionStatus.DISPUTED,
  ],
  [TransactionStatus.COMPLETED]: [],
  [TransactionStatus.DISPUTED]: [TransactionStatus.COMPLETED],
  [TransactionStatus.REFUNDED]: [],
  [TransactionStatus.CLOSED]: [],
};

function parseType(raw: string | undefined): TransactionType {
  const key = String(raw ?? 'ONLINE_SHOPPING')
    .toUpperCase()
    .replace(/-/g, '_');
  if (!(key in TransactionType)) {
    throw new BadRequestException(`invalid transaction type: ${raw}`);
  }
  return TransactionType[key as keyof typeof TransactionType];
}

function transactionTypeFromProductTypeCode(code: string | undefined): TransactionType {
  const c = (code ?? '').toLowerCase();
  if (c.includes('land')) {
    return TransactionType.LAND;
  }
  if (
    c.includes('estate') ||
    c.includes('property') ||
    c.includes('real') ||
    c.includes('housing')
  ) {
    return TransactionType.REAL_ESTATE;
  }
  return TransactionType.ONLINE_SHOPPING;
}

function parseFundingParty(raw: string): TransactionFundingParty {
  const key = raw.trim().toUpperCase().replace(/-/g, '_');
  if (!(key in TransactionFundingParty)) {
    throw new BadRequestException('fundedBy must be ME or COUNTERPARTY');
  }
  return TransactionFundingParty[key as keyof typeof TransactionFundingParty];
}

function makeShareToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

function moneyString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BadRequestException('amount must be positive');
  }
  return value.toFixed(2);
}

type PublicViewContext = {
  deviceId?: string;
  userAgent?: string;
  viewerUserId?: string;
};

type PublicAnalyticsSource = {
  id: string;
  amount: { toString(): string };
  status: TransactionStatus;
};

const PAID_TRANSACTION_STATUSES = new Set<TransactionStatus>([
  TransactionStatus.FUNDED,
  TransactionStatus.IN_PROGRESS,
  TransactionStatus.INSPECTION,
  TransactionStatus.COMPLETED,
  TransactionStatus.CLOSED,
]);

type ParticipantRole = 'LAWYER' | 'AGENT';

function parseParticipantRole(raw: string | undefined): ParticipantRole {
  const role = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (role !== 'LAWYER' && role !== 'AGENT') {
    throw new BadRequestException('role must be LAWYER or AGENT');
  }
  return role;
}

type PartySide = 'buyer' | 'seller';

function parsePartySide(raw: string | undefined): PartySide {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s !== 'buyer' && s !== 'seller') {
    throw new BadRequestException('partySide must be buyer or seller');
  }
  return s;
}

function participantNotificationRole(side: PartySide, role: ParticipantRole): string {
  return `${side}_${role.toLowerCase()}`;
}

type TxParticipantFields = {
  buyerLawyerId: string | null;
  buyerLawyerInviteStatus: ParticipantInviteStatus;
  buyerAgentId: string | null;
  buyerAgentInviteStatus: ParticipantInviteStatus;
  sellerLawyerId: string | null;
  sellerLawyerInviteStatus: ParticipantInviteStatus;
  sellerAgentId: string | null;
  sellerAgentInviteStatus: ParticipantInviteStatus;
};

function sanitizeAuditDetail(detail: string | null | undefined): string {
  const raw = String(detail ?? '').trim();
  if (!raw) return '';

  // Legacy format: `userId=<uuid>; message=<text...>`
  const legacy = raw.match(/^userId=[^;]+;\s*message=(.*)$/s);
  if (legacy && legacy[1]) {
    return legacy[1].trim();
  }

  // Current format: `message=<text...>`
  const msgOnly = raw.match(/^message=(.*)$/s);
  if (msgOnly && msgOnly[1]) {
    return msgOnly[1].trim();
  }

  return raw;
}

function getParticipantSlot(
  tx: TxParticipantFields,
  side: PartySide,
  role: ParticipantRole,
): { userId: string | null; status: ParticipantInviteStatus } {
  if (side === 'buyer' && role === 'LAWYER') {
    return { userId: tx.buyerLawyerId, status: tx.buyerLawyerInviteStatus };
  }
  if (side === 'buyer' && role === 'AGENT') {
    return { userId: tx.buyerAgentId, status: tx.buyerAgentInviteStatus };
  }
  if (side === 'seller' && role === 'LAWYER') {
    return { userId: tx.sellerLawyerId, status: tx.sellerLawyerInviteStatus };
  }
  return { userId: tx.sellerAgentId, status: tx.sellerAgentInviteStatus };
}

function inviteDataForSlot(
  side: PartySide,
  role: ParticipantRole,
  participantUserId: string,
) {
  if (side === 'buyer' && role === 'LAWYER') {
    return {
      buyerLawyerId: participantUserId,
      buyerLawyerInviteStatus: ParticipantInviteStatus.PENDING,
    };
  }
  if (side === 'buyer' && role === 'AGENT') {
    return {
      buyerAgentId: participantUserId,
      buyerAgentInviteStatus: ParticipantInviteStatus.PENDING,
    };
  }
  if (side === 'seller' && role === 'LAWYER') {
    return {
      sellerLawyerId: participantUserId,
      sellerLawyerInviteStatus: ParticipantInviteStatus.PENDING,
    };
  }
  return {
    sellerAgentId: participantUserId,
    sellerAgentInviteStatus: ParticipantInviteStatus.PENDING,
  };
}

function acceptDataForSlot(side: PartySide, role: ParticipantRole) {
  if (side === 'buyer' && role === 'LAWYER') {
    return { buyerLawyerInviteStatus: ParticipantInviteStatus.ACCEPTED };
  }
  if (side === 'buyer' && role === 'AGENT') {
    return { buyerAgentInviteStatus: ParticipantInviteStatus.ACCEPTED };
  }
  if (side === 'seller' && role === 'LAWYER') {
    return { sellerLawyerInviteStatus: ParticipantInviteStatus.ACCEPTED };
  }
  return { sellerAgentInviteStatus: ParticipantInviteStatus.ACCEPTED };
}

function defaultParticipantInviteMessage(opts: {
  inviterLabel: string;
  partySide: PartySide;
  professionalRole: ParticipantRole;
  productTitle: string;
  amount: string;
  transactionId: string;
}): string {
  const roleWord = opts.professionalRole === 'LAWYER' ? 'lawyer' : 'agent';
  const shortId = opts.transactionId.slice(0, 8);
  return [
    'Hello,',
    '',
    `${opts.inviterLabel} (${opts.partySide}) would like to invite you to act as the ${roleWord} for their side of a PayNexa transaction.`,
    '',
    `Product: ${opts.productTitle}`,
    `Amount: ${opts.amount}`,
    `Transaction: #${shortId}…`,
    '',
    `I would like to invite you to this transaction for you to be my ${roleWord} (I am the ${opts.partySide} in this deal).`,
    '',
    'Regards,',
    opts.inviterLabel,
  ].join('\n');
}

function roleToBuyerSeller(
  roleRaw: string,
  creatorId: string,
  counterpartyId: string,
): { buyerId: string; sellerId: string; counterpartyRole: 'buyer' | 'seller' } {
  const role = roleRaw.trim().toLowerCase();
  if (role === 'buyer') {
    return { buyerId: creatorId, sellerId: counterpartyId, counterpartyRole: 'seller' };
  }
  if (role === 'seller') {
    return { buyerId: counterpartyId, sellerId: creatorId, counterpartyRole: 'buyer' };
  }
  throw new BadRequestException('role must be buyer or seller');
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitmqService,
    private readonly sms: SmsService,
    private readonly notificationEvents: TransactionNotificationsService,
  ) {}

  /** Defaults match api-gateway dev URLs so local runs work without a full .env. */
  private userServiceUrl(): string {
    const raw =
      process.env.USER_SERVICE_URL?.trim() || 'http://127.0.0.1:5001';
    return raw.replace(/\/$/, '');
  }

  private productServiceUrl(): string {
    const raw =
      process.env.PRODUCT_SERVICE_URL?.trim() || 'http://127.0.0.1:5005';
    return raw.replace(/\/$/, '');
  }

  private async searchUserDirectory(query: string) {
    try {
      return await this.rabbit.rpc<Record<string, unknown>>('user.rpc.user.search', {
        query: query.trim(),
      });
    } catch {
      return null;
    }
  }

  private async searchApprovedProfessionals(role: ParticipantRole, query: string) {
    try {
      const body = await this.rabbit.rpc<{ items?: Array<Record<string, unknown>> }>(
        'user.rpc.professionals.search',
        { role, query: query.trim() },
      );
      return body.items ?? [];
    } catch {
      throw new ServiceUnavailableException('professional lookup is currently unavailable');
    }
  }

  /** Product-service internal listing row (no secret): includes product-type pricing flags. */
  private async fetchProductProfessionalPricingFlags(
    productId: string | null | undefined,
  ): Promise<{ lawyerPricingEnabled: boolean; agentPricingEnabled: boolean } | null> {
    if (!productId) return null;
    try {
      const body = await this.rabbit.rpc<{
        lawyerPricingEnabled?: boolean;
        agentPricingEnabled?: boolean;
      }>('product.rpc.product.get', { productId });
      return {
        lawyerPricingEnabled: body.lawyerPricingEnabled === true,
        agentPricingEnabled: body.agentPricingEnabled === true,
      };
    } catch {
      return null;
    }
  }

  private async ensurePersonalKycApproved(userId: string): Promise<void> {
    try {
      const body = await this.rabbit.rpc<{ approved?: boolean }>(
        'user.rpc.kyc.personal.status',
        { userId },
      );
      if (!body.approved) {
        throw new ConflictException('complete KYC before creating transactions');
      }
    } catch (e) {
      console.error('KYC verification failed:', e);
      if (e instanceof ConflictException) throw e;
      throw new ServiceUnavailableException('could not verify KYC status');
    }
  }

  async searchCounterparty(queryRaw?: string): Promise<Record<string, unknown>> {
    const query = queryRaw?.trim() ?? '';
    if (!query) {
      throw new BadRequestException('query is required');
    }
    const found = await this.searchUserDirectory(query);
    if (!found) {
      return {
        found: false,
        message:
          'The user you searched for is not using our platform. Ask them to open an account.',
      };
    }
    return { found: true, user: found };
  }

  async searchTransactionParticipants(
    transactionId: string,
    roleRaw?: string,
    queryRaw?: string,
    partySideRaw?: string,
  ): Promise<Record<string, unknown>> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    const role = parseParticipantRole(roleRaw);
    const partySide = parsePartySide(partySideRaw);
    if (tx.workflow !== TransactionWorkflow.ESCROW_TWO_PARTY || !tx.productId) {
      return {
        items: [],
        partySide,
        productPricing: { lawyerPricingEnabled: false, agentPricingEnabled: false },
        disabledReason:
          'Lawyers and agents are available only in two-party escrow transactions.',
      };
    }
    const pricing = await this.fetchProductProfessionalPricingFlags(tx.productId);
    const lawyerOk = pricing?.lawyerPricingEnabled === true;
    const agentOk = pricing?.agentPricingEnabled === true;
    if (role === 'LAWYER' && !lawyerOk) {
      return {
        items: [],
        partySide,
        productPricing: {
          lawyerPricingEnabled: lawyerOk,
          agentPricingEnabled: agentOk,
        },
        disabledReason:
          'This product type does not have lawyer pricing enabled, so lawyers cannot be attached to this transaction.',
      };
    }
    if (role === 'AGENT' && !agentOk) {
      return {
        items: [],
        partySide,
        productPricing: {
          lawyerPricingEnabled: lawyerOk,
          agentPricingEnabled: agentOk,
        },
        disabledReason:
          'This product type does not have agent pricing enabled, so agents cannot be attached to this transaction.',
      };
    }
    const items = await this.searchApprovedProfessionals(role, queryRaw ?? '');
    const slot = getParticipantSlot(tx, partySide, role);
    return {
      items: items
        .filter((item) => {
          const id = typeof item.id === 'string' ? item.id : '';
          return id && id !== tx.buyerId && id !== tx.sellerId;
        })
        .map((item) => ({
          ...item,
          invited:
            typeof item.id === 'string' &&
            !!slot.userId &&
            item.id === slot.userId,
          inviteStatus: slot.status,
        })),
      partySide,
      productPricing: {
        lawyerPricingEnabled: lawyerOk,
        agentPricingEnabled: agentOk,
      },
    };
  }

  async resolveOptionalViewerId(
    authorization?: string,
    deviceId?: string,
  ): Promise<string | undefined> {
    if (!authorization?.startsWith('Bearer ') || !deviceId?.trim()) {
      return undefined;
    }
    try {
      const session = await this.rabbit.rpc<{ user?: { id?: string } }>(
        'user.rpc.session.resolve',
        { authorization, deviceId },
      );
      return session.user?.id;
    } catch {
      return undefined;
    }
  }

  async listNotifications(userId?: string): Promise<Record<string, unknown>> {
    if (!userId) {
      throw new BadRequestException('userId query required');
    }
    const rows = await this.prisma.transactionNotification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      include: { transaction: true },
      take: 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        message: row.message,
        role: row.role,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        status: row.transaction.status,
      })),
    };
  }

  notificationsStream(userId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const sub = this.notificationEvents.notificationsSubject.subscribe((event) => {
        const payload = event.data as { recipientId?: string };
        if (payload.recipientId === userId) {
          subscriber.next(event);
        }
      });
      return () => sub.unsubscribe();
    });
  }

  async markNotificationRead(id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.transactionNotification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    this.notificationEvents.notificationsSubject.next({
      data: {
        type: 'notification.read',
        id: row.id,
        recipientId: row.recipientId,
        readAt: row.readAt?.toISOString() ?? null,
      },
    });
    return { ok: true };
  }

  async createTransaction(dto: CreateTransactionDto): Promise<Record<string, unknown>> {
    return this.createEscrowTransaction(dto);
  }

  async createEscrowTransaction(dto: CreateTransactionDto): Promise<Record<string, unknown>> {
    const sellerId = dto.createdByUserId.trim();
    const buyerId = dto.counterpartyId.trim();
    if (sellerId === buyerId) {
      throw new BadRequestException('buyer must be a different user');
    }
    await this.ensurePersonalKycApproved(sellerId);
    const userLookup = await this.searchUserDirectory(buyerId);
    if (!userLookup) {
      throw new NotFoundException(
        'The buyer you searched for is not using our platform. Ask them to open an account.',
      );
    }
    const fundedBy = TransactionFundingParty.COUNTERPARTY;
    let productRow: {
      id: string;
      sellerUserId: string;
      title: string;
      price: string;
      productTypeCode?: string;
    };
    try {
      productRow = await this.rabbit.rpc('product.rpc.product.get', {
        productId: dto.productId,
      });
    } catch {
      throw new NotFoundException('product not found');
    }
    if (productRow.sellerUserId !== sellerId) {
      throw new ConflictException('selected product must belong to the seller creating this transaction');
    }
    const type = dto.type
      ? parseType(dto.type)
      : transactionTypeFromProductTypeCode(productRow.productTypeCode);
    const documents = dto.documents ?? [];
    const terms = JSON.stringify({
      workflow: TransactionWorkflow.ESCROW_TWO_PARTY,
      productId: productRow.id,
      productTitle: productRow.title,
      amount: productRow.price,
      fundedBy,
      buyerAlwaysFunds: true,
      sellerAutoAccepted: true,
      source: 'catalog_product',
    });

    const transaction = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          workflow: TransactionWorkflow.ESCROW_TWO_PARTY,
          type,
          productId: productRow.id,
          productTitle: productRow.title,
          quantity: 1,
          unitPrice: productRow.price,
          amount: productRow.price,
          buyerId,
          sellerId,
          createdByUserId: sellerId,
          fundedBy,
          terms,
          acceptedPartyIds: { set: [sellerId] },
          agreements: {
            create: {
              version: 1,
              content: terms,
              actorId: sellerId,
            },
          },
          auditLogs: {
            create: [
              {
                action: 'escrow.created',
                actorId: sellerId,
                detail: 'seller created two-party escrow transaction',
              },
              {
                action: 'transaction.accepted',
                actorId: sellerId,
                detail: 'seller auto-accepted on creation',
              },
            ],
          },
        },
      });
      if (documents.length > 0) {
        await tx.transactionDocument.createMany({
          data: documents.map((document) => ({
            transactionId: created.id,
            fileUrl: document.fileUrl,
            fileKey: document.fileKey,
            uploader: document.uploader,
          })),
        });
      }
      return created;
    });
    const targetPhone =
      typeof userLookup.phone === 'string' ? userLookup.phone : '';
    if (targetPhone) {
      await this.sms.sendTransactionInviteSms(targetPhone, {
        transactionId: transaction.id,
        productTitle: productRow.title,
        role: 'buyer',
      });
    }
    await this.notificationEvents.notify({
      transactionId: transaction.id,
      recipientId: buyerId,
      role: 'buyer',
      eventType: 'transaction.invited',
      title: 'Transaction invitation',
      message: `You were invited to a PayNexa transaction for "${productRow.title}".`,
    });

    await this.rabbit.publish('transaction.created', {
      transactionId: transaction.id,
      workflow: transaction.workflow,
      buyerId,
      sellerId,
      type: transaction.type,
      occurredAt: transaction.createdAt.toISOString(),
    });
    await this.rabbit.publish('transaction.invitation.sent', {
      transactionId: transaction.id,
      counterpartyId: buyerId,
      emailFunction: 'alertCounterparty-transaction-invited',
      smsProvider: 'twilio',
      occurredAt: new Date().toISOString(),
    });

    return {
      transactionId: transaction.id,
      workflow: transaction.workflow,
      status: transaction.status,
      event: 'escrow.created',
      roomPath: `/transactions/${transaction.id}`,
    };
  }

  async createPublicTransaction(dto: CreatePublicTransactionDto): Promise<Record<string, unknown>> {
    const sellerId = dto.createdByUserId.trim();
    await this.ensurePersonalKycApproved(sellerId);

    const quantity = Number(dto.quantity);
    const unitPrice = Number(dto.unitPrice);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException('quantity must be at least 1');
    }
    const amount = moneyString(unitPrice * quantity);
    const unitPriceText = moneyString(unitPrice);
    const shareToken = makeShareToken();
    const itemTitle = dto.itemTitle.trim();
    const itemDescription = dto.itemDescription?.trim() ?? '';
    const sellerNote = dto.sellerNote?.trim() ?? '';
    const fundedBy = TransactionFundingParty.COUNTERPARTY;
    const terms = JSON.stringify({
      workflow: TransactionWorkflow.PUBLIC_SHAREABLE,
      itemTitle,
      itemDescription,
      quantity,
      unitPrice: unitPriceText,
      amount,
      protectionFee: '0.00',
      totalBuyerPays: amount,
      deliveryNeeded: dto.deliveryNeeded === true,
      sellerNote,
      fundedBy,
      sellerAutoAccepted: true,
      buyerAssignedOnPayment: true,
    });

    const transaction = await this.prisma.transaction.create({
      data: {
        workflow: TransactionWorkflow.PUBLIC_SHAREABLE,
        shareToken,
        type: dto.type ? parseType(dto.type) : TransactionType.ONLINE_SHOPPING,
        productId: null,
        productTitle: itemTitle,
        quantity,
        unitPrice: unitPriceText,
        amount,
        buyerId: null,
        sellerId,
        createdByUserId: sellerId,
        fundedBy,
        terms,
        acceptedPartyIds: { set: [sellerId] },
        status: TransactionStatus.AWAITING_FUNDING,
        agreements: {
          create: {
            version: 1,
            content: terms,
            actorId: sellerId,
          },
        },
        auditLogs: {
          create: [
            {
              action: 'public.created',
              actorId: sellerId,
              detail: 'seller created shareable public transaction',
            },
            {
              action: 'transaction.accepted',
              actorId: sellerId,
              detail: 'seller auto-accepted on creation',
            },
          ],
        },
      },
    });

    await this.rabbit.publish('transaction.created', {
      transactionId: transaction.id,
      workflow: transaction.workflow,
      sellerId,
      type: transaction.type,
      occurredAt: transaction.createdAt.toISOString(),
    });

    return {
      transactionId: transaction.id,
      workflow: transaction.workflow,
      status: transaction.status,
      event: 'public.created',
      shareToken,
      sharePath: `/pay/${shareToken}`,
    };
  }


  private async findTransactionByPublicRef(ref: string) {
    const key = ref.trim();
    if (!key) {
      throw new BadRequestException('transaction id required');
    }
    return this.prisma.transaction.findFirst({
      where: {
        OR: [{ id: key }, { shareToken: key }],
      },
    });
  }

  /** Resolves a public pay-link ref to the shareable template and optional buyer order row. */
  private async resolvePublicCheckout(ref: string) {
    const row = await this.findTransactionByPublicRef(ref);
    if (!row || row.workflow !== TransactionWorkflow.PUBLIC_SHAREABLE) {
      throw new NotFoundException('transaction not found');
    }
    if (row.sourceShareTransactionId) {
      const template = await this.prisma.transaction.findUnique({
        where: { id: row.sourceShareTransactionId },
      });
      if (!template || template.workflow !== TransactionWorkflow.PUBLIC_SHAREABLE) {
        throw new NotFoundException('transaction not found');
      }
      return { template, order: row };
    }
    return { template: row, order: null };
  }

  private async findBuyerOrderForTemplate(
    templateId: string,
    buyerId: string,
  ) {
    return this.prisma.transaction.findFirst({
      where: {
        sourceShareTransactionId: templateId,
        buyerId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private normalizePublicDeviceId(value: string | undefined): string | null {
    const clean = String(value ?? '').trim();
    return clean ? clean.slice(0, 128) : null;
  }

  private async recordPublicView(
    transactionId: string,
    view?: PublicViewContext,
  ): Promise<boolean> {
    const deviceId = this.normalizePublicDeviceId(view?.deviceId);
    const userAgent = String(view?.userAgent ?? '').trim().slice(0, 512) || null;
    const viewerUserId = String(view?.viewerUserId ?? '').trim() || null;
    if (!deviceId && !userAgent && !viewerUserId) return false;

    // Deduplicate: if this device or user already viewed, do not count again
    if (deviceId || viewerUserId) {
      const existing = await this.prisma.transactionPublicView.findFirst({
        where: {
          transactionId,
          OR: [
            ...(deviceId ? [{ deviceId }] : []),
            ...(viewerUserId ? [{ viewerUserId }] : []),
          ],
        },
      });
      if (existing) return false;
    }

    try {
      await this.prisma.transactionPublicView.create({
        data: {
          transactionId,
          deviceId,
          viewerUserId,
          userAgent,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async getPublicAnalytics(tx: PublicAnalyticsSource): Promise<Record<string, unknown>> {
    const [totalViews, deviceRows, anonymousViews, recentRows] = await Promise.all([
      this.prisma.transactionPublicView.count({ where: { transactionId: tx.id } }),
      this.prisma.transactionPublicView.findMany({
        where: { transactionId: tx.id, deviceId: { not: null } },
        distinct: ['deviceId'],
        select: { deviceId: true },
      }),
      this.prisma.transactionPublicView.count({
        where: { transactionId: tx.id, deviceId: null },
      }),
      this.prisma.transactionPublicView.findMany({
        where: { transactionId: tx.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          deviceId: true,
          convertedAt: true,
          createdAt: true,
        },
      }),
    ]);
    const uniqueViewers = deviceRows.length + anonymousViews;
    const paidCount = PAID_TRANSACTION_STATUSES.has(tx.status) ? 1 : 0;
    const viewedNotBought = Math.max(uniqueViewers - paidCount, 0);
    const conversionRate = uniqueViewers > 0 ? ((paidCount / uniqueViewers) * 100).toFixed(1) : '0.0';
    return {
      totalViews,
      uniqueViewers,
      paidCount,
      totalEarnings: paidCount > 0 ? tx.amount.toString() : '0.00',
      conversionRate,
      viewedNotBought,
      recentViewers: recentRows.map((row, index) => {
        const suffix = row.deviceId ? row.deviceId.slice(-6).toUpperCase() : String(index + 1).padStart(2, '0');
        return {
          label: `Visitor ${suffix}`,
          viewedAt: row.createdAt.toISOString(),
          convertedAt: row.convertedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  async getPublicTransactionSummary(
    id: string,
    view?: PublicViewContext,
  ): Promise<Record<string, unknown>> {
    const { template, order } = await this.resolvePublicCheckout(id);
    const isNewView = await this.recordPublicView(template.id, view);
    if (isNewView) {
      await this.notificationEvents.notify({
        transactionId: template.id,
        recipientId: template.sellerId,
        role: 'seller',
        eventType: 'transaction.public_viewed',
        title: 'Payment link viewed',
        message: `Someone viewed your PayNexa payment link for "${template.productTitle}".`,
      });
    }
    const seller = await this.lookupPartyProfile(template.sellerId);
    let terms: Record<string, unknown> = {};
    try {
      terms = JSON.parse(template.terms) as Record<string, unknown>;
    } catch {
      terms = {};
    }
    const amount = template.amount.toString();
    const protectionFee = typeof terms.protectionFee === 'string' ? terms.protectionFee : '0.00';
    const totalBuyerPays = typeof terms.totalBuyerPays === 'string' ? terms.totalBuyerPays : amount;
    const viewerOrder =
      order ??
      (view?.viewerUserId
        ? await this.findBuyerOrderForTemplate(template.id, view.viewerUserId)
        : null);
    const responseStatus = viewerOrder?.status ?? template.status;
    const responseBuyerId = viewerOrder?.buyerId ?? null;
    const payTransactionId = viewerOrder?.id ?? template.id;
    return {
      id: payTransactionId,
      templateId: template.id,
      workflow: template.workflow,
      shareToken: template.shareToken,
      sharePath: template.shareToken
        ? `/pay/${template.shareToken}`
        : `/pay/${template.id}`,
      sellerId: template.sellerId,
      buyerId: responseBuyerId,
      seller: seller?.displayName || seller?.phone || seller?.email || 'Seller',
      item: template.productTitle,
      itemDescription:
        typeof terms.itemDescription === 'string' && terms.itemDescription.trim()
          ? terms.itemDescription
          : null,
      quantity: template.quantity,
      unitPrice: template.unitPrice?.toString() ?? amount,
      amount,
      protectionFee,
      totalBuyerPays,
      deliveryNeeded: terms.deliveryNeeded === true,
      status: responseStatus,
      sellerNote: typeof terms.sellerNote === 'string' && terms.sellerNote.trim() ? terms.sellerNote : null,
    };
  }

  async claimPublicTransaction(
    ref: string,
    actorId: string,
    deviceIdRaw?: string,
  ): Promise<Record<string, unknown>> {
    const buyerId = actorId?.trim();
    if (!buyerId) {
      throw new BadRequestException('actorId required');
    }
    const { template, order } = await this.resolvePublicCheckout(ref);
    if (template.sellerId === buyerId) {
      throw new ConflictException('seller cannot buy their own public transaction');
    }

    const deviceId = this.normalizePublicDeviceId(deviceIdRaw);
    const now = new Date();

    const existingOrder =
      order?.buyerId === buyerId
        ? order
        : await this.findBuyerOrderForTemplate(template.id, buyerId);

    if (existingOrder) {
      return {
        transactionId: existingOrder.id,
        workflow: template.workflow,
        buyerId,
        status: existingOrder.status,
        event: 'public.claimed',
        alreadyClaimed: true,
      };
    }

    // Legacy rows: buyer was assigned directly on the template (shareToken cleared).
    if (!template.shareToken && template.buyerId) {
      if (template.buyerId !== buyerId) {
        throw new ConflictException(
          'this public transaction is already assigned to another buyer',
        );
      }
      return {
        transactionId: template.id,
        workflow: template.workflow,
        buyerId,
        status: template.status,
        event: 'public.claimed',
        alreadyClaimed: true,
      };
    }

    if (!template.shareToken) {
      throw new NotFoundException('transaction not found');
    }

    const accepted = Array.from(new Set([template.sellerId, buyerId]));
    const status = TransactionStatus.AWAITING_FUNDING;
    const buyerOrder = await this.prisma.transaction.create({
      data: {
        workflow: TransactionWorkflow.PUBLIC_SHAREABLE,
        sourceShareTransactionId: template.id,
        shareToken: null,
        type: template.type,
        productId: template.productId,
        productTitle: template.productTitle,
        quantity: template.quantity,
        unitPrice: template.unitPrice,
        amount: template.amount,
        buyerId,
        sellerId: template.sellerId,
        createdByUserId: template.sellerId,
        fundedBy: template.fundedBy,
        terms: template.terms,
        status,
        acceptedPartyIds: { set: accepted },
        agreements: {
          create: {
            version: 1,
            content: template.terms,
            actorId: buyerId,
          },
        },
        auditLogs: {
          create: [
            {
              action: 'public.checkout_started',
              actorId: buyerId,
              detail: 'buyer started checkout from shared payment link',
            },
            {
              action: 'transaction.accepted',
              actorId: buyerId,
              detail: 'buyer accepted transaction on checkout',
            },
          ],
        },
      },
    });

    if (deviceId) {
      await this.prisma.transactionPublicView
        .create({
          data: {
            transactionId: template.id,
            deviceId,
            viewerUserId: buyerId,
            convertedAt: now,
          },
        })
        .catch(() => undefined);
    }

    await this.rabbit.publish('transaction.created', {
      transactionId: buyerOrder.id,
      workflow: buyerOrder.workflow,
      buyerId,
      sellerId: template.sellerId,
      type: buyerOrder.type,
      occurredAt: now.toISOString(),
    });

    await this.rabbit.publish('transaction.updated', {
      transactionId: buyerOrder.id,
      workflow: buyerOrder.workflow,
      sellerId: template.sellerId,
      buyerId,
      type: buyerOrder.type,
      status,
      occurredAt: now.toISOString(),
    });

    await this.notificationEvents.notify({
      transactionId: buyerOrder.id,
      recipientId: template.sellerId,
      role: 'seller',
      eventType: 'transaction.public_checkout_started',
      title: 'Buyer started checkout',
      message: `A buyer started checkout for "${template.productTitle}".`,
    });

    return {
      transactionId: buyerOrder.id,
      workflow: buyerOrder.workflow,
      buyerId,
      status,
      event: 'public.checkout_started',
    };
  }


  async acceptTransaction(id: string, actorId: string): Promise<Record<string, unknown>> {
    const existing = await this.prisma.transaction.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('transaction not found');
    }
    if (!existing.buyerId) {
      throw new ConflictException('public transaction has not been claimed by a buyer yet');
    }
    if (actorId !== existing.buyerId && actorId !== existing.sellerId) {
      throw new ConflictException('only buyer or seller can accept');
    }
    const accepted = new Set(existing.acceptedPartyIds);
    if (!accepted.has(actorId)) {
      accepted.add(actorId);
    }
    const nextAccepted = Array.from(accepted);
    const bothAccepted =
      nextAccepted.includes(existing.buyerId) && nextAccepted.includes(existing.sellerId);
    const nextStatus = bothAccepted
      ? TransactionStatus.AWAITING_FUNDING
      : existing.status;

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        acceptedPartyIds: { set: nextAccepted },
        status: nextStatus,
        auditLogs: {
          create: {
            action: 'transaction.accepted',
            actorId,
            detail: 'party accepted transaction',
          },
        },
      },
    });

    await this.rabbit.publish('transaction.accepted', {
      transactionId: updated.id,
      actorId,
      status: updated.status,
      occurredAt: new Date().toISOString(),
    });

    await this.notificationEvents.notifyAccepted(
      {
        id: updated.id,
        buyerId: existing.buyerId,
        sellerId: existing.sellerId,
        productTitle: existing.productTitle,
      },
      actorId,
      updated.status,
    );

    return {
      transactionId: updated.id,
      status: updated.status,
      event: 'transaction.accepted',
    };
  }

  async updateState(
    id: string,
    newState: string,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const next = newState as TransactionStatus;
    if (!(next in TransactionStatus)) {
      throw new BadRequestException('invalid state');
    }
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException('transaction not found');
    }
    const allowed = TRANSITIONS[transaction.status] ?? [];
    if (!allowed.includes(next)) {
      throw new ConflictException(
        `invalid transition: ${transaction.status} -> ${next}`,
      );
    }
    const isBuyer = actorId === transaction.buyerId;
    const isSeller = actorId === transaction.sellerId;
    if (!isBuyer && !isSeller) {
      throw new ConflictException('only buyer or seller can update transaction state');
    }
    if (next === TransactionStatus.FUNDED) {
      throw new ConflictException(
        'funding must be completed via wallet payment (escrow.funded)',
      );
    }
    const buyerOnly = new Set<TransactionStatus>([TransactionStatus.COMPLETED]);
    const sellerOnly = new Set<TransactionStatus>([
      TransactionStatus.IN_PROGRESS,
      TransactionStatus.INSPECTION,
    ]);
    if (buyerOnly.has(next) && !isBuyer) {
      throw new ConflictException('only the buyer can perform this action');
    }
    if (sellerOnly.has(next) && !isSeller) {
      throw new ConflictException('only the seller can perform this action');
    }
    if (next === TransactionStatus.CLOSED) {
      if (!isBuyer) {
        throw new ConflictException('only the buyer can close this transaction');
      }
      if (!transaction.buyerId) {
        throw new ConflictException(
          'shareable listing cannot be closed; only individual buyer orders can be closed',
        );
      }
      if (transaction.shareToken) {
        throw new ConflictException(
          'close the buyer order from your purchases, not the share link listing',
        );
      }
      const fundedStatuses = new Set<TransactionStatus>([
        TransactionStatus.FUNDED,
        TransactionStatus.IN_PROGRESS,
        TransactionStatus.INSPECTION,
        TransactionStatus.COMPLETED,
      ]);
      if (fundedStatuses.has(transaction.status)) {
        throw new ConflictException('cannot cancel or close a transaction after it has been funded');
      }
    }
    if (next === TransactionStatus.COMPLETED) {
      await this.settleEscrowToSeller({
        transactionId: transaction.id,
        sellerId: transaction.sellerId,
        amount: transaction.amount.toString(),
        actorId,
        productTitle: transaction.productTitle,
      });
    }
    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: next,
        auditLogs: {
          create: {
            action: 'state.changed',
            actorId,
            detail: `state=${next}`,
          },
        },
      },
    });
    if (next === TransactionStatus.COMPLETED) {
      await this.rabbit.publish('transaction.completed', {
        transactionId: updated.id,
        workflow: updated.workflow,
        actorId,
        sellerId: transaction.sellerId,
        buyerId: transaction.buyerId,
        amount: transaction.amount.toString(),
        occurredAt: new Date().toISOString(),
      });
    }
    if (next === TransactionStatus.REFUNDED) {
      await this.rabbit.publish('transaction.refunded', {
        transactionId: updated.id,
        workflow: updated.workflow,
        actorId,
        buyerId: transaction.buyerId,
        amount: transaction.amount.toString(),
        occurredAt: new Date().toISOString(),
      });
    }
    await this.notificationEvents.notifyStateChange(
      {
        id: transaction.id,
        buyerId: transaction.buyerId,
        sellerId: transaction.sellerId,
        productTitle: transaction.productTitle,
      },
      next,
      actorId,
    );
    return { transactionId: updated.id, status: updated.status };
  }

  /** Called by escrow-service after a successful wallet debit (not via PATCH /state). */
  async markWalletPaymentFunded(
    id: string,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException('transaction not found');
    }
    if (!transaction.buyerId) {
      throw new ConflictException('transaction has no buyer assigned');
    }
    if (actorId !== transaction.buyerId) {
      throw new ConflictException('only the buyer can fund this transaction');
    }
    const fundedStatuses = new Set<TransactionStatus>([
      TransactionStatus.FUNDED,
      TransactionStatus.IN_PROGRESS,
      TransactionStatus.INSPECTION,
      TransactionStatus.COMPLETED,
      TransactionStatus.CLOSED,
    ]);
    if (fundedStatuses.has(transaction.status)) {
      return {
        transactionId: transaction.id,
        status: transaction.status,
        alreadyFunded: true,
      };
    }
    if (
      transaction.status !== TransactionStatus.AWAITING_FUNDING &&
      transaction.status !== TransactionStatus.AWAITING_ACCEPTANCE
    ) {
      throw new ConflictException(
        `transaction cannot be funded while ${transaction.status}`,
      );
    }
    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: TransactionStatus.FUNDED,
        auditLogs: {
          create: {
            action: 'payment.funded',
            actorId,
            detail: 'wallet payment funded escrow',
          },
        },
      },
    });
    await this.notificationEvents.notifyFunded(
      {
        id: updated.id,
        buyerId: transaction.buyerId,
        sellerId: transaction.sellerId,
        productTitle: transaction.productTitle,
      },
      actorId,
    );
    return {
      transactionId: updated.id,
      status: updated.status,
      alreadyFunded: false,
    };
  }

  private escrowServiceUrl(): string {
    const raw = process.env.ESCROW_SERVICE_URL?.trim() || 'http://127.0.0.1:5003';
    return raw.replace(/\/$/, '');
  }

  private resolveInternalApiSecret(): string {
    const fromEnv = process.env.INTERNAL_API_SECRET?.trim();
    if (fromEnv) return fromEnv;
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('INTERNAL_API_SECRET is not configured');
    }
    return DEV_FALLBACK_INTERNAL_API_SECRET;
  }

  private async refundEscrowToBuyer(params: {
    transactionId: string;
    buyerId: string;
    amount: string;
    actorId: string;
    productTitle: string;
  }): Promise<void> {
    try {
      await this.rabbit.rpc('escrow.rpc.wallet.refund-to-buyer', {
        transactionId: params.transactionId,
        buyerUserId: params.buyerId,
        amount: params.amount,
        actorId: params.actorId,
        productTitle: params.productTitle,
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `escrow could not refund buyer via RPC: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async listShareBuyerOrders(templateId: string) {
    const template = await this.prisma.transaction.findUnique({
      where: { id: templateId },
    });
    if (!template?.shareToken) {
      return [];
    }
    const legacyMatch: {
      sourceShareTransactionId: null;
      shareToken: null;
      buyerId: { not: null };
      sellerId: string;
      workflow: TransactionWorkflow;
      id: { not: string };
      productId?: string;
      productTitle?: string;
      amount?: typeof template.amount;
    } = {
      sourceShareTransactionId: null,
      shareToken: null,
      buyerId: { not: null },
      sellerId: template.sellerId,
      workflow: TransactionWorkflow.PUBLIC_SHAREABLE,
      id: { not: templateId },
    };
    if (template.productId) {
      legacyMatch.productId = template.productId;
    } else {
      legacyMatch.productTitle = template.productTitle;
      legacyMatch.amount = template.amount;
    }
    const rows = await this.prisma.transaction.findMany({
      where: {
        OR: [{ sourceShareTransactionId: templateId }, legacyMatch],
      },
      orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        buyerId: row.buyerId,
        status: row.status,
        amount: row.amount.toString(),
        productTitle: row.productTitle,
        updatedAt: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        buyer: row.buyerId ? await this.lookupPartyProfile(row.buyerId) : null,
      })),
    );
  }

  private async settleEscrowToSeller(params: {
    transactionId: string;
    sellerId: string;
    amount: string;
    actorId: string;
    productTitle: string;
  }): Promise<void> {
    try {
      await this.rabbit.rpc('escrow.rpc.wallet.settle-to-seller', {
        transactionId: params.transactionId,
        sellerUserId: params.sellerId,
        amount: params.amount,
        actorId: params.actorId,
        productTitle: params.productTitle,
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `escrow could not release funds to seller via RPC: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  verifyInternalApiSecret(secret: string | undefined): void {
    const expected =
      process.env.INTERNAL_API_SECRET?.trim() ||
      (process.env.NODE_ENV === 'production' ? '' : DEV_FALLBACK_INTERNAL_API_SECRET);
    if (!expected?.length) {
      throw new ServiceUnavailableException('INTERNAL_API_SECRET is not configured');
    }
    if (secret?.trim() !== expected) {
      throw new ConflictException('invalid internal secret');
    }
  }

  async inviteParticipant(
    id: string,
    actorId: string,
    participantUserId: string,
    roleRaw: string,
    partySideRaw: string,
    messageRaw?: string,
  ): Promise<Record<string, unknown>> {
    const role = parseParticipantRole(roleRaw);
    const partySide = parsePartySide(partySideRaw);
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException('transaction not found');
    }
    if (transaction.workflow !== TransactionWorkflow.ESCROW_TWO_PARTY) {
      throw new ConflictException('participants can only be invited to two-party escrow transactions');
    }
    if (actorId !== transaction.buyerId && actorId !== transaction.sellerId) {
      throw new ConflictException('only buyer or seller can invite participants');
    }
    if (partySide === 'buyer' && actorId !== transaction.buyerId) {
      throw new ConflictException('only the buyer can invite buyer-side professionals');
    }
    if (partySide === 'seller' && actorId !== transaction.sellerId) {
      throw new ConflictException('only the seller can invite seller-side professionals');
    }
    if (participantUserId === transaction.buyerId || participantUserId === transaction.sellerId) {
      throw new ConflictException('buyer or seller cannot be invited as participant');
    }

    const existingSlot = getParticipantSlot(transaction, partySide, role);
    if (existingSlot.userId && existingSlot.status === ParticipantInviteStatus.ACCEPTED) {
      // Once accepted, the professional for that side+role is immutable.
      throw new ConflictException('cannot change/remove participant after acceptance');
    }

    const pricing = await this.fetchProductProfessionalPricingFlags(transaction.productId);
    if (role === 'LAWYER' && pricing?.lawyerPricingEnabled !== true) {
      throw new BadRequestException(
        'lawyer invites are not allowed for this product type (lawyer pricing disabled)',
      );
    }
    if (role === 'AGENT' && pricing?.agentPricingEnabled !== true) {
      throw new BadRequestException(
        'agent invites are not allowed for this product type (agent pricing disabled)',
      );
    }

    const profile = await this.searchUserDirectory(participantUserId);
    if (!profile) {
      throw new NotFoundException('invited user not found');
    }

    const inviterProfile = await this.searchUserDirectory(actorId);
    const inviterLabel =
      (typeof inviterProfile?.displayName === 'string' &&
        inviterProfile.displayName.trim()) ||
      (typeof inviterProfile?.email === 'string' && inviterProfile.email.trim()) ||
      (typeof inviterProfile?.phone === 'string' && inviterProfile.phone.trim()) ||
      `${actorId.slice(0, 8)}…`;

    const trimmedMessage = messageRaw?.trim();
    const message =
      trimmedMessage && trimmedMessage.length > 0
        ? trimmedMessage
        : defaultParticipantInviteMessage({
            inviterLabel,
            partySide,
            professionalRole: role,
            productTitle: transaction.productTitle,
            amount: transaction.amount.toString(),
            transactionId: transaction.id,
          });

    const data = inviteDataForSlot(partySide, role, participantUserId);
    const notifRole = participantNotificationRole(partySide, role);
    await this.prisma.transaction.update({
      where: { id },
      data: {
        ...data,
        auditLogs: {
          create: {
            action: `participant.${partySide}.${role.toLowerCase()}.invited`,
            actorId,
            detail: `message=${message.slice(0, 500)}`,
          },
        },
      },
    });

    await this.notificationEvents.notify({
      transactionId: id,
      recipientId: participantUserId,
      message,
      role: notifRole,
      eventType: 'transaction.participant_invited',
      title: 'Transaction invitation',
    });
    return {
      transactionId: id,
      role,
      partySide,
      invitedUserId: participantUserId,
      status: 'PENDING',
    };
  }

  async acceptParticipantInvite(
    id: string,
    actorId: string,
    roleRaw: string,
    partySideRaw: string,
  ): Promise<Record<string, unknown>> {
    const role = parseParticipantRole(roleRaw);
    const partySide = parsePartySide(partySideRaw);
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    if (tx.workflow !== TransactionWorkflow.ESCROW_TWO_PARTY) {
      throw new ConflictException('participant invites are only available in two-party escrow transactions');
    }
    const slot = getParticipantSlot(tx, partySide, role);
    if (!slot.userId || slot.status !== ParticipantInviteStatus.PENDING) {
      throw new ConflictException('no pending invite for this role and party');
    }
    if (slot.userId !== actorId) {
      throw new ConflictException('only invited participant can accept');
    }

    const data = acceptDataForSlot(partySide, role);
    await this.prisma.transaction.update({
      where: { id },
      data: {
        ...data,
        auditLogs: {
          create: {
            action: `participant.${partySide}.${role.toLowerCase()}.accepted`,
            actorId,
            detail: 'participant accepted invitation',
          },
        },
      },
    });
    const inviterId =
      partySide === 'buyer' ? tx.buyerId ?? '' : tx.sellerId;
    if (inviterId) {
      await this.notificationEvents.notifyParticipantAccepted(
        {
          id: tx.id,
          buyerId: tx.buyerId,
          sellerId: tx.sellerId,
          productTitle: tx.productTitle,
        },
        inviterId,
        partySide,
        role,
      );
    }
    return { transactionId: id, role, partySide, status: 'ACCEPTED' };
  }

  async versionAgreement(
    id: string,
    content: string,
    actorId: string,
  ): Promise<Record<string, unknown>> {
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException('transaction not found');
    }
    const latest = await this.prisma.agreementVersion.findFirst({
      where: { transactionId: id },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    await this.prisma.$transaction([
      this.prisma.agreementVersion.create({
        data: { transactionId: id, version, content, actorId },
      }),
      this.prisma.transactionAudit.create({
        data: {
          transactionId: id,
          action: 'agreement.versioned',
          actorId,
          detail: `v${version}`,
        },
      }),
    ]);
    return { transactionId: id, agreementVersion: version };
  }

  async raiseDispute(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException('transaction not found');
    }
    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: TransactionStatus.DISPUTED,
        auditLogs: {
          create: {
            action: 'dispute.created',
            actorId,
            detail: reason,
          },
        },
      },
    });
    await this.rabbit.publish('dispute.created', {
      transactionId: updated.id,
      actorId,
      reason,
      occurredAt: new Date().toISOString(),
    });
    await this.notificationEvents.notifyDisputeOpened(
      {
        id: transaction.id,
        buyerId: transaction.buyerId,
        sellerId: transaction.sellerId,
        productTitle: transaction.productTitle,
      },
      actorId,
      reason,
    );
    return {
      transactionId: updated.id,
      status: updated.status,
      event: 'dispute.created',
    };
  }

  async getTransactionRoom(id: string): Promise<Record<string, unknown>> {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        documents: { orderBy: { createdAt: 'asc' } },
        agreements: { orderBy: { version: 'asc' } },
        auditLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    const timeline = tx.auditLogs.map((entry) => ({
      at: entry.createdAt.toISOString(),
      action: entry.action,
      actorId: entry.actorId,
      detail: sanitizeAuditDetail(entry.detail),
    }));

    const [
      product,
      buyerParty,
      sellerParty,
      buyerLawyerParty,
      buyerAgentParty,
      sellerLawyerParty,
      sellerAgentParty,
      publicAnalytics,
      shareBuyerOrders,
    ] = await Promise.all([
      tx.productId ? this.fetchProductSnapshotForRoom(tx.productId) : Promise.resolve(null),
      tx.buyerId ? this.lookupPartyProfile(tx.buyerId) : Promise.resolve(null),
      this.lookupPartyProfile(tx.sellerId),
      tx.buyerLawyerId ? this.lookupPartyProfile(tx.buyerLawyerId) : Promise.resolve(null),
      tx.buyerAgentId ? this.lookupPartyProfile(tx.buyerAgentId) : Promise.resolve(null),
      tx.sellerLawyerId ? this.lookupPartyProfile(tx.sellerLawyerId) : Promise.resolve(null),
      tx.sellerAgentId ? this.lookupPartyProfile(tx.sellerAgentId) : Promise.resolve(null),
      tx.workflow === TransactionWorkflow.PUBLIC_SHAREABLE
        ? this.getPublicAnalytics(tx)
        : Promise.resolve(null),
      tx.shareToken
        ? this.listShareBuyerOrders(tx.id)
        : Promise.resolve(null),
    ]);

    return {
      transaction: {
        id: tx.id,
        workflow: tx.workflow,
        shareToken: tx.shareToken,
        sharePath: tx.shareToken ? `/pay/${tx.shareToken}` : null,
        type: tx.type,
        productId: tx.productId,
        productTitle: tx.productTitle,
        quantity: tx.quantity,
        unitPrice: tx.unitPrice?.toString() ?? null,
        amount: tx.amount.toString(),
        fundedBy: tx.fundedBy,
        buyerId: tx.buyerId,
        sellerId: tx.sellerId,
        terms: tx.terms,
        status: tx.status,
        acceptedPartyIds: tx.acceptedPartyIds,
        buyerLawyerId: tx.buyerLawyerId,
        buyerLawyerInviteStatus: tx.buyerLawyerInviteStatus,
        buyerAgentId: tx.buyerAgentId,
        buyerAgentInviteStatus: tx.buyerAgentInviteStatus,
        sellerLawyerId: tx.sellerLawyerId,
        sellerLawyerInviteStatus: tx.sellerLawyerInviteStatus,
        sellerAgentId: tx.sellerAgentId,
        sellerAgentInviteStatus: tx.sellerAgentInviteStatus,
        createdAt: tx.createdAt.toISOString(),
        updatedAt: tx.updatedAt.toISOString(),
      },
      product,
      parties: {
        buyer: buyerParty,
        seller: sellerParty,
        buyerLawyer: buyerLawyerParty,
        buyerAgent: buyerAgentParty,
        sellerLawyer: sellerLawyerParty,
        sellerAgent: sellerAgentParty,
      },
      publicAnalytics,
      shareBuyerOrders,
      documents: tx.documents,
      agreements: tx.agreements,
      auditLogs: tx.auditLogs,
      timeline,
    };
  }

  private async lookupPartyProfile(userId: string | null | undefined): Promise<{
    id: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
  } | null> {
    if (!userId) return null;
    try {
      const row = await this.rabbit.rpc<any>('user.rpc.user.search', {
        query: userId,
      });
      if (!row) return null;
      return {
        id: row.id,
        displayName: row.displayName ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Full product row from product-service (images, attributes). */
  private async fetchProductSnapshotForRoom(
    productId: string | null | undefined,
  ): Promise<Record<string, unknown> | null> {
    if (!productId) return null;
    try {
      return await this.rabbit.rpc<Record<string, unknown>>('product.rpc.product.get-full', {
        productId,
      });
    } catch {
      return null;
    }
  }

  async listTransactionsForParty(
    buyerId?: string,
    sellerId?: string,
  ): Promise<Record<string, unknown>> {
    if (!buyerId && !sellerId) {
      throw new BadRequestException('buyerId or sellerId query required');
    }
    const rows = await this.prisma.transaction.findMany({
      where: {
        OR: [
          ...(buyerId ? [{ buyerId }] : []),
          ...(sellerId ? [{ sellerId }] : []),
          ...(buyerId
            ? [
                { buyerLawyerId: buyerId },
                { buyerAgentId: buyerId },
                { sellerLawyerId: buyerId },
                { sellerAgentId: buyerId },
              ]
            : []),
          ...(sellerId
            ? [
                { buyerLawyerId: sellerId },
                { buyerAgentId: sellerId },
                { sellerLawyerId: sellerId },
                { sellerAgentId: sellerId },
              ]
            : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        workflow: true,
        shareToken: true,
        type: true,
        productId: true,
        productTitle: true,
        quantity: true,
        unitPrice: true,
        amount: true,
        buyerId: true,
        sellerId: true,
        fundedBy: true,
        status: true,
        updatedAt: true,
      },
    });
    return {
      items: rows.map((row) => ({
        ...row,
        sharePath: row.shareToken ? `/pay/${row.shareToken}` : null,
        unitPrice: row.unitPrice?.toString() ?? null,
        amount: row.amount.toString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async addDocument(
    id: string,
    dto: AddDocumentDto,
  ): Promise<Record<string, unknown>> {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    if (
      dto.actorId !== tx.buyerId &&
      dto.actorId !== tx.sellerId
    ) {
      throw new ConflictException('only buyer or seller can add documents');
    }
    const document = await this.prisma.transactionDocument.create({
      data: {
        transactionId: id,
        fileUrl: dto.fileUrl,
        fileKey: dto.fileKey,
        uploader: dto.uploader,
      },
    });
    await this.prisma.transactionAudit.create({
      data: {
        transactionId: id,
        action: 'document.added',
        actorId: dto.actorId,
        detail: `fileKey=${dto.fileKey}`,
      },
    });
    return {
      transactionId: id,
      documentId: document.id,
      fileKey: document.fileKey,
    };
  }
}
