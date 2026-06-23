import type { DisputeStatus, TransactionDispute, TransactionDisputeResponse } from '@prisma/client';

export type DisputeThreadMessage = {
  id: string;
  actorId: string;
  actorRole: string;
  message: string;
  createdAt: string;
  kind: 'opening' | 'reply' | 'resolution';
};

type DisputeRow = TransactionDispute & {
  responses: TransactionDisputeResponse[];
};

export function pickPrimaryDispute(rows: DisputeRow[]): DisputeRow | null {
  if (!rows.length) return null;
  const roots = rows
    .filter((r) => !r.parentDisputeId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return roots[0] ?? rows[0];
}

export function partyHasComplaint(rows: DisputeRow[], role: string): boolean {
  return rows.some((r) => r.raisedByRole === role);
}

export function buildMergedThread(rows: DisputeRow[]): DisputeThreadMessage[] {
  const items: DisputeThreadMessage[] = [];
  const roots = rows
    .filter((r) => !r.parentDisputeId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const root of roots) {
    items.push({
      id: `opening-${root.id}`,
      actorId: root.raisedByUserId,
      actorRole: root.raisedByRole,
      message: root.description,
      createdAt: root.createdAt.toISOString(),
      kind: 'opening',
    });
    for (const r of root.responses) {
      items.push({
        id: r.id,
        actorId: r.actorId,
        actorRole: r.actorRole,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        kind: 'reply',
      });
    }
  }

  for (const child of rows.filter((r) => r.parentDisputeId)) {
    items.push({
      id: `opening-${child.id}`,
      actorId: child.raisedByUserId,
      actorRole: child.raisedByRole,
      message: child.description,
      createdAt: child.createdAt.toISOString(),
      kind: 'opening',
    });
    for (const r of child.responses) {
      items.push({
        id: r.id,
        actorId: r.actorId,
        actorRole: r.actorRole,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        kind: 'reply',
      });
    }
  }

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function mapUnifiedDispute(rows: DisputeRow[]) {
  const primary = pickPrimaryDispute(rows);
  if (!primary) return null;

  const thread = buildMergedThread(rows);
  if (primary.resolution && primary.resolutionReason) {
    const outcome =
      primary.resolution === 'REFUND_TO_BUYER'
        ? 'Refund to buyer'
        : 'Release to seller';
    thread.push({
      id: `resolution-${primary.id}`,
      actorId: primary.resolvedByAdminId ?? 'admin',
      actorRole: 'paynexa',
      message: `${outcome}. ${primary.resolutionReason}`,
      createdAt: primary.resolvedAt?.toISOString() ?? primary.createdAt.toISOString(),
      kind: 'resolution',
    });
  }
  const open = rows.some(
    (r) => r.status === 'OPEN' || r.status === 'COUNTERED',
  );
  const status = primary.resolution
    ? ('RESOLVED' as DisputeStatus)
    : open
      ? rows.some((r) => r.status === 'COUNTERED')
        ? ('COUNTERED' as DisputeStatus)
        : ('OPEN' as DisputeStatus)
      : primary.status;

  return {
    id: primary.id,
    transactionId: primary.transactionId,
    raisedByUserId: primary.raisedByUserId,
    raisedByRole: primary.raisedByRole,
    description: primary.description,
    parentDisputeId: null,
    status,
    resolution: primary.resolution,
    resolutionReason: primary.resolutionReason,
    resolvedAt: primary.resolvedAt?.toISOString() ?? null,
    createdAt: primary.createdAt.toISOString(),
    thread,
    responses: thread.filter((m) => m.kind === 'reply'),
  };
}
