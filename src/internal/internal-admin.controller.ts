import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { TransactionAdminService } from '../admin/transaction-admin.service';

import type { ResolveDisputeDto } from '../dto/dispute.dto';

@Controller('internal/admin')
export class InternalAdminController {
  constructor(private readonly admin: TransactionAdminService) {}

  private verifySecret(secret: string | undefined): void {
    const expected =
      process.env.INTERNAL_API_SECRET?.trim() ||
      (process.env.NODE_ENV === 'production' ? '' : 'change-me');
    if (!expected || secret?.trim() !== expected) {
      throw new UnauthorizedException('invalid internal secret');
    }
  }

  @Get('transactions')
  listTransactions(
    @Headers('x-internal-secret') secret: string | undefined,
    @Query('query') query?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.verifySecret(secret);
    return this.admin.listTransactions({
      query,
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('transactions/:id')
  getTransaction(
    @Headers('x-internal-secret') secret: string | undefined,
    @Param('id') id: string,
  ) {
    this.verifySecret(secret);
    return this.admin.getTransactionDetail(id);
  }

  @Get('disputes')
  listDisputes(
    @Headers('x-internal-secret') secret: string | undefined,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.verifySecret(secret);
    return this.admin.listDisputes({
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('disputes/:id')
  getDispute(
    @Headers('x-internal-secret') secret: string | undefined,
    @Param('id') id: string,
  ) {
    this.verifySecret(secret);
    return this.admin.getDisputeDetail(id);
  }

  @Patch('disputes/:id/resolve')
  resolveDispute(
    @Headers('x-internal-secret') secret: string | undefined,
    @Param('id') id: string,
    @Body() body: { adminId: string; dto: ResolveDisputeDto },
  ) {
    this.verifySecret(secret);
    return this.admin.resolveDispute(id, {
      adminId: body.adminId,
      resolution: body.dto.resolution,
      resolutionReason: body.dto.resolutionReason,
      internalNotes: body.dto.internalNotes,
    });
  }
}
